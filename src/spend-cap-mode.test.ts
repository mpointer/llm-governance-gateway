// Spend-cap observe mode (issue #8).
//
// The point of these tests is the LEDGER, not the absence of a throw. An
// observe-mode test that only asserts "didn't throw" passes just as well
// against a build that skipped cap evaluation entirely — which is exactly the
// zero-cap workaround this mode exists to replace. So every test here asserts
// the recorded cap event.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { SpendCapError } from "./errors.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { SpendCapEvent, UsageEntry } from "./types.js";

const OutSchema = z.object({ answer: z.string() });

const base = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
};

/** A store already carrying `spentCents` of spend for `userId`. */
async function storeWithSpend(spentCents: number, userId: string | null = "u1") {
  const usage = new MemoryUsageStore();
  await usage.logUsage({
    userId,
    provider: "x",
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostCents: spentCents,
    cacheHit: false,
    traceId: "seed",
    createdAt: new Date(),
  } satisfies UsageEntry);
  return usage;
}

function mockGateway(usage: MemoryUsageStore, caps: object, obs?: object) {
  const gw = new Gateway({
    usage,
    mock: true,
    promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
    caps,
    ...(obs ? { observability: obs } : {}),
  });
  gw.registerMockResponder("q", () => ({ answer: "ok" }));
  return gw;
}

describe("spend cap mode: enforce (default)", () => {
  it("throws and records enforced:true — unchanged from 0.10.0", async () => {
    const usage = await storeWithSpend(300);
    const gw = mockGateway(usage, { userDailyCents: 200, globalDailyCents: 0 });

    await expect(gw.runStructured({ ...base, userId: "u1" })).rejects.toThrow(
      SpendCapError,
    );

    expect(usage.capEvents).toHaveLength(1);
    expect(usage.capEvents[0]!.wouldBlock).toBe(true);
    expect(usage.capEvents[0]!.enforced).toBe(true);
  });

  it("an explicit mode:'enforce' behaves identically to omitting it", async () => {
    const usage = await storeWithSpend(300);
    const gw = mockGateway(usage, {
      userDailyCents: 200,
      globalDailyCents: 0,
      mode: "enforce" as const,
    });
    await expect(gw.runStructured({ ...base, userId: "u1" })).rejects.toThrow(
      SpendCapError,
    );
    expect(usage.capEvents[0]!.enforced).toBe(true);
  });
});

describe("spend cap mode: observe", () => {
  it("does not throw, and the call still produces its result", async () => {
    const usage = await storeWithSpend(300);
    const gw = mockGateway(usage, {
      userDailyCents: 200,
      globalDailyCents: 0,
      mode: "observe" as const,
    });

    const res = await gw.runStructured({ ...base, userId: "u1" });
    expect(res.object).toEqual({ answer: "ok" });
  });

  it("records the breach it declined to enforce", async () => {
    const usage = await storeWithSpend(300);
    const gw = mockGateway(usage, {
      userDailyCents: 200,
      globalDailyCents: 0,
      mode: "observe" as const,
    });

    await gw.runStructured({ ...base, userId: "u1" });

    // The load-bearing assertion: the cap was actually evaluated and the
    // breach written down. Setting the caps to 0 would produce no event at all.
    expect(usage.capEvents).toHaveLength(1);
    const ev = usage.capEvents[0]!;
    expect(ev.wouldBlock).toBe(true);
    expect(ev.enforced).toBe(false);
    expect(ev.capCents).toBe(200);
    expect(ev.spentCents).toBe(300);
    expect(ev.userId).toBe("u1");
  });

  it("zero caps are NOT equivalent: they record nothing", async () => {
    // This is the distinction the issue turns on. Same spend, same overage,
    // but the zero-cap workaround has nothing to show for it afterwards.
    const usage = await storeWithSpend(300);
    const gw = mockGateway(usage, {
      userDailyCents: 0,
      anonDailyCents: 0,
      globalDailyCents: 0,
    });

    await gw.runStructured({ ...base, userId: "u1" });
    expect(usage.capEvents).toHaveLength(0);
  });

  it("evaluates EVERY cap rather than stopping at the first breach", async () => {
    // Global and per-user are both blown. Enforce mode throws at the global
    // one and never evaluates the user cap; observe mode records both.
    const usage = await storeWithSpend(500);
    const gw = mockGateway(usage, {
      userDailyCents: 200,
      globalDailyCents: 400,
      mode: "observe" as const,
    });

    await gw.runStructured({ ...base, userId: "u1" });

    expect(usage.capEvents).toHaveLength(2);
    const routes = usage.capEvents.map((e) => e.route);
    expect(routes).toContain("global");
    expect(routes).toContain(null);
    expect(usage.capEvents.every((e) => e.enforced === false)).toBe(true);
  });

  it("enforce mode stops at the first breach (the contrast case)", async () => {
    const usage = await storeWithSpend(500);
    const gw = mockGateway(usage, {
      userDailyCents: 200,
      globalDailyCents: 400,
    });

    await expect(gw.runStructured({ ...base, userId: "u1" })).rejects.toThrow(
      SpendCapError,
    );
    expect(usage.capEvents).toHaveLength(1);
    expect(usage.capEvents[0]!.route).toBe("global");
  });

  it("under caps, observe mode records nothing — it is not a firehose", async () => {
    const usage = await storeWithSpend(10);
    const gw = mockGateway(usage, {
      userDailyCents: 200,
      globalDailyCents: 0,
      mode: "observe" as const,
    });

    await gw.runStructured({ ...base, userId: "u1" });
    expect(usage.capEvents).toHaveLength(0);
  });

  it("fires onSpendCapEvent so an exporter sees the breach too", async () => {
    const seen: SpendCapEvent[] = [];
    const usage = await storeWithSpend(300);
    const gw = mockGateway(
      usage,
      { userDailyCents: 200, globalDailyCents: 0, mode: "observe" as const },
      { onSpendCapEvent: (e: SpendCapEvent) => void seen.push(e) },
    );

    await gw.runStructured({ ...base, userId: "u1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.enforced).toBe(false);
  });

  it("scopes the recorded breach to the org that blew the cap", async () => {
    const usage = new MemoryUsageStore();
    await usage.logUsage({
      userId: "u1",
      orgId: "orgA",
      provider: "x",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 300,
      cacheHit: false,
      traceId: "seed",
      createdAt: new Date(),
    });
    const gw = mockGateway(usage, {
      userDailyCents: 200,
      globalDailyCents: 0,
      mode: "observe" as const,
    });

    await gw.runStructured({ ...base, userId: "u1", orgId: "orgA" });
    expect(usage.capEvents.at(-1)!.orgId).toBe("orgA");
    expect(usage.capEvents.at(-1)!.enforced).toBe(false);
  });

  it("governs embeddings on the same terms", async () => {
    const usage = await storeWithSpend(300);
    const gw = new Gateway({
      usage,
      mock: true,
      caps: { userDailyCents: 200, globalDailyCents: 0, mode: "observe" },
    });

    // Enforce mode rejects this exact call (see embed-temp.test.ts).
    const res = await gw.embed(["x"], { userId: "u1", dimensions: 8 });
    expect(res.embeddings).toHaveLength(1);
    expect(usage.capEvents).toHaveLength(1);
    expect(usage.capEvents[0]!.enforced).toBe(false);
  });
});
