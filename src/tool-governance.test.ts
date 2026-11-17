// Governed tool calls: ToolPolicy caps and prices, the guardrails.tool hook,
// and a ledger row per tool call. Driven through a real AI SDK tool loop over
// a scripted model, and read back from the ledger.

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { Gateway, type StreamTextOptions } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { GatewayConfig } from "./types.js";

type Step = { parts: unknown[] };
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });

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

let nextId = 0;
/** One model step that calls `lookup` once per entry of `args`. */
const toolStep = (...args: unknown[]): Step => ({
  parts: [
    { type: "stream-start", warnings: [] },
    ...(args.length ? args : [{ q: "x" }]).map((a) => ({
      type: "tool-call",
      toolCallId: `c${nextId++}`,
      toolName: "lookup",
      input: JSON.stringify(a),
    })),
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

/** A `lookup` tool that records what it was run with. */
function lookupTool(impl: (input: { q: string }) => unknown = () => ({ ok: true })) {
  const seen: { q: string }[] = [];
  const lookup = tool({
    inputSchema: z.object({ q: z.string() }),
    execute: async (input) => {
      seen.push(input);
      return impl(input);
    },
  });
  return { tools: { lookup }, seen };
}

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const base: Omit<StreamTextOptions, "tools"> = {
  slug: "agent",
  messages: [user("go")],
  userId: "u1",
  route: "agent",
  stopWhen: stepCountIs(10),
};

async function run(gw: Gateway, opts: StreamTextOptions) {
  const res = await gw.streamText(opts);
  for await (const _ of res.textStream) {
    // consume
  }
  return res.result;
}

const toolRows = (store: MemoryUsageStore) => store.entries.filter((e) => e.provider === "tool");

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("off by default", () => {
  it("with no toolPolicy and no tool hook, tools run and write no rows of their own", async () => {
    const { model } = scriptedModel([toolStep(), textStep()]);
    const { gw, store } = makeGw(model);
    const { tools, seen } = lookupTool();
    const out = await run(gw, { ...base, tools });
    expect(seen).toHaveLength(1);
    expect(out.toolDenials).toBeUndefined();
    expect(toolRows(store)).toHaveLength(0);
    expect(store.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("the tool call's ledger row", () => {
  it("is priced by policy and carries the arguments, the result and the call's lineage", async () => {
    const { model } = scriptedModel([toolStep({ q: "weather" }), textStep()]);
    const { gw, store } = makeGw(model, { toolPolicy: { lookup: { costCents: 3 } } });
    const { tools } = lookupTool(() => ({ temp: 21 }));
    const r = gw.startRun({ id: "r" });
    await run(gw, { ...base, tools, run: r });

    const [row] = toolRows(store);
    expect(row).toMatchObject({
      provider: "tool",
      model: "lookup",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 3,
      promptSlug: "agent",
      runId: "r",
      stepIndex: 0,
    });
    expect(row!.inputText).toBe(JSON.stringify({ q: "weather" }));
    expect(row!.outputText).toBe(JSON.stringify({ temp: 21 }));
    expect(row!.metadata).toMatchObject({ innerStep: 0 });
    expect(typeof row!.metadata?.toolCallId).toBe("string");
    // The tool's price is the run's spend: 5¢ + 5¢ of model steps, 3¢ of tool.
    expect(r.spentCents).toBeCloseTo(13, 10);
    expect(r.snapshot().tools).toEqual({ lookup: { calls: 1, cents: 3 } });
  });

  it("costCents can be a function of the arguments", async () => {
    const { model } = scriptedModel([toolStep({ q: "abcd" }), textStep()]);
    const { gw, store } = makeGw(model, {
      toolPolicy: { lookup: { costCents: (input) => (input as { q: string }).q.length * 2 } },
    });
    await run(gw, { ...base, tools: lookupTool().tools });
    expect(toolRows(store)[0]!.estimatedCostCents).toBe(8);
  });

  it("a tool that throws is still ledgered and charged, and the turn goes on", async () => {
    const { model, state } = scriptedModel([toolStep(), textStep()]);
    const { gw, store } = makeGw(model, { toolPolicy: { lookup: { costCents: 3 } } });
    const { tools } = lookupTool(() => {
      throw new Error("upstream 500");
    });
    const out = await run(gw, { ...base, tools });
    expect(out.text).toBe("done");
    expect(state.calls).toBe(2);
    const [row] = toolRows(store);
    expect(row).toMatchObject({ estimatedCostCents: 3, outputText: null });
    expect(row!.metadata).toMatchObject({ toolError: "upstream 500" });
  });

  it("an async-generator tool stays a generator and its last value is ledgered", async () => {
    const { model } = scriptedModel([toolStep(), textStep()]);
    const { gw, store } = makeGw(model, { toolPolicy: { lookup: {} } });
    const tools = {
      lookup: tool({
        inputSchema: z.object({ q: z.string() }),
        async *execute() {
          yield { progress: 0.5 };
          yield { final: true };
        },
      }),
    };
    const out = await run(gw, { ...base, tools });
    expect(out.text).toBe("done");
    expect(toolRows(store)[0]!.outputText).toBe(JSON.stringify({ final: true }));
  });
});

// ---------------------------------------------------------------------------
describe("ToolPolicy caps", () => {
  it("maxCalls: the call past the limit is not run, is ledgered as denied, and the loop goes on", async () => {
    const { model, state } = scriptedModel([toolStep(), toolStep(), toolStep(), textStep()]);
    const { gw, store } = makeGw(model, { toolPolicy: { lookup: { costCents: 1, maxCalls: 2 } } });
    const { tools, seen } = lookupTool();
    const out = await run(gw, { ...base, tools });

    expect(seen).toHaveLength(2);
    expect(state.calls).toBe(4); // the model was told and answered
    expect(out.text).toBe("done");
    expect(out.toolDenials).toEqual([
      expect.objectContaining({ tool: "lookup", reason: "max-calls" }),
    ]);
    const rows = toolRows(store);
    expect(rows.map((r) => r.estimatedCostCents)).toEqual([1, 1, 0]);
    expect(rows[2]!.metadata).toMatchObject({ toolDenied: "max-calls", innerStep: 2 });
    expect(rows[2]!.outputText).toBeNull();
  });

  it("maxCents: denied when the call would take the tool past its spend limit", async () => {
    const { model } = scriptedModel([toolStep(), toolStep(), textStep()]);
    const { gw, store } = makeGw(model, { toolPolicy: { lookup: { costCents: 3, maxCents: 5 } } });
    const { tools, seen } = lookupTool();
    const out = await run(gw, { ...base, tools });
    expect(seen).toHaveLength(1);
    expect(out.toolDenials?.[0]).toMatchObject({ reason: "max-cents" });
    expect(toolRows(store)[1]!.metadata).toMatchObject({ toolDenied: "max-cents" });
  });

  it("two calls in one step cannot both pass a limit with room for one", async () => {
    const { model } = scriptedModel([toolStep({ q: "a" }, { q: "b" }), textStep()]);
    const { gw } = makeGw(model, { toolPolicy: { lookup: { maxCalls: 1 } } });
    const { tools, seen } = lookupTool();
    const out = await run(gw, { ...base, tools });
    expect(seen).toHaveLength(1);
    expect(out.toolDenials).toHaveLength(1);
  });

  it("limits are per run when the call carries one, and per call when it does not", async () => {
    const policy = { toolPolicy: { lookup: { maxCalls: 1 } } };
    {
      const { model } = scriptedModel([toolStep(), textStep(), toolStep(), textStep()]);
      const { gw } = makeGw(model, policy);
      const { tools, seen } = lookupTool();
      const r = gw.startRun();
      await run(gw, { ...base, tools, run: r });
      const second = await run(gw, { ...base, tools, run: r });
      expect(seen).toHaveLength(1);
      expect(second.toolDenials?.[0]).toMatchObject({ reason: "max-calls" });
    }
    {
      const { model } = scriptedModel([toolStep(), textStep(), toolStep(), textStep()]);
      const { gw } = makeGw(model, policy);
      const { tools, seen } = lookupTool();
      await run(gw, { ...base, tools });
      const second = await run(gw, { ...base, tools });
      expect(seen).toHaveLength(2);
      expect(second.toolDenials).toBeUndefined();
    }
  });

  it("run-budget: a priced tool the run cannot afford is not run", async () => {
    const { model } = scriptedModel([toolStep(), textStep()]);
    const { gw, store } = makeGw(model, { toolPolicy: { lookup: { costCents: 50 } } });
    const { tools, seen } = lookupTool();
    const out = await run(gw, { ...base, tools, run: gw.startRun({ budgetCents: 20 }) });
    expect(seen).toHaveLength(0);
    expect(out.toolDenials?.[0]).toMatchObject({ reason: "run-budget" });
    expect(toolRows(store)[0]).toMatchObject({ estimatedCostCents: 0 });
  });

  it("a tool's price counts toward the in-loop budget stop", async () => {
    // Budget 8¢: the first model step is 5¢ and its tool call 3¢, so the run
    // is at its budget after one inner step and the loop stops there.
    const { model, state } = scriptedModel([toolStep()]);
    const { gw } = makeGw(model, { toolPolicy: { lookup: { costCents: 3 } } });
    const r = gw.startRun({ budgetCents: 8 });
    const out = await run(gw, { ...base, tools: lookupTool().tools, run: r });
    expect(state.calls).toBe(1);
    expect(out.runStopped).toMatchObject({ limit: "budget" });
    expect(r.spentCents).toBeCloseTo(8, 10);
  });

  it("observe mode runs the tool and records that a cap would have denied it", async () => {
    const { model } = scriptedModel([toolStep(), toolStep(), textStep()]);
    const { gw, store } = makeGw(model, {
      toolPolicy: { lookup: { maxCalls: 1 } },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0, mode: "observe" },
    });
    const { tools, seen } = lookupTool();
    const out = await run(gw, { ...base, tools });
    expect(seen).toHaveLength(2);
    expect(out.toolDenials).toBeUndefined();
    expect(toolRows(store)[1]!.metadata).toMatchObject({ toolWouldDeny: "max-calls" });
  });
});

// ---------------------------------------------------------------------------
describe("guardrails.tool", () => {
  it("block: the tool is not run, the verdict is on its row, and its reservation is released", async () => {
    const { model, state } = scriptedModel([
      toolStep({ q: "drop table" }),
      toolStep({ q: "ok" }),
      textStep(),
    ]);
    const { gw, store } = makeGw(model, {
      toolPolicy: { lookup: { maxCalls: 1 } },
      guardrails: {
        tool: (ctx) =>
          (ctx.input as { q: string }).q.includes("drop")
            ? { action: "block", reason: "destructive query" }
            : { action: "allow" },
      },
    });
    const { tools, seen } = lookupTool();
    const out = await run(gw, { ...base, tools });

    // The blocked call did not use up the one call the policy allows.
    expect(seen).toEqual([{ q: "ok" }]);
    expect(state.calls).toBe(3);
    expect(out.toolDenials).toEqual([
      expect.objectContaining({ reason: "guardrail", detail: "destructive query" }),
    ]);
    const [blocked, allowed] = toolRows(store);
    expect(blocked!.metadata).toMatchObject({ toolDenied: "guardrail" });
    expect(blocked!.guardrails).toEqual([
      expect.objectContaining({ hook: "tool", action: "block", reason: "destructive query" }),
    ]);
    expect(allowed!.guardrails).toEqual([
      expect.objectContaining({ hook: "tool", action: "allow" }),
    ]);
  });

  it("sees the tool, the arguments, the identity and the run", async () => {
    let seenCtx: unknown;
    const { model } = scriptedModel([toolStep({ q: "x" }), textStep()]);
    const { gw } = makeGw(model, {
      guardrails: {
        tool: (ctx) => {
          seenCtx = ctx;
          return { action: "allow" };
        },
      },
    });
    await run(gw, { ...base, tools: lookupTool().tools, run: gw.startRun({ id: "r" }) });
    expect(seenCtx).toMatchObject({
      slug: "agent",
      tool: "lookup",
      input: { q: "x" },
      userId: "u1",
      route: "agent",
      runId: "r",
    });
  });

  it("transform: the tool runs with the rewritten arguments, and they are what is ledgered", async () => {
    const { model } = scriptedModel([toolStep({ q: "ssn 123-45-6789" }), textStep()]);
    const { gw, store } = makeGw(model, {
      guardrails: { tool: () => ({ action: "transform", input: { q: "ssn [redacted]" } }) },
    });
    const { tools, seen } = lookupTool();
    await run(gw, { ...base, tools });
    expect(seen).toEqual([{ q: "ssn [redacted]" }]);
    expect(toolRows(store)[0]!.inputText).toBe(JSON.stringify({ q: "ssn [redacted]" }));
  });

  it("a transform the tool's schema rejects is a denial, or under failOpen the original call", async () => {
    const bad = { tool: () => ({ action: "transform" as const, input: { q: 42 } }) };
    {
      const { model } = scriptedModel([toolStep({ q: "x" }), textStep()]);
      const { gw } = makeGw(model, { guardrails: bad });
      const { tools, seen } = lookupTool();
      const out = await run(gw, { ...base, tools });
      expect(seen).toHaveLength(0);
      expect(out.toolDenials?.[0]).toMatchObject({ reason: "guardrail" });
    }
    {
      const { model } = scriptedModel([toolStep({ q: "x" }), textStep()]);
      const { gw, store } = makeGw(model, { guardrails: { ...bad, failOpen: true } });
      const { tools, seen } = lookupTool();
      await run(gw, { ...base, tools });
      expect(seen).toEqual([{ q: "x" }]);
      expect(toolRows(store)[0]!.guardrails?.[0]).toMatchObject({
        action: "allow",
        failOpen: true,
      });
    }
  });

  it("a throwing hook denies the call by default and lets it through under failOpen", async () => {
    const boom = {
      tool: () => {
        throw new Error("classifier down");
      },
    };
    {
      const { model } = scriptedModel([toolStep(), textStep()]);
      const { gw } = makeGw(model, { guardrails: boom });
      const { tools, seen } = lookupTool();
      await run(gw, { ...base, tools });
      expect(seen).toHaveLength(0);
    }
    {
      const { model } = scriptedModel([toolStep(), textStep()]);
      const { gw, store } = makeGw(model, { guardrails: { ...boom, failOpen: true } });
      const { tools, seen } = lookupTool();
      await run(gw, { ...base, tools });
      expect(seen).toHaveLength(1);
      expect(toolRows(store)[0]!.guardrails?.[0]).toMatchObject({ error: "classifier down" });
    }
  });
});

// ---------------------------------------------------------------------------
describe("unpriced tools", () => {
  it("a tool the policy does not name runs at 0¢ and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { model } = scriptedModel([toolStep(), toolStep(), textStep()]);
    const { gw, store } = makeGw(model, { toolPolicy: {} });
    const { tools, seen } = lookupTool();
    await run(gw, { ...base, tools });
    expect(seen).toHaveLength(2);
    expect(toolRows(store).map((r) => r.estimatedCostCents)).toEqual([0, 0]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("no ToolPolicy"))).toHaveLength(1);
  });

  it("preflightTools throws for a tool with no policy and passes otherwise", () => {
    const { model } = scriptedModel([textStep()]);
    const { gw } = makeGw(model, { toolPolicy: { lookup: {} } });
    expect(() => gw.preflightTools(["lookup"])).not.toThrow();
    expect(() => gw.preflightTools({ lookup: {}, search: {} })).toThrow(
      /no ToolPolicy for: search/,
    );
  });
});
