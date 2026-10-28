// Guardrail parity across the four governed paths, plus the cache-hit
// contract. 0.16.0 ran the hooks on runStructured only; the shared front
// door (gateway.ts frontDoor / applyPostGuardrail) is what makes these the
// same policy on runText, streamStructured and batch. Every test here runs
// one hook configuration through a path and reads the verdict back off the
// ledger row, which is the only place policy is supposed to be visible.

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { GuardrailError } from "./errors.js";
import { MemoryCacheStore, MemoryUsageStore } from "./adapters/memory.js";
import { MemoryBatchJobStore, type BatchClient, type BatchResultItem } from "./batch.js";
import type { GuardrailConfig } from "./guardrails.js";
import type { ModelConfigStore } from "./types.js";

const OutSchema = z.object({ answer: z.string() });

function make(guardrails: GuardrailConfig | undefined, cache = new MemoryCacheStore()) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    cache,
    promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
    mock: true,
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    guardrails,
  });
  gw.registerMockResponder("sum", (input) => ({ answer: `echo:${(input as { t: string }).t}` }));
  return { gw, usage };
}

const base = {
  slug: "sum",
  input: { t: "hello" },
  variables: (i: { t: string }) => ({ t: i.t }),
  userId: "u1",
  route: "test",
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("runText", () => {
  it("pre block: zero-token row, no responder call, GuardrailError", async () => {
    let calls = 0;
    const { gw, usage } = make({ pre: () => ({ action: "block", reason: "pii" }) });
    gw.registerMockResponder("sum", () => {
      calls++;
      return "x";
    });
    const err = await gw.runText({ ...base, cache: false }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.hook).toBe("pre");
    expect(calls).toBe(0);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]).toMatchObject({ provider: "guardrail", model: "pre", inputTokens: 0 });
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "pre", action: "block" });
  });

  it("pre transform: the rewritten prompt is what is ledgered", async () => {
    const { gw, usage } = make({
      pre: (ctx) => ({ action: "transform", prompt: ctx.prompt.replace("hello", "[x]") }),
    });
    const res = await gw.runText({ ...base, cache: false });
    const row = usage.entries.find((e) => e.id === res.usageLogId)!;
    expect(row.inputText).toBe("Summarize: [x]");
    expect(row.guardrails?.[0]).toMatchObject({ hook: "pre", action: "transform" });
  });

  it("post transform: the caller and the cache get the transformed text", async () => {
    const cache = new MemoryCacheStore();
    const { gw, usage } = make(
      { post: () => ({ action: "transform", output: "scrubbed" }) },
      cache,
    );
    const res = await gw.runText({ ...base, cacheParts: ["k"] });
    expect(res.text).toBe("scrubbed");
    expect(usage.entries[0]!.outputText).toBe("scrubbed");
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "transform" });
    const again = await gw.runText({ ...base, cacheParts: ["k"] });
    expect(again.cacheHit).toBe(true);
    expect(again.text).toBe("scrubbed");
  });

  it("post transform to a non-string is a block (fail closed) with the error recorded", async () => {
    const { gw, usage } = make({ post: () => ({ action: "transform", output: { nope: 1 } }) });
    const err = await gw.runText({ ...base, cache: false }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.reason).toMatch(/must transform to a string/);
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "block" });
  });

  it("post block: the row carries the spent tokens and the error carries the text", async () => {
    const { gw, usage } = make({ post: () => ({ action: "block", reason: "crisis" }) });
    // runText stringifies the responder's value; give it text.
    gw.registerMockResponder("sum", (input) => `echo:${(input as { t: string }).t}`);
    const err = await gw.runText({ ...base, cache: false }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.output).toBe("echo:hello");
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.provider).toBe("mock");
    expect(usage.entries[0]!.inputTokens).toBeGreaterThan(0);
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "block" });
  });

  it("no hooks: the row's guardrails is NULL, as before", async () => {
    const { gw, usage } = make(undefined);
    await gw.runText({ ...base, cache: false });
    expect(usage.entries[0]!.guardrails).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("streamStructured", () => {
  const sopts = { ...base, schema: OutSchema, cache: false as const };

  it("pre block throws before any stream is opened", async () => {
    const { gw, usage } = make({ pre: () => ({ action: "block", reason: "pii" }) });
    const err = await gw.streamStructured(sopts).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]).toMatchObject({ provider: "guardrail", model: "pre" });
  });

  it("post transform: object resolves to the transformed value and the row says so", async () => {
    const { gw, usage } = make({
      post: () => ({ action: "transform", output: { answer: "scrubbed" }, reason: "scrub" }),
    });
    const res = await gw.streamStructured(sopts);
    expect(await res.object).toEqual({ answer: "scrubbed" });
    expect(usage.entries[0]!.outputText).toBe(JSON.stringify({ answer: "scrubbed" }));
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "transform" });
  });

  it("post block: object rejects with GuardrailError, the row is written, no failover", async () => {
    const { gw, usage } = make({ post: () => ({ action: "block", reason: "crisis" }) });
    const err = await gw.streamStructured(sopts).catch((e) => e);
    // Mock mode finalizes synchronously, so the block surfaces on the call.
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.output).toEqual({ answer: "echo:hello" });
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.provider).toBe("mock");
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "block" });
  });

  it("both hooks: the row carries pre then post", async () => {
    const { gw, usage } = make({
      pre: () => ({ action: "allow" }),
      post: () => ({ action: "allow" }),
    });
    const res = await gw.streamStructured(sopts);
    await res.object;
    expect(usage.entries[0]!.guardrails?.map((g) => g.hook)).toEqual(["pre", "post"]);
  });
});

// ---------------------------------------------------------------------------
describe("cache hits run the hooks too", () => {
  const sopts = { ...base, schema: OutSchema, cacheParts: ["k"] };

  it("a pre policy that blocks the second caller blocks even though the value is cached", async () => {
    const { gw, usage } = make({
      pre: (ctx) =>
        ctx.userId === "banned" ? { action: "block", reason: "banned user" } : { action: "allow" },
    });
    const first = await gw.runStructured(sopts);
    expect(first.cacheHit).toBe(false);
    const err = await gw.runStructured({ ...sopts, userId: "banned" }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.hook).toBe("pre");
    // Zero-token guardrail row, not a cache row.
    expect(usage.entries[1]).toMatchObject({
      provider: "guardrail",
      model: "pre",
      cacheHit: false,
    });
  });

  it("a post transform applies to a hit and is NOT written back to the cache", async () => {
    const cache = new MemoryCacheStore();
    const { gw, usage } = make(undefined, cache);
    const first = await gw.runStructured(sopts);
    expect(first.object).toEqual({ answer: "echo:hello" });

    // Same cache, a gateway that now has a post policy.
    const { gw: gw2, usage: usage2 } = make(
      { post: () => ({ action: "transform", output: { answer: "redacted" } }) },
      cache,
    );
    const hit = await gw2.runStructured(sopts);
    expect(hit.cacheHit).toBe(true);
    expect(hit.object).toEqual({ answer: "redacted" });
    expect(usage2.entries[0]).toMatchObject({ provider: "cache", cacheHit: true });
    expect(usage2.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "transform" });
    // The stored value is untouched: a gateway without the policy still sees the original.
    const again = await gw.runStructured(sopts);
    expect(again.object).toEqual({ answer: "echo:hello" });
    expect(usage.entries).toHaveLength(2);
  });

  it("a post block on a hit writes the cache row with the verdict and throws", async () => {
    const cache = new MemoryCacheStore();
    const { gw } = make(undefined, cache);
    await gw.runStructured(sopts);
    const { gw: gw2, usage: usage2 } = make(
      { post: () => ({ action: "block", reason: "stale policy" }) },
      cache,
    );
    const err = await gw2.runStructured(sopts).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.output).toEqual({ answer: "echo:hello" });
    expect(usage2.entries).toHaveLength(1);
    expect(usage2.entries[0]).toMatchObject({ provider: "cache", cacheHit: true });
    expect(usage2.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "block" });
  });

  it("a plain hit with no hooks is unchanged: one cache row, guardrails NULL", async () => {
    const { gw, usage } = make(undefined);
    await gw.runStructured(sopts);
    const hit = await gw.runStructured(sopts);
    expect(hit.cacheHit).toBe(true);
    expect(usage.entries[1]).toMatchObject({ provider: "cache", cacheHit: true, guardrails: null });
  });
});

// ---------------------------------------------------------------------------
describe("batch", () => {
  function succeeded(customId: string, input: unknown): BatchResultItem {
    return {
      customId,
      result: {
        type: "succeeded",
        message: {
          content: [{ type: "tool_use", name: "emit_result", input }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    };
  }
  function fakeClient(resultItems: BatchResultItem[]) {
    const submitted: { customId: string }[][] = [];
    const client: BatchClient = {
      async submit(requests) {
        submitted.push(requests);
        return { id: "batch_1" };
      },
      async check() {
        return { status: "ended" };
      },
      async *results() {
        for (const item of resultItems) yield item;
      },
    };
    return { client, submitted };
  }
  function makeBatch(client: BatchClient, guardrails: GuardrailConfig) {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      cache: new MemoryCacheStore(),
      promptDefaults: [{ slug: "extract", body: "Extract from: {{text}}", variables: ["text"] }],
      providers: { apiKeys: { anthropic: "sk-test" } },
      batch: { client, store: new MemoryBatchJobStore() },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
      guardrails,
    });
    return { gw, usage };
  }
  const items = [
    { id: "a", variables: { text: "clean" } },
    { id: "b", variables: { text: "ssn 123-45-6789" } },
  ];

  it("submit: a pre block excludes the item, ledgers a zero-token row, and reports it", async () => {
    const { client, submitted } = fakeClient([]);
    const { gw, usage } = makeBatch(client, {
      pre: (ctx) =>
        /\d{3}-\d{2}-\d{4}/.test(ctx.prompt)
          ? { action: "block", reason: "ssn" }
          : { action: "allow", reason: "clean" },
    });
    const res = await gw.submitBatch(OutSchema, { slug: "extract", items, userId: "u1" });
    expect(res.blocked).toEqual([{ id: "b", reason: "ssn" }]);
    expect(res.submittedCount).toBe(1);
    expect(submitted[0]!.map((r) => r.customId)).toEqual(["a"]);
    const blockRow = usage.entries.find((e) => e.provider === "guardrail")!;
    expect(blockRow).toMatchObject({
      model: "pre",
      inputTokens: 0,
      traceId: "batch:guardrail:extract:b",
    });
    // The allowed item's verdict rides the reservation row, tagged with its id.
    const reserve = usage.entries.find((e) => e.route === "batch:reserve:extract")!;
    expect(reserve.guardrails).toEqual([
      expect.objectContaining({ hook: "pre", action: "allow", detail: { batchItemId: "a" } }),
    ]);
  });

  it("submit: every item blocked means nothing is submitted", async () => {
    const { client, submitted } = fakeClient([]);
    const { gw } = makeBatch(client, { pre: () => ({ action: "block", reason: "no" }) });
    const res = await gw.submitBatch(OutSchema, { slug: "extract", items, userId: "u1" });
    expect(res.batchId).toBeNull();
    expect(res.blocked.map((b) => b.id)).toEqual(["a", "b"]);
    expect(submitted).toHaveLength(0);
  });

  it("reconcile: a post block marks the item reason 'guardrail' and the item row carries the verdict", async () => {
    const { client } = fakeClient([
      succeeded("a", { answer: "fine" }),
      succeeded("b", { answer: "self-harm content" }),
    ]);
    const { gw, usage } = makeBatch(client, {
      post: (ctx) =>
        String((ctx.output as { answer: string }).answer).includes("self-harm")
          ? { action: "block", reason: "crisis" }
          : { action: "transform", output: { answer: "ok" } },
    });
    const sub = await gw.submitBatch(OutSchema, { slug: "extract", items, userId: "u1" });
    const rec = await gw.reconcileBatch(sub.batchId!, OutSchema);
    expect(rec.results).toEqual([
      { id: "a", ok: true, object: { answer: "ok" } },
      { id: "b", ok: false, reason: "guardrail", error: "crisis" },
    ]);
    const rowA = usage.entries.find((e) => e.traceId === "batch_1:a")!;
    const rowB = usage.entries.find((e) => e.traceId === "batch_1:b")!;
    expect(rowA.guardrails?.[0]).toMatchObject({ hook: "post", action: "transform" });
    expect(rowB.guardrails?.[0]).toMatchObject({ hook: "post", action: "block", reason: "crisis" });
    // Blocked items were still billed: the tokens were spent.
    expect(rowB.inputTokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
describe("admin pin shadowing a task warns once (#57)", () => {
  it("warns the first time a task is ignored in favor of the pin, not again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store: ModelConfigStore = {
      getOverride: async () => ({ provider: "anthropic", model: "pinned-model" }),
      getChain: async () => [],
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
      modelConfig: store,
      tasks: { defaults: { enrich: "claude-haiku-4-5-20251001" } },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const call = () =>
      gw
        .runStructured({ ...base, schema: OutSchema, cache: false, task: "enrich" })
        .catch((e: Error) => e.message);
    // No API key is configured, so the pinned link cannot run; the warning
    // fires during resolution, before that error.
    expect(await call()).toMatch(/No API key/);
    expect(await call()).toMatch(/No API key/);
    const shadow = warn.mock.calls.filter((c) => String(c[0]).includes("#57"));
    expect(shadow).toHaveLength(1);
    expect(String(shadow[0]![0])).toContain('task "enrich" is shadowed');
    expect(String(shadow[0]![0])).toContain("anthropic/pinned-model");
  });

  it("does not warn when the call names no task", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store: ModelConfigStore = {
      getOverride: async () => ({ provider: "anthropic", model: "pinned-model" }),
      getChain: async () => [],
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
      modelConfig: store,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await gw.runStructured({ ...base, schema: OutSchema, cache: false }).catch(() => {});
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("#57"))).toHaveLength(0);
  });
});
