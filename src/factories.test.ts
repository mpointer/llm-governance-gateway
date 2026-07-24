// Provider factory registry (#2): BYO cloud SDK factories join the routing
// namespace. Real-money pricing (never silent $0), NOT ZDR by default.

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
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("nope");
    },
  } as unknown as LanguageModel;
}

describe("provider factories", () => {
  it("parseAny: builtins > endpoints > factories > bare-anthropic", () => {
    const r = new ProviderRegistry({
      endpoints: { shared: { baseURL: "http://x/v1" } },
      factories: { bedrock: { model: () => fakeLm("x") } },
    });
    expect(r.parseAny("bedrock:anthropic.claude-sonnet-4-6-v1:0")).toMatchObject({
      provider: "bedrock",
      model: "anthropic.claude-sonnet-4-6-v1:0",
    });
    expect(r.parseAny("openai:gpt-4.1").provider).toBe("openai");
    expect(r.isFactory("bedrock")).toBe(true);
    expect(r.isFactory("shared")).toBe(false);
  });

  it("factories price at REAL rates: registered pricing used, fallback warns", () => {
    const r = new ProviderRegistry({
      factories: { bedrock: { model: () => fakeLm("x") } },
      pricing: { "priced-model": { in: 0.3, out: 1.5 } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(r.estimateForLink("bedrock", "priced-model", 1000, 1000)).toBeCloseTo(1.8, 10);
    expect(warn).not.toHaveBeenCalled();
    // Unknown model: conservative fallback WITH warning — never silent $0.
    expect(r.estimateForLink("bedrock", "unpriced-model", 1000, 1000)).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("factories are NOT ZDR by default; retention assertion enables them", () => {
    const r = new ProviderRegistry({
      factories: { bedrock: { model: () => fakeLm("x") } },
      retention: { bedrock: { zdr: true, note: "in-region, no retention" } },
    });
    const r2 = new ProviderRegistry({ factories: { bedrock: { model: () => fakeLm("x") } } });
    expect(r2.isZdr("bedrock", "any")).toBe(false); // cloud ≠ self-hosted
    expect(r.isZdr("bedrock", "any")).toBe(true);
  });

  it("chain factory: link generates and attributes usage to the factory name", async () => {
    const built: string[] = [];
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: {
        factories: {
          azure: {
            model: (id) => {
              built.push(id);
              return fakeLm("via-azure");
            },
          },
        },
        pricing: { "gpt4-prod": { in: 0.2, out: 0.8 } },
      },
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [{ factory: "azure", model: "gpt4-prod" }],
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
    expect(res.object.answer).toBe("via-azure");
    expect(built).toEqual(["gpt4-prod"]); // deployment alias passed through
    expect(usage.entries[0]!.provider).toBe("azure");
    expect(usage.entries[0]!.estimatedCostCents).toBeCloseTo((100 * 0.2 + 50 * 0.8) / 1000, 10);
  });

  it("task routing resolves factory-prefixed model ids", async () => {
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: { factories: { watsonx: { model: () => fakeLm("x") } } },
      tasks: { defaults: { extract: "watsonx:granite-13b-chat" } },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    expect(await gw.tasks!.modelForTask("extract")).toMatchObject({
      provider: "watsonx",
      model: "granite-13b-chat",
    });
  });
});
