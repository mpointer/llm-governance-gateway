// #14, NewsHound half: native Anthropic streaming. The native path streams
// via messages.create({ stream: true }) so (a) streamText can carry web
// search / thinking / prompt caching live, and (b) runText can opt into a
// streaming transport for completions past the SDK's 10-minute
// non-streaming ceiling.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import { DEFAULT_DEGRADED_NOTICE, Gateway } from "./gateway.js";
import type { AnthropicMessagesClient } from "./anthropic-native.js";
import { MemoryUsageStore } from "./adapters/memory.js";

type Ev = Record<string, unknown>;

/** Raw Anthropic SSE events for: "Let me search." [web search] "Paris is " "the capital." */
function events(opts: { failAfter?: number } = {}): Ev[] {
  const all: Ev[] = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 10 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Let me search." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "server_tool_use", name: "web_search" },
    },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result" } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Paris is " } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "the capital." } },
    { type: "content_block_stop", index: 3 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } },
    },
    { type: "message_stop" },
  ];
  return opts.failAfter === undefined ? all : all.slice(0, opts.failAfter);
}

function streamingClient(opts: { failAfter?: number; failWith?: Error } = {}) {
  const params: Record<string, unknown>[] = [];
  const client = {
    messages: {
      async create(p: Record<string, unknown>) {
        params.push(p);
        if (!p.stream) throw new Error("test client only streams");
        const evs = events(opts);
        return (async function* () {
          for (const e of evs) yield e;
          if (opts.failWith) throw opts.failWith;
        })();
      },
    },
  } as unknown as AnthropicMessagesClient;
  return { client, params };
}

function makeGw(client: AnthropicMessagesClient) {
  const store = new MemoryUsageStore();
  const gw = new Gateway({
    usage: store,
    promptDefaults: [{ slug: "q", body: "Q: {{q}}", variables: ["q"] }],
    anthropic: { client },
    modelConfig: {
      getOverride: async () => null,
      getChain: async () => [{ provider: "anthropic" as const, model: "claude-sonnet-4-6" }],
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
  return { gw, store };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const turn = {
  slug: "q",
  system: "Be brief.",
  messages: [{ role: "user" as const, content: "capital of France?" }],
};

describe("streamText with native Anthropic options", () => {
  it("streams deltas natively, with a newline across the search block", async () => {
    const { client, params } = streamingClient();
    const { gw, store } = makeGw(client);
    const res = await gw.streamText({ ...turn, anthropic: { webSearch: true, cacheSystem: true } });
    expect(await collect(res.textStream)).toEqual([
      "Let me search.",
      "\n",
      "Paris is ",
      "the capital.",
    ]);
    const out = await res.result;
    expect(out.text).toBe("Let me search.\nParis is the capital.");
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(params[0]!.stream).toBe(true);
    expect(params[0]!.tools).toEqual([expect.objectContaining({ name: "web_search" })]);
    expect(params[0]!.messages).toEqual([{ role: "user", content: "capital of France?" }]);
    const row = store.entries[0]!;
    expect(row.webSearches).toBe(1);
    expect(row.cacheReadTokens).toBe(10);
    expect(row.provider).toBe("anthropic");
  });

  it("a native failure after text degrades with the notice", async () => {
    const { client } = streamingClient({
      failAfter: 3,
      failWith: Object.assign(new Error("overloaded"), { status: 529 }),
    });
    const { gw } = makeGw(client);
    const res = await gw.streamText({ ...turn, anthropic: { webSearch: true } });
    expect(await collect(res.textStream)).toEqual([
      "Let me search.",
      `\n\n${DEFAULT_DEGRADED_NOTICE}`,
    ]);
    expect((await res.result).degraded).toBe(true);
  });

  it("anthropic options plus AI SDK tools is rejected", async () => {
    const { client } = streamingClient();
    const { gw } = makeGw(client);
    await expect(
      gw.streamText({
        ...turn,
        anthropic: { webSearch: true },
        tools: { t: tool({ inputSchema: z.object({}), execute: async () => 1 }) },
      }),
    ).rejects.toThrow(/anthropic.*tools/);
  });
});

describe("runText with anthropic.stream (long completions)", () => {
  it("uses the streaming transport and returns the joined text", async () => {
    const { client, params } = streamingClient();
    const { gw, store } = makeGw(client);
    const res = await gw.runText({
      slug: "q",
      input: { q: "x" },
      variables: (i: { q: string }) => ({ q: i.q }),
      cache: false,
      maxOutputTokens: 64_000,
      anthropic: { stream: true, webSearch: true },
    });
    expect(params[0]!.stream).toBe(true);
    expect(params[0]!.max_tokens).toBe(64_000);
    expect(res.text).toBe("Let me search.\nParis is the capital.");
    expect(store.entries[0]!.webSearches).toBe(1);
    expect(store.entries[0]!.outputTokens).toBe(40);
  });
});
