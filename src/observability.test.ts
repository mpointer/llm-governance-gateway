// Observability export hooks: fire after durable writes, never break the call.

import { describe, expect, it, vi } from "vitest";
import { Gateway } from "./gateway.js";
import { SpendCapError } from "./errors.js";
import { toOtelAttributes } from "./observability.js";
import type { SpendCapEvent, UsageEntry } from "./types.js";
import { MemoryRateLimiter, MemoryUsageStore } from "./adapters/memory.js";
import { z } from "zod";

const schema = z.object({ s: z.string() });

function make(hooks: ConstructorParameters<typeof Gateway>[0]["observability"], caps?: { globalDailyCents?: number }) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    rateLimiter: new MemoryRateLimiter(100),
    promptDefaults: [{ slug: "p", body: "Do: {{t}}", variables: ["t"] }],
    mock: true,
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0, ...caps },
    observability: hooks,
  });
  gw.registerMockResponder("p", () => ({ s: "ok" }));
  return { gw, usage };
}

const opts = {
  slug: "p",
  input: { t: "x" },
  variables: (i: { t: string }) => ({ t: i.t }),
  schema,
  cacheParts: ["x"],
  anonKey: "t",
};

describe("observability hooks", () => {
  it("onUsage fires with the logged entry including its id", async () => {
    const seen: (UsageEntry & { id: string | number })[] = [];
    const { gw } = make({ onUsage: (e) => void seen.push(e) });
    await gw.runStructured({ ...opts, cache: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.provider).toBe("mock");
    expect(seen[0]!.id).toBeDefined();
    expect(seen[0]!.traceId).toBeTruthy();
  });

  it("a throwing hook is swallowed and warned once, the call succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gw } = make({
      onUsage: () => {
        throw new Error("exporter down");
      },
    });
    const r1 = await gw.runStructured({ ...opts, cache: false });
    const r2 = await gw.runStructured({ ...opts, cache: false });
    expect(r1.object.s).toBe("ok");
    expect(r2.object.s).toBe("ok");
    const obsWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("observability hook"),
    );
    expect(obsWarnings).toHaveLength(1); // suppressed after the first
    warn.mockRestore();
  });

  it("an async-rejecting hook is swallowed too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gw } = make({ onUsage: async () => Promise.reject(new Error("nope")) });
    const r = await gw.runStructured({ ...opts, cache: false });
    expect(r.object.s).toBe("ok");
    warn.mockRestore();
  });

  it("onSpendCapEvent fires when the global cap blocks", async () => {
    const events: SpendCapEvent[] = [];
    const { gw, usage } = make(
      { onSpendCapEvent: (e) => void events.push(e) },
      { globalDailyCents: 1 },
    );
    // Seed spend past the cap.
    await usage.logUsage({
      provider: "x",
      model: "x",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostCents: 50,
      cacheHit: false,
      traceId: "seed",
      createdAt: new Date(),
    });
    await expect(gw.runStructured({ ...opts, cache: false })).rejects.toThrow(SpendCapError);
    expect(events).toHaveLength(1);
    expect(events[0]!.wouldBlock).toBe(true);
  });

  it("onJudgeScore fires for the caller-computed rubric", async () => {
    const scores: unknown[] = [];
    const { gw } = make({ onJudgeScore: (s) => void scores.push(s) });
    await gw.runStructured({
      ...opts,
      cache: false,
      judgeRubric: () => ({ quality: 4 }),
    });
    expect(scores).toHaveLength(1);
  });
});

describe("toOtelAttributes", () => {
  it("maps entries onto gen_ai.* and llm_gateway.* attributes", () => {
    const attrs = toOtelAttributes({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostCents: 2,
      cacheHit: false,
      traceId: "t1",
      userId: "u1",
      route: "lib/ai",
      webSearches: 3,
      createdAt: new Date(),
    });
    expect(attrs["gen_ai.system"]).toBe("anthropic");
    expect(attrs["gen_ai.response.model"]).toBe("claude-sonnet-5");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(attrs["enduser.id"]).toBe("u1");
    expect(attrs["llm_gateway.web_searches"]).toBe(3);
    expect(attrs["llm_gateway.cache_hit"]).toBe(false);
    // absent optionals stay absent rather than emitting nulls
    expect("llm_gateway.duration_ms" in attrs).toBe(false);
  });
});
