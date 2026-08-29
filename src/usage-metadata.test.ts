// Caller-defined usage metadata (issue #12).
//
// The reported failure was not "there is no field" but "attribution is lost":
// an adopter tracking cost along an axis the gateway has no opinion on (a
// background-job run id) had to drop it for every gateway-routed call. So the
// tests here check that metadata reaches the LEDGER on each path that writes a
// row — including the ones that are easy to forget: cache hits, the judge, and
// timed-out attempts.

import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";

const OutSchema = z.object({ answer: z.string() });

const RUN = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
};

const META = { agentRunId: "run-42", campaign: "spring" };

function mockGw(usage: MemoryUsageStore, extra: object = {}) {
  const gw = new Gateway({
    usage,
    mock: true,
    promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...extra,
  });
  gw.registerMockResponder("q", () => ({ answer: "ok" }));
  return gw;
}

describe("usage metadata", () => {
  it("reaches the ledger on runStructured", async () => {
    const usage = new MemoryUsageStore();
    await mockGw(usage).runStructured({ ...RUN, cache: false, metadata: META });
    expect(usage.entries[0]!.metadata).toEqual(META);
  });

  it("reaches the ledger on runText", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      mock: true,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    gw.registerMockResponder("q", () => "plain text");
    await gw.runText({ ...RUN, cache: false, metadata: META });
    expect(usage.entries[0]!.metadata).toEqual(META);
  });

  it("reaches the ledger on embed", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await gw.embed(["a"], { dimensions: 8, metadata: META });
    expect(usage.entries[0]!.metadata).toEqual(META);
  });

  it("is on the CACHE-HIT row too, not just the generating call", async () => {
    // The cache hit writes its own zero-token row. If metadata only rode along
    // on generation, a cached-heavy workload would lose most of its
    // attribution — the failure mode is silent and proportional to hit rate.
    const usage = new MemoryUsageStore();
    const gw = mockGw(usage);
    await gw.runStructured({ ...RUN, cacheParts: ["k"], metadata: META });
    await gw.runStructured({ ...RUN, cacheParts: ["k"], metadata: META });

    expect(usage.entries).toHaveLength(2);
    expect(usage.entries[1]!.cacheHit).toBe(true);
    expect(usage.entries[1]!.metadata).toEqual(META);
  });

  it("a cache hit carries the CURRENT call's metadata, not the stored one", async () => {
    // Two different runs can share a cache entry; the row must attribute to
    // whoever made this call.
    const usage = new MemoryUsageStore();
    const gw = mockGw(usage);
    await gw.runStructured({ ...RUN, cacheParts: ["k"], metadata: { agentRunId: "first" } });
    await gw.runStructured({ ...RUN, cacheParts: ["k"], metadata: { agentRunId: "second" } });

    expect(usage.entries[1]!.cacheHit).toBe(true);
    expect(usage.entries[1]!.metadata).toEqual({ agentRunId: "second" });
  });

  it("is on the judge's own usage row", async () => {
    // Judge spend is logged under route "judge:<route>" precisely so eval cost
    // is visible. It should be attributable on the same axis as the call.
    const usage = new MemoryUsageStore();
    const gw = mockGw(usage);
    // The judge responder returns a flat criterion -> score record.
    gw.registerMockResponder("judge:q", () => ({ grounded: 5 }));

    await gw.runStructured({
      ...RUN,
      cache: false,
      metadata: META,
      judge: { criteria: { grounded: "is grounded" }, sampleRate: 1 },
    });

    const judgeRow = usage.entries.find((e) => e.route?.startsWith("judge:"));
    expect(judgeRow).toBeDefined();
    expect(judgeRow!.metadata).toEqual(META);
  });

  it("is on the zero-token row written when an attempt times out", async () => {
    // The ledger-first principle: a provider call that may have spent money
    // leaves a row. That row is useless for attribution if it drops metadata.
    const usage = new MemoryUsageStore();
    const hang: LanguageModel = {
      specificationVersion: "v2",
      provider: "slow",
      modelId: "slow",
      supportedUrls: {},
      async doGenerate({ abortSignal }: { abortSignal?: AbortSignal }) {
        return await new Promise((_r, rej) => {
          abortSignal?.addEventListener("abort", () => rej(abortSignal.reason));
        });
      },
      async doStream() {
        throw new Error("unused");
      },
    } as unknown as LanguageModel;

    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "slow", languageModel: hang },
        ],
      },
    });

    await expect(
      gw.runStructured({ ...RUN, cache: false, metadata: META, attemptMs: 1000 }),
    ).rejects.toThrow();

    // The aborted-attempt row is written fire-and-forget; let it land.
    await vi.waitFor(() => expect(usage.entries.length).toBeGreaterThan(0));
    expect(usage.entries[0]!.metadata).toEqual(META);
  });

  it("is absent, not empty, when the caller passes none", async () => {
    const usage = new MemoryUsageStore();
    await mockGw(usage).runStructured({ ...RUN, cache: false });
    expect(usage.entries[0]!.metadata).toBeUndefined();
  });

  it("reaches the observability hook alongside the row", async () => {
    const seen: (Record<string, unknown> | null | undefined)[] = [];
    const usage = new MemoryUsageStore();
    const gw = mockGw(usage, {
      observability: {
        onUsage: (e: { metadata?: Record<string, unknown> | null }) =>
          void seen.push(e.metadata),
      },
    });
    await gw.runStructured({ ...RUN, cache: false, metadata: META });
    expect(seen).toContainEqual(META);
  });

  it("the gateway never reads it: it is not part of the cache key", async () => {
    // If metadata leaked into the cache key, every distinct agentRunId would
    // miss — turning an attribution field into a silent cache-busting bug.
    const usage = new MemoryUsageStore();
    const gw = mockGw(usage);
    await gw.runStructured({ ...RUN, cacheParts: ["k"], metadata: { agentRunId: "a" } });
    const second = await gw.runStructured({
      ...RUN,
      cacheParts: ["k"],
      metadata: { agentRunId: "b" },
    });

    expect(second.cacheHit).toBe(true);
  });
});
