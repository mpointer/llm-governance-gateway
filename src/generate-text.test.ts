// generateText: the governed streamText turn for a caller that does not
// stream. It is the same loop, so the first group pins that it ledgers and
// governs exactly as streamText does; the rest pins the two places it differs,
// both of which follow from nobody watching partial text.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { Gateway, type GenerateTextOptions } from "./gateway.js";
import { GuardrailError, RunLimitError } from "./errors.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { GatewayConfig, UsageEntry } from "./types.js";

type Step = { parts: unknown[]; then?: "hang" | Error } | Error;
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
    async doStream(opts: { abortSignal?: AbortSignal }) {
      const step = steps[Math.min(state.calls, steps.length - 1)]!;
      state.calls++;
      if (step instanceof Error) throw step;
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of step.parts) c.enqueue(p);
            // Error on a later tick: c.error() discards chunks still queued.
            if (step.then instanceof Error) {
              const err = step.then;
              setTimeout(() => c.error(err), 0);
            } else if (step.then === "hang") {
              opts.abortSignal?.addEventListener("abort", () => c.error(new Error("aborted")));
            } else c.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
  return { model, state };
}

// Priced at 1 cent per token (below): a tool step costs 5¢, a text step 5¢.
const toolStep = (args: unknown = { q: "x" }): Step => ({
  parts: [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: JSON.stringify(args) },
    { type: "finish", finishReason: "tool-calls", usage: usage(4, 1) },
  ],
});
const textStep = (text = "done"): Step => ({
  parts: [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: usage(3, 2) },
  ],
});
/** Text, then the stream fails without finishing. */
const partial = (text: string, then: "hang" | Error): Step => ({
  parts: [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
  ],
  then,
});
const httpError = (status: number) =>
  Object.assign(new Error(`${status} upstream`), { statusCode: status });

function makeGw(models: LanguageModel[], extra: Partial<GatewayConfig> = {}) {
  const store = new MemoryUsageStore();
  const gw = new Gateway({
    usage: store,
    modelConfig: {
      getOverride: async () => null,
      getChain: async () =>
        models.map((languageModel, i) => ({
          provider: "anthropic" as const,
          model: i === 0 ? "priced" : `priced-${i}`,
          languageModel,
        })),
    },
    providers: {
      pricing: { priced: { in: 1000, out: 1000 }, "priced-1": { in: 1000, out: 1000 } },
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...extra,
  });
  return { gw, store };
}

function lookupTool() {
  const seen: unknown[] = [];
  const lookup = tool({
    inputSchema: z.object({ q: z.string() }),
    execute: async (input) => {
      seen.push(input);
      return { ok: true };
    },
  });
  return { tools: { lookup }, seen };
}

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const base: GenerateTextOptions = {
  slug: "agent",
  messages: [user("go")],
  userId: "u1",
  route: "agent",
  stopWhen: stepCountIs(10),
};

/** A row without what differs between two runs of the same turn. */
const shape = (e: UsageEntry) => {
  const { traceId: _t, createdAt: _c, durationMs: _d, ...rest } = e;
  return rest;
};

// ---------------------------------------------------------------------------
describe("generateText: the same governed turn as streamText", () => {
  it("returns the text, the tool calls and results, usage, and the trace id", async () => {
    const { model } = scriptedModel([toolStep(), textStep("it is sunny")]);
    const { gw, store } = makeGw([model]);
    const { tools, seen } = lookupTool();
    const out = await gw.generateText({ ...base, tools });

    expect(out.text).toBe("it is sunny");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolResults).toHaveLength(1);
    expect(out.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("priced");
    expect(out.failovers).toEqual([]);
    expect(out.traceId).toBe(store.entries[0]!.traceId);
    expect(out).not.toHaveProperty("degraded");
    expect(out).not.toHaveProperty("runStopped");
    expect(seen).toEqual([{ q: "x" }]);
    // No run: one row for the whole turn, as streamText writes.
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      promptSlug: "agent",
    });
  });

  it("writes the rows streamText writes for the same turn, run and tool policy", async () => {
    const config: Partial<GatewayConfig> = { toolPolicy: { lookup: { costCents: 3 } } };
    const ledger = async (how: "stream" | "generate") => {
      const { model } = scriptedModel([toolStep(), toolStep(), textStep()]);
      const { gw, store } = makeGw([model], config);
      const run = gw.startRun({ id: "turn", budgetCents: 500 });
      const opts = { ...base, tools: lookupTool().tools, run };
      if (how === "generate") await gw.generateText(opts);
      else {
        const res = await gw.streamText(opts);
        for await (const _ of res.textStream) {
          // drain
        }
        await res.result;
      }
      return { rows: store.entries.map(shape), spent: run.spentCents };
    };
    const streamed = await ledger("stream");
    const generated = await ledger("generate");
    expect(generated.rows).toEqual(streamed.rows);
    expect(generated.spent).toBe(streamed.spent);
    // Two tool steps and their two tool calls, then the closing row.
    expect(generated.rows.map((r) => r.provider)).toEqual([
      "tool",
      "anthropic",
      "tool",
      "anthropic",
      "anthropic",
    ]);
    expect(generated.spent).toBe(5 + 3 + 5 + 3 + 5);
  });

  it("stops the tool loop when the run's budget is spent, and refuses the run's next call", async () => {
    const { model, state } = scriptedModel([toolStep(), toolStep(), toolStep(), textStep()]);
    const { gw, store } = makeGw([model]);
    const run = gw.startRun({ id: "r", budgetCents: 10 });
    const out = await gw.generateText({ ...base, tools: lookupTool().tools, run });

    expect(out.runStopped).toEqual({ limit: "budget", runId: "r" });
    expect(state.calls).toBe(2); // two 5¢ steps reach the 10¢ budget
    expect(store.capEvents).toHaveLength(1);
    expect(store.capEvents[0]).toMatchObject({ runId: "r", enforced: true });
    await expect(gw.generateText({ ...base, run })).rejects.toThrow(RunLimitError);
  });

  it("hands a tool denial back to the model and reports it", async () => {
    const { model } = scriptedModel([toolStep(), toolStep(), textStep()]);
    const { gw } = makeGw([model], { toolPolicy: { lookup: { maxCalls: 1 } } });
    const { tools, seen } = lookupTool();
    const out = await gw.generateText({ ...base, tools });

    expect(seen).toHaveLength(1);
    expect(out.text).toBe("done");
    expect(out.toolDenials).toHaveLength(1);
    expect(out.toolDenials![0]).toMatchObject({ tool: "lookup", reason: "max-calls" });
  });

  it("runs the guardrail hooks: a pre block before the model, a post block after it", async () => {
    const pre = scriptedModel([textStep()]);
    const blockedBefore = makeGw([pre.model], {
      guardrails: { pre: () => ({ action: "block", reason: "pii" }) },
    });
    await expect(blockedBefore.gw.generateText(base)).rejects.toThrow(GuardrailError);
    expect(pre.state.calls).toBe(0);

    const post = scriptedModel([textStep("secret")]);
    const blockedAfter = makeGw([post.model], {
      guardrails: { post: () => ({ action: "block", reason: "leak" }) },
    });
    const err = await blockedAfter.gw.generateText(base).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.hook).toBe("post");
    expect(blockedAfter.store.entries).toHaveLength(1); // the call was paid for and is ledgered
  });

  it("answers from the mock responder in mock mode", async () => {
    const store = new MemoryUsageStore();
    const gw = new Gateway({ usage: store, mock: true });
    gw.registerMockResponder("agent", () => "stubbed");
    const out = await gw.generateText(base);
    expect(out.text).toBe("stubbed");
    expect(out.provider).toBe("mock");
    expect(store.entries).toHaveLength(1);
  });

  it("names itself in its own errors", async () => {
    const { gw } = makeGw([scriptedModel([textStep()]).model]);
    await expect(
      gw.generateText({ ...base, messages: [{ role: "assistant", content: "hi" }] }),
    ).rejects.toThrow("generateText: messages must end with a user message");
  });
});

// ---------------------------------------------------------------------------
describe("generateText: text nobody saw can be failed over", () => {
  it("a link that fails after producing text is failed over, and its spend is ledgered", async () => {
    const a = scriptedModel([partial("half an ans", httpError(503))]);
    const b = scriptedModel([textStep("whole answer")]);
    const { gw, store } = makeGw([a.model, b.model]);
    const out = await gw.generateText(base);

    expect(out.text).toBe("whole answer"); // none of the first link's text
    expect(out.model).toBe("priced-1");
    expect(out.failovers).toEqual([
      { provider: "anthropic", model: "priced", reason: "retryable", hadPartialOutput: true },
    ]);
    expect(store.entries).toHaveLength(2);
    // The abandoned link's row: estimated tokens, not zero, and its text.
    expect(store.entries[0]).toMatchObject({ model: "priced", outputText: "half an ans" });
    expect(store.entries[0]!.outputTokens).toBeGreaterThan(0);
    expect(store.entries[0]!.estimatedCostCents).toBeGreaterThan(0);
    expect(store.entries[0]!.degraded).toBeUndefined();
  });

  it("the same failure through streamText degrades instead, because the text was shown", async () => {
    const a = scriptedModel([partial("half an ans", httpError(503))]);
    const b = scriptedModel([textStep("whole answer")]);
    const { gw } = makeGw([a.model, b.model]);
    const res = await gw.streamText(base);
    for await (const _ of res.textStream) {
      // drain
    }
    expect((await res.result).degraded).toBe(true);
    expect(b.state.calls).toBe(0);
  });

  it("a non-retryable failure after text rejects, with the spend ledgered", async () => {
    const a = scriptedModel([partial("half", httpError(400))]);
    const b = scriptedModel([textStep()]);
    const { gw, store } = makeGw([a.model, b.model]);
    await expect(gw.generateText(base)).rejects.toThrow(/400/);
    expect(b.state.calls).toBe(0);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.estimatedCostCents).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("generateText: a turn that fails after a tool has run", () => {
  it("rejects with the error, does not fail over, and keeps what it spent in the ledger", async () => {
    const a = scriptedModel([toolStep(), httpError(503)]);
    const b = scriptedModel([textStep("never")]);
    const { gw, store } = makeGw([a.model, b.model], { toolPolicy: { lookup: { costCents: 2 } } });
    const { tools, seen } = lookupTool();
    const run = gw.startRun({ id: "r" });

    await expect(gw.generateText({ ...base, tools, run })).rejects.toThrow(/503/);
    expect(seen).toHaveLength(1); // the tool ran once
    expect(b.state.calls).toBe(0); // and was not run again on another link
    // The tool step, the tool call, and the failed remainder of the turn.
    expect(store.entries.map((e) => e.provider)).toEqual(["tool", "anthropic", "anthropic"]);
    expect(store.entries[2]!.degraded).toBe(true);
    expect(store.entries[2]!.outputText).toBeNull(); // no notice was appended
    expect(run.spentCents).toBeGreaterThanOrEqual(5 + 2);
  });

  it("an abort while a tool runs rejects with the caller's reason", async () => {
    const { model } = scriptedModel([toolStep(), textStep()]);
    const { gw, store } = makeGw([model]);
    const controller = new AbortController();
    const slow = tool({
      inputSchema: z.object({ q: z.string() }),
      execute: async () => {
        controller.abort(new Error("caller gave up"));
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true };
      },
    });
    await expect(
      gw.generateText({ ...base, tools: { lookup: slow }, signal: controller.signal }),
    ).rejects.toThrow("caller gave up");
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.aborted).toBe(true);
  });
});
