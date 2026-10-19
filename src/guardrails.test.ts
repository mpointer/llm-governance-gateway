// Guardrail hooks: pre/post verdicts, ledgering, fail-closed vs fail-open,
// transform semantics (prompt, output, cache, judge), and mock-mode parity.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { GuardrailError } from "./errors.js";
import { MemoryCacheStore, MemoryUsageStore } from "./adapters/memory.js";
import type { GuardrailConfig } from "./guardrails.js";

const OutSchema = z.object({ answer: z.string() });

function make(guardrails: GuardrailConfig, extra: { cache?: MemoryCacheStore; judge?: boolean } = {}) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    cache: extra.cache,
    promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
    mock: true,
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    guardrails,
    judge: { random: () => 0 },
  });
  gw.registerMockResponder("sum", (input) => ({ answer: `echo:${(input as { t: string }).t}` }));
  if (extra.judge) gw.registerMockResponder("judge:sum", (obj) => ({ ok: (obj as { answer: string }).answer.includes("scrubbed") ? 5 : 1 }));
  return { gw, usage };
}

function opts(over: Partial<Parameters<Gateway["runStructured"]>[0]> = {}) {
  return {
    slug: "sum",
    schema: OutSchema,
    input: { t: "hello" },
    variables: (i: { t: string }) => ({ t: i.t }),
    cache: false as const,
    userId: "u1",
    route: "test",
    ...over,
  };
}

describe("pre guardrail", () => {
  it("allow: the call proceeds and the usage row carries the verdict", async () => {
    const { gw, usage } = make({ pre: () => ({ action: "allow", reason: "clean" }) });
    const res = await gw.runStructured(opts());
    expect(res.object.answer).toBe("echo:hello");
    const row = usage.entries.find((e) => e.id === res.usageLogId)!;
    expect(row.guardrails).toEqual([expect.objectContaining({ hook: "pre", action: "allow", reason: "clean", failOpen: false })]);
  });

  it("block: no provider call, a zero-token row with the block, GuardrailError thrown", async () => {
    let calls = 0;
    const { gw, usage } = make({ pre: () => ({ action: "block", reason: "pii in prompt", detail: { kind: "ssn" } }) });
    gw.registerMockResponder("sum", () => {
      calls++;
      return { answer: "x" };
    });
    const err = await gw.runStructured(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.hook).toBe("pre");
    expect(err.reason).toBe("pii in prompt");
    expect(err.detail).toEqual({ kind: "ssn" });
    expect(err.output).toBeUndefined();
    expect(calls).toBe(0);
    expect(usage.entries).toHaveLength(1);
    const row = usage.entries[0]!;
    expect(row.provider).toBe("guardrail");
    expect(row.model).toBe("pre");
    expect(row.inputTokens).toBe(0);
    expect(row.estimatedCostCents).toBe(0);
    expect(row.guardrails).toEqual([expect.objectContaining({ hook: "pre", action: "block", reason: "pii in prompt", detail: { kind: "ssn" } })]);
  });

  it("transform: the rewritten prompt is what goes out and what is ledgered", async () => {
    const { gw, usage } = make({ pre: (ctx) => ({ action: "transform", prompt: ctx.prompt.replace("hello", "[redacted]"), reason: "scrub" }) });
    const res = await gw.runStructured(opts());
    const row = usage.entries.find((e) => e.id === res.usageLogId)!;
    expect(row.inputText).toBe("Summarize: [redacted]");
    expect(row.guardrails?.[0]).toMatchObject({ hook: "pre", action: "transform", reason: "scrub" });
  });

  it("sees the rendered prompt, the input and the identity", async () => {
    let seen: unknown;
    const { gw } = make({
      pre: (ctx) => {
        seen = ctx;
        return { action: "allow" };
      },
    });
    await gw.runStructured(opts({ task: undefined }));
    expect(seen).toMatchObject({ slug: "sum", prompt: "Summarize: hello", input: { t: "hello" }, userId: "u1", route: "test" });
  });
});

describe("post guardrail", () => {
  it("block: the usage row is written with the spent tokens, then GuardrailError carries the object", async () => {
    const { gw, usage } = make({ post: (ctx) => ({ action: "block", reason: `bad: ${(ctx.output as { answer: string }).answer}` }) });
    const err = await gw.runStructured(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.hook).toBe("post");
    expect(err.output).toEqual({ answer: "echo:hello" });
    expect(usage.entries).toHaveLength(1);
    const row = usage.entries[0]!;
    expect(row.provider).toBe("mock");
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.guardrails?.[0]).toMatchObject({ hook: "post", action: "block", reason: "bad: echo:hello" });
  });

  it("transform: the caller, the cache and the judge all see the transformed object", async () => {
    const cache = new MemoryCacheStore();
    const { gw, usage } = make({ post: () => ({ action: "transform", output: { answer: "scrubbed" } }) }, { cache, judge: true });
    const res = await gw.runStructured(opts({ cache: true, cacheParts: ["k"], judge: { criteria: { ok: "ok" } } }));
    expect(res.object).toEqual({ answer: "scrubbed" });
    // The judge scored the transformed object (the mock judge gives 5 only for "scrubbed").
    expect(usage.judgeScores[0]!.rubric).toEqual({ ok: 5 });
    // A second call is served from cache with the transformed value.
    const again = await gw.runStructured(opts({ cache: true, cacheParts: ["k"] }));
    expect(again.cacheHit).toBe(true);
    expect(again.object).toEqual({ answer: "scrubbed" });
  });

  it("transform that breaks the schema is a block (fail closed)", async () => {
    const { gw, usage } = make({ post: () => ({ action: "transform", output: { answer: 42 } }) });
    const err = await gw.runStructured(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.reason).toMatch(/schema-invalid/);
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "block" });
  });

  it("transform that breaks the schema under failOpen keeps the original object and records the error", async () => {
    const { gw, usage } = make({ post: () => ({ action: "transform", output: { answer: 42 } }), failOpen: true });
    const res = await gw.runStructured(opts());
    expect(res.object).toEqual({ answer: "echo:hello" });
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "allow", failOpen: true });
    expect(usage.entries[0]!.guardrails?.[0]?.error).toMatch(/schema-invalid/);
  });

  it("both hooks: the row carries both records in order", async () => {
    const { gw, usage } = make({ pre: () => ({ action: "allow" }), post: () => ({ action: "allow" }) });
    const res = await gw.runStructured(opts());
    const row = usage.entries.find((e) => e.id === res.usageLogId)!;
    expect(row.guardrails?.map((g) => g.hook)).toEqual(["pre", "post"]);
  });
});

describe("hook failure policy", () => {
  it("a throwing hook blocks by default and the error is ledgered", async () => {
    const { gw, usage } = make({
      pre: () => {
        throw new Error("classifier down");
      },
    });
    const err = await gw.runStructured(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.reason).toMatch(/classifier down/);
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "pre", action: "block", error: "classifier down", failOpen: false });
  });

  it("failOpen: a throwing hook lets the call through and the row says the gate was open", async () => {
    const { gw, usage } = make({
      post: () => {
        throw new Error("classifier down");
      },
      failOpen: true,
    });
    const res = await gw.runStructured(opts());
    expect(res.object.answer).toBe("echo:hello");
    expect(usage.entries[0]!.guardrails?.[0]).toMatchObject({ hook: "post", action: "allow", error: "classifier down", failOpen: true });
  });

  it("an invalid verdict shape is treated as a thrown hook", async () => {
    const { gw } = make({ pre: () => ({ action: "block" }) as never });
    const err = await gw.runStructured(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err.reason).toMatch(/without a reason/);
  });
});

describe("no guardrails configured", () => {
  it("writes NULL guardrails so pre-0.16 rows and unguarded rows look the same", async () => {
    const usage = new MemoryUsageStore();
    const gw = new Gateway({
      usage,
      promptDefaults: [{ slug: "sum", body: "Summarize: {{t}}", variables: ["t"] }],
      mock: true,
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    });
    gw.registerMockResponder("sum", () => ({ answer: "x" }));
    await gw.runStructured(opts());
    expect(usage.entries[0]!.guardrails).toBeNull();
  });
});
