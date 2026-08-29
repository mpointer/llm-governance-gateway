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

// ---------------------------------------------------------------------------
// Failover alignment (S4). runText previously fell through to the next link on
// NON-retryable errors whenever the chain had more than one link, so a caller
// error like a 400 burned a call on the next provider too. It now advances
// only on retryable errors and attempt timeouts, matching callWithChain.
// ---------------------------------------------------------------------------

describe("runText failover alignment", () => {
  function failingLm(status: number | undefined, id: string): {
    lm: LanguageModel;
    calls: () => number;
  } {
    let calls = 0;
    return {
      calls: () => calls,
      lm: {
        specificationVersion: "v2",
        provider: "fake",
        modelId: id,
        supportedUrls: {},
        async doGenerate() {
          calls++;
          const err = new Error(`boom ${status ?? "none"}`) as Error & {
            statusCode?: number;
          };
          if (status !== undefined) err.statusCode = status;
          throw err;
        },
        async doStream() {
          throw new Error("not used");
        },
      } as unknown as LanguageModel,
    };
  }

  function okTextLm(text: string, id: string): { lm: LanguageModel; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      lm: {
        specificationVersion: "v2",
        provider: "fake",
        modelId: id,
        supportedUrls: {},
        async doGenerate() {
          calls++;
          return {
            content: [{ type: "text", text }],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        },
        async doStream() {
          throw new Error("not used");
        },
      } as unknown as LanguageModel,
    };
  }

  const mk = (links: { model: string; languageModel: LanguageModel }[]) =>
    new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "t", body: "Say {{w}}", variables: ["w"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => links.map((l) => ({ provider: "anthropic" as const, ...l })),
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

  const textOpts = {
    slug: "t",
    input: { w: "hi" },
    variables: (i: { w: string }) => ({ w: i.w }),
    cache: false as const,
  };

  it("a 400 no longer burns a call on the next link", async () => {
    const first = failingLm(400, "bad");
    const second = okTextLm("should not be reached", "next");
    const gw = mk([
      { model: "bad", languageModel: first.lm },
      { model: "next", languageModel: second.lm },
    ]);

    await expect(gw.runText(textOpts)).rejects.toThrow(/boom 400/);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0); // previously would have been 1
  });

  it("a 503 still advances to the next link", async () => {
    const first = failingLm(503, "flaky");
    const second = okTextLm("recovered", "next");
    const gw = mk([
      { model: "flaky", languageModel: first.lm },
      { model: "next", languageModel: second.lm },
    ]);

    const res = await gw.runText(textOpts);
    expect(res.text).toBe("recovered");
    expect(res.model).toBe("next");
    expect(second.calls()).toBe(1);
  });
});
