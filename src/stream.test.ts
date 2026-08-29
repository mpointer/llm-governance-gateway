// Governed streaming: same front door (rate limit, caps, cache), streamObject
// body. Includes one real streamObject pass over a fake V2 model.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { RateLimitError, StreamStallError } from "./errors.js";
import { MemoryRateLimiter, MemoryUsageStore } from "./adapters/memory.js";

const OutSchema = z.object({ answer: z.string() });

function makeMock(rateMax = 100) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    rateLimiter: new MemoryRateLimiter(rateMax),
    promptDefaults: [{ slug: "s", body: "Say {{w}}", variables: ["w"] }],
    mock: true,
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
  gw.registerMockResponder("s", () => ({ answer: "hi" }));
  return { gw, usage };
}

const opts = {
  slug: "s",
  schema: OutSchema,
  input: { w: "hi" },
  variables: (i: { w: string }) => ({ w: i.w }),
  cacheParts: ["hi"],
  userId: "u1",
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("streamStructured", () => {
  it("mock mode: single-emission stream, usage logged, object resolves", async () => {
    const { gw, usage } = makeMock();
    const res = await gw.streamStructured(opts);
    expect(res.cached).toBe(false);
    expect(await collect(res.partialObjectStream)).toEqual([{ answer: "hi" }]);
    expect(await res.object).toEqual({ answer: "hi" });
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.provider).toBe("mock");
  });

  it("second call streams from cache", async () => {
    const { gw, usage } = makeMock();
    await (await gw.streamStructured(opts)).object;
    const res2 = await gw.streamStructured(opts);
    expect(res2.cached).toBe(true);
    expect(await res2.object).toEqual({ answer: "hi" });
    expect(usage.entries[1]!.cacheHit).toBe(true);
  });

  it("rate limit applies before any stream starts", async () => {
    const { gw } = makeMock(1);
    await (await gw.streamStructured(opts)).object;
    await expect(gw.streamStructured({ ...opts, cacheParts: ["other"] })).rejects.toThrow(
      RateLimitError,
    );
  });

  it("cacheParts required unless cache:false", async () => {
    const { gw } = makeMock();
    await expect(
      gw.streamStructured({ ...opts, cacheParts: undefined }),
    ).rejects.toThrow(/cacheParts is required/);
  });

  it("streams real partials through streamObject over a fake V2 model", async () => {
    const chunks = [`{"ans`, `wer": "streamed"}`];
    const fake = {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "fake-stream",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not used");
      },
      async doStream() {
        const parts = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          ...chunks.map((delta) => ({ type: "text-delta", id: "1", delta })),
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
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

    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "s", body: "Say {{w}}", variables: ["w"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "fake-stream", languageModel: fake },
        ],
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    const res = await gw.streamStructured({ ...opts, cache: false, cacheParts: undefined });
    const partials = await collect(res.partialObjectStream);
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(await res.object).toEqual({ answer: "streamed" });
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.inputTokens).toBe(7);
    expect(usage.entries[0]!.outputTokens).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Stall clocks. See docs/design/timeouts-and-deadlines.md.
//
// The regression these guard against is a MISSING LEDGER ROW, not a missing
// throw: before this, a stalled stream left `await stream.object` pending
// forever, so finalize() never ran and a provider call that spent money left
// no audit trail. Every test here asserts the usage row, not just the error.
// ---------------------------------------------------------------------------

/**
 * A model whose stream emits `deltas`, then goes silent forever.
 * `respondToAbort: false` simulates a provider that ignores cancellation —
 * the guard must still surface the stall rather than depending on the source
 * to unwind.
 */
function hangingModel(deltas: string[], respondToAbort = true): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "hang",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not used");
    },
    async doStream({ abortSignal }: { abortSignal?: AbortSignal }) {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            for (const delta of deltas) {
              controller.enqueue({ type: "text-delta", id: "1", delta });
            }
            // then silence: never finish, never close
            if (respondToAbort) {
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

function stallGateway(model: LanguageModel) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "s", body: "Say {{w}}", variables: ["w"] }],
    modelConfig: {
      getOverride: async () => null,
      getChain: async () => [
        { provider: "anthropic" as const, model: "hang", languageModel: model },
      ],
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
  return { gw, usage };
}

const streamOpts = { ...opts, cache: false, cacheParts: undefined };

describe("streamStructured stall clocks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first-chunk timeout: nothing ever arrives", async () => {
    const { gw, usage } = stallGateway(hangingModel([]));
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: 5_000,
      streamStallMs: 5_000,
    });
    const settled = expect(res.object).rejects.toThrow(StreamStallError);
    await vi.advanceTimersByTimeAsync(5_100);
    await settled;

    // The load-bearing assertion: the aborted attempt is in the ledger.
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.provider).toBe("anthropic");
    expect(usage.entries[0]!.model).toBe("hang");
    expect(usage.entries[0]!.inputTokens).toBe(0);
    expect(usage.entries[0]!.outputTokens).toBe(0);
    expect(usage.entries[0]!.estimatedCostCents).toBe(0);
  });

  it("mid-stream stall: output starts, then goes silent", async () => {
    const { gw, usage } = stallGateway(hangingModel([`{"answer": "par`]));
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: 5_000,
      streamStallMs: 5_000,
    });
    const partials: unknown[] = [];
    const drain = (async () => {
      for await (const p of res.partialObjectStream) partials.push(p);
    })();

    // Attach both rejection handlers BEFORE advancing the clock: these
    // promises reject during the advance, and a handler attached afterwards
    // leaves an unhandled-rejection window.
    const drained = expect(drain).rejects.toThrow(StreamStallError);
    const settled = expect(res.object).rejects.toMatchObject({
      name: "StreamStallError",
      phase: "stall",
    });
    await vi.advanceTimersByTimeAsync(5_100);
    await settled;
    await drained;

    expect(partials.length).toBeGreaterThanOrEqual(1); // real output did arrive
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.outputTokens).toBe(0);
  });

  it("trips for a consumer that only awaits object and never iterates", async () => {
    // The reason the guard owns iteration rather than driving the clock from
    // the consumer: streamObject runs the model eagerly, so this consumer
    // observes no partials at all and could never tick a consumer-driven clock.
    const { gw, usage } = stallGateway(hangingModel([`{"answer": "x`]));
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: 5_000,
      streamStallMs: 5_000,
    });
    const settled = expect(res.object).rejects.toThrow(StreamStallError);
    await vi.advanceTimersByTimeAsync(5_100);
    await settled;
    expect(usage.entries).toHaveLength(1);
  });

  it("surfaces the stall even when the provider ignores the abort", async () => {
    const { gw, usage } = stallGateway(hangingModel([], /* respondToAbort */ false));
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: 5_000,
      streamStallMs: 5_000,
    });
    const settled = expect(res.object).rejects.toThrow(StreamStallError);
    await vi.advanceTimersByTimeAsync(5_100);
    await settled;
    expect(usage.entries).toHaveLength(1);
  });

  it("0 disables the clocks: a silent stream is left pending", async () => {
    const { gw, usage } = stallGateway(hangingModel([]));
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: 0,
      streamStallMs: 0,
    });
    let settled = false;
    void res.object.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
    expect(usage.entries).toHaveLength(0);
  });

  it("leaves no timers pending once a stall settles", async () => {
    const { gw } = stallGateway(hangingModel([]));
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: 5_000,
      streamStallMs: 5_000,
    });
    const settled = expect(res.object).rejects.toThrow(StreamStallError);
    await vi.advanceTimersByTimeAsync(5_100);
    await settled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a healthy stream is unaffected and still completes", async () => {
    const complete = {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "ok",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not used");
      },
      async doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "1" });
              controller.enqueue({ type: "text-delta", id: "1", delta: `{"answer":"ok"}` });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
              });
              controller.close();
            },
          }),
        };
      },
    } as unknown as LanguageModel;

    const { gw, usage } = stallGateway(complete);
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: 5_000,
      streamStallMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await res.object).toEqual({ answer: "ok" });
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.outputTokens).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Real timers, deliberately. Vitest's fake clock does not reliably propagate
// chunks through the AI SDK's internal TransformStream pipeline before it
// jumps to the next timer, which makes a drip-fed stream look stalled when it
// is not. This is the one case where the fake-timer tests could hide a real
// regression, so it pays the ~300ms to run against the real clock.
describe("streamStructured stall clocks (real timers)", () => {
  const GAP_MS = 30;      // each gap well under the window
  const WINDOW_MS = 300;  // total run (~150ms) far exceeds it

  it("a slow-but-alive stream outlives the stall window", async () => {
    // The core claim of chunk-relative clocks: this stream's TOTAL duration
    // is many times streamStallMs, but no single GAP is, so it must run to
    // completion. A total-duration cap would kill it — which is precisely why
    // the design uses chunk-relative clocks instead.
    const drip = {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "drip",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not used");
      },
      async doStream() {
        // Each delta must EXTEND A PARSEABLE PARTIAL, because the clocks
        // measure partial-object emissions rather than raw provider chunks
        // (see guardStream). `{"ans` alone yields no partial at all.
        const deltas = [`{"answer":"s`, `l`, `o`, `w`, `"}`];
        let i = 0;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "1" });
            },
            pull(controller) {
              return new Promise<void>((resolve) => {
                setTimeout(() => {
                  if (i < deltas.length) {
                    controller.enqueue({ type: "text-delta", id: "1", delta: deltas[i]! });
                    i++;
                  } else {
                    controller.enqueue({ type: "text-end", id: "1" });
                    controller.enqueue({
                      type: "finish",
                      finishReason: "stop",
                      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
                    });
                    controller.close();
                  }
                  resolve();
                }, GAP_MS);
              });
            },
          }),
        };
      },
    } as unknown as LanguageModel;

    const { gw, usage } = stallGateway(drip);
    const res = await gw.streamStructured({
      ...streamOpts,
      streamFirstChunkMs: WINDOW_MS,
      streamStallMs: WINDOW_MS,
    });
    expect(await res.object).toEqual({ answer: "slow" });
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.outputTokens).toBe(5);
  });
});
