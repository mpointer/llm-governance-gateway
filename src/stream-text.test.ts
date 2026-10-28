// Governed streamText with tool calling (#14, Scout half). See
// docs/design/streaming-text.md for the failure contract these tests pin.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { DEFAULT_DEGRADED_NOTICE, Gateway, type StreamTextOptions } from "./gateway.js";
import { GuardrailError, RateLimitError } from "./errors.js";
import { MemoryRateLimiter, MemoryUsageStore } from "./adapters/memory.js";
import type { GatewayConfig } from "./types.js";

type Step = { parts: unknown[]; then?: "hang" | Error } | "hang" | Error;

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });

/** A fake V2 model whose Nth doStream call plays steps[N]. */
function scriptedModel(steps: Step[], id = "fake-model") {
  const state = { calls: 0, prompts: [] as unknown[] };
  const model = {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not used");
    },
    async doStream(opts: { prompt: unknown; abortSignal?: AbortSignal }) {
      const step = steps[Math.min(state.calls, steps.length - 1)]!;
      state.calls++;
      state.prompts.push(opts.prompt);
      if (step instanceof Error) throw step;
      if (step === "hang") {
        return {
          stream: new ReadableStream({
            start(c) {
              opts.abortSignal?.addEventListener("abort", () => c.error(new Error("aborted")));
            },
          }),
        };
      }
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of step.parts) c.enqueue(p);
            // Error on a later tick: c.error() discards chunks still queued.
            if (step.then instanceof Error) {
              const err = step.then;
              setTimeout(() => c.error(err), 0);
            } else if (step.then === "hang")
              opts.abortSignal?.addEventListener("abort", () => c.error(new Error("aborted")));
            else c.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
  return { model, state };
}

function textStep(deltas: string[], u = usage(3, 2)): Step {
  return {
    parts: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      ...deltas.map((delta) => ({ type: "text-delta", id: "t", delta })),
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: u },
    ],
  };
}

function toolStep(name: string, args: unknown, u = usage(4, 1)): Step {
  return {
    parts: [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(args) },
      { type: "finish", finishReason: "tool-calls", usage: u },
    ],
  };
}

function makeGw(
  links: { model: LanguageModel; model_id?: string }[],
  extra: Partial<GatewayConfig> = {},
) {
  const store = new MemoryUsageStore();
  const gw = new Gateway({
    usage: store,
    modelConfig: {
      getOverride: async () => null,
      getChain: async () =>
        links.map((l, i) => ({
          provider: "anthropic" as const,
          model: l.model_id ?? `link-${i}`,
          languageModel: l.model,
        })),
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...extra,
  });
  return { gw, store };
}

const user = (text: string): ModelMessage => ({ role: "user", content: text });

const base: StreamTextOptions = {
  slug: "scout-chat-user",
  system: "You are Scout.",
  messages: [user("hi")],
  userId: "u1",
  route: "scout-chat",
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("streamText: happy path", () => {
  it("streams deltas and resolves result after the ledger row", async () => {
    const { model } = scriptedModel([textStep(["Hel", "lo"])]);
    const { gw, store } = makeGw([{ model }]);
    const res = await gw.streamText(base);
    expect(await collect(res.textStream)).toEqual(["Hel", "lo"]);
    const out = await res.result;
    expect(out.text).toBe("Hello");
    expect(out.degraded).toBe(false);
    expect(out.failovers).toEqual([]);
    expect(store.entries).toHaveLength(1);
    const row = store.entries[0]!;
    expect(row.promptSlug).toBe("scout-chat-user");
    expect(row.route).toBe("scout-chat");
    expect(row.outputTokens).toBeGreaterThan(0);
    expect(row.cacheHit).toBe(false);
    expect(row.degraded ?? false).toBe(false);
  });

  it("runs a tool step and totals usage across steps", async () => {
    const { model } = scriptedModel([toolStep("lookup", { q: "x" }), textStep(["done"])]);
    const { gw, store } = makeGw([{ model }]);
    let executed = 0;
    const res = await gw.streamText({
      ...base,
      tools: {
        lookup: tool({
          inputSchema: z.object({ q: z.string() }),
          execute: async () => {
            executed++;
            return { ok: true };
          },
        }),
      },
      stopWhen: stepCountIs(4),
    });
    await collect(res.textStream);
    const out = await res.result;
    expect(out.text).toBe("done");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolResults).toHaveLength(1);
    expect(executed).toBe(1);
    const row = store.entries[0]!;
    expect(row.inputTokens).toBe(4 + 3);
    expect(row.outputTokens).toBe(1 + 2);
    expect(row.metadata?.toolCalls).toBe(1);
  });

  it("never caches", async () => {
    const { model, state } = scriptedModel([textStep(["a"])]);
    const { gw } = makeGw([{ model }]);
    await (await gw.streamText(base)).result;
    await (await gw.streamText(base)).result;
    expect(state.calls).toBe(2);
  });

  it("rate limit runs before the stream opens", async () => {
    const { model, state } = scriptedModel([textStep(["a"])]);
    const { gw } = makeGw([{ model }], { rateLimiter: new MemoryRateLimiter(1) });
    await (await gw.streamText(base)).result;
    await expect(gw.streamText(base)).rejects.toBeInstanceOf(RateLimitError);
    expect(state.calls).toBe(1);
  });

  it("rejects a turn that does not end with a user message", async () => {
    const { model, state } = scriptedModel([textStep(["a"])]);
    const { gw } = makeGw([{ model }]);
    await expect(gw.streamText({ ...base, messages: [] })).rejects.toThrow(
      /messages must end with a user message/,
    );
    await expect(
      gw.streamText({ ...base, messages: [user("q"), { role: "assistant", content: "a" }] }),
    ).rejects.toThrow(/messages must end with a user message/);
    expect(state.calls).toBe(0);
  });

  it("passes {{placeholder}} text in the user message through unchanged", async () => {
    const { model, state } = scriptedModel([textStep(["a"])]);
    const { gw } = makeGw([{ model }]);
    await (await gw.streamText({ ...base, messages: [user("hi {{name}}")] })).result;
    expect(JSON.stringify(state.prompts[0])).toContain("hi {{name}}");
  });

  it("resolves result with full text when the consumer never iterates", async () => {
    const { model } = scriptedModel([textStep(["a", "b", "c"])]);
    const { gw } = makeGw([{ model }]);
    const out = await (await gw.streamText(base)).result;
    expect(out.text).toBe("abc");
  });

  it("mock mode streams the responder's text once", async () => {
    const { gw } = makeGw([], { mock: true });
    gw.registerMockResponder("scout-chat-user", () => "mocked");
    const res = await gw.streamText(base);
    expect(await collect(res.textStream)).toEqual(["mocked"]);
    expect((await res.result).text).toBe("mocked");
  });
});

const httpError = (status: number) =>
  Object.assign(new Error(`${status} upstream`), { statusCode: status });

describe("streamText: failover before the point of no return", () => {
  it("fails over on a first-chunk stall", async () => {
    const a = scriptedModel(["hang"]);
    const b = scriptedModel([textStep(["ok"])]);
    const { gw, store } = makeGw([{ model: a.model }, { model: b.model }]);
    const res = await gw.streamText({ ...base, streamFirstChunkMs: 50 });
    const out = await res.result;
    expect(out.text).toBe("ok");
    expect(out.failovers).toEqual([
      { provider: "anthropic", model: "link-0", reason: "stall", hadPartialOutput: false },
    ]);
    expect(store.entries).toHaveLength(2);
    expect(store.entries[0]!.outputTokens).toBe(0);
    expect(store.entries[0]!.model).toBe("link-0");
  });

  it("fails over on a retryable error before any part", async () => {
    const a = scriptedModel([httpError(503)]);
    const b = scriptedModel([textStep(["ok"])]);
    const { gw } = makeGw([{ model: a.model }, { model: b.model }]);
    const out = await (await gw.streamText(base)).result;
    expect(out.text).toBe("ok");
    expect(out.failovers[0]!.reason).toBe("retryable");
  });

  it("a non-retryable error does not fail over", async () => {
    const a = scriptedModel([httpError(400)]);
    const b = scriptedModel([textStep(["ok"])]);
    const { gw } = makeGw([{ model: a.model }, { model: b.model }]);
    const res = await gw.streamText(base);
    await expect(collect(res.textStream)).rejects.toThrow(/400/);
    await expect(res.result).rejects.toThrow(/400/);
    expect(b.state.calls).toBe(0);
  });

  it("an exhausted chain rejects with the last link's error", async () => {
    const a = scriptedModel([httpError(503)]);
    const b = scriptedModel([httpError(502)]);
    const { gw } = makeGw([{ model: a.model }, { model: b.model }]);
    await expect((await gw.streamText(base)).result).rejects.toThrow(/502/);
  });

  it("requireZdr filters links", async () => {
    const a = scriptedModel([textStep(["a"])]);
    const b = scriptedModel([textStep(["b"])]);
    const { gw } = makeGw([{ model: a.model }, { model: b.model }], {
      providers: { retention: { "anthropic:link-1": { zdr: true } } },
    });
    const out = await (await gw.streamText({ ...base, requireZdr: true })).result;
    expect(out.text).toBe("b");
    expect(a.state.calls).toBe(0);
  });
});

/** Text deltas with no finish, then `then`. */
const partial = (deltas: string[], then: "hang" | Error): Step => ({
  parts: [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    ...deltas.map((delta) => ({ type: "text-delta", id: "t", delta })),
  ],
  then,
});

describe("streamText: degrade after the point of no return", () => {
  it("a stall after text degrades with the default notice", async () => {
    const a = scriptedModel([partial(["Part"], "hang")]);
    const b = scriptedModel([textStep(["never"])]);
    const { gw, store } = makeGw([{ model: a.model }, { model: b.model }]);
    const res = await gw.streamText({ ...base, streamStallMs: 50 });
    expect(await collect(res.textStream)).toEqual(["Part", "\n\n" + DEFAULT_DEGRADED_NOTICE]);
    const out = await res.result;
    expect(out.degraded).toBe(true);
    expect(out.text).toBe("Part\n\n" + DEFAULT_DEGRADED_NOTICE);
    expect(b.state.calls).toBe(0);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.degraded).toBe(true);
    expect(store.entries[0]!.estimatedCostCents).toBeGreaterThan(0);
  });

  it.each([503, 400])("an error (%i) after text degrades without failover", async (status) => {
    const a = scriptedModel([partial(["Part"], httpError(status))]);
    const b = scriptedModel([textStep(["never"])]);
    const { gw } = makeGw([{ model: a.model }, { model: b.model }]);
    const res = await gw.streamText(base);
    expect(await collect(res.textStream)).toEqual(["Part", "\n\n" + DEFAULT_DEGRADED_NOTICE]);
    expect((await res.result).degraded).toBe(true);
    expect(b.state.calls).toBe(0);
  });

  it("degradedNotice overrides the default", async () => {
    const a = scriptedModel([partial(["Part"], httpError(503))]);
    const { gw } = makeGw([{ model: a.model }]);
    const res = await gw.streamText({ ...base, degradedNotice: "Oops." });
    expect(await collect(res.textStream)).toEqual(["Part", "\n\nOops."]);
  });

  it("a failure after a tool call but before text degrades to notice-only", async () => {
    const a = scriptedModel([toolStep("lookup", { q: "x" }), httpError(503)]);
    const b = scriptedModel([textStep(["never"])]);
    const { gw } = makeGw([{ model: a.model }, { model: b.model }]);
    let executed = 0;
    const res = await gw.streamText({
      ...base,
      tools: {
        lookup: tool({
          inputSchema: z.object({ q: z.string() }),
          execute: async () => {
            executed++;
            return { ok: true };
          },
        }),
      },
      stopWhen: stepCountIs(4),
    });
    expect(await collect(res.textStream)).toEqual([DEFAULT_DEGRADED_NOTICE]);
    expect((await res.result).degraded).toBe(true);
    expect(executed).toBe(1);
    expect(b.state.calls).toBe(0);
  });

  it("a slow tool between text steps does not trip the stall clock", async () => {
    const step1: Step = {
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "a" },
        { type: "text-end", id: "t" },
        { type: "tool-call", toolCallId: "c1", toolName: "slow", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: usage(1, 1) },
      ],
    };
    const a = scriptedModel([step1, textStep(["b"])]);
    const { gw } = makeGw([{ model: a.model }]);
    const res = await gw.streamText({
      ...base,
      streamStallMs: 50,
      tools: {
        slow: tool({
          inputSchema: z.object({}),
          execute: async () => {
            await new Promise((r) => setTimeout(r, 200));
            return { ok: true };
          },
        }),
      },
      stopWhen: stepCountIs(4),
    });
    const out = await res.result;
    expect(out.degraded).toBe(false);
    expect(out.text).toBe("ab");
  });
});

describe("streamText: caller abort", () => {
  it("abort after text: no notice, rejects with the caller's reason, one estimated row", async () => {
    const a = scriptedModel([partial(["Part"], "hang")]);
    const { gw, store } = makeGw([{ model: a.model }]);
    const ctl = new AbortController();
    const res = await gw.streamText({ ...base, signal: ctl.signal });
    const seen: string[] = [];
    const reading = (async () => {
      for await (const d of res.textStream) {
        seen.push(d);
        ctl.abort(new Error("client went away"));
      }
    })();
    await expect(res.result).rejects.toThrow("client went away");
    await reading.catch(() => {});
    expect(seen).toEqual(["Part"]);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.outputTokens).toBeGreaterThan(0);
    expect(store.entries[0]!.degraded ?? false).toBe(false);
  });

  it("abort before any part: rejects, one zero-token row, no failover", async () => {
    const a = scriptedModel(["hang"]);
    const b = scriptedModel([textStep(["never"])]);
    const { gw, store } = makeGw([{ model: a.model }, { model: b.model }]);
    const ctl = new AbortController();
    const res = await gw.streamText({ ...base, signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error("stop")), 10);
    await expect(res.result).rejects.toThrow("stop");
    expect(b.state.calls).toBe(0);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.outputTokens).toBe(0);
  });

  it("abort while a tool executes: no notice, rejects, one row", async () => {
    const a = scriptedModel([toolStep("wait", {}), textStep(["never"])]);
    const { gw, store } = makeGw([{ model: a.model }]);
    const ctl = new AbortController();
    const res = await gw.streamText({
      ...base,
      signal: ctl.signal,
      tools: {
        wait: tool({
          inputSchema: z.object({}),
          execute: async () => {
            ctl.abort(new Error("bye"));
            await new Promise((r) => setTimeout(r, 50));
            return { ok: true };
          },
        }),
      },
      stopWhen: stepCountIs(4),
    });
    const deltas: string[] = [];
    const reading = (async () => {
      for await (const d of res.textStream) deltas.push(d);
    })();
    await expect(res.result).rejects.toThrow("bye");
    await reading.catch(() => {});
    expect(deltas).toEqual([]);
    expect(store.entries).toHaveLength(1);
  });
});

describe("streamText: guardrails", () => {
  it("pre-hook sees the last user message as prompt and system separately", async () => {
    const seen: { prompt: string; system?: string }[] = [];
    const { model } = scriptedModel([textStep(["a"])]);
    const { gw } = makeGw([{ model }], {
      guardrails: {
        pre: (ctx) => {
          seen.push({ prompt: ctx.prompt, system: ctx.system });
          return { action: "allow" };
        },
      },
    });
    await (
      await gw.streamText({
        ...base,
        messages: [user("first"), { role: "assistant", content: "x" }, user("last")],
      })
    ).result;
    expect(seen).toEqual([{ prompt: "last", system: "You are Scout." }]);
  });

  it("pre transform replaces only the last user message", async () => {
    const { model, state } = scriptedModel([textStep(["a"])]);
    const { gw } = makeGw([{ model }], {
      guardrails: { pre: () => ({ action: "transform", prompt: "scrubbed" }) },
    });
    await (await gw.streamText({ ...base, messages: [user("ssn 123")] })).result;
    const sent = JSON.stringify(state.prompts[0]);
    expect(sent).toContain("scrubbed");
    expect(sent).not.toContain("ssn 123");
    expect(sent).toContain("You are Scout.");
  });

  it("pre block rejects before the stream opens", async () => {
    const { model, state } = scriptedModel([textStep(["a"])]);
    const { gw, store } = makeGw([{ model }], {
      guardrails: { pre: () => ({ action: "block", reason: "no" }) },
    });
    await expect(gw.streamText(base)).rejects.toBeInstanceOf(GuardrailError);
    expect(state.calls).toBe(0);
    expect(store.entries[0]!.provider).toBe("guardrail");
  });

  it("post block rejects result after streaming; the deltas were delivered", async () => {
    const { model } = scriptedModel([textStep(["bad"])]);
    const { gw, store } = makeGw([{ model }], {
      guardrails: { post: () => ({ action: "block", reason: "unsafe" }) },
    });
    const res = await gw.streamText(base);
    const deltas: string[] = [];
    const reading = (async () => {
      for await (const d of res.textStream) deltas.push(d);
    })();
    await expect(res.result).rejects.toBeInstanceOf(GuardrailError);
    await reading.catch(() => {});
    expect(deltas).toEqual(["bad"]);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.guardrails).toEqual([
      expect.objectContaining({ hook: "post", action: "block" }),
    ]);
  });

  it("post transform changes result.text only", async () => {
    const { model } = scriptedModel([textStep(["raw"])]);
    const { gw } = makeGw([{ model }], {
      guardrails: { post: () => ({ action: "transform", output: "clean" }) },
    });
    const res = await gw.streamText(base);
    expect(await collect(res.textStream)).toEqual(["raw"]);
    expect((await res.result).text).toBe("clean");
  });
});

describe("streamText: final-review fixes", () => {
  it("a ledger failure after a clean stream rejects result, with no notice and no hang", async () => {
    class DownStore extends MemoryUsageStore {
      override async logUsage(): Promise<string> {
        throw new Error("db down");
      }
    }
    const { model } = scriptedModel([textStep(["Hel", "lo"])]);
    const { gw } = makeGw([{ model }], { usage: new DownStore() });
    const res = await gw.streamText(base);
    const deltas: string[] = [];
    const reading = (async () => {
      for await (const d of res.textStream) deltas.push(d);
    })();
    await expect(res.result).rejects.toThrow("db down");
    await reading.catch(() => {});
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("keeps image parts of a multimodal user turn, with and without a pre transform", async () => {
    const msg: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
      ],
    };
    for (const guardrails of [
      undefined,
      { pre: () => ({ action: "transform" as const, prompt: "scrubbed" }) },
    ]) {
      const { model, state } = scriptedModel([textStep(["a"])]);
      const { gw } = makeGw([{ model }], guardrails ? { guardrails } : {});
      await (await gw.streamText({ ...base, messages: [msg] })).result;
      const sent = JSON.stringify(state.prompts[0]);
      expect(sent).toContain("image/png");
      expect(sent).toContain(guardrails ? "scrubbed" : "what is this");
    }
  });

  it("deadlineMs bounds a hung tool: the turn degrades instead of hanging", async () => {
    const a = scriptedModel([toolStep("hang", {}), textStep(["never"])]);
    const { gw } = makeGw([{ model: a.model }]);
    const res = await gw.streamText({
      ...base,
      deadlineMs: 100,
      tools: { hang: tool({ inputSchema: z.object({}), execute: () => new Promise(() => {}) }) },
      stopWhen: stepCountIs(4),
    });
    const out = await res.result;
    expect(out.degraded).toBe(true);
  });

  it("a cut-off step's input estimate includes prior steps' tool results", async () => {
    const a = scriptedModel([toolStep("big", {}), partial(["x"], httpError(503))]);
    const { gw, store } = makeGw([{ model: a.model }]);
    const res = await gw.streamText({
      ...base,
      tools: {
        big: tool({ inputSchema: z.object({}), execute: async () => ({ blob: "y".repeat(4000) }) }),
      },
      stopWhen: stepCountIs(4),
    });
    await res.result;
    expect(store.entries[0]!.inputTokens).toBeGreaterThan(1000);
  });

  it("the ledger stores the post-transformed text", async () => {
    const { model } = scriptedModel([textStep(["raw pii"])]);
    const { gw, store } = makeGw([{ model }], {
      guardrails: { post: () => ({ action: "transform", output: "clean" }) },
    });
    await (await gw.streamText(base)).result;
    expect(store.entries[0]!.outputText).toBe("clean");
  });
});
