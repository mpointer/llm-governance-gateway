// Governed batch: fake BatchClient + MemoryBatchJobStore, zero network.
// Covers the design doc's hard-requirements list.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { SpendCapError } from "./errors.js";
import { MemoryCacheStore, MemoryUsageStore } from "./adapters/memory.js";
import {
  MemoryBatchJobStore,
  type BatchClient,
  type BatchResultItem,
} from "./batch.js";

const OutSchema = z.object({ answer: z.string() });

function succeeded(customId: string, input: unknown, inTok = 100, outTok = 50): BatchResultItem {
  return {
    customId,
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "tool_use", name: "emit_result", input }],
        usage: { input_tokens: inTok, output_tokens: outTok },
      },
    },
  };
}

function fakeBatchClient(resultItems: BatchResultItem[], statuses: string[] = ["ended"]) {
  const submitted: { customId: string; params: Record<string, unknown> }[][] = [];
  let checkIdx = 0;
  const client: BatchClient = {
    async submit(requests) {
      submitted.push(requests);
      return { id: "batch_123" };
    },
    async check() {
      const s = statuses[Math.min(checkIdx, statuses.length - 1)]!;
      checkIdx++;
      return { status: s };
    },
    async *results() {
      for (const item of resultItems) yield item;
    },
  };
  return { client, submitted };
}

function makeGw(client: BatchClient, over: { caps?: object; cache?: MemoryCacheStore } = {}) {
  const usage = new MemoryUsageStore();
  const store = new MemoryBatchJobStore();
  const gw = new Gateway({
    usage,
    cache: over.cache ?? new MemoryCacheStore(),
    promptDefaults: [{ slug: "extract", body: "Extract from: {{text}}", variables: ["text"] }],
    providers: { apiKeys: { anthropic: "sk-test" } },
    batch: { client, store },
    caps: over.caps ?? { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
  return { gw, usage, store };
}

const items = [
  { id: "a", variables: { text: "alpha" } },
  { id: "b", variables: { text: "beta" } },
];

describe("governed batch", () => {
  it("submits misses, reserves estimated cost, tracks the job", async () => {
    const { client, submitted } = fakeBatchClient([]);
    const { gw, usage, store } = makeGw(client);

    const res = await gw.submitBatch(OutSchema, {
      slug: "extract",
      model: "claude-haiku-4-5-20251001",
      items,
      userId: "u1",
    });
    expect(res.batchId).toBe("batch_123");
    expect(res.submittedCount).toBe(2);
    expect(res.reservedCents).toBeGreaterThan(0);

    // Forced structured output per item.
    const params = submitted[0]![0]!.params;
    expect((params.tool_choice as { type: string }).type).toBe("tool");

    // Reservation counts against caps immediately.
    const reserve = usage.entries.find((e) => e.route === "batch:reserve:extract");
    expect(reserve?.estimatedCostCents).toBeCloseTo(res.reservedCents, 10);

    const job = await store.getJob("batch_123");
    expect(job?.status).toBe("submitted");
    expect(job?.reservedCents).toBeCloseTo(res.reservedCents, 10);
  });

  it("maxCostCents is a hard ceiling: fails fast, submits nothing", async () => {
    const { client, submitted } = fakeBatchClient([]);
    const { gw, usage } = makeGw(client);
    await expect(
      gw.submitBatch(OutSchema, {
        slug: "extract",
        model: "claude-haiku-4-5-20251001",
        items,
        maxCostCents: 0.000001,
      }),
    ).rejects.toThrow(/exceeds maxCostCents/);
    expect(submitted).toHaveLength(0);
    expect(usage.entries).toHaveLength(0);
  });

  it("spend cap sees the projected reservation", async () => {
    const { client } = fakeBatchClient([]);
    const { gw, usage } = makeGw(client, { caps: { globalDailyCents: 0.001 } });
    await expect(
      gw.submitBatch(OutSchema, {
        slug: "extract",
        model: "claude-haiku-4-5-20251001",
        items,
      }),
    ).rejects.toThrow(SpendCapError);
    expect(usage.capEvents).toHaveLength(1);
  });

  it("cache pre-check serves hits and submits only misses", async () => {
    const cache = new MemoryCacheStore();
    const { client, submitted } = fakeBatchClient([]);
    const { gw } = makeGw(client, { cache });
    // Prime the cache for item "a" using the same key derivation.
    const { cacheKey } = await import("./gateway.js");
    await cache.set(
      cacheKey("extract", [JSON.stringify({ text: "alpha" })]),
      { answer: "cached-alpha" },
      3600,
    );
    const res = await gw.submitBatch(OutSchema, {
      slug: "extract",
      model: "claude-haiku-4-5-20251001",
      items,
    });
    expect(res.cached).toEqual([{ id: "a", object: { answer: "cached-alpha" } }]);
    expect(res.submittedCount).toBe(1);
    expect(submitted[0]).toHaveLength(1);
    expect(submitted[0]![0]!.customId).toBe("b");
  });

  it("all-cached: nothing submitted, no reservation", async () => {
    const cache = new MemoryCacheStore();
    const { client, submitted } = fakeBatchClient([]);
    const { gw, usage } = makeGw(client, { cache });
    const { cacheKey } = await import("./gateway.js");
    for (const it2 of items) {
      await cache.set(
        cacheKey("extract", [JSON.stringify(it2.variables)]),
        { answer: "c" },
        3600,
      );
    }
    const res = await gw.submitBatch(OutSchema, {
      slug: "extract",
      model: "claude-haiku-4-5-20251001",
      items,
    });
    expect(res.batchId).toBeNull();
    expect(submitted).toHaveLength(0);
    expect(usage.entries).toHaveLength(0);
  });

  it("reconcile: validates items, logs discounted actuals, releases reservation; net = actuals", async () => {
    const { client } = fakeBatchClient([
      succeeded("a", { answer: "A" }),
      succeeded("b", { wrong: true }), // schema-invalid
      { customId: "c", result: { type: "expired" } },
    ]);
    const { gw, usage } = makeGw(client);
    const sub = await gw.submitBatch(OutSchema, {
      slug: "extract",
      model: "claude-haiku-4-5-20251001",
      items: [...items, { id: "c", variables: { text: "gamma" } }],
    });
    await gw.pollBatch("batch_123");
    const rec = await gw.reconcileBatch("batch_123", OutSchema);

    expect(rec.alreadyReconciled).toBe(false);
    expect(rec.results).toEqual([
      { id: "a", ok: true, object: { answer: "A" } },
      expect.objectContaining({ id: "b", ok: false, reason: "schema" }),
      { id: "c", ok: false, reason: "expired" },
    ]);

    // Two succeeded items billed (schema-invalid still consumed tokens);
    // expired item billed nothing.
    const itemRows = usage.entries.filter((e) => e.route === "batch:extract");
    expect(itemRows).toHaveLength(2);
    // 50% discount: haiku in .08/1K out .4/1K → (100*.08+50*.4)/1000 * .5
    expect(itemRows[0]!.estimatedCostCents).toBeCloseTo(((100 * 0.08 + 50 * 0.4) / 1000) * 0.5, 10);
    expect(itemRows[0]!.traceId).toBe("batch_123:a");

    // Reservation fully released: net spend = sum of actuals.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const net = await usage.sumSpendCents(today);
    expect(net).toBeCloseTo(rec.costCents, 10);
    expect(net).toBeLessThan(sub.reservedCents); // estimate was conservative
  });

  it("second reconcile is a no-op returning the stored summary", async () => {
    const { client } = fakeBatchClient([succeeded("a", { answer: "A" })]);
    const { gw, usage } = makeGw(client);
    await gw.submitBatch(OutSchema, {
      slug: "extract",
      model: "claude-haiku-4-5-20251001",
      items: [items[0]!],
    });
    const first = await gw.reconcileBatch("batch_123", OutSchema);
    const rowsAfterFirst = usage.entries.length;
    const second = await gw.reconcileBatch("batch_123", OutSchema);
    expect(second.alreadyReconciled).toBe(true);
    expect(second.costCents).toBeCloseTo(first.costCents, 10);
    expect(usage.entries).toHaveLength(rowsAfterFirst); // nothing re-logged
  });

  it("rejects non-Anthropic model resolution", async () => {
    const { client } = fakeBatchClient([]);
    const { gw } = makeGw(client);
    await expect(
      gw.submitBatch(OutSchema, { slug: "extract", model: "openai:gpt-4.1", items }),
    ).rejects.toThrow(/Anthropic models only/);
  });
});
