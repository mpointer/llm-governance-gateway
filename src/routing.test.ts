import { describe, expect, it } from "vitest";
import { parseModelId, ProviderRegistry } from "./providers.js";
import { TaskRouter } from "./tasks.js";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import { listProviderModels, __resetModelsListCache } from "./discovery.js";

describe("parseModelId", () => {
  it("treats bare ids as Anthropic", () => {
    expect(parseModelId("claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });
  it("parses provider prefixes", () => {
    expect(parseModelId("openai:gpt-4.1")).toEqual({ provider: "openai", model: "gpt-4.1" });
    expect(parseModelId("openrouter:meta-llama/llama-3.3-70b")).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b",
    });
    expect(parseModelId("venice:mistral-31-24b")).toEqual({
      provider: "venice",
      model: "mistral-31-24b",
    });
  });
  it("unknown prefixes fall through as Anthropic model ids", () => {
    // Model ids can legitimately contain colons only after a known scheme.
    expect(parseModelId("weird:thing")).toEqual({ provider: "anthropic", model: "weird:thing" });
  });
});

describe("TaskRouter", () => {
  const defaults = {
    enrich: "claude-haiku-4-5",
    editorial: "claude-opus-4-8",
    translate: "google:gemini-2.0-flash",
  };

  it("routes to code defaults", async () => {
    const r = new TaskRouter({ defaults });
    const m = await r.modelForTask("translate");
    expect(m).toMatchObject({ provider: "google", model: "gemini-2.0-flash", source: "default" });
  });

  it("store overrides beat code defaults, with TTL cache + invalidation", async () => {
    let calls = 0;
    const overrides: Record<string, string> = { enrich: "openai:gpt-4.1-mini" };
    const r = new TaskRouter({
      defaults,
      store: {
        getOverrides: async () => {
          calls++;
          return overrides;
        },
      },
    });
    expect((await r.modelForTask("enrich")).source).toBe("override");
    await r.modelForTask("editorial"); // cached — no second store call
    expect(calls).toBe(1);
    overrides.editorial = "venice:mistral-31-24b";
    r.invalidateOverrides();
    const m = await r.modelForTask("editorial");
    expect(calls).toBe(2);
    expect(m).toMatchObject({ provider: "venice", model: "mistral-31-24b", source: "override" });
  });

  it("degrades to code defaults when the store throws", async () => {
    const r = new TaskRouter({
      defaults,
      store: {
        getOverrides: async () => {
          throw new Error("db down");
        },
      },
    });
    const m = await r.modelForTask("enrich");
    expect(m.source).toBe("default");
  });

  it("throws loudly on unknown tasks", async () => {
    const r = new TaskRouter({ defaults });
    await expect(r.modelForTask("typo")).rejects.toThrow(/Unknown AI task/);
  });
});

describe("Gateway.runPromptTest (mock mode)", () => {
  it("renders, generates, and logs to admin:prompt-test", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({ usage, mock: true, appId: "test" });
    const res = await gw.runPromptTest({
      slug: "greet",
      body: "Say hello to {{name}}.",
      variables: { name: "Mike" },
      userId: "admin1",
    });
    expect(res.prompt).toBe("Say hello to Mike.");
    expect(res.provider).toBe("mock");
    expect(res.costCents).toBe(0);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.route).toBe("admin:prompt-test");
    expect(usage.entries[0]!.userId).toBe("admin1");
  });
});

describe("model discovery fallback", () => {
  it("returns static knownModels when no key is configured", async () => {
    __resetModelsListCache();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const registry = new ProviderRegistry({});
      const res = await listProviderModels(registry, "anthropic");
      expect(res.source).toBe("fallback");
      expect(res.configured).toBe(false);
      expect(res.models).toContain("claude-sonnet-4-6");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      __resetModelsListCache();
    }
  });
});
