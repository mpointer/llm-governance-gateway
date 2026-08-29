// Native Anthropic path: fake structural client, zero network. Verifies
// request shaping (thinking/tools/cache_control/tool_choice), usage capture
// (cache + web search tokens), cost integration, repair, and chain failover
// from a native link to an AI SDK link.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type {
  AnthropicMessagesClient,
  AnthropicMessage,
  AnthropicRequestOptions,
} from "./anthropic-native.js";

const OutSchema = z.object({ answer: z.string() });

function fakeClient(responses: Partial<AnthropicMessage>[]): {
  client: AnthropicMessagesClient;
  requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  let i = 0;
  return {
    requests,
    client: {
      messages: {
        async create(params) {
          requests.push(params);
          const r = responses[Math.min(i, responses.length - 1)];
          i++;
          return {
            content: r.content ?? [],
            usage: r.usage,
          } as AnthropicMessage;
        },
      },
    },
  };
}

function toolUseMsg(input: unknown, usage?: AnthropicMessage["usage"]): Partial<AnthropicMessage> {
  return {
    content: [{ type: "tool_use", name: "emit_result", input }],
    usage: usage ?? { input_tokens: 10, output_tokens: 5 },
  };
}

function makeGw(client: AnthropicMessagesClient, chainTail?: LanguageModel) {
  return new Gateway({
    usage: new MemoryUsageStore(),
    promptDefaults: [{ slug: "q", body: "Q: {{q}}", variables: ["q"] }],
    anthropic: { client },
    modelConfig: {
      getOverride: async () => null,
      getChain: async () => [
        { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
        ...(chainTail
          ? [{ provider: "openai" as const, model: "fake-tail", languageModel: chainTail }]
          : []),
      ],
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
}

const baseOpts = {
  slug: "q",
  schema: OutSchema,
  input: { q: "hi" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  anonKey: "t",
};

describe("native Anthropic path", () => {
  it("throws when native options are set but no client is configured", async () => {
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "q", body: "Q: {{q}}", variables: ["q"] }],
    });
    await expect(
      gw.runStructured({ ...baseOpts, anthropic: { thinking: true } }),
    ).rejects.toThrow(/GatewayConfig.anthropic is not configured/);
  });

  it("forces tool_use without thinking; captures cache + search usage and costs them", async () => {
    const { client, requests } = fakeClient([
      toolUseMsg(
        { answer: "native" },
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 2000,
          server_tool_use: { web_search_requests: 2 },
        },
      ),
    ]);
    const gw = makeGw(client);
    const usage = (gw as unknown as { usage: MemoryUsageStore }).usage;

    const res = await gw.runStructured({
      ...baseOpts,
      system: "Be terse.",
      anthropic: { cacheSystem: true, webSearch: { maxUses: 2 } },
    });
    expect(res.object).toEqual({ answer: "native" });

    const req = requests[0]!;
    // webSearch present → tool_choice auto (server tools break forced choice)
    expect((req.tool_choice as { type: string }).type).toBe("auto");
    const tools = req.tools as { name?: string; type?: string; max_uses?: number }[];
    expect(tools.some((t) => t.name === "emit_result")).toBe(true);
    expect(tools.some((t) => t.type === "web_search_20250305" && t.max_uses === 2)).toBe(true);
    const system = req.system as { text: string; cache_control?: object }[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(req.thinking).toBeUndefined(); // not requested

    const row = usage.entries[0]!;
    expect(row.cacheCreateTokens).toBe(1000);
    expect(row.cacheReadTokens).toBe(2000);
    expect(row.webSearches).toBe(2);
    // sonnet: in .3, out 1.5, cacheWrite .375, cacheRead .03 per 1K + 2¢ search
    const expected = (100 * 0.3 + 50 * 1.5 + 1000 * 0.375 + 2000 * 0.03) / 1000 + 2 * 1;
    expect(row.estimatedCostCents).toBeCloseTo(expected, 10);
  });

  it("adaptive thinking on supported models; gated off for haiku", async () => {
    const { client, requests } = fakeClient([toolUseMsg({ answer: "x" })]);
    const gw = makeGw(client);
    await gw.runStructured({ ...baseOpts, anthropic: { thinking: true } });
    expect(requests[0]!.thinking).toEqual({ type: "adaptive" });
    expect((requests[0]!.tool_choice as { type: string }).type).toBe("auto");

    const { client: c2, requests: r2 } = fakeClient([toolUseMsg({ answer: "x" })]);
    const gw2 = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "q", body: "Q: {{q}}", variables: ["q"] }],
      anthropic: { client: c2 },
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [{ provider: "anthropic" as const, model: "claude-haiku-4-5" }],
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await gw2.runStructured({ ...baseOpts, anthropic: { thinking: true } });
    expect(r2[0]!.thinking).toBeUndefined(); // haiku would 400
    expect((r2[0]!.tool_choice as { type: string }).type).toBe("tool"); // no thinking → forced
  });

  it("repairs a schema-invalid tool input, then succeeds on the same link", async () => {
    const { client, requests } = fakeClient([
      toolUseMsg({ wrong: 1 }),
      toolUseMsg({ answer: "fixed" }),
    ]);
    const gw = makeGw(client);
    const res = await gw.runStructured({ ...baseOpts, anthropic: {} });
    expect(res.object).toEqual({ answer: "fixed" });
    expect(requests).toHaveLength(2);
    const secondPrompt = (requests[1]!.messages as { content: string }[])[0]!.content;
    expect(secondPrompt).toContain("failed schema validation");
  });

  it("falls through to an AI SDK chain link when the native link stays invalid", async () => {
    const { client } = fakeClient([toolUseMsg({ wrong: 1 })]); // invalid forever
    const calls: string[] = [];
    const tail = {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "fake-tail",
      supportedUrls: {},
      async doGenerate(options: { prompt: unknown }) {
        calls.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text: `{"answer": "from-tail"}` }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
      async doStream() {
        throw new Error("not implemented");
      },
    } as unknown as LanguageModel;

    const gw = makeGw(client, tail);
    const res = await gw.runStructured({ ...baseOpts, anthropic: {} });
    expect(res.object).toEqual({ answer: "from-tail" });
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Request-level abort. See docs/design/timeouts-and-deadlines.md (S2).
//
// Before this, the native path passed no signal and no timeout: it inherited
// whatever the BYO client happened to be constructed with, so a consumer
// passing a bare `new Anthropic()` got the SDK's 10-minute default while every
// AI SDK path in the same gateway was bounded at 60s.
// ---------------------------------------------------------------------------

/** Fake client that records the second (options) argument of each create. */
function signalCapturingClient(responses: Partial<AnthropicMessage>[]): {
  client: AnthropicMessagesClient;
  options: (AnthropicRequestOptions | undefined)[];
} {
  const options: (AnthropicRequestOptions | undefined)[] = [];
  let i = 0;
  return {
    options,
    client: {
      messages: {
        async create(_params, opts) {
          options.push(opts);
          const r = responses[Math.min(i, responses.length - 1)];
          i++;
          return { content: r.content ?? [], usage: r.usage } as AnthropicMessage;
        },
      },
    },
  };
}

describe("native Anthropic abort signal", () => {
  it("passes a live AbortSignal to the client on the structured path", async () => {
    const { client, options } = signalCapturingClient([toolUseMsg({ answer: "ok" })]);
    const gw = makeGw(client);
    await gw.runStructured({ ...baseOpts, anthropic: { thinking: false } });

    expect(options).toHaveLength(1);
    const signal = options[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Bounded, not merely present: it must not already be aborted, and the
    // gateway must have disposed the attempt clock after the call returned.
    expect(signal!.aborted).toBe(false);
  });

  it("passes a live AbortSignal on the runText native path", async () => {
    const { client, options } = signalCapturingClient([
      { content: [{ type: "text", text: "grounded" }], usage: { input_tokens: 3, output_tokens: 2 } },
    ]);
    const gw = makeGw(client);
    const res = await gw.runText({
      slug: "q",
      input: { q: "hi" },
      variables: (i: { q: string }) => ({ q: i.q }),
      cache: false,
      anthropic: { webSearch: true },
    });

    expect(res.text).toBe("grounded");
    expect(options[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the in-flight request when the caller's signal fires", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const client: AnthropicMessagesClient = {
      messages: {
        async create(_params, opts) {
          observed = opts?.signal;
          // Never resolves on its own; only the signal ends it.
          return await new Promise<AnthropicMessage>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () =>
              reject(new Error("request aborted")),
            );
          });
        },
      },
    };
    const gw = makeGw(client);
    const pending = gw.runStructured({
      ...baseOpts,
      anthropic: { thinking: false },
      signal: controller.signal,
    });
    // Let the call reach the client before aborting.
    await new Promise((r) => setTimeout(r, 0));
    expect(observed?.aborted).toBe(false);
    controller.abort(new Error("caller went away"));

    await expect(pending).rejects.toThrow(/aborted/);
    expect(observed?.aborted).toBe(true);
  });

  it("a BYO client written against the one-argument shape still works", async () => {
    // Back-compat proof for widening AnthropicMessagesClient: this client
    // declares `create(params)` only, ignores the options argument entirely,
    // and must remain both assignable and functional.
    const oneArg: AnthropicMessagesClient = {
      messages: {
        async create(params: Record<string, unknown>) {
          expect(params).toHaveProperty("model");
          return {
            content: [{ type: "tool_use", name: "emit_result", input: { answer: "legacy" } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          } as AnthropicMessage;
        },
      },
    };
    const gw = makeGw(oneArg);
    const res = await gw.runStructured({ ...baseOpts, anthropic: { thinking: false } });
    expect(res.object).toEqual({ answer: "legacy" });
  });
});
