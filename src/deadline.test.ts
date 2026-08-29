// Whole-operation budgets and per-attempt clocks.
// See docs/design/timeouts-and-deadlines.md (S3/S4).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import {
  AttemptTimeoutError,
  DeadlineExceededError,
} from "./errors.js";
import { AttemptBudget, MIN_ATTEMPT_MS, attemptSignal, sleep } from "./deadline.js";
import { MemoryUsageStore } from "./adapters/memory.js";

const OutSchema = z.object({ answer: z.string() });

/** A model that never resolves until its abortSignal fires. */
function hangingLm(id = "slow"): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate({ abortSignal }: { abortSignal?: AbortSignal }) {
      return await new Promise((_res, rej) => {
        abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    },
    async doStream() {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

/** A model that answers immediately. */
function okLm(answer: string, id = "ok"): LanguageModel {
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

function gwWithChain(
  links: { model: string; languageModel: LanguageModel }[],
  timeouts?: { attemptMs?: number; deadlineMs?: number },
) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
    modelConfig: {
      getOverride: async () => null,
      getChain: async () =>
        links.map((l) => ({ provider: "anthropic" as const, ...l })),
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...(timeouts ? { timeouts } : {}),
  });
  return { gw, usage };
}

const runOpts = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  anonKey: "t",
};

describe("AttemptBudget", () => {
  it("is unbounded without a deadline", () => {
    const b = new AttemptBudget();
    expect(b.remainingMs()).toBeUndefined();
    expect(b.expired()).toBe(false);
    expect(b.canStartAttempt()).toBe(true);
    expect(b.clampDelay(9_999)).toBe(9_999);
  });

  it("clamps attempts and delays to what is left", () => {
    const b = new AttemptBudget(5_000);
    expect(b.remainingMs()).toBeLessThanOrEqual(5_000);
    expect(b.clampDelay(60_000)).toBeLessThanOrEqual(5_000);
  });

  it("refuses to start an attempt below the floor", () => {
    const b = new AttemptBudget(MIN_ATTEMPT_MS - 1);
    expect(b.canStartAttempt()).toBe(false);
  });
});

describe("attemptSignal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires on its own clock and reports timedOut", async () => {
    const a = attemptSignal(1_000);
    expect(a.timedOut()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(a.signal.aborted).toBe(true);
    expect(a.timedOut()).toBe(true);
    a.dispose();
  });

  it("fires on caller abort WITHOUT reporting timedOut", () => {
    const c = new AbortController();
    const a = attemptSignal(60_000, c.signal);
    c.abort(new Error("caller"));
    expect(a.signal.aborted).toBe(true);
    // The distinction Rule 5 exists for: a caller abort is not a timeout.
    expect(a.timedOut()).toBe(false);
    a.dispose();
  });

  it("leaves no timer pending after dispose", async () => {
    const a = attemptSignal(60_000);
    expect(vi.getTimerCount()).toBe(1);
    a.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("sleep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a caller abort cuts a backoff short instead of waiting it out", async () => {
    const c = new AbortController();
    const p = sleep(8_000, c.signal);
    const settled = expect(p).rejects.toThrow("gone");
    c.abort(new Error("gone"));
    await settled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves normally and clears its timer", async () => {
    const p = sleep(500);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("attempt timeouts and deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a slow link times out, the chain advances, and the attempt is ledgered", async () => {
    const { gw, usage } = gwWithChain(
      [
        { model: "slow", languageModel: hangingLm() },
        { model: "fast", languageModel: okLm("second") },
      ],
      { attemptMs: 5_000 },
    );
    const p = gw.runStructured(runOpts);
    await vi.advanceTimersByTimeAsync(5_100);
    const res = await p;

    expect(res.object).toEqual({ answer: "second" });
    // Two rows: the timed-out attempt (zero-token) and the successful one.
    expect(usage.entries).toHaveLength(2);
    const timedOut = usage.entries[0]!;
    expect(timedOut.model).toBe("slow");
    expect(timedOut.inputTokens).toBe(0);
    expect(timedOut.outputTokens).toBe(0);
    expect(timedOut.estimatedCostCents).toBe(0);
    expect(usage.entries[1]!.model).toBe("fast");
  });

  it("does NOT retry the link that just timed out", async () => {
    let calls = 0;
    const counting = {
      ...hangingLm(),
      async doGenerate({ abortSignal }: { abortSignal?: AbortSignal }) {
        calls++;
        return await new Promise((_r, rej) => {
          abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
        });
      },
    } as unknown as LanguageModel;

    const { gw } = gwWithChain(
      [
        { model: "slow", languageModel: counting },
        { model: "fast", languageModel: okLm("ok") },
      ],
      { attemptMs: 5_000 },
    );
    const p = gw.runStructured(runOpts);
    await vi.advanceTimersByTimeAsync(5_100);
    await p;
    // A link that just demonstrated it is slow gets exactly one chance.
    expect(calls).toBe(1);
  });

  it("a blown deadline is terminal: no further links are tried", async () => {
    let secondCalled = false;
    const second = {
      ...okLm("never"),
      async doGenerate() {
        secondCalled = true;
        return {
          content: [{ type: "text", text: JSON.stringify({ answer: "never" }) }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    } as unknown as LanguageModel;

    const { gw } = gwWithChain(
      [
        { model: "slow", languageModel: hangingLm() },
        { model: "fast", languageModel: second },
      ],
      { attemptMs: 30_000, deadlineMs: 6_000 },
    );
    const p = gw.runStructured(runOpts);
    const settled = expect(p).rejects.toThrow(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(6_500);
    await settled;
    expect(secondCalled).toBe(false);
  });

  it("refuses to start a link the remaining budget cannot cover", async () => {
    // Deadline below MIN_ATTEMPT_MS: nothing should be dialled at all.
    let called = false;
    const never = {
      ...okLm("x"),
      async doGenerate() {
        called = true;
        throw new Error("should not be reached");
      },
    } as unknown as LanguageModel;

    const { gw } = gwWithChain([{ model: "m", languageModel: never }], {
      deadlineMs: MIN_ATTEMPT_MS - 1,
    });
    await expect(gw.runStructured(runOpts)).rejects.toThrow(DeadlineExceededError);
    expect(called).toBe(false);
  });

  it("per-call attemptMs overrides the gateway config", async () => {
    const { gw } = gwWithChain([{ model: "slow", languageModel: hangingLm() }], {
      attemptMs: 60_000,
    });
    const p = gw.runStructured({ ...runOpts, attemptMs: 2_000 });
    const settled = expect(p).rejects.toThrow(AttemptTimeoutError);
    await vi.advanceTimersByTimeAsync(2_100);
    await settled;
  });

  it("ledgers a timed-out attempt on the TASK-routed single-link path too", async () => {
    // Task routing has no chain loop to catch the timeout. This is the shape
    // the first adopter uses for every call, so it must not be the one path
    // where a timed-out attempt vanishes from the ledger.
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      tasks: {
        defaults: { summarize: "slowfactory:slow" },
        store: { getOverrides: async () => ({}) },
      },
      // A provider factory gives the task a resolvable model without needing
      // an API key in the environment.
      providers: {
        factories: {
          slowfactory: { model: () => hangingLm() },
        },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
      timeouts: { attemptMs: 5_000 },
    });

    const p = gw.runStructured({ ...runOpts, task: "summarize" });
    const settled = expect(p).rejects.toThrow(AttemptTimeoutError);
    await vi.advanceTimersByTimeAsync(5_100);
    await settled;

    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]!.inputTokens).toBe(0);
    expect(usage.entries[0]!.estimatedCostCents).toBe(0);
  });

  it("a judge that runs out of clock SKIPS instead of failing the response", async () => {
    // A governance check must never be the thing that breaks the request it
    // was watching. The judge already self-skips under spend pressure; a
    // timeout is the same class of outcome.
    const usage = new MemoryUsageStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      providers: { factories: { slowjudge: { model: () => hangingLm("judge") } } },
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "ok", languageModel: okLm("main") },
        ],
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    const p = gw.runStructured({
      ...runOpts,
      judge: { criteria: { accuracy: "is it right" }, model: "slowjudge:j" },
    });
    // Push past the judge's own 15s budget.
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await p;

    // The main response survives intact...
    expect(res.object).toEqual({ answer: "main" });
    // ...and the judge left a trace of why it skipped, without a score row.
    expect(warn.mock.calls.flat().join(" ")).toMatch(/judge skipped/);
    expect(usage.entries.some((e) => e.route?.startsWith("judge:"))).toBe(false);
    warn.mockRestore();
  });

  it("leaves no timers pending after a chain timeout settles", async () => {
    const { gw } = gwWithChain(
      [
        { model: "slow", languageModel: hangingLm() },
        { model: "fast", languageModel: okLm("second") },
      ],
      { attemptMs: 5_000 },
    );
    const p = gw.runStructured(runOpts);
    await vi.advanceTimersByTimeAsync(5_100);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unbounded by default: no deadline error on a long chain", async () => {
    const { gw } = gwWithChain([{ model: "ok", languageModel: okLm("done") }]);
    const res = await gw.runStructured(runOpts);
    expect(res.object).toEqual({ answer: "done" });
  });
});
