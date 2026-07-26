// Web-search-grounded runText: native Anthropic text path.
// Demand source: civic-data-adapters' discovery callback wants grounded text
// generation; native web search previously worked only through runStructured.

import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import type { AnthropicMessage } from "./anthropic-native.js";
import { MemoryRateLimiter, MemoryUsageStore } from "./adapters/memory.js";

function fakeAnthropicClient(opts: {
  text?: string;
  webSearches?: number;
  stopReason?: string;
  failFirst?: number;
  failStatus?: number;
}) {
  const params: Record<string, unknown>[] = [];
  let calls = 0;
  return {
    params,
    client: {
      messages: {
        async create(p: Record<string, unknown>): Promise<AnthropicMessage> {
          params.push(p);
          calls++;
          if (opts.failFirst && calls <= opts.failFirst) {
            const err = new Error("overloaded") as Error & { status: number };
            err.status = opts.failStatus ?? 529;
            throw err;
          }
          return {
            content: [
              { type: "server_tool_use", name: "web_search" },
              { type: "text", text: "Grounded: " },
              { type: "text", text: opts.text ?? "answer" },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              server_tool_use: { web_search_requests: opts.webSearches ?? 2 },
            },
            stop_reason: opts.stopReason ?? "end_turn",
          };
        },
      },
    },
  };
}

function fakeTextLm(text: string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("nope");
    },
  } as unknown as LanguageModel;
}

function make(client: ReturnType<typeof fakeAnthropicClient>["client"] | null, chain?: () => Promise<unknown[]>) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    rateLimiter: new MemoryRateLimiter(100),
    promptDefaults: [{ slug: "disc", body: "Find sources: {{q}}", variables: ["q"] }],
    ...(client ? { anthropic: { client } } : {}),
    providers: { webSearchCentsPerCall: 1 },
    modelConfig: {
      getOverride: async () => null,
      getChain: (chain ?? (async () => [{ provider: "anthropic", model: "claude-sonnet-5" }])) as never,
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
  return { gw, usage };
}

const opts = {
  slug: "disc",
  input: { q: "meeting minutes" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  anonKey: "t",
};

describe("runText native (web search)", () => {
  it("runs the native path on an anthropic link with no API key (BYO client), returns grounded text + webSearches", async () => {
    const fake = fakeAnthropicClient({ text: "civic answer", webSearches: 3 });
    const { gw, usage } = make(fake.client);
    const res = await gw.runText({ ...opts, anthropic: { webSearch: true } });
    expect(res.text).toBe("Grounded: civic answer");
    expect(res.webSearches).toBe(3);
    expect(res.finishReason).toBe("stop");
    expect(res.provider).toBe("anthropic");
    const row = usage.entries.at(-1)!;
    expect(row.webSearches).toBe(3);
    expect(row.inputTokens).toBe(100);
    // web_search tool requested with default max_uses
    const sent = fake.params[0]!;
    const tools = sent.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("web_search");
    expect(tools[0]!.max_uses).toBe(4);
    // no emit tool, no tool_choice forcing on the text path
    expect(sent.tool_choice).toBeUndefined();
  });

  it("charges web searches into estimatedCostCents", async () => {
    const fake = fakeAnthropicClient({ webSearches: 5 });
    const { gw, usage } = make(fake.client);
    await gw.runText({ ...opts, anthropic: { webSearch: { maxUses: 5 } } });
    const row = usage.entries.at(-1)!;
    // 5 searches * 1 cent/call = at least 5 cents regardless of token rates
    expect(row.estimatedCostCents).toBeGreaterThanOrEqual(5);
  });

  it("maps max_tokens stop_reason to length", async () => {
    const fake = fakeAnthropicClient({ stopReason: "max_tokens" });
    const { gw } = make(fake.client);
    const res = await gw.runText({ ...opts, anthropic: { webSearch: true } });
    expect(res.finishReason).toBe("length");
  });

  it("retries transient native failures, then succeeds", async () => {
    const fake = fakeAnthropicClient({ failFirst: 1, failStatus: 529 });
    const { gw } = make(fake.client);
    const res = await gw.runText({ ...opts, anthropic: { webSearch: true } });
    expect(res.text).toContain("Grounded");
    expect(fake.params.length).toBe(2);
  });

  it("fails over from a broken native link to a plain AI SDK link", async () => {
    const fake = fakeAnthropicClient({ failFirst: 99, failStatus: 529 });
    const lm = fakeTextLm("ungrounded fallback");
    const { gw, usage } = make(fake.client, async () => [
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "openai", model: "gpt-4o", languageModel: lm },
    ]);
    const res = await gw.runText({ ...opts, anthropic: { webSearch: true } });
    expect(res.text).toBe("ungrounded fallback");
    expect(res.provider).toBe("openai");
    expect(res.webSearches).toBeUndefined();
    expect(usage.entries.at(-1)!.webSearches).toBeNull();
  });

  it("throws when anthropic options are set but no native client is configured", async () => {
    const lm = fakeTextLm("x");
    const { gw } = make(null, async () => [
      { provider: "openai", model: "gpt-4o", languageModel: lm },
    ]);
    await expect(gw.runText({ ...opts, anthropic: { webSearch: true } })).rejects.toThrow(
      /GatewayConfig.anthropic is not configured/,
    );
  });
});
