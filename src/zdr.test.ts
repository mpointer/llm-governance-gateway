// ZDR-aware routing: retention is caller-asserted, missing = NOT ZDR
// (fail closed), chains skip non-eligible links, audit field recorded.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { ZdrViolationError } from "./errors.js";
import { ProviderRegistry } from "./providers.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import { MemoryBatchJobStore, type BatchClient } from "./batch.js";

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
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("nope");
    },
  } as unknown as LanguageModel;
}

const RETENTION = {
  anthropic: { zdr: true, note: "org ZDR addendum" },
  "openai:gpt-4.1-zdr": { zdr: true }, // model-specific assertion
  // openai (provider-level) deliberately absent → NOT ZDR
};

describe("registry.isZdr", () => {
  const r = new ProviderRegistry({ retention: RETENTION });
  it("fails closed on missing entries; model-specific beats provider", () => {
    expect(r.isZdr("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(r.isZdr("openai", "gpt-4.1")).toBe(false);
    expect(r.isZdr("openai", "gpt-4.1-zdr")).toBe(true);
    expect(r.isZdr("venice", "anything")).toBe(false);
    expect(new ProviderRegistry({}).isZdr("anthropic", "x")).toBe(false);
  });
  it("mock and cache are trivially ZDR", () => {
    expect(r.isZdr("mock", "mock")).toBe(true);
    expect(r.isZdr("cache", "cache")).toBe(true);
  });
});

describe("ZDR routing enforcement", () => {
  function gwWithChain(links: { provider: "anthropic" | "openai"; model: string }[]) {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: { retention: RETENTION },
      modelConfig: {
        getOverride: async () => null,
        getChain: async () =>
          links.map((l) => ({ ...l, languageModel: fakeLm(`via-${l.provider}`) })),
      },
      tasks: {
        defaults: { intake: "claude-sonnet-4-6" },
        constraints: { intake: { requireZdr: true } },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    return { gw, usage };
  }

  const opts = {
    slug: "q",
    schema: OutSchema,
    input: { q: "x" },
    variables: (i: { q: string }) => ({ q: i.q }),
    cache: false as const,
    anonKey: "t",
  };

  it("chain SKIPS non-ZDR links and runs the first eligible one", async () => {
    const { gw, usage } = gwWithChain([
      { provider: "openai", model: "gpt-4.1" }, // not ZDR → skipped
      { provider: "anthropic", model: "claude-sonnet-4-6" }, // ZDR → runs
    ]);
    const res = await gw.runStructured({ ...opts, requireZdr: true });
    expect(res.object.answer).toBe("via-anthropic");
    expect(usage.entries[0]!.zdrEnforced).toBe(true);
  });

  it("throws ZdrViolationError when the constraint eliminates every link", async () => {
    const { gw } = gwWithChain([{ provider: "openai", model: "gpt-4.1" }]);
    await expect(gw.runStructured({ ...opts, requireZdr: true })).rejects.toThrow(
      ZdrViolationError,
    );
  });

  it("without requireZdr the same chain runs its first link", async () => {
    const { gw, usage } = gwWithChain([{ provider: "openai", model: "gpt-4.1" }]);
    const res = await gw.runStructured(opts);
    expect(res.object.answer).toBe("via-openai");
    expect(usage.entries[0]!.zdrEnforced).toBeNull();
  });

  it("task constraint applies without a per-call flag", async () => {
    const { gw } = gwWithChain([{ provider: "openai", model: "gpt-4.1" }]);
    // task "intake" requires ZDR; task routing resolves to anthropic which IS
    // ZDR — but the task branch needs an API key for anthropic. Use the
    // chain-elimination case instead via task override store simulation:
    // simplest deterministic check — the task branch asserts before key lookup.
    const gw2 = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: { retention: {} }, // nothing is ZDR
      tasks: {
        defaults: { intake: "claude-sonnet-4-6" },
        constraints: { intake: { requireZdr: true } },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await expect(gw2.runStructured({ ...opts, task: "intake" })).rejects.toThrow(
      ZdrViolationError,
    );
    void gw;
  });

  it("streaming enforces the constraint on the resolved link", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: { retention: {} },
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "openai" as const, model: "gpt-4.1", languageModel: fakeLm("x") },
        ],
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await expect(
      gw.streamStructured({ ...opts, requireZdr: true }),
    ).rejects.toThrow(ZdrViolationError);
  });

  it("batch submit refuses a non-ZDR model when required", async () => {
    const client: BatchClient = {
      async submit() {
        throw new Error("must not be reached");
      },
      async check() {
        return { status: "ended" };
      },
      async *results() {},
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: { apiKeys: { anthropic: "sk" }, retention: {} },
      batch: { client, store: new MemoryBatchJobStore() },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await expect(
      gw.submitBatch(OutSchema, {
        slug: "q",
        model: "claude-haiku-4-5-20251001",
        items: [{ id: "a", variables: { q: "x" } }],
        requireZdr: true,
      }),
    ).rejects.toThrow(ZdrViolationError);
  });
});
