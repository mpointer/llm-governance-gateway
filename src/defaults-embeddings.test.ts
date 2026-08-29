// Neutralized defaults (finding 3.6) + broader embeddings (finding 3.7).

import { describe, expect, it, vi } from "vitest";
import { Gateway } from "./gateway.js";
import { ProviderRegistry } from "./providers.js";
import { buildEmbeddingModel, EMBEDDING_PROVIDER_IDS } from "./embeddings.js";
import { MemoryUsageStore } from "./adapters/memory.js";

describe("3.6 default provider/model is no longer a silent assumption", () => {
  it("warns loudly, once, when falling back to the library default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = new ProviderRegistry();
    const a = reg.resolveDefault();
    const b = reg.resolveDefault();

    // Still resolves — backward compatible, the fallback is unchanged.
    expect(a.provider).toBe("anthropic");
    expect(a.model).toBe("claude-sonnet-4-6");
    expect(b.provider).toBe("anthropic");

    const warned = warn.mock.calls.flat().join(" ");
    expect(warned).toMatch(/No default provider and model configured/);
    // Names the fix, not just the problem.
    expect(warned).toMatch(/defaultProvider/);
    expect(warned).toMatch(/AI_DEFAULT_PROVIDER/);
    // Once per registry: a per-call warning would be noise on a hot path.
    expect(warn.mock.calls.length).toBe(1);
    warn.mockRestore();
  });

  it("is silent when the default is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = new ProviderRegistry({
      defaultProvider: "openai",
      defaultModel: "gpt-4.1-mini",
    });
    const r = reg.resolveDefault();
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4.1-mini");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("env overrides still work and are also silent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AI_DEFAULT_PROVIDER = "google";
    process.env.AI_DEFAULT_MODEL = "gemini-2.5-pro";
    try {
      const r = new ProviderRegistry().resolveDefault();
      expect(r.provider).toBe("google");
      expect(r.model).toBe("gemini-2.5-pro");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      delete process.env.AI_DEFAULT_PROVIDER;
      delete process.env.AI_DEFAULT_MODEL;
      warn.mockRestore();
    }
  });

  it("requireExplicitDefault upgrades the warning to a throw", () => {
    const reg = new ProviderRegistry({ requireExplicitDefault: true });
    expect(() => reg.resolveDefault()).toThrow(/No default provider and model configured/);
  });

  it("requireExplicitDefault still allows a configured default", () => {
    const reg = new ProviderRegistry({
      requireExplicitDefault: true,
      defaultProvider: "openai",
      defaultModel: "gpt-4.1",
    });
    expect(reg.resolveDefault().model).toBe("gpt-4.1");
  });

  it("an explicit override argument satisfies the requirement", () => {
    const reg = new ProviderRegistry({ requireExplicitDefault: true });
    const r = reg.resolveDefault({ provider: "openai", model: "gpt-4.1-nano" });
    expect(r.model).toBe("gpt-4.1-nano");
  });
});

describe("3.7 embeddings are no longer OpenAI-only", () => {
  it("lists more than one first-class embedding provider", () => {
    expect(EMBEDDING_PROVIDER_IDS).toContain("openai");
    expect(EMBEDDING_PROVIDER_IDS).toContain("voyage");
  });

  it("builds a Voyage embedding model from a config key", () => {
    const reg = new ProviderRegistry({ apiKeys: { voyage: "vk-test" } });
    const em = buildEmbeddingModel(reg, "voyage", "voyage-3-lite");
    expect(em).not.toBeNull();
    expect((em as { modelId?: string }).modelId).toBe("voyage-3-lite");
  });

  it("builds a Voyage embedding model from VOYAGE_API_KEY", () => {
    process.env.VOYAGE_API_KEY = "vk-env";
    try {
      const em = buildEmbeddingModel(new ProviderRegistry(), "voyage", "voyage-3");
      expect(em).not.toBeNull();
    } finally {
      delete process.env.VOYAGE_API_KEY;
    }
  });

  it("returns null without a key, so the caller can fall back", () => {
    const reg = new ProviderRegistry();
    expect(buildEmbeddingModel(reg, "voyage", "voyage-3")).toBeNull();
  });

  it("openai still works exactly as before", () => {
    const reg = new ProviderRegistry({ apiKeys: { openai: "sk-test" } });
    const em = buildEmbeddingModel(reg, "openai", "text-embedding-3-small");
    expect(em).not.toBeNull();
  });

  it("an unknown provider still returns null and names the BYO seam", async () => {
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await expect(gw.embed(["x"], { model: "cohere:embed-v3" })).rejects.toThrow(
      /Pass opts\.embeddingModel/,
    );
  });

  it("Voyage models are priced, so embedding spend is not silently free", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
      providers: { pricing: { "voyage-3-lite": { in: 0.002, out: 0 } } },
    });
    const fake = {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "voyage-3-lite",
      maxEmbeddingsPerCall: 100,
      supportsParallelCalls: true,
      async doEmbed({ values }: { values: string[] }) {
        return { embeddings: values.map(() => [1, 0]), usage: { tokens: 1000 } };
      },
    } as unknown as Parameters<typeof gw.embed>[1]["embeddingModel"];

    await gw.embed(["a"], { model: "voyage:voyage-3-lite", embeddingModel: fake });
    expect(usage.entries[0]!.provider).toBe("voyage");
    expect(usage.entries[0]!.estimatedCostCents).toBeCloseTo(0.002, 6);
  });
});
