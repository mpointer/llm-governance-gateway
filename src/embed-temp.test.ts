// Harvest issues from the ProjectFlowAI adoption:
// per-link temperature overrides + governed embeddings.

import { describe, expect, it } from "vitest";
import type { EmbeddingModel, LanguageModel } from "ai";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { SpendCapError } from "./errors.js";
import { mockEmbedding } from "./embeddings.js";
import { MemoryUsageStore } from "./adapters/memory.js";

const OutSchema = z.object({ answer: z.string() });

function tempRecordingLm(answer: string): { lm: LanguageModel; temps: (number | undefined)[] } {
  const temps: (number | undefined)[] = [];
  return {
    temps,
    lm: {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "fake",
      supportedUrls: {},
      async doGenerate(options: { temperature?: number }) {
        temps.push(options.temperature);
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
    } as unknown as LanguageModel,
  };
}

const runOpts = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  anonKey: "t",
};

describe("per-link temperature", () => {
  it("null suppresses call-level temperature; a number pins it; unset inherits", async () => {
    const a = tempRecordingLm("a"); // link temp: null  → never send
    const b = tempRecordingLm("b"); // link temp: 0.3   → pinned
    const c = tempRecordingLm("c"); // unset            → call-level
    const mk = (link: object, lm: LanguageModel) =>
      new Gateway({
        usage: new MemoryUsageStore(),
        promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
        modelConfig: {
          getOverride: async () => null,
          getChain: async () => [
            { provider: "anthropic" as const, model: "m", languageModel: lm, ...link },
          ],
        },
        caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
      });

    await mk({ temperature: null }, a.lm).runStructured({ ...runOpts, temperature: 0.9 });
    await mk({ temperature: 0.3 }, b.lm).runStructured({ ...runOpts, temperature: 0.9 });
    await mk({}, c.lm).runStructured({ ...runOpts, temperature: 0.9 });

    expect(a.temps).toEqual([undefined]); // suppressed despite call-level 0.9
    expect(b.temps).toEqual([0.3]); // link pin beats call
    expect(c.temps).toEqual([0.9]); // inherits call level
  });
});

describe("governed embeddings", () => {
  it("mock mode: deterministic unit vectors, usage ledgered", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const r1 = await gw.embed(["alpha", "beta"], { route: "test", dimensions: 64 });
    const r2 = await gw.embed(["alpha"], { dimensions: 64 });
    expect(r1.embeddings).toHaveLength(2);
    expect(r1.embeddings[0]).toHaveLength(64);
    expect(r1.embeddings[0]).toEqual(r2.embeddings[0]); // identical input → identical vector
    const norm = Math.sqrt(r1.embeddings[0]!.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(usage.entries[0]!.route).toBe("test");
    expect(usage.entries[0]!.outputTokens).toBe(0);
  });

  it("mockEmbedding matches the ported ProjectFlowAI shape", () => {
    const v = mockEmbedding("hello");
    expect(v).toHaveLength(1536);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it("BYO embedding model: real tokens ledgered at real pricing", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const fake = {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "text-embedding-3-small",
      maxEmbeddingsPerCall: 100,
      supportsParallelCalls: true,
      async doEmbed({ values }: { values: string[] }) {
        return {
          embeddings: values.map(() => [0.6, 0.8]),
          usage: { tokens: 42 },
        };
      },
    } as unknown as EmbeddingModel;

    const res = await gw.embed(["a", "b"], {
      model: "openai:text-embedding-3-small",
      embeddingModel: fake,
      userId: "u1",
    });
    expect(res.embeddings).toEqual([[0.6, 0.8], [0.6, 0.8]]);
    expect(res.inputTokens).toBe(42);
    // 42 tokens at 0.002¢/1K
    expect(usage.entries[0]!.estimatedCostCents).toBeCloseTo((42 * 0.002) / 1000, 12);
  });

  it("spend caps govern embeddings too", async () => {
    const usage = new MemoryUsageStore();
    await usage.logUsage({
      userId: "u1",
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
      mock: true,
      caps: { userDailyCents: 200, globalDailyCents: 0 },
    });
    await expect(gw.embed(["x"], { userId: "u1" })).rejects.toThrow(SpendCapError);
  });

  it("empty input short-circuits without ledger noise", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({ usage, mock: true });
    const res = await gw.embed([]);
    expect(res.embeddings).toEqual([]);
    expect(usage.entries).toHaveLength(0);
  });
});
