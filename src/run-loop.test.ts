// Run governance INSIDE a streamText tool loop: the budget stop composed into
// the caller's stopWhen, and one ledger row per completed tool step.
//
// The front door checks a run's budget before a call. A tool loop can spend
// many times that inside one call, so these tests drive a real AI SDK loop
// over a scripted model and read the result back from the ledger.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { Gateway, type StreamTextOptions } from "./gateway.js";
import { RunLimitError } from "./errors.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { GatewayConfig } from "./types.js";

type Step = { parts: unknown[] };
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });

/** A fake V2 model whose Nth doStream call plays steps[N]. */
function scriptedModel(steps: Step[]) {
  const state = { calls: 0 };
  const model = {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "priced",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not used");
    },
    async doStream() {
      const step = steps[Math.min(state.calls, steps.length - 1)]!;
      state.calls++;
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of step.parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
  return { model, state };
}

// Priced at 1 cent per token (below), so a tool step costs 5¢ and a text step 5¢.
const toolStep = (): Step => ({
  parts: [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
    { type: "finish", finishReason: "tool-calls", usage: usage(4, 1) },
  ],
});
const textStep = (text: string): Step => ({
  parts: [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: usage(3, 2) },
  ],
});

function makeGw(model: LanguageModel, extra: Partial<GatewayConfig> = {}) {
  const store = new MemoryUsageStore();
  const gw = new Gateway({
    usage: store,
    modelConfig: {
      getOverride: async () => null,
      getChain: async () => [
        { provider: "anthropic" as const, model: "priced", languageModel: model },
      ],
    },
    providers: { pricing: { priced: { in: 1000, out: 1000 } } }, // 1¢ per token
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...extra,
  });
  return { gw, store };
}

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const tools = {
  lookup: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
};
const base: StreamTextOptions = {
  slug: "agent",
  messages: [user("go")],
  userId: "u1",
  route: "agent",
  tools,
  stopWhen: stepCountIs(10),
};

async function drain(res: { textStream: AsyncIterable<string> }) {
  for await (const _ of res.textStream) {
    // consume
  }
}

// ---------------------------------------------------------------------------
describe("per-step ledger rows", () => {
  it("a tool step is ledgered on its own and the closing row carries the rest", async () => {
    const { model } = scriptedModel([toolStep(), textStep("done")]);
    const { gw, store } = makeGw(model);
    const run = gw.startRun({ id: "r" });
    const res = await gw.streamText({ ...base, run });
    await drain(res);
    const out = await res.result;

    expect(out.text).toBe("done");
    expect(out.runStopped).toBeUndefined();
    expect(store.entries).toHaveLength(2);
    const [step, closing] = store.entries;
    expect(step).toMatchObject({ inputTokens: 4, outputTokens: 1, runId: "r", stepIndex: 0 });
    expect(step!.metadata).toMatchObject({ innerStep: 0, toolCalls: 1 });
    expect(closing).toMatchObject({ inputTokens: 3, outputTokens: 2, runId: "r", stepIndex: 0 });
    expect(closing!.metadata).toMatchObject({ innerSteps: 2, toolCalls: 0 });
    expect(closing!.outputText).toBe("done");

    // Every quantity is ledgered exactly once.
    const sum = (k: "inputTokens" | "outputTokens") => store.entries.reduce((s, e) => s + e[k], 0);
    expect(sum("inputTokens")).toBe(out.usage.inputTokens);
    expect(sum("outputTokens")).toBe(out.usage.outputTokens);
    expect(run.spentCents).toBeCloseTo(10, 10);
    expect(run.steps).toBe(1); // one governed call, however many inner steps
  });

  it("without a run the turn is still exactly one row", async () => {
    const { model } = scriptedModel([toolStep(), textStep("done")]);
    const { gw, store } = makeGw(model);
    const res = await gw.streamText(base);
    await drain(res);
    await res.result;
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(store.entries[0]!.metadata).toEqual({ toolCalls: 1 });
  });

  it("a run call with no tool step writes one row with no inner-step keys", async () => {
    const { model } = scriptedModel([textStep("hi")]);
    const { gw, store } = makeGw(model);
    const res = await gw.streamText({ ...base, run: gw.startRun() });
    await drain(res);
    await res.result;
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.metadata).toEqual({ toolCalls: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("budget stop inside the loop", () => {
  it("stops the loop after the step that spends the budget", async () => {
    // The model would call the tool forever. Budget 8¢, 5¢ per step:
    // step 0 leaves 3¢ (continue), step 1 puts the run at 10¢ (stop).
    const { model, state } = scriptedModel([toolStep()]);
    const { gw, store } = makeGw(model);
    const run = gw.startRun({ id: "r", budgetCents: 8 });
    const res = await gw.streamText({ ...base, run });
    await drain(res);
    const out = await res.result;

    expect(state.calls).toBe(2);
    expect(out.runStopped).toEqual({ limit: "budget", runId: "r" });
    expect(out.toolResults).toHaveLength(2);
    expect(run.spentCents).toBeCloseTo(10, 10);

    // Two tool-step rows, then a zero-token closing row.
    expect(store.entries.map((e) => [e.inputTokens, e.outputTokens])).toEqual([
      [4, 1],
      [4, 1],
      [0, 0],
    ]);
    expect(store.entries.map((e) => e.metadata?.innerStep)).toEqual([0, 1, undefined]);
    expect(store.entries[2]!.metadata).toMatchObject({ innerSteps: 2, toolCalls: 0 });

    // Recorded like the front door's breach, and the next call is refused.
    expect(store.capEvents).toEqual([
      expect.objectContaining({
        runId: "r",
        capCents: 8,
        spentCents: 10,
        route: "run:agent",
        wouldBlock: true,
        enforced: true,
      }),
    ]);
    await expect(gw.streamText({ ...base, run })).rejects.toBeInstanceOf(RunLimitError);
  });

  it("counts what the run had spent before the turn", async () => {
    const { model, state } = scriptedModel([toolStep()]);
    const { gw } = makeGw(model);
    const run = gw.startRun({ budgetCents: 18 });
    run.record(9); // earlier steps of the run
    const res = await gw.streamText({ ...base, run });
    await drain(res);
    // 9 + 5 = 14 (continue), 9 + 10 = 19 >= 18 (stop).
    expect((await res.result).runStopped).toBeDefined();
    expect(state.calls).toBe(2);
  });

  it("a parent's budget stops a child's loop and is the run named", async () => {
    const { model, state } = scriptedModel([toolStep()]);
    const { gw, store } = makeGw(model);
    const parent = gw.startRun({ id: "parent", budgetCents: 8 });
    const child = gw.startRun({ id: "child", parent });
    const res = await gw.streamText({ ...base, run: child });
    await drain(res);
    const out = await res.result;
    expect(state.calls).toBe(2);
    expect(out.runStopped).toEqual({ limit: "budget", runId: "parent" });
    expect(store.capEvents[0]).toMatchObject({ runId: "parent" });
    expect(parent.spentCents).toBeCloseTo(10, 10);
  });

  it("a turn that finishes inside the budget is not marked stopped", async () => {
    const { model } = scriptedModel([toolStep(), textStep("done")]);
    const { gw, store } = makeGw(model);
    const res = await gw.streamText({ ...base, run: gw.startRun({ budgetCents: 100 }) });
    await drain(res);
    expect((await res.result).runStopped).toBeUndefined();
    expect(store.capEvents).toHaveLength(0);
  });

  it("observe mode records the breach and lets the loop run on", async () => {
    const { model, state } = scriptedModel([toolStep(), toolStep(), toolStep(), textStep("done")]);
    const { gw, store } = makeGw(model, {
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0, mode: "observe" },
    });
    const run = gw.startRun({ id: "r", budgetCents: 8 });
    const res = await gw.streamText({ ...base, run });
    await drain(res);
    const out = await res.result;
    expect(state.calls).toBe(4);
    expect(out.text).toBe("done");
    expect(out.runStopped).toBeUndefined();
    expect(store.capEvents).toEqual([
      expect.objectContaining({ runId: "r", wouldBlock: true, enforced: false }),
    ]);
  });

  it("the caller's own stop condition still applies", async () => {
    const { model, state } = scriptedModel([toolStep()]);
    const { gw } = makeGw(model);
    const run = gw.startRun({ budgetCents: 1000 });
    const res = await gw.streamText({ ...base, stopWhen: stepCountIs(3), run });
    await drain(res);
    expect((await res.result).runStopped).toBeUndefined();
    expect(state.calls).toBe(3);
  });

  it("with no stopWhen the loop is one step and nothing is added", async () => {
    const { model, state } = scriptedModel([toolStep()]);
    const { gw } = makeGw(model);
    const { stopWhen: _omit, ...single } = base;
    const res = await gw.streamText({ ...single, run: gw.startRun({ budgetCents: 1 }) });
    await drain(res);
    expect((await res.result).runStopped).toBeUndefined();
    expect(state.calls).toBe(1);
  });
});
