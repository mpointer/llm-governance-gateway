// #15: GatewayConfig.isRetryable replaces the built-in 429/5xx predicate, so
// an adopter can retry network errors (no status) or 408/409 without an
// outer wrapper. Default behavior is unchanged.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { isRetryable } from "./backoff.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { GatewayConfig } from "./types.js";

const netError = () => new Error("ECONNRESET"); // no statusCode/status

/** Fails with a network error on the first call, then answers. */
function flakyModel(answer: string) {
  const state = { calls: 0 };
  const model = {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    async doGenerate() {
      state.calls++;
      if (state.calls === 1) throw netError();
      return {
        content: [{ type: "text", text: answer }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      state.calls++;
      throw netError();
    },
  } as unknown as LanguageModel;
  return { model, state };
}

function okStreamModel(text: string) {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "b",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not used");
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: text });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            c.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

const withNetwork = (err: unknown) =>
  isRetryable(err) || (err instanceof Error && !("statusCode" in err));

function gw(models: LanguageModel[], extra: Partial<GatewayConfig> = {}) {
  return new Gateway({
    usage: new MemoryUsageStore(),
    promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
    modelConfig: {
      getOverride: async () => null,
      getChain: async () =>
        models.map((m, i) => ({
          provider: "anthropic" as const,
          model: `l${i}`,
          languageModel: m,
        })),
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...extra,
  });
}

const textOpts = {
  slug: "q",
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
};

describe("GatewayConfig.isRetryable (#15)", () => {
  it("default: a network error is not retried", async () => {
    const { model, state } = flakyModel("ok");
    await expect(gw([model]).runText(textOpts)).rejects.toThrow("ECONNRESET");
    expect(state.calls).toBe(1);
  });

  it("a custom predicate retries a network error on runText", async () => {
    const { model, state } = flakyModel("ok");
    const res = await gw([model], { isRetryable: withNetwork }).runText(textOpts);
    expect(res.text).toBe("ok");
    expect(state.calls).toBe(2);
  });

  it("a custom predicate retries a network error on runStructured", async () => {
    const { model, state } = flakyModel(JSON.stringify({ a: "ok" }));
    const res = await gw([model], { isRetryable: withNetwork }).runStructured({
      ...textOpts,
      schema: z.object({ a: z.string() }),
    });
    expect(res.object).toEqual({ a: "ok" });
    expect(state.calls).toBe(2);
  });

  it("a custom predicate makes streamText fail over on a network error", async () => {
    const a = flakyModel("never");
    const g = gw([a.model, okStreamModel("from-b")], { isRetryable: withNetwork });
    const res = await g.streamText({ slug: "q", messages: [{ role: "user", content: "x" }] });
    expect((await res.result).text).toBe("from-b");
  });
});
