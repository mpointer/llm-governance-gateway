// Judge-in-the-request-path: sampling, budget-awareness, observe/gate modes.
// All deterministic: mock responders + injectable RNG.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { JudgeGateError } from "./errors.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { JudgeConfig } from "./types.js";

const OutSchema = z.object({ answer: z.string() });
const CRITERIA = {
  accuracy: "Factually consistent with the request",
  brevity: "No filler or repetition",
};

function make(over: {
  random?: () => number;
  caps?: object;
  judgeScores?: Record<string, number>;
  registerJudge?: boolean;
} = {}) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
    mock: true,
    caps: over.caps ?? { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    judge: { random: over.random ?? (() => 0) }, // rng()=0 < sampleRate → always judge
  });
  gw.registerMockResponder("sum", () => ({ answer: "short" }));
  if (over.registerJudge !== false) {
    gw.registerMockResponder("judge:sum", () => over.judgeScores ?? { accuracy: 4, brevity: 5 });
  }
  return { gw, usage };
}

function opts(judge: JudgeConfig) {
  return {
    slug: "sum",
    schema: OutSchema,
    input: { t: "x" },
    variables: (i: { t: string }) => ({ t: i.t }),
    cache: false as const,
    userId: "u1",
    route: "test",
    judge,
  };
}

describe("judge-in-path", () => {
  it("scores, persists, and logs judge usage under judge:<route>", async () => {
    const { gw, usage } = make();
    const res = await gw.runStructured(opts({ criteria: CRITERIA }));
    expect(res.object.answer).toBe("short");
    expect(usage.judgeScores).toHaveLength(1);
    expect(usage.judgeScores[0]!.rubric).toEqual({ accuracy: 4, brevity: 5 });
    expect(usage.judgeScores[0]!.overallScore).toBe(4.5);
    expect(usage.judgeScores[0]!.usageLogId).toBe(res.usageLogId);
    const judgeRows = usage.entries.filter((e) => e.route === "judge:test");
    expect(judgeRows).toHaveLength(1);
  });

  it("sampling: rng >= sampleRate skips the judge entirely", async () => {
    const { gw, usage } = make({ random: () => 0.99 });
    await gw.runStructured(opts({ criteria: CRITERIA, sampleRate: 0.5 }));
    expect(usage.judgeScores).toHaveLength(0);
    expect(usage.entries.filter((e) => e.route?.startsWith("judge:"))).toHaveLength(0);
  });

  it("sampleRate 0 never judges", async () => {
    const { gw, usage } = make({ random: () => 0 });
    await gw.runStructured(opts({ criteria: CRITERIA, sampleRate: 0 }));
    expect(usage.judgeScores).toHaveLength(0);
  });

  it("budget-aware: skips the judge when estimated cost would cross the global cap", async () => {
    const usage = new MemoryUsageStore();
    // Pre-spend just under the cap; a priced judge model estimate crosses it.
    await usage.logUsage({
      userId: "other",
      provider: "x",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 99.999,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 100 },
      judge: { random: () => 0 },
    });
    gw.registerMockResponder("sum", () => ({ answer: "short" }));
    gw.registerMockResponder("judge:sum", () => ({ accuracy: 5, brevity: 5 }));

    // Priced model → nonzero estimate → skip. Main call must still succeed.
    const res = await gw.runStructured(
      opts({ criteria: CRITERIA, model: "claude-sonnet-4-6" }),
    );
    expect(res.object.answer).toBe("short");
    expect(usage.judgeScores).toHaveLength(0);
  });

  it("gate mode: throws JudgeGateError below threshold, scores persisted first", async () => {
    const { gw, usage } = make({ judgeScores: { accuracy: 1, brevity: 2 } });
    try {
      await gw.runStructured(opts({ criteria: CRITERIA, mode: "gate", threshold: 3 }));
      expect.unreachable("should have gated");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeGateError);
      const g = e as JudgeGateError;
      expect(g.overallScore).toBe(1.5);
      expect((g.object as { answer: string }).answer).toBe("short");
    }
    expect(usage.judgeScores).toHaveLength(1); // audit trail survives the gate
  });

  it("gate mode passes at/above threshold", async () => {
    const { gw } = make({ judgeScores: { accuracy: 3, brevity: 3 } });
    const res = await gw.runStructured(opts({ criteria: CRITERIA, mode: "gate", threshold: 3 }));
    expect(res.object.answer).toBe("short");
  });

  it("mock mode without a judge responder skips with a warning, never throws", async () => {
    const { gw, usage } = make({ registerJudge: false });
    const res = await gw.runStructured(opts({ criteria: CRITERIA }));
    expect(res.object.answer).toBe("short");
    expect(usage.judgeScores).toHaveLength(0);
  });
});
