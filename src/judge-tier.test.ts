// A first-class, admin-configurable judge tier (critique finding 3.4).
//
// The judge used to borrow the DEFAULT PROVIDER's fast tier, so an operator
// could not pin it to a cheap, ZDR-compliant model on a different provider —
// exactly the implicit coupling the no-hardcoded-model objective forbids.
//
// The existing budget-aware and ZDR-aware skips, and PR 20's failure
// isolation (a judge must never break the response it is watching), are
// asserted here too so the tier work cannot regress them.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import { ProviderRegistry } from "./providers.js";

const OutSchema = z.object({ answer: z.string() });

function lm(payload: unknown, id: string, calls: string[]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      calls.push(id);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
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

const runOpts = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  judge: { criteria: { accuracy: "is it right" } },
};

describe("judge tier resolution", () => {
  it("an admin-pinned judge model beats config and the default provider", async () => {
    const calls: string[] = [];
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "main", languageModel: lm({ answer: "a" }, "main", calls) },
        ],
        // The point of the finding: the judge lives on a DIFFERENT provider
        // than the generation chain, pinned by the admin store.
        getJudgeModel: async () => "cheapjudge:j",
      },
      providers: {
        factories: { cheapjudge: { model: () => lm({ accuracy: 5 }, "judge-model", calls) } },
      },
      judge: { model: "shouldnotwin:x" },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await gw.runStructured(runOpts);
    expect(calls).toContain("judge-model");
    const judgeRow = usage.entries.find((e) => e.route?.startsWith("judge:"));
    expect(judgeRow!.provider).toBe("cheapjudge");
    expect(judgeRow!.model).toBe("j");
  });

  it("a per-call judge.model still wins over the admin pin", async () => {
    const calls: string[] = [];
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "main", languageModel: lm({ answer: "a" }, "main", calls) },
        ],
        getJudgeModel: async () => "admin:j",
      },
      providers: {
        factories: {
          admin: { model: () => lm({ accuracy: 4 }, "admin-judge", calls) },
          percall: { model: () => lm({ accuracy: 5 }, "percall-judge", calls) },
        },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    await gw.runStructured({
      ...runOpts,
      judge: { criteria: { accuracy: "x" }, model: "percall:j" },
    });
    expect(calls).toContain("percall-judge");
    expect(calls).not.toContain("admin-judge");
  });

  it("a store without getJudgeModel is unaffected (optional SPI method)", async () => {
    const calls: string[] = [];
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: {
        // No getJudgeModel at all — the pre-3.4 store shape.
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "main", languageModel: lm({ answer: "a" }, "main", calls) },
        ],
      },
      providers: { factories: { cfg: { model: () => lm({ accuracy: 3 }, "cfg-judge", calls) } } },
      judge: { model: "cfg:j" },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    await gw.runStructured(runOpts);
    expect(calls).toContain("cfg-judge");
  });

  it("a throwing judge-model store degrades to config, never fails the call", async () => {
    const calls: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "main", languageModel: lm({ answer: "a" }, "main", calls) },
        ],
        getJudgeModel: async () => {
          throw new Error("db down");
        },
      },
      providers: { factories: { cfg: { model: () => lm({ accuracy: 3 }, "cfg-judge", calls) } } },
      judge: { model: "cfg:j" },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    const res = await gw.runStructured(runOpts);
    // The main response is intact and the judge still ran on the fallback.
    expect(res.object).toEqual({ answer: "a" });
    expect(calls).toContain("cfg-judge");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/judge model store unreachable/);
    warn.mockRestore();
  });
});

describe("judge tier in the provider tier model", () => {
  it("is a named tier alongside fast and power", () => {
    const reg = new ProviderRegistry({
      tiers: { openai: { fast: "gpt-4.1-mini", power: "gpt-4.1", judge: "gpt-4.1-nano" } },
    });
    expect(reg.tierModel("openai", "judge")).toBe("gpt-4.1-nano");
    expect(reg.tierModel("openai", "fast")).toBe("gpt-4.1-mini");
  });

  it("falls back to the provider's fast tier when no judge tier is set", () => {
    // The pre-tier behavior: the judge used the fast model.
    const reg = new ProviderRegistry({ tiers: { openai: { fast: "gpt-4.1-mini" } } });
    expect(reg.tierModel("openai", "judge")).toBe("gpt-4.1-mini");
  });

  it("has no built-in judge model baked in for any provider", () => {
    // Baking one in would be the same out-of-box provider bias finding 3.6
    // objects to; the fallback to `fast` is the only default.
    const reg = new ProviderRegistry();
    expect(reg.tierModel("anthropic", "judge")).toBe(reg.tierModel("anthropic", "fast"));
  });
});

describe("judge tier preserves existing governance", () => {
  it("still skips (not fails) when the judge model is not ZDR and the call requires it", async () => {
    const calls: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "main", languageModel: lm({ answer: "a" }, "main", calls) },
        ],
        getJudgeModel: async () => "leaky:j",
      },
      providers: {
        factories: { leaky: { model: () => lm({ accuracy: 5 }, "leaky-judge", calls) } },
        retention: { anthropic: { zdr: true } },
      },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });

    const res = await gw.runStructured({ ...runOpts, requireZdr: true });
    expect(res.object).toEqual({ answer: "a" }); // main call unaffected
    expect(calls).not.toContain("leaky-judge");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/judge skipped/);
    expect(usage.entries.some((e) => e.route?.startsWith("judge:"))).toBe(false);
    warn.mockRestore();
  });

  it("still skips when the judge would cross the global cap", async () => {
    const calls: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "anthropic" as const, model: "main", languageModel: lm({ answer: "a" }, "main", calls) },
        ],
        getJudgeModel: async () => "j:j",
      },
      providers: { factories: { j: { model: () => lm({ accuracy: 5 }, "the-judge", calls) } } },
      // Cap just above what the main call costs, so the judge estimate crosses it.
      caps: { globalDailyCents: 0.0001, userDailyCents: 0, anonDailyCents: 0 },
    });
    const res = await gw.runStructured(runOpts);
    expect(res.object).toEqual({ answer: "a" });
    expect(calls).not.toContain("the-judge");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/judge skipped/);
    warn.mockRestore();
  });
});
