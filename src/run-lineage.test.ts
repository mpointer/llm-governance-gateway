// Governed runs: lineage on every ledger row a call writes, the run budget,
// the step ceiling, nesting, and snapshot/resume.
//
// Lineage is stamped in one place (logUsage) from a `lineage` key every
// ledger write must carry, so the compiler enforces coverage of the sites.
// These tests check the other half: that what lands in the ledger is right,
// on each path and for each kind of row (final, cache hit, guardrail block,
// judge, refused step).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { GuardrailError, RunLimitError } from "./errors.js";
import { GovernedRun } from "./run.js";
import { MemoryCacheStore, MemoryUsageStore } from "./adapters/memory.js";
import type { GatewayConfig, ModelConfigStore } from "./types.js";

const OutSchema = z.object({ answer: z.string() });

/** Mock-mode gateway: free calls, good for lineage. */
function mockGw(over: Partial<GatewayConfig> = {}) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    cache: new MemoryCacheStore(),
    promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
    mock: true,
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...over,
  });
  gw.registerMockResponder("sum", () => ({ answer: "ok" }));
  return { gw, usage };
}

const base = {
  slug: "sum",
  input: { t: "hello" },
  variables: (i: { t: string }) => ({ t: i.t }),
  userId: "u1",
  route: "test",
};
const structured = { ...base, schema: OutSchema, cache: false as const };

/** A fake model whose every call reports 1 input and 1 output token. */
function lm(calls: { n: number }): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "priced",
    supportedUrls: {},
    async doGenerate() {
      calls.n++;
      return {
        content: [{ type: "text", text: JSON.stringify({ answer: "a" }) }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

/** Real (non-mock) gateway where every call costs exactly 10 cents. */
function pricedGw(over: Partial<GatewayConfig> = {}) {
  const usage = new MemoryUsageStore();
  const calls = { n: 0 };
  const store: ModelConfigStore = {
    getOverride: async () => null,
    getChain: async () => [
      { provider: "anthropic" as const, model: "priced", languageModel: lm(calls) },
    ],
  };
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
    modelConfig: store,
    // (1 * 5000 + 1 * 5000) / 1000 = 10 cents per call.
    providers: { pricing: { priced: { in: 5000, out: 5000 } } },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...over,
  });
  return { gw, usage, calls };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
describe("lineage on the ledger", () => {
  it("every path stamps runId and an incrementing stepIndex", async () => {
    const { gw, usage } = mockGw();
    gw.registerMockResponder("chat", () => "hi");
    const run = gw.startRun({ id: "run-1" });

    await gw.runStructured({ ...structured, run });
    await gw.runText({ ...base, cache: false, run });
    await (await gw.streamStructured({ ...structured, run })).object;
    await (await gw.streamText({ slug: "chat", messages: [{ role: "user", content: "hi" }], run }))
      .result;
    await gw.embed(["a"], { run, dimensions: 8 });

    expect(usage.entries.map((e) => [e.runId, e.stepIndex])).toEqual([
      ["run-1", 0],
      ["run-1", 1],
      ["run-1", 2],
      ["run-1", 3],
      ["run-1", 4],
    ]);
    expect(usage.entries.every((e) => e.parentRunId === null)).toBe(true);
    expect(run.steps).toBe(5);
  });

  it("a call without a run writes no lineage keys at all", async () => {
    const { gw, usage } = mockGw();
    await gw.runStructured(structured);
    const row = usage.entries[0]!;
    expect("runId" in row).toBe(false);
    expect("stepIndex" in row).toBe(false);
    expect("parentRunId" in row).toBe(false);
  });

  it("a cache hit is a step of the run and its row carries the lineage", async () => {
    const { gw, usage } = mockGw();
    const run = gw.startRun();
    const cached = { ...base, schema: OutSchema, cacheParts: ["k"] };
    await gw.runStructured({ ...cached, run });
    const hit = await gw.runStructured({ ...cached, run });
    expect(hit.cacheHit).toBe(true);
    expect(usage.entries[1]).toMatchObject({ provider: "cache", runId: run.id, stepIndex: 1 });
  });

  it("a guardrail block and the judge row share the judged call's step", async () => {
    const { gw, usage } = mockGw({
      guardrails: {
        pre: (ctx) =>
          ctx.prompt.includes("blockme") ? { action: "block", reason: "no" } : { action: "allow" },
      },
      judge: { random: () => 0 },
    });
    gw.registerMockResponder("judge:sum", () => ({ ok: 4 }));
    const run = gw.startRun();

    await gw.runStructured({ ...structured, run, judge: { criteria: { ok: "ok" } } });
    const err = await gw
      .runStructured({ ...structured, input: { t: "blockme" }, run })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);

    // Step 0: the judge row, then the main row. Step 1: the guardrail block.
    const step0 = usage.entries.filter((e) => e.stepIndex === 0);
    expect(step0.map((e) => e.route).sort()).toEqual(["judge:test", "test"]);
    expect(step0.every((e) => e.runId === run.id)).toBe(true);
    const block = usage.entries.find((e) => e.provider === "guardrail")!;
    expect(block).toMatchObject({ runId: run.id, stepIndex: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("a failed link's row belongs to the same step", () => {
  function streamLm(behaviour: "fail" | "ok"): LanguageModel {
    return {
      specificationVersion: "v2",
      provider: "fake",
      modelId: behaviour,
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not used");
      },
      async doStream() {
        if (behaviour === "fail")
          throw Object.assign(new Error("503 upstream"), { statusCode: 503 });
        const parts = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: JSON.stringify({ answer: "a" }) },
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ];
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const p of parts) controller.enqueue(p);
              controller.close();
            },
          }),
        };
      },
    } as unknown as LanguageModel;
  }

  it("streamStructured failover: the abandoned link and the winner share runId and stepIndex", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "first", languageModel: streamLm("fail") },
          { provider: "openai" as const, model: "second", languageModel: streamLm("ok") },
        ],
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const run = gw.startRun({ id: "r" });
    await gw.runStructured({ ...structured, run }).catch(() => {}); // step 0, outcome irrelevant
    const res = await gw.streamStructured({ ...structured, run });
    await collect(res.partialObjectStream);
    expect(await res.object).toEqual({ answer: "a" });
    expect(res.failovers).toHaveLength(1);

    const step1 = usage.entries.filter((e) => e.stepIndex === 1);
    expect(step1.map((e) => e.model)).toEqual(["first", "second"]);
    expect(step1.every((e) => e.runId === "r")).toBe(true);
    expect(run.steps).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("run budget", () => {
  it("counts spend from the ledger and refuses the call after the budget is spent", async () => {
    const { gw, usage, calls } = pricedGw();
    const run = gw.startRun({ budgetCents: 25 });

    // 10, 20, 30: the third is admitted because 20 < 25 when it is checked.
    for (let i = 0; i < 3; i++) await gw.runStructured({ ...structured, run });
    expect(run.spentCents).toBeCloseTo(30, 10);
    expect(run.remainingCents()).toBeCloseTo(-5, 10);

    const err = await gw.runStructured({ ...structured, run }).catch((e) => e);
    expect(err).toBeInstanceOf(RunLimitError);
    expect(err.limit).toBe("budget");
    expect(err.runId).toBe(run.id);
    expect(err.detail).toMatchObject({ budgetCents: 25, steps: 3 });
    // No provider call, no usage row, no step taken for the refused call.
    expect(calls.n).toBe(3);
    expect(usage.entries).toHaveLength(3);
    expect(run.steps).toBe(3);
    // The refusal is a spend-cap event that names the run.
    expect(usage.capEvents).toEqual([
      expect.objectContaining({
        runId: run.id,
        capCents: 25,
        route: "run:test",
        wouldBlock: true,
        enforced: true,
      }),
    ]);
    // The ledger agrees with the run.
    const ledger = usage.entries.reduce((s, e) => s + e.estimatedCostCents, 0);
    expect(ledger).toBeCloseTo(run.spentCents, 10);
  });

  it("observe mode records the breach and lets the call through", async () => {
    const { gw, usage, calls } = pricedGw({
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0, mode: "observe" },
    });
    const run = gw.startRun({ budgetCents: 10 });
    await gw.runStructured({ ...structured, run });
    await gw.runStructured({ ...structured, run }); // over budget, observed
    expect(calls.n).toBe(2);
    expect(run.steps).toBe(2);
    expect(usage.capEvents).toEqual([
      expect.objectContaining({ runId: run.id, wouldBlock: true, enforced: false }),
    ]);
  });

  it("a run with no budget only groups rows", async () => {
    const { gw } = pricedGw();
    const run = gw.startRun();
    for (let i = 0; i < 5; i++) await gw.runStructured({ ...structured, run });
    expect(run.remainingCents()).toBeUndefined();
    expect(run.spentCents).toBeCloseTo(50, 10);
  });
});

// ---------------------------------------------------------------------------
describe("step ceiling", () => {
  it("refuses the call past maxSteps and leaves a zero-token row", async () => {
    const { gw, usage } = mockGw();
    const run = gw.startRun({ maxSteps: 2 });
    await gw.runStructured({ ...structured, run });
    await gw.runStructured({ ...structured, run });
    const err = await gw.runStructured({ ...structured, run }).catch((e) => e);
    expect(err).toBeInstanceOf(RunLimitError);
    expect(err.limit).toBe("steps");
    expect(err.detail).toMatchObject({ steps: 2, maxSteps: 2 });
    expect(run.steps).toBe(2);
    expect(usage.entries[2]).toMatchObject({
      provider: "run",
      model: "step-limit",
      inputTokens: 0,
      estimatedCostCents: 0,
      runId: run.id,
      stepIndex: 2,
    });
  });

  it("is enforced even in observe mode: it is a loop guard, not a threshold on trial", async () => {
    const { gw } = mockGw({
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0, mode: "observe" },
    });
    const run = gw.startRun({ maxSteps: 1 });
    await gw.runStructured({ ...structured, run });
    await expect(gw.runStructured({ ...structured, run })).rejects.toBeInstanceOf(RunLimitError);
  });
});

// ---------------------------------------------------------------------------
describe("nested runs", () => {
  it("a child's spend counts against the parent, and the parent's budget stops the child", async () => {
    const { gw, usage } = pricedGw();
    const parent = gw.startRun({ id: "parent", budgetCents: 15 });
    const child = gw.startRun({ id: "child", parent });

    await gw.runStructured({ ...structured, run: child }); // 10
    expect(child.spentCents).toBeCloseTo(10, 10);
    expect(parent.spentCents).toBeCloseTo(10, 10);
    expect(child.remainingCents()).toBeCloseTo(5, 10); // the parent's budget
    await gw.runStructured({ ...structured, run: child }); // 20, parent now over

    const err = await gw.runStructured({ ...structured, run: child }).catch((e) => e);
    expect(err).toBeInstanceOf(RunLimitError);
    expect(err.runId).toBe("parent"); // the run that actually ran out
    expect(usage.capEvents[0]).toMatchObject({ runId: "parent" });

    // Child rows say whose child they are; the parent's own steps are its own.
    expect(usage.entries.every((e) => e.runId === "child" && e.parentRunId === "parent")).toBe(
      true,
    );
    expect(parent.steps).toBe(0);
    expect(child.steps).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("snapshot and resume", () => {
  it("a resumed run continues the step count and keeps the budget", async () => {
    const { gw, usage } = pricedGw();
    const run = gw.startRun({ id: "r", budgetCents: 15, maxSteps: 9 });
    await gw.runStructured({ ...structured, run });

    const snap = JSON.parse(JSON.stringify(run.snapshot()));
    expect(snap).toEqual({ runId: "r", budgetCents: 15, maxSteps: 9, spentCents: 10, steps: 1 });

    const resumed = gw.resumeRun(snap);
    await gw.runStructured({ ...structured, run: resumed }); // 20, over
    expect(usage.entries[1]).toMatchObject({ runId: "r", stepIndex: 1 });
    await expect(gw.runStructured({ ...structured, run: resumed })).rejects.toMatchObject({
      limit: "budget",
    });
  });

  it("a child's snapshot keeps the parent id, and resume can re-link the parent", () => {
    const parent = new GovernedRun({ id: "p", budgetCents: 5 });
    const child = new GovernedRun({ id: "c", parent });
    const snap = child.snapshot();
    expect(snap.parentRunId).toBe("p");
    const loose = GovernedRun.fromSnapshot(snap);
    expect(loose.parentRunId).toBe("p");
    expect(loose.remainingCents()).toBeUndefined(); // no live parent to ask
    const linked = GovernedRun.fromSnapshot(snap, { parent });
    expect(linked.remainingCents()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe("GovernedRun validation", () => {
  it("rejects a non-positive budget and a non-integer or zero step ceiling", () => {
    expect(() => new GovernedRun({ budgetCents: 0 })).toThrow(/budgetCents/);
    expect(() => new GovernedRun({ budgetCents: -1 })).toThrow(/budgetCents/);
    expect(() => new GovernedRun({ budgetCents: Number.NaN })).toThrow(/budgetCents/);
    expect(() => new GovernedRun({ maxSteps: 0 })).toThrow(/maxSteps/);
    expect(() => new GovernedRun({ maxSteps: 1.5 })).toThrow(/maxSteps/);
  });

  it("generates an id when none is given", () => {
    expect(new GovernedRun().id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
