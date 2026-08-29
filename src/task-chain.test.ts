// Per-task failover chains (critique finding 3.3).
//
// Before this, a task collapsed to ONE link (admin override → task → chain[0]
// → default), so an app with a primary/fallback/backup2 role chain got no
// failover from the gateway on its task-routed calls — which is how the first
// adopter makes every call. The chain is now walked by the same loop
// runStructured's main chain uses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { ZdrViolationError } from "./errors.js";
import { MemoryUsageStore } from "./adapters/memory.js";

const OutSchema = z.object({ answer: z.string() });

/** Records every call so we can assert which links were actually dialled. */
function recordingLm(
  behavior: "ok" | "retryable" | "fatal" | "hang",
  answer: string,
  calls: string[],
  id: string,
): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate({ abortSignal }: { abortSignal?: AbortSignal }) {
      calls.push(id);
      if (behavior === "hang") {
        return await new Promise((_r, rej) => {
          abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
        });
      }
      if (behavior === "retryable") {
        const e = new Error("503 upstream") as Error & { statusCode?: number };
        e.statusCode = 503;
        throw e;
      }
      if (behavior === "fatal") {
        const e = new Error("400 bad request") as Error & { statusCode?: number };
        e.statusCode = 400;
        throw e;
      }
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

function gwWithTaskChain(
  chain: string | string[],
  models: Record<string, LanguageModel>,
  extra: Record<string, unknown> = {},
) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
    tasks: { defaults: { summarize: chain } },
    providers: {
      factories: Object.fromEntries(
        Object.entries(models).map(([name, lm]) => [name, { model: () => lm }]),
      ),
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...extra,
  });
  return { gw, usage };
}

const runOpts = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  task: "summarize",
};

const textOpts = {
  slug: "q",
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  task: "summarize",
};

describe("per-task failover chains: runStructured", () => {
  it("walks past a retryable failure to the next link in the task chain", async () => {
    const calls: string[] = [];
    const { gw, usage } = gwWithTaskChain(
      ["primary:m", "fallback:m", "backup2:m"],
      {
        primary: recordingLm("retryable", "", calls, "primary"),
        fallback: recordingLm("ok", "from-fallback", calls, "fallback"),
        backup2: recordingLm("ok", "from-backup2", calls, "backup2"),
      },
    );
    const res = await gw.runStructured(runOpts);
    expect(res.object).toEqual({ answer: "from-fallback" });
    // primary retried twice internally, then the chain advanced. backup2
    // never needed dialling.
    expect(calls.filter((c) => c === "primary").length).toBeGreaterThanOrEqual(1);
    expect(calls).toContain("fallback");
    expect(calls).not.toContain("backup2");
    expect(usage.entries.at(-1)!.model).toBe("m");
  });

  it("a single-model task is still exactly one link (pre-chain behavior)", async () => {
    const calls: string[] = [];
    const { gw } = gwWithTaskChain("only:m", {
      only: recordingLm("fatal", "", calls, "only"),
    });
    await expect(gw.runStructured(runOpts)).rejects.toThrow(/400/);
    expect(calls).toEqual(["only"]);
  });

  it("a non-retryable error stops the chain rather than burning the next link", async () => {
    const calls: string[] = [];
    const { gw } = gwWithTaskChain(["primary:m", "fallback:m"], {
      primary: recordingLm("fatal", "", calls, "primary"),
      fallback: recordingLm("ok", "never", calls, "fallback"),
    });
    await expect(gw.runStructured(runOpts)).rejects.toThrow(/400/);
    expect(calls).toEqual(["primary"]);
  });

  it("ZDR filters the task chain instead of failing on the first link", async () => {
    // Previously task routing collapsed to one link BEFORE the ZDR filter,
    // so an ineligible primary threw rather than skipping to an eligible one.
    const calls: string[] = [];
    const { gw } = gwWithTaskChain(
      ["notzdr:m", "iszdr:m"],
      {
        notzdr: recordingLm("ok", "leaky", calls, "notzdr"),
        iszdr: recordingLm("ok", "compliant", calls, "iszdr"),
      },
      { providers: undefined },
    );
    // rebuild with retention config
    const usage = new MemoryUsageStore();
    const gw2 = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      tasks: { defaults: { summarize: ["notzdr:m", "iszdr:m"] } },
      providers: {
        factories: {
          notzdr: { model: () => recordingLm("ok", "leaky", calls, "notzdr") },
          iszdr: { model: () => recordingLm("ok", "compliant", calls, "iszdr") },
        },
        retention: { iszdr: { zdr: true } },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    void gw;
    const res = await gw2.runStructured({ ...runOpts, requireZdr: true });
    expect(res.object).toEqual({ answer: "compliant" });
    expect(calls).toEqual(["iszdr"]); // the non-ZDR link was never dialled
  });

  it("errors when every link in a ZDR-required task chain is ineligible", async () => {
    const calls: string[] = [];
    const { gw } = gwWithTaskChain(["a:m", "b:m"], {
      a: recordingLm("ok", "x", calls, "a"),
      b: recordingLm("ok", "y", calls, "b"),
    });
    await expect(
      gw.runStructured({ ...runOpts, requireZdr: true }),
    ).rejects.toThrow(ZdrViolationError);
    expect(calls).toEqual([]);
  });
});

describe("per-task failover chains: runText", () => {
  it("walks the task chain on a retryable failure", async () => {
    const calls: string[] = [];
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      tasks: { defaults: { summarize: ["primary:m", "fallback:m"] } },
      providers: {
        factories: {
          primary: { model: () => recordingLm("retryable", "", calls, "primary") },
          fallback: { model: () => recordingLm("ok", "text-from-fallback", calls, "fallback") },
        },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const res = await gw.runText(textOpts);
    // The fixture emits JSON (it is shared with the structured tests); what
    // matters here is that the SECOND link produced the answer.
    expect(res.text).toContain("text-from-fallback");
    expect(res.model).toBe("m");
    expect(calls).toContain("fallback");
  });
});

describe("per-task failover chains: timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an attempt timeout advances the chain AND ledgers a zero-token row", async () => {
    // Combines PR20's ledger-first rule with the new failover: the slow link
    // must leave an audit trail and the chain must still produce an answer.
    const calls: string[] = [];
    const { gw, usage } = gwWithTaskChain(
      ["slow:m", "fast:m"],
      {
        slow: recordingLm("hang", "", calls, "slow"),
        fast: recordingLm("ok", "recovered", calls, "fast"),
      },
      { timeouts: { attemptMs: 5_000 } },
    );
    const p = gw.runStructured(runOpts);
    await vi.advanceTimersByTimeAsync(5_100);
    const res = await p;

    expect(res.object).toEqual({ answer: "recovered" });
    expect(calls).toEqual(["slow", "fast"]);
    // Two rows: the timed-out attempt (zero-token) and the success.
    expect(usage.entries).toHaveLength(2);
    expect(usage.entries[0]!.inputTokens).toBe(0);
    expect(usage.entries[0]!.estimatedCostCents).toBe(0);
    expect(usage.entries[1]!.outputTokens).toBeGreaterThan(0);
  });
});

describe("per-task chain config", () => {
  it("chainForTask expands a single id to a one-link chain", async () => {
    const { gw } = gwWithTaskChain("only:m", { only: recordingLm("ok", "a", [], "only") });
    const chain = await gw.tasks!.chainForTask("summarize");
    expect(chain).toHaveLength(1);
    expect(chain[0]!.model).toBe("m");
  });

  it("modelForTask still returns the head of the chain", async () => {
    const { gw } = gwWithTaskChain(["first:m1", "second:m2"], {
      first: recordingLm("ok", "a", [], "first"),
      second: recordingLm("ok", "b", [], "second"),
    });
    // Adopters compare the gateway's resolution against their own using this;
    // chains must not change what it answers.
    expect((await gw.tasks!.modelForTask("summarize")).model).toBe("m1");
  });

  it("an empty chain is a loud config error, not an empty result", async () => {
    const { gw } = gwWithTaskChain([], {});
    await expect(gw.tasks!.chainForTask("summarize")).rejects.toThrow(/empty model chain/);
  });

  it("an unknown task still fails loudly", async () => {
    const { gw } = gwWithTaskChain("only:m", { only: recordingLm("ok", "a", [], "only") });
    await expect(gw.tasks!.chainForTask("nope")).rejects.toThrow(/Unknown AI task/);
  });

  it("an override store may return a chain, and it wins over the default", async () => {
    const calls: string[] = [];
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      tasks: {
        defaults: { summarize: "default:m" },
        store: { getOverrides: async () => ({ summarize: ["ov1:m", "ov2:m"] }) },
      },
      providers: {
        factories: {
          default: { model: () => recordingLm("ok", "d", calls, "default") },
          ov1: { model: () => recordingLm("retryable", "", calls, "ov1") },
          ov2: { model: () => recordingLm("ok", "from-override-chain", calls, "ov2") },
        },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const res = await gw.runStructured(runOpts);
    expect(res.object).toEqual({ answer: "from-override-chain" });
    expect(calls).not.toContain("default");
  });
});
