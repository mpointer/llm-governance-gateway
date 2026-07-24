// Governed streaming: same front door (rate limit, caps, cache), streamObject
// body. Includes one real streamObject pass over a fake V2 model.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { RateLimitError } from "./errors.js";
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
