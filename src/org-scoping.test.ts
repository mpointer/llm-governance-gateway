// Multi-tenant org scoping (critique finding 3.1).
//
// The requirement is ISOLATION: one gateway instance serving several tenants
// must not let one tenant's spend, cache, chain, prompts or task overrides
// reach another. Every test here asserts isolation, not merely that an orgId
// was accepted.
//
// The other half is backward compatibility: an unscoped caller must behave
// exactly as it did before org scoping existed. That is asserted too — it is
// the constraint most easily broken by a change like this.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway, cacheKey } from "./gateway.js";
import { SpendCapError } from "./errors.js";
import { MemoryUsageStore, MemoryPromptStore } from "./adapters/memory.js";
import type { StoredPrompt, PromptStore, ModelConfigStore } from "./types.js";

const OutSchema = z.object({ answer: z.string() });

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

const base = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cacheParts: ["k"],
};

describe("org scoping: cache key", () => {
  it("namespaces by tenant and leaves unscoped keys byte-identical", () => {
    const unscoped = cacheKey("slug", ["a"]);
    expect(unscoped).toBe(cacheKey("slug", ["a"], undefined));
    expect(unscoped.startsWith("aicache:slug:")).toBe(true); // pre-org shape
    const orgA = cacheKey("slug", ["a"], "orgA");
    const orgB = cacheKey("slug", ["a"], "orgB");
    expect(orgA).not.toBe(orgB);
    expect(orgA).not.toBe(unscoped);
  });

  it("one tenant never reads another's cached answer", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    let n = 0;
    gw.registerMockResponder("q", () => ({ answer: `call-${++n}` }));

    const a = await gw.runStructured({ ...base, orgId: "orgA" });
    const b = await gw.runStructured({ ...base, orgId: "orgB" });
    const a2 = await gw.runStructured({ ...base, orgId: "orgA" });

    expect(a.object).toEqual({ answer: "call-1" });
    // Same slug and cacheParts, different tenant: must be a MISS.
    expect(b.object).toEqual({ answer: "call-2" });
    expect(b.cacheHit).toBe(false);
    // ...and orgA still hits its own entry.
    expect(a2.cacheHit).toBe(true);
    expect(a2.object).toEqual({ answer: "call-1" });
  });
});

describe("org scoping: ledger and spend caps", () => {
  it("stamps the tenant on every usage row", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    gw.registerMockResponder("q", () => ({ answer: "a" }));
    await gw.runStructured({ ...base, orgId: "orgA" });
    expect(usage.entries[0]!.orgId).toBe("orgA");
  });

  it("one tenant's spend does not trip another tenant's circuit breaker", async () => {
    const usage = new MemoryUsageStore();
    // orgA has already burned well past the breaker.
    await usage.logUsage({
      orgId: "orgA",
      provider: "x",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 10_000,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      mock: true,
      caps: { globalDailyCents: 5_000 },
    });
    gw.registerMockResponder("q", () => ({ answer: "a" }));

    // orgA is blocked...
    await expect(
      gw.runStructured({ ...base, orgId: "orgA", cacheParts: ["1"] }),
    ).rejects.toThrow(SpendCapError);
    // ...and orgB is entirely unaffected. This is the isolation failure that
    // org scoping exists to prevent.
    const b = await gw.runStructured({ ...base, orgId: "orgB", cacheParts: ["2"] });
    expect(b.object).toEqual({ answer: "a" });
  });

  it("an unscoped gateway still sums across everything (pre-org behavior)", async () => {
    const usage = new MemoryUsageStore();
    await usage.logUsage({
      orgId: "orgA",
      provider: "x",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 10_000,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      mock: true,
      caps: { globalDailyCents: 5_000 },
    });
    gw.registerMockResponder("q", () => ({ answer: "a" }));
    // No orgId anywhere: the breaker sees ALL spend, exactly as before.
    await expect(gw.runStructured({ ...base })).rejects.toThrow(SpendCapError);
  });

  it("enforces an explicit per-org cap and records the event with the tenant", async () => {
    const usage = new MemoryUsageStore();
    await usage.logUsage({
      orgId: "orgA",
      provider: "x",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 300,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      mock: true,
      caps: { globalDailyCents: 0, userDailyCents: 0, anonDailyCents: 0, orgDailyCents: 200 },
    });
    gw.registerMockResponder("q", () => ({ answer: "a" }));
    await expect(gw.runStructured({ ...base, orgId: "orgA" })).rejects.toThrow(SpendCapError);
    // The ledger-first principle: the cap event names the tenant.
    expect(usage.capEvents.at(-1)!.orgId).toBe("orgA");
    // A different tenant is untouched by orgA's cap.
    await expect(
      gw.runStructured({ ...base, orgId: "orgB", cacheParts: ["z"] }),
    ).resolves.toBeTruthy();
  });
});

describe("org scoping: chains, prompts and task overrides", () => {
  it("resolves a different chain per tenant", async () => {
    const usage = new MemoryUsageStore();
    const store: ModelConfigStore = {
      getOverride: async () => null,
      getChain: async (orgId) => [
        {
          provider: "anthropic" as const,
          model: orgId === "orgB" ? "b-model" : "a-model",
          languageModel: lm(orgId === "orgB" ? "from-B" : "from-A"),
        },
      ],
    };
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const a = await gw.runStructured({ ...base, cache: false, cacheParts: undefined, orgId: "orgA" });
    const b = await gw.runStructured({ ...base, cache: false, cacheParts: undefined, orgId: "orgB" });
    expect(a.object).toEqual({ answer: "from-A" });
    expect(b.object).toEqual({ answer: "from-B" });
    expect(usage.entries[0]!.model).toBe("a-model");
    expect(usage.entries[1]!.model).toBe("b-model");
  });

  it("resolves a different prompt per tenant, falling back to the global one", async () => {
    const store = new MemoryPromptStore();
    await store.seedPrompt({ slug: "q", body: "GLOBAL {{q}}", variables: ["q"] });
    await store.seedPrompt({ slug: "q", body: "ORG-A {{q}}", variables: ["q"] }, "orgA");

    expect((await store.getPrompt("q", "orgA"))!.body).toBe("ORG-A {{q}}");
    // orgB has no override, so it inherits the shared prompt rather than 404ing.
    expect((await store.getPrompt("q", "orgB"))!.body).toBe("GLOBAL {{q}}");
    expect((await store.getPrompt("q"))!.body).toBe("GLOBAL {{q}}");
  });

  it("task overrides are cached PER TENANT, not shared", async () => {
    const seen: (string | null | undefined)[] = [];
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
      tasks: {
        defaults: { summarize: "anthropic:default-model" },
        store: {
          getOverrides: async (orgId) => {
            seen.push(orgId);
            return orgId === "orgB" ? { summarize: "anthropic:b-model" } : {};
          },
        },
      },
    });

    expect((await gw.tasks!.modelForTask("summarize", "orgA")).model).toBe("default-model");
    expect((await gw.tasks!.modelForTask("summarize", "orgB")).model).toBe("b-model");
    // Both tenants were resolved independently: a single shared TTL cache
    // would have served orgA's empty overrides to orgB.
    expect(seen).toEqual(["orgA", "orgB"]);
  });
});

describe("org scoping: backward compatibility", () => {
  it("a store that ignores orgId entirely still works", async () => {
    // The SPI widening must not require implementers to change anything.
    const legacy: PromptStore = {
      async getPrompt(slug: string): Promise<StoredPrompt | undefined> {
        return { slug, body: "LEGACY {{q}}", modelHint: null };
      },
    };
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      prompts: legacy,
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    gw.registerMockResponder("q", () => ({ answer: "ok" }));
    const res = await gw.runStructured({ ...base, orgId: "orgA" });
    expect(res.object).toEqual({ answer: "ok" });
  });

  it("GatewayConfig.orgId is the default and per-call orgId wins", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      orgId: "config-org",
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    gw.registerMockResponder("q", () => ({ answer: "a" }));
    await gw.runStructured({ ...base, cacheParts: ["1"] });
    await gw.runStructured({ ...base, cacheParts: ["2"], orgId: "call-org" });
    expect(usage.entries[0]!.orgId).toBe("config-org");
    expect(usage.entries[1]!.orgId).toBe("call-org");
  });

  it("an unscoped call writes a null-org row, as before", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    gw.registerMockResponder("q", () => ({ answer: "a" }));
    await gw.runStructured({ ...base });
    expect(usage.entries[0]!.orgId).toBeNull();
  });
});
