import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { RateLimitError, SpendCapError } from "./errors.js";
import {
  MemoryCacheStore,
  MemoryRateLimiter,
  MemoryUsageStore,
} from "./adapters/memory.js";
import type { PromptDefault } from "./types.js";

const OutSchema = z.object({ answer: z.string() });

const PROMPTS: PromptDefault[] = [
  {
    slug: "greet",
    body: "Say hello to {{name}}.",
    variables: ["name"],
  },
];

function makeGateway(over: {
  usage?: MemoryUsageStore;
  rateLimiter?: MemoryRateLimiter;
  caps?: { userDailyCents?: number; anonDailyCents?: number; globalDailyCents?: number };
} = {}) {
  const usage = over.usage ?? new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    cache: new MemoryCacheStore(),
    rateLimiter: over.rateLimiter ?? new MemoryRateLimiter(100),
    promptDefaults: PROMPTS,
    mock: true,
    appId: "test",
    caps: over.caps,
  });
  gw.registerMockResponder("greet", () => ({ answer: "hi" }));
  return { gw, usage };
}

function runOpts(extra: Partial<Parameters<Gateway["runStructured"]>[0]> = {}) {
  return {
    slug: "greet",
    schema: OutSchema,
    input: { name: "Mike" },
    variables: (i: { name: string }) => ({ name: i.name }),
    cacheParts: ["Mike"],
    userId: "u1",
    ...extra,
  };
}

describe("Gateway.runStructured (mock mode)", () => {
  let gw: Gateway;
  let usage: MemoryUsageStore;

  beforeEach(() => {
    ({ gw, usage } = makeGateway());
  });

  it("returns validated object and logs usage", async () => {
    const res = await gw.runStructured(runOpts());
    expect(res.object).toEqual({ answer: "hi" });
    expect(res.cacheHit).toBe(false);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.provider).toBe("mock");
    expect(usage.entries[0]!.app).toBe("test");
  });

  it("serves the second identical call from cache", async () => {
    await gw.runStructured(runOpts());
    const res = await gw.runStructured(runOpts());
    expect(res.cacheHit).toBe(true);
    expect(usage.entries).toHaveLength(2);
    expect(usage.entries[1]!.provider).toBe("cache");
    expect(usage.entries[1]!.estimatedCostCents).toBe(0);
  });

  it("cache:false bypasses read and write", async () => {
    await gw.runStructured(runOpts({ cache: false, cacheParts: undefined }));
    const res = await gw.runStructured(runOpts({ cache: false, cacheParts: undefined }));
    expect(res.cacheHit).toBe(false);
  });

  it("requires cacheParts unless cache:false", async () => {
    await expect(
      gw.runStructured(runOpts({ cacheParts: undefined })),
    ).rejects.toThrow(/cacheParts is required/);
  });

  it("throws RateLimitError when the limiter denies", async () => {
    const { gw: limited } = makeGateway({ rateLimiter: new MemoryRateLimiter(1) });
    await limited.runStructured(runOpts());
    await expect(limited.runStructured(runOpts({ cacheParts: ["other"] }))).rejects.toThrow(
      RateLimitError,
    );
  });

  it("enforces the per-user daily spend cap and records the event", async () => {
    const usage = new MemoryUsageStore();
    // Pre-load today's spend beyond the cap.
    await usage.logUsage({
      userId: "u1",
      provider: "anthropic",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 500,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const { gw } = makeGateway({ usage, caps: { userDailyCents: 200, globalDailyCents: 0 } });
    await expect(gw.runStructured(runOpts())).rejects.toThrow(SpendCapError);
    expect(usage.capEvents).toHaveLength(1);
    expect(usage.capEvents[0]!.wouldBlock).toBe(true);
  });

  it("global circuit breaker trips regardless of identity", async () => {
    const usage = new MemoryUsageStore();
    await usage.logUsage({
      userId: "someone-else",
      provider: "anthropic",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 6000,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const { gw } = makeGateway({ usage, caps: { globalDailyCents: 5000 } });
    try {
      await gw.runStructured(runOpts());
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SpendCapError);
      expect((e as SpendCapError).scope).toBe("global");
    }
  });

  it("explicit 0 caps disable enforcement", async () => {
    const usage = new MemoryUsageStore();
    await usage.logUsage({
      userId: "u1",
      provider: "anthropic",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 999999,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const { gw } = makeGateway({
      usage,
      caps: { userDailyCents: 0, globalDailyCents: 0 },
    });
    const res = await gw.runStructured(runOpts());
    expect(res.object.answer).toBe("hi");
  });

  it("saves a judge score when a rubric is provided", async () => {
    const res = await gw.runStructured(
      runOpts({ judgeRubric: () => ({ clarity: 4, brevity: 2 }) }),
    );
    expect(res.usageLogId).toBeDefined();
    expect(usage.judgeScores).toHaveLength(1);
    expect(usage.judgeScores[0]!.overallScore).toBe(3);
  });

  it("throws for an unknown prompt slug", async () => {
    await expect(
      gw.runStructured(runOpts({ slug: "nope", cacheParts: ["x"] })),
    ).rejects.toThrow(/not found/);
  });

  it("throws when mock mode has no responder for the slug", async () => {
    const gw2 = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: PROMPTS,
      mock: true,
    });
    await expect(gw2.runStructured(runOpts())).rejects.toThrow(/no responder/);
  });
});
