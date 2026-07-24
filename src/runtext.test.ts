// runText: governed text generation (added for the ProjectFlowAI adoption).

import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { RateLimitError } from "./errors.js";
import { MemoryRateLimiter, MemoryUsageStore } from "./adapters/memory.js";

function fakeTextLm(text: string, finishReason = "stop", fail = 0): { lm: LanguageModel; calls: number[] } {
  const calls: number[] = [];
  let n = 0;
  return {
    calls,
    lm: {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "fake",
      supportedUrls: {},
      async doGenerate() {
        calls.push(++n);
        if (n <= fail) {
          const err = new Error("boom") as Error & { statusCode: number };
          err.statusCode = 503;
          throw err;
        }
        return {
          content: [{ type: "text", text }],
          finishReason,
          usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
          warnings: [],
        };
      },
      async doStream() {
        throw new Error("nope");
      },
    } as unknown as LanguageModel,
  };
}

function make(links: { lm: LanguageModel }[], rateMax = 100) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    rateLimiter: new MemoryRateLimiter(rateMax),
    promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
    modelConfig: {
      getOverride: async () => null,
      getChain: async () =>
        links.map((l, i) => ({
          provider: "anthropic" as const,
          model: `m${i}`,
          languageModel: l.lm,
        })),
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
  return { gw, usage };
}

const opts = {
  slug: "sum",
  input: { t: "x" },
  variables: (i: { t: string }) => ({ t: i.t }),
  cache: false as const,
  anonKey: "t",
};

describe("runText", () => {
  it("generates text, logs usage, surfaces finishReason", async () => {
    const a = fakeTextLm("hello world", "stop");
    const { gw, usage } = make([a]);
    const res = await gw.runText(opts);
    expect(res.text).toBe("hello world");
    expect(res.finishReason).toBe("stop");
    expect(usage.entries[0]!.outputText).toBe("hello world");
  });

  it("surfaces length finishReason for truncation-aware callers", async () => {
    const a = fakeTextLm("truncated...", "length");
    const { gw } = make([a]);
    const res = await gw.runText({ ...opts, maxOutputTokens: 5 });
    expect(res.finishReason).toBe("length");
  });

  it("falls through the chain on failure", async () => {
    const bad = fakeTextLm("", "stop", 99); // always 503s
    const good = fakeTextLm("from-fallback");
    const { gw } = make([bad, good]);
    const res = await gw.runText(opts);
    expect(res.text).toBe("from-fallback");
    expect(res.model).toBe("m1");
    expect(bad.calls.length).toBe(3); // 1 + 2 transient retries
  });

  it("rate limits and caches like the structured path", async () => {
    const a = fakeTextLm("cached-me");
    const { gw, usage } = make([a], 5);
    const first = await gw.runText({ ...opts, cache: undefined, cacheParts: ["k"] });
    expect(first.cacheHit).toBe(false);
    const second = await gw.runText({ ...opts, cache: undefined, cacheParts: ["k"] });
    expect(second.cacheHit).toBe(true);
    expect(second.text).toBe("cached-me");
    expect(usage.entries[1]!.cacheHit).toBe(true);
    const { gw: limited } = make([fakeTextLm("x")], 1);
    await limited.runText(opts);
    await expect(limited.runText(opts)).rejects.toThrow(RateLimitError);
  });

  it("mock mode uses slug responders", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    gw.registerMockResponder("sum", () => "mock text");
    const res = await gw.runText(opts);
    expect(res.text).toBe("mock text");
    expect(res.provider).toBe("mock");
  });
});
