// Custom OpenAI-compatible endpoints (Ollama / vLLM / LM Studio presets):
// parsing, zero-cost accounting, ZDR defaults, chain integration.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { ProviderRegistry } from "./providers.js";
import { MemoryUsageStore } from "./adapters/memory.js";

const OutSchema = z.object({ answer: z.string() });

function fakeLm(answer: string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: JSON.stringify({ answer }) }],
        finishReason: "stop",
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("nope");
    },
  } as unknown as LanguageModel;
}

describe("custom endpoints", () => {
  it("parseAny: builtin prefixes win, presets and configured endpoints resolve, bare = anthropic", () => {
    const r = new ProviderRegistry({
      endpoints: { gpubox: { baseURL: "http://gpu:8000/v1" } },
    });
    expect(r.parseAny("openai:gpt-4.1")).toMatchObject({ provider: "openai", endpoint: false });
    expect(r.parseAny("ollama:llama3.3")).toMatchObject({ provider: "ollama", endpoint: true });
    expect(r.parseAny("gpubox:qwen2.5-72b")).toMatchObject({ provider: "gpubox", endpoint: true });
    expect(r.parseAny("claude-sonnet-4-6")).toMatchObject({ provider: "anthropic", endpoint: false });
    // Unknown prefix that is neither builtin nor endpoint → anthropic passthrough
    expect(r.parseAny("mystery:thing")).toMatchObject({ provider: "anthropic", endpoint: false });
  });

  it("presets build zero-config; endpoint cost is 0 with no fallback warning", () => {
    const r = new ProviderRegistry({});
    expect(r.buildEndpointModel("ollama", "llama3.3")).not.toBeNull();
    expect(r.buildEndpointModel("nonexistent", "x")).toBeNull();
    const warn = vi.spyOn(console, "warn");
    expect(r.estimateForLink("ollama", "llama3.3", 5000, 5000)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("endpoints default to ZDR; retention override wins", () => {
    const r = new ProviderRegistry({
      endpoints: { shared: { baseURL: "http://shared-infra:8000/v1" } },
      retention: { shared: { zdr: false, note: "multi-tenant box" } },
    });
    expect(r.isZdr("ollama", "llama3.3")).toBe(true);
    expect(r.isZdr("shared", "llama3.3")).toBe(false);
  });

  it("chain: local-first with cloud fallback; endpoint usage logged at $0", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { endpoint: "vllm", model: "qwen2.5-72b", languageModel: fakeLm("local") },
          { provider: "anthropic" as const, model: "claude-sonnet-4-6", languageModel: fakeLm("cloud") },
        ],
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const res = await gw.runStructured({
      slug: "q",
      schema: OutSchema,
      input: { q: "x" },
      variables: (i: { q: string }) => ({ q: i.q }),
      cache: false,
      anonKey: "t",
    });
    expect(res.object.answer).toBe("local");
    expect(usage.entries[0]!.provider).toBe("vllm");
    expect(usage.entries[0]!.estimatedCostCents).toBe(0);
    expect(usage.entries[0]!.inputTokens).toBe(11); // tokens still logged
  });

  it("task routing accepts endpoint-prefixed model ids", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: { endpoints: { gpubox: { baseURL: "http://gpu:8000/v1" } } },
      tasks: { defaults: { local_summarize: "gpubox:qwen2.5-72b" } },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const resolved = await gw.tasks!.modelForTask("local_summarize");
    expect(resolved).toMatchObject({ provider: "gpubox", model: "qwen2.5-72b" });
  });
});
