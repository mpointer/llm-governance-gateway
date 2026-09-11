// ModelConfigStore.getOverride()'s tier parameter (added for a real adopter
// safety requirement, CareerPointers finding F-038: an explicit tier request
// must never be silently downgraded by an admin-pinned model). The gateway
// itself makes no policy decision here — it only passes the call's tier
// through so a store CAN implement "tier beats the pin" if it wants to.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { ModelConfigStore } from "./types.js";

const OutSchema = z.object({ answer: z.string() });
const base = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
};

function lm(answer: string, id = "m"): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: JSON.stringify({ answer }) }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

describe("ModelConfigStore.getOverride() tier parameter", () => {
  it("passes the call's tier through to getOverride", async () => {
    const seen: (string | undefined)[] = [];
    const store: ModelConfigStore = {
      getOverride: async (_orgId, tier) => {
        seen.push(tier);
        return null; // fall through to chain either way
      },
      getChain: async () => [
        { provider: "anthropic" as const, model: "chain-model", languageModel: lm("a") },
      ],
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await gw.runStructured({ ...base, cacheParts: ["1"] });
    await gw.runStructured({ ...base, cacheParts: ["2"], tier: "fast" });
    await gw.runStructured({ ...base, cacheParts: ["3"], tier: "power" });

    expect(seen).toEqual([undefined, "fast", "power"]);
  });

  it("a store can let an explicit tier beat the admin pin (the F-038 use case)", async () => {
    const usage = new MemoryUsageStore();
    const seenOverrideCalls: (string | undefined)[] = [];
    const store: ModelConfigStore = {
      // The actual adopter pattern: return null (no pin) whenever a tier was
      // requested, so resolution falls through to the chain instead of the
      // hard-pinned model — provable here by observing getOverride's own
      // per-call tier argument line up with whether it returned a pin.
      getOverride: async (_orgId, tier) => {
        seenOverrideCalls.push(tier);
        return tier ? null : { provider: "anthropic", model: "pinned-model" };
      },
      getChain: async () => [
        { provider: "anthropic" as const, model: "chain-model", languageModel: lm("from-chain") },
      ],
    };
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    // Explicit tier: this store's policy skips the pin, falls to the chain.
    await gw.runStructured({ ...base, cacheParts: ["1"], tier: "fast" });
    expect(usage.entries[0]!.model).toBe("chain-model");
    expect(seenOverrideCalls).toEqual(["fast"]);
  });

  it("a store implementing getOverride with fewer parameters still works (backward compat)", async () => {
    const usage = new MemoryUsageStore();
    // Pre-existing adopter shape: zero-arg getOverride, ignores tier entirely
    // (same convention already established for the pre-existing orgId param).
    const legacy: ModelConfigStore = {
      getOverride: async () => null,
      getChain: async () => [
        { provider: "anthropic" as const, model: "legacy-model", languageModel: lm("legacy") },
      ],
    };
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: legacy,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const res = await gw.runStructured({ ...base, cacheParts: ["1"], tier: "power" });
    expect(res.object).toEqual({ answer: "legacy" });
    expect(usage.entries[0]!.model).toBe("legacy-model");
  });
});
