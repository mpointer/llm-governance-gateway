// Regression coverage for AI_APICallError: model: standard — a downstream
// adopter's `promptConfig.modelHint` (a per-prompt cost-tier label, seeded as
// the literal string "standard" on every prompt) was forwarded verbatim as
// the Anthropic model id whenever a call fell through to Gateway's
// admin-override or no-chain default-resolution branches. Anthropic has no
// "standard" model, so the call 404'd deep inside the AI SDK.
//
// `modelHint` is a legitimate per-prompt model override (see
// `promptFingerprint`'s doc comment in gateway.ts) — the fix is not to stop
// using it, but to validate it against the provider the call will actually
// reach before trusting it as a literal id.
//
// The validation itself has a failure mode of its own that these tests pin
// down: REJECTING a hint silently runs a different model than the prompt
// asked for, which is less visible than the 404 it replaces. So rejection is
// narrow — a tier label, or an id positively attributable to another
// provider — and everything else is let through to fail loudly upstream.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { ProviderRegistry } from "./providers.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { ModelConfigStore, PromptStore, StoredPrompt } from "./types.js";

describe("ProviderRegistry.resolveModelHint", () => {
  it("returns undefined for an unset or blank hint", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint(undefined, "anthropic")).toBeUndefined();
    expect(reg.resolveModelHint("   ", "anthropic")).toBeUndefined();
  });

  it("passes through a hint that is a real, known model id", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint("claude-sonnet-4-6", "anthropic")).toEqual({
      model: "claude-sonnet-4-6",
    });
  });

  it("rejects a cost-tier label that is not a real model id", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint("standard", "anthropic")).toBeUndefined();
    expect(reg.resolveModelHint("economy", "google")).toBeUndefined();
    expect(reg.resolveModelHint("premium", "openai")).toBeUndefined();
    // The library's own tier vocabulary is just as wrong in this position.
    expect(reg.resolveModelHint("fast", "anthropic")).toBeUndefined();
    expect(reg.resolveModelHint("power", "anthropic")).toBeUndefined();
  });

  // A hint is only ever paired with ONE provider. Asking "does any of
  // anthropic/google/openai know this id" accepted a hint for a provider the
  // call was never going to reach, and the mismatched pair 404'd exactly like
  // the tier label this check exists to catch.
  it("validates against the provider the model will actually be paired with", () => {
    const underAnthropic = new ProviderRegistry({ defaultProvider: "anthropic" });
    const underOpenai = new ProviderRegistry({ defaultProvider: "openai" });

    expect(underAnthropic.resolveModelHint("gpt-4.1-mini")).toBeUndefined();
    expect(underOpenai.resolveModelHint("gpt-4.1-mini")).toEqual({ model: "gpt-4.1-mini" });

    // Same rule when the caller names the provider explicitly.
    expect(underOpenai.resolveModelHint("gpt-4.1-mini", "anthropic")).toBeUndefined();
    expect(underAnthropic.resolveModelHint("claude-sonnet-4-6", "openai")).toBeUndefined();
  });

  // `knownModels` is a best-effort list — BUILTIN_TIERS plus pricing keys
  // that happen to match a hardcoded claude/gemini/gpt prefix. Requiring
  // membership would silently downgrade legitimate pins.
  it("does not require membership of the best-effort known-model list", () => {
    const reg = new ProviderRegistry({
      defaultProvider: "openai",
      // Registered pricing, but no "gpt" prefix, so knownModels misses it.
      pricing: { "o4-mini": { in: 0.11, out: 0.44 } },
    });
    expect(reg.resolveModelHint("o4-mini", "openai")).toEqual({ model: "o4-mini" });

    // A model released after this version shipped.
    const anthropic = new ProviderRegistry({ defaultProvider: "anthropic" });
    expect(anthropic.resolveModelHint("claude-opus-9", "anthropic")).toEqual({
      model: "claude-opus-9",
    });
  });

  it("accepts an adopter's configured tier model even when it is a bare word", () => {
    const reg = new ProviderRegistry({ tiers: { anthropic: { power: "sonnet" } } });
    expect(reg.resolveModelHint("sonnet", "anthropic")).toEqual({ model: "sonnet" });
    // Still rejected for a provider that has not configured it.
    expect(reg.resolveModelHint("sonnet", "google")).toBeUndefined();
  });

  it("trusts a hint unchanged for aggregator/proxy providers (nothing to check it against)", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint("standard", "openrouter")).toEqual({ model: "standard" });
    expect(reg.resolveModelHint("meta-llama/Llama-3.3-70B", "together")).toEqual({
      model: "meta-llama/Llama-3.3-70B",
    });
  });

  // The exemption above has to key off the provider that will be used, not
  // off whether the caller happened to pass one: a row with no
  // providerOverride on an openrouter-default deployment is the common case.
  it("applies the aggregator exemption to the configured default provider too", () => {
    const reg = new ProviderRegistry({ defaultProvider: "openrouter" });
    expect(reg.resolveModelHint("meta-llama/llama-3.3-70b")).toEqual({
      model: "meta-llama/llama-3.3-70b",
    });
    expect(reg.resolveModelHint("standard")).toEqual({ model: "standard" });
  });

  describe("scheme-prefixed ids (the form the README documents elsewhere)", () => {
    it("parses the prefix and reports the provider it names", () => {
      const reg = new ProviderRegistry({ defaultProvider: "anthropic" });
      expect(reg.resolveModelHint("openai:gpt-4.1")).toEqual({
        provider: "openai",
        model: "gpt-4.1",
      });
      expect(reg.resolveModelHint("openai:gpt-4.1", "openai")).toEqual({
        provider: "openai",
        model: "gpt-4.1",
      });
    });

    it("refuses to move a pinned call to another provider", () => {
      const reg = new ProviderRegistry();
      expect(reg.resolveModelHint("openai:gpt-4.1", "anthropic")).toBeUndefined();
    });

    it("leaves a colon that is not a provider namespace alone", () => {
      const reg = new ProviderRegistry();
      // OpenRouter ":free"/":beta" variants are part of the model id.
      expect(reg.resolveModelHint("meta-llama/llama-3.3-70b:free", "openrouter")).toEqual({
        model: "meta-llama/llama-3.3-70b:free",
      });
    });

    it("rejects a custom-endpoint prefix rather than sending it to the wrong provider", () => {
      const reg = new ProviderRegistry({
        endpoints: { ollama: { baseURL: "http://localhost:11434/v1" } },
      });
      // `resolveDefault`'s override can only express a built-in ProviderId,
      // so this cannot be honoured here — and must not be handed to the
      // default provider as a literal model id either.
      expect(reg.resolveModelHint("ollama:llama3", "anthropic")).toBeUndefined();
      expect(reg.resolveModelHint("ollama:llama3")).toBeUndefined();
    });
  });
});

describe("ProviderRegistry.resolveDefault composed with a validated hint (no network — SDK client construction only)", () => {
  it("a bad hint never reaches buildLanguageModel; the configured default does", () => {
    const reg = new ProviderRegistry({ apiKeys: { anthropic: "fake-key-for-test" } });
    const resolved = reg.resolveDefault({
      provider: "anthropic",
      model: reg.resolveModelHint("standard", "anthropic")?.model ?? "claude-sonnet-4-6",
    });
    expect(resolved.model).toBe("claude-sonnet-4-6");
    expect(resolved.languageModel?.modelId).toBe("claude-sonnet-4-6");
  });

  it("a real hint reaches buildLanguageModel unchanged", () => {
    const reg = new ProviderRegistry({ apiKeys: { anthropic: "fake-key-for-test" } });
    const resolved = reg.resolveDefault({
      provider: "anthropic",
      model: reg.resolveModelHint("claude-opus-4-8", "anthropic")?.model ?? "claude-sonnet-4-6",
    });
    expect(resolved.model).toBe("claude-opus-4-8");
    expect(resolved.languageModel?.modelId).toBe("claude-opus-4-8");
  });
});

const OutSchema = z.object({ answer: z.string() });
const base = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
};

const noAdminPin: ModelConfigStore = {
  getOverride: async () => null,
  getChain: async () => [],
};

// `providerOverride` (like `modelHint`) is a DB-row-only field — it never
// flows through `promptDefaults`, only through a `PromptStore` row, which is
// how it actually reaches the Gateway in production (CP's
// `DrizzleCpPromptStore` forwards `row.providerOverride` verbatim).
function storeWith(rows: Record<string, { modelHint?: string; providerOverride?: string }>): PromptStore {
  return {
    getPrompt: async (slug: string): Promise<StoredPrompt | undefined> => {
      const row = rows[slug];
      return row ? { slug, body: "Q {{q}}", ...row } : undefined;
    },
  };
}

describe("Gateway.runStructured no longer forwards a bad modelHint to resolveDefault", () => {
  it("admin-override branch: an admin's pinned model wins over a bad hint (previously the hint always won)", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const store: ModelConfigStore = {
      getOverride: async () => ({ provider: "anthropic", model: "admin-pinned-model" }),
      getChain: async () => [],
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [
        { slug: "q", body: "Q {{q}}", variables: ["q"], modelHint: "standard" },
      ],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    // No API key configured, so the call still fails — but only after
    // resolveDefault was asked to resolve the CORRECT model.
    await expect(gw.runStructured(base)).rejects.toThrow(/No API key/);
    expect(resolveDefault).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "admin-pinned-model",
    });
    resolveDefault.mockRestore();
  });

  it("admin-override branch: a real hint still overrides the pinned model, within the pinned provider", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const store: ModelConfigStore = {
      getOverride: async () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      getChain: async () => [],
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [
        { slug: "q", body: "Q {{q}}", variables: ["q"], modelHint: "claude-opus-4-8" },
      ],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await expect(gw.runStructured(base)).rejects.toThrow(/No API key/);
    expect(resolveDefault).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    resolveDefault.mockRestore();
  });

  // `resolveDefault` fills an absent model from `defaultModel`, so passing it
  // a provider on its own pairs providerOverride "openai" with the configured
  // default model — a guaranteed 404, and the same class of bug as the tier
  // label. A row with no usable hint must resolve the default PAIR.
  it("no-chain default branch: a bad hint drops the whole override, provider included", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      prompts: storeWith({ q: { modelHint: "standard", providerOverride: "openai" } }),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: noAdminPin,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await expect(gw.runStructured(base)).rejects.toThrow();
    expect(resolveDefault).toHaveBeenCalledWith(undefined);
    resolveDefault.mockRestore();
  });

  it("no-chain default branch: providerOverride with no hint resolves the configured default pair", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      prompts: storeWith({ q: { providerOverride: "openai" } }),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: noAdminPin,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await expect(gw.runStructured(base)).rejects.toThrow();
    expect(resolveDefault).toHaveBeenCalledWith(undefined);
    resolveDefault.mockRestore();
  });

  it("no-chain default branch: a real hint still resolves as a literal model override", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      prompts: storeWith({ q: { modelHint: "gpt-4.1-mini", providerOverride: "openai" } }),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: noAdminPin,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await expect(gw.runStructured(base)).rejects.toThrow();
    expect(resolveDefault).toHaveBeenCalledWith({
      model: "gpt-4.1-mini",
      provider: "openai",
    });
    resolveDefault.mockRestore();
  });

  it("no-chain default branch: a scheme-prefixed hint supplies its own provider", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      prompts: storeWith({ q: { modelHint: "openai:gpt-4.1" } }),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: noAdminPin,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await expect(gw.runStructured(base)).rejects.toThrow();
    expect(resolveDefault).toHaveBeenCalledWith({ model: "gpt-4.1", provider: "openai" });
    resolveDefault.mockRestore();
  });

  it("warns once per distinct rejected hint, naming it as the problem", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [
        { slug: "q", body: "Q {{q}}", variables: ["q"], modelHint: "standard" },
      ],
      modelConfig: noAdminPin,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await gw.runStructured({ ...base, cacheParts: ["1"] }).catch(() => {});
    await gw.runStructured({ ...base, cacheParts: ["2"] }).catch(() => {});

    const calls = warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("modelHint"));
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/"standard"/);
    warn.mockRestore();
  });

  // The message names the provider, so deduping on the hint alone silences
  // every provider after the first — the second rejection would warn zero
  // times despite being a different, separately-actionable problem.
  it("warns again for the same hint rejected under a different provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      prompts: storeWith({
        q: { modelHint: "standard", providerOverride: "openai" },
        q2: { modelHint: "standard", providerOverride: "google" },
      }),
      promptDefaults: [
        { slug: "q", body: "Q {{q}}", variables: ["q"] },
        { slug: "q2", body: "Q {{q}}", variables: ["q"] },
      ],
      modelConfig: noAdminPin,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await gw.runStructured(base).catch(() => {});
    await gw.runStructured({ ...base, slug: "q2" }).catch(() => {});

    const calls = warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("modelHint"));
    expect(calls.length).toBe(2);
    expect(calls.some((m) => m.includes('"openai"'))).toBe(true);
    expect(calls.some((m) => m.includes('"google"'))).toBe(true);
    warn.mockRestore();
  });
});
