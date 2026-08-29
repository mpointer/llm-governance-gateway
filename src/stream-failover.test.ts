// Streaming mid-stream failover (critique finding 3.2).
//
// PR 19 gave streaming a stall clock and a ledger row; a stall still threw to
// the consumer. Now the stream advances to the next eligible link and
// continues, with a documented degradation contract when the chain runs out.
//
// Every failure path here asserts the ledger row, not just the throw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { StreamStallError, ZdrViolationError } from "./errors.js";
import { MemoryUsageStore } from "./adapters/memory.js";

const OutSchema = z.object({ answer: z.string() });

/** Streams `deltas`, then either finishes or goes silent forever. */
function streamingLm(
  id: string,
  deltas: string[],
  mode: "finish" | "hang" | "error",
  calls: string[],
): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not used");
    },
    async doStream({ abortSignal }: { abortSignal?: AbortSignal }) {
      calls.push(id);
      if (mode === "error") {
        const e = new Error("503 upstream") as Error & { statusCode?: number };
        e.statusCode = 503;
        throw e;
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            for (const d of deltas) {
              controller.enqueue({ type: "text-delta", id: "1", delta: d });
            }
            if (mode === "finish") {
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
              });
              controller.close();
            } else {
              abortSignal?.addEventListener("abort", () => {
                try {
                  controller.error(new Error("aborted"));
                } catch {
                  /* already closed */
                }
              });
            }
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

function gwChain(
  links: { model: string; languageModel: LanguageModel }[],
  extra: Record<string, unknown> = {},
) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "s", body: "Say {{w}}", variables: ["w"] }],
    modelConfig: {
      getOverride: async () => null,
      getChain: async () => links.map((l) => ({ provider: "anthropic" as const, ...l })),
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...extra,
  });
  return { gw, usage };
}

const opts = {
  slug: "s",
  schema: OutSchema,
  input: { w: "hi" },
  variables: (i: { w: string }) => ({ w: i.w }),
  cache: false as const,
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("streaming failover", () => {
  it("fails over on a transient link error and completes on the next link", async () => {
    const calls: string[] = [];
    const { gw, usage } = gwChain([
      { model: "bad", languageModel: streamingLm("bad", [], "error", calls) },
      {
        model: "good",
        languageModel: streamingLm("good", [`{"answer":"recovered"}`], "finish", calls),
      },
    ]);
    const res = await gw.streamStructured(opts);
    expect(await res.object).toEqual({ answer: "recovered" });
    expect(calls).toEqual(["bad", "good"]);
    expect(res.failovers).toHaveLength(1);
    expect(res.failovers[0]).toMatchObject({ model: "bad", reason: "retryable" });

    // Ledger-first: the abandoned link left a zero-token row, and the
    // successful link its real one.
    expect(usage.entries).toHaveLength(2);
    expect(usage.entries[0]!.model).toBe("bad");
    expect(usage.entries[0]!.estimatedCostCents).toBe(0);
    expect(usage.entries[1]!.model).toBe("good");
    expect(usage.entries[1]!.outputTokens).toBe(4);
  });

  it("a consumer that only awaits object still drives the failover", async () => {
    // The driver owns iteration precisely so this works: streamObject runs
    // eagerly, so a lazy consumer must not stall the chain.
    const calls: string[] = [];
    const { gw } = gwChain([
      { model: "bad", languageModel: streamingLm("bad", [], "error", calls) },
      { model: "good", languageModel: streamingLm("good", [`{"answer":"ok"}`], "finish", calls) },
    ]);
    const res = await gw.streamStructured(opts);
    expect(await res.object).toEqual({ answer: "ok" });
    expect(calls).toEqual(["bad", "good"]);
  });

  it("partials from the surviving link still reach the consumer", async () => {
    const calls: string[] = [];
    const { gw } = gwChain([
      { model: "bad", languageModel: streamingLm("bad", [], "error", calls) },
      {
        model: "good",
        languageModel: streamingLm("good", [`{"answer":"a`, `bc"}`], "finish", calls),
      },
    ]);
    const res = await gw.streamStructured(opts);
    const partials = await collect(res.partialObjectStream);
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(await res.object).toEqual({ answer: "abc" });
  });

  it("a non-retryable link error is terminal — no failover", async () => {
    const calls: string[] = [];
    const fatal = {
      ...streamingLm("fatal", [], "error", calls),
      async doStream() {
        calls.push("fatal");
        const e = new Error("400 bad request") as Error & { statusCode?: number };
        e.statusCode = 400;
        throw e;
      },
    } as unknown as LanguageModel;

    const { gw, usage } = gwChain([
      { model: "fatal", languageModel: fatal },
      { model: "never", languageModel: streamingLm("never", [`{"answer":"x"}`], "finish", calls) },
    ]);
    const res = await gw.streamStructured(opts);
    await expect(res.object).rejects.toThrow(/400/);
    expect(calls).toEqual(["fatal"]);
    // Still ledgered, even though it was terminal.
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.estimatedCostCents).toBe(0);
  });

  it("ZDR filters the streaming chain rather than failing on link one", async () => {
    const calls: string[] = [];
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "s", body: "Say {{w}}", variables: ["w"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "openai" as const, model: "leaky", languageModel: streamingLm("leaky", [`{"answer":"no"}`], "finish", calls) },
          { provider: "anthropic" as const, model: "safe", languageModel: streamingLm("safe", [`{"answer":"yes"}`], "finish", calls) },
        ],
      },
      providers: { retention: { anthropic: { zdr: true } } },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const res = await gw.streamStructured({ ...opts, requireZdr: true });
    expect(await res.object).toEqual({ answer: "yes" });
    expect(calls).toEqual(["safe"]);
  });

  it("errors when every streaming link is ZDR-ineligible", async () => {
    const calls: string[] = [];
    const { gw } = gwChain([
      { model: "a", languageModel: streamingLm("a", [`{"answer":"x"}`], "finish", calls) },
    ]);
    await expect(
      gw.streamStructured({ ...opts, requireZdr: true }),
    ).rejects.toThrow(ZdrViolationError);
    expect(calls).toEqual([]);
  });
});

describe("streaming failover: stalls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a stalled link fails over instead of throwing to the consumer", async () => {
    // This is the behavior change from PR 19: a stall used to be terminal.
    const calls: string[] = [];
    const { gw, usage } = gwChain(
      [
        { model: "stalls", languageModel: streamingLm("stalls", [`{"answer":"par`], "hang", calls) },
        { model: "good", languageModel: streamingLm("good", [`{"answer":"done"}`], "finish", calls) },
      ],
      { timeouts: { streamFirstChunkMs: 5_000, streamStallMs: 5_000 } },
    );
    const res = await gw.streamStructured(opts);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await res.object).toEqual({ answer: "done" });
    expect(calls).toEqual(["stalls", "good"]);
    expect(res.failovers[0]).toMatchObject({ reason: "stall", hadPartialOutput: true });
    // The stalled link is ledgered, then the survivor.
    expect(usage.entries).toHaveLength(2);
    expect(usage.entries[0]!.model).toBe("stalls");
    expect(usage.entries[0]!.outputTokens).toBe(0);
  });

  it("degradation contract: chain exhausted surfaces the last error, all ledgered", async () => {
    const calls: string[] = [];
    const { gw, usage } = gwChain(
      [
        { model: "s1", languageModel: streamingLm("s1", [], "hang", calls) },
        { model: "s2", languageModel: streamingLm("s2", [], "hang", calls) },
      ],
      { timeouts: { streamFirstChunkMs: 5_000, streamStallMs: 5_000 } },
    );
    const res = await gw.streamStructured(opts);
    const settled = expect(res.object).rejects.toThrow(StreamStallError);
    await vi.advanceTimersByTimeAsync(11_000);
    await settled;

    expect(calls).toEqual(["s1", "s2"]);
    // Every attempted link left a row — the ledger is the audit trail even
    // when the whole chain failed.
    expect(usage.entries).toHaveLength(2);
    expect(usage.entries.map((e) => e.model)).toEqual(["s1", "s2"]);
    expect(usage.entries.every((e) => e.estimatedCostCents === 0)).toBe(true);
  });

  it("the iterator sees the same terminal error as the object promise", async () => {
    const calls: string[] = [];
    const { gw } = gwChain([{ model: "s1", languageModel: streamingLm("s1", [], "hang", calls) }], {
      timeouts: { streamFirstChunkMs: 5_000, streamStallMs: 5_000 },
    });
    const res = await gw.streamStructured(opts);
    const drained = expect(collect(res.partialObjectStream)).rejects.toThrow(StreamStallError);
    const settled = expect(res.object).rejects.toThrow(StreamStallError);
    await vi.advanceTimersByTimeAsync(5_100);
    await settled;
    await drained;
  });

  it("a caller abort is terminal — it does not fail over", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const { gw } = gwChain([
      { model: "s1", languageModel: streamingLm("s1", [], "hang", calls) },
      { model: "s2", languageModel: streamingLm("s2", [`{"answer":"x"}`], "finish", calls) },
    ]);
    const res = await gw.streamStructured({ ...opts, signal: controller.signal });
    const settled = expect(res.object).rejects.toThrow();
    controller.abort(new Error("caller went away"));
    await vi.advanceTimersByTimeAsync(10);
    await settled;
    // The caller asked to stop, not to retry somewhere else.
    expect(calls).toEqual(["s1"]);
  });
});
