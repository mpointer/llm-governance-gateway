// Regression coverage for AI_APICallError: model: standard — a downstream
// adopter's `promptConfig.modelHint` (a per-prompt cost-tier label, seeded as
// the literal string "standard" on every prompt) was forwarded verbatim as
// the Anthropic model id whenever a call fell through to Gateway's
// admin-override or no-chain default-resolution branches. Anthropic has no
// "standard" model, so the call 404'd deep inside the AI SDK.
//
// `modelHint` is a legitimate per-prompt model override (see
// `promptFingerprint`'s doc comment in gateway.ts) — the fix is not to stop
// using it, but to validate it against the resolved provider's known models
// before trusting it as a literal id, exactly like `resolveDefault` already
// treats an unconfigured default as a loud, recoverable condition rather than
// forwarding garbage upstream.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { ProviderRegistry } from "./providers.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { ModelConfigStore, PromptStore } from "./types.js";

describe("ProviderRegistry.resolveModelHint", () => {
  it("returns undefined for an unset hint", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint(undefined, "anthropic")).toBeUndefined();
  });

  it("passes through a hint that is a real, known model id", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint("claude-sonnet-4-6", "anthropic")).toBe("claude-sonnet-4-6");
  });

  it("rejects a cost-tier label that is not a real model id", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint("standard", "anthropic")).toBeUndefined();
    expect(reg.resolveModelHint("economy", "google")).toBeUndefined();
    expect(reg.resolveModelHint("premium", "openai")).toBeUndefined();
  });

  it("checks across anthropic/google/openai when no provider is given", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint("gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(reg.resolveModelHint("standard")).toBeUndefined();
  });

  it("trusts a hint unchanged for aggregator/proxy providers (no known-model list to check)", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolveModelHint("standard", "openrouter")).toBe("standard");
    expect(reg.resolveModelHint("meta-llama/Llama-3.3-70B", "together")).toBe(
      "meta-llama/Llama-3.3-70B",
    );
  });
});

describe("ProviderRegistry.resolveDefault composed with a validated hint (no network — SDK client construction only)", () => {
  it("a bad hint never reaches buildLanguageModel; the configured default does", () => {
    const reg = new ProviderRegistry({ apiKeys: { anthropic: "fake-key-for-test" } });
    const resolved = reg.resolveDefault({
      provider: "anthropic",
      model: reg.resolveModelHint("standard", "anthropic") ?? "claude-sonnet-4-6",
    });
    expect(resolved.model).toBe("claude-sonnet-4-6");
    expect(resolved.languageModel?.modelId).toBe("claude-sonnet-4-6");
  });

  it("a real hint reaches buildLanguageModel unchanged", () => {
    const reg = new ProviderRegistry({ apiKeys: { anthropic: "fake-key-for-test" } });
    const resolved = reg.resolveDefault({
      provider: "anthropic",
      model: reg.resolveModelHint("claude-opus-4-8", "anthropic") ?? "claude-sonnet-4-6",
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

  // `providerOverride` (like `modelHint`) is a DB-row-only field — it never
  // flows through `promptDefaults`, only through a `PromptStore` row, which
  // is how it actually reaches the Gateway in production (CP's
  // `DrizzleCpPromptStore` forwards `row.providerOverride` verbatim).
  function storeWith(row: { modelHint?: string; providerOverride?: string }): PromptStore {
    return {
      getPrompt: async () => ({ slug: "q", body: "Q {{q}}", ...row }),
    };
  }

  it("no-chain default branch: a bad hint is dropped, providerOverride is still honored", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const store: ModelConfigStore = {
      getOverride: async () => null,
      getChain: async () => [],
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      prompts: storeWith({ modelHint: "standard", providerOverride: "openai" }),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await expect(gw.runStructured(base)).rejects.toThrow();
    expect(resolveDefault).toHaveBeenCalledWith({ provider: "openai" });
    resolveDefault.mockRestore();
  });

  it("no-chain default branch: a real hint still resolves as a literal model override", async () => {
    const resolveDefault = vi.spyOn(ProviderRegistry.prototype, "resolveDefault");
    const store: ModelConfigStore = {
      getOverride: async () => null,
      getChain: async () => [],
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      prompts: storeWith({ modelHint: "gpt-4.1-mini", providerOverride: "openai" }),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await expect(gw.runStructured(base)).rejects.toThrow();
    expect(resolveDefault).toHaveBeenCalledWith({
      model: "gpt-4.1-mini",
      provider: "openai",
    });
    resolveDefault.mockRestore();
  });

  it("warns once per distinct rejected hint, naming it as the problem", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store: ModelConfigStore = {
      getOverride: async () => null,
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

    await gw.runStructured({ ...base, cacheParts: ["1"] }).catch(() => {});
    await gw.runStructured({ ...base, cacheParts: ["2"] }).catch(() => {});

    const calls = warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("modelHint"));
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/"standard"/);
    warn.mockRestore();
  });
});
