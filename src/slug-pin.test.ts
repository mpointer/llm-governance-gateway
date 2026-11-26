// "The slug names the model" (#49, docs/design/model-naming.md): the opt-in
// `slugPinWins`, a slug's `tierModels` and `fallbackModels`, the code-level
// ZDR lock `zdr.slugs`, and `routedBy` on the ledger.
//
// The design names four ways this change would be a failure even if it
// worked. Each has a test here:
//   - an adopter's routing changes without opting in
//   - a ZDR-locked slug runs on a non-eligible model, by any path
//   - the ledger cannot tell a slug-pinned call from a chain-routed one
//   - a fast/power toggle silently does nothing on a slug with `tierModels`

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway, promptFingerprint } from "./gateway.js";
import { ZdrViolationError } from "./errors.js";
import { ProviderRegistry } from "./providers.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { BatchClient } from "./batch.js";
import { MemoryBatchJobStore } from "./batch.js";
import type { GatewayConfig, PromptDefault, StoredPrompt } from "./types.js";

const OutSchema = z.object({ answer: z.string() });

/**
 * A model that answers with its own id, in every mode the gateway calls. An
 * id starting "down" fails with a retryable error and no backoff, so a chain
 * walks past it at once.
 */
function fakeLm(id: string): LanguageModel {
  const fail = () =>
    Object.assign(new Error(`503 from ${id}`), {
      statusCode: 503,
      responseHeaders: { "retry-after": "0" },
    });
  const text = JSON.stringify({ answer: id });
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      if (id.startsWith("down")) throw fail();
      return { content: [{ type: "text", text }], finishReason: "stop", usage, warnings: [] };
    },
    async doStream() {
      if (id.startsWith("down")) throw fail();
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: text });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({ type: "finish", finishReason: "stop", usage });
            c.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

interface Setup {
  /** The stored prompt row for slug "q". Omit for no row. */
  row?: Partial<StoredPrompt>;
  def?: Partial<PromptDefault>;
  /** What the admin pin store returns. */
  adminPin?: { provider: "anthropic"; model: string } | null;
  /** The configured chain's model ids, all on the `fake` factory. */
  chain?: string[];
  config?: Partial<GatewayConfig>;
}

/** Every model lives on two factories: `fake`, and `vault`, which is ZDR. */
function setup(s: Setup = {}) {
  const usage = new MemoryUsageStore();
  const getOverride = vi.fn(async () => s.adminPin ?? null);
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "q", body: "Answer: {{q}}", variables: ["q"], ...s.def }],
    prompts: {
      getPrompt: async (slug) =>
        s.row && slug === "q" ? { slug, body: "Answer: {{q}}", ...s.row } : undefined,
    },
    modelConfig: {
      getOverride,
      getChain: async () => (s.chain ?? ["chain-a"]).map((model) => ({ factory: "fake", model })),
    },
    providers: {
      factories: { fake: { model: fakeLm }, vault: { model: fakeLm } },
      retention: { vault: { zdr: true } },
      fallbackPricing: { in: 1, out: 1 },
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    ...s.config,
  });
  return { gw, usage, getOverride };
}

const call = {
  slug: "q",
  input: { q: "hi" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  userId: "u1",
};

/** The five governed methods, each reduced to "which model answered". */
const METHODS = {
  runStructured: async (gw: Gateway, extra: object = {}) => {
    const r = await gw.runStructured({ ...call, schema: OutSchema, ...extra });
    return r.object.answer;
  },
  runText: async (gw: Gateway, extra: object = {}) => {
    const r = await gw.runText({ ...call, ...extra });
    return r.model;
  },
  streamStructured: async (gw: Gateway, extra: object = {}) => {
    const r = await gw.streamStructured({ ...call, schema: OutSchema, ...extra });
    return (await r.object).answer;
  },
  streamText: async (gw: Gateway, extra: object = {}) => {
    const r = await gw.streamText({
      slug: "q",
      messages: [{ role: "user", content: "hi" }],
      userId: "u1",
      ...extra,
    });
    for await (const _ of r.textStream) {
      // drain
    }
    return (await r.result).model;
  },
  generateText: async (gw: Gateway, extra: object = {}) => {
    const r = await gw.generateText({
      slug: "q",
      messages: [{ role: "user", content: "hi" }],
      userId: "u1",
      ...extra,
    });
    return r.model;
  },
} as const;
const methodNames = Object.keys(METHODS) as (keyof typeof METHODS)[];

const on = { slugPinWins: true };
const lastRow = (usage: MemoryUsageStore) => usage.entries.at(-1)!;

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("without slugPinWins, nothing changes", () => {
  it.each(methodNames)("%s ignores the slug's pins and writes no routedBy", async (name) => {
    const { gw, usage } = setup({
      row: {
        modelHint: "fake:slug-model",
        tierModels: { fast: "fake:fast", power: "fake:power" },
        fallbackModels: ["fake:fb"],
      },
    });
    expect(await METHODS[name](gw, { tier: "fast" })).toBe("chain-a");
    for (const row of usage.entries) expect(row).not.toHaveProperty("routedBy");
  });

  it("a prompt that sets neither new field keeps the fingerprint it had before", () => {
    const cfg = {
      body: "B",
      modelHint: "claude-sonnet-4-6",
      providerOverride: "anthropic",
      temperature: 0.2,
    };
    // The fingerprint as it was computed before these fields existed.
    const before = createHash("sha256")
      .update("B\u0000claude-sonnet-4-6\u0000anthropic\u00000.2")
      .digest("hex")
      .slice(0, 12);
    expect(promptFingerprint(cfg)).toBe(before);
    const tiered = promptFingerprint({ ...cfg, tierModels: { fast: "a", power: "b" } });
    expect(tiered).not.toBe(before);
    expect(promptFingerprint({ ...cfg, tierModels: { fast: "a", power: "c" } })).not.toBe(tiered);
    expect(promptFingerprint({ ...cfg, fallbackModels: ["x"] })).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe("slugPinWins: the slug's model outranks the admin pin, the task and the chain", () => {
  it.each(methodNames)(
    "%s runs the slug's model and ledgers it as routed by the slug",
    async (name) => {
      const { gw, usage, getOverride } = setup({
        row: { modelHint: "fake:slug-model" },
        adminPin: { provider: "anthropic", model: "claude-sonnet-4-6" },
        config: { ...on, tasks: { defaults: { triage: "fake:task-model" } } },
      });
      expect(await METHODS[name](gw, { task: "triage" })).toBe("slug-model");
      expect(lastRow(usage)).toMatchObject({
        provider: "fake",
        model: "slug-model",
        routedBy: "slug",
      });
      // The admin pin was never consulted: the slug outranks it.
      expect(getOverride).not.toHaveBeenCalled();
    },
  );

  it("a slug that pins nothing resolves as before, and the row says which layer decided", async () => {
    const task = { tasks: { defaults: { triage: "fake:task-model" } } };
    const viaTask = setup({ config: { ...on, ...task } });
    expect(await METHODS.runText(viaTask.gw, { task: "triage" })).toBe("task-model");
    expect(lastRow(viaTask.usage).routedBy).toBe("task-default");

    const viaOverride = setup({
      config: {
        ...on,
        tasks: {
          defaults: { triage: "fake:task-model" },
          store: { getOverrides: async () => ({ triage: "fake:override-model" }) },
        },
      },
    });
    expect(await METHODS.runStructured(viaOverride.gw, { task: "triage" })).toBe("override-model");
    expect(lastRow(viaOverride.usage).routedBy).toBe("task-override");

    const viaChain = setup({ config: on });
    expect(await METHODS.streamText(viaChain.gw)).toBe("chain-a");
    expect(lastRow(viaChain.usage).routedBy).toBe("chain");
  });

  it("applies on a call with an inline prompt body, which never loads the prompt row", async () => {
    const { gw, usage } = setup({ row: { modelHint: "fake:slug-model" }, config: on });
    const r = await gw.runText({ ...call, promptBody: "Inline {{q}}" });
    expect(r.model).toBe("slug-model");
    expect(lastRow(usage).routedBy).toBe("slug");
  });

  it("a slug with no row and no code default pins nothing, and the call still runs", async () => {
    const { gw, usage } = setup({ config: on });
    const r = await gw.generateText({
      slug: "never-registered",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.model).toBe("chain-a");
    expect(lastRow(usage).routedBy).toBe("chain");
  });

  it("a pin that is not a model id is skipped with one warning, not sent to a provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gw, usage } = setup({ row: { modelHint: "standard" }, config: on });
    expect(await METHODS.runText(gw)).toBe("chain-a");
    expect(await METHODS.runText(gw)).toBe("chain-a");
    expect(lastRow(usage).routedBy).toBe("chain");
    const about = warn.mock.calls.filter((c) => String(c[0]).includes('pins "standard"'));
    expect(about).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("slugPinWins: tierModels", () => {
  const row = { tierModels: { fast: "fake:quick", power: "fake:strong" } };

  it.each(methodNames)("%s: the call's tier picks the slug's fast or power model", async (name) => {
    const { gw } = setup({ row, config: on });
    expect(await METHODS[name](gw, { tier: "fast" })).toBe("quick");
    expect(await METHODS[name](gw, { tier: "power" })).toBe("strong");
  });

  it("with no tier on the call: modelHint when the row has one, otherwise the power model", async () => {
    const powerOnly = setup({ row, config: on });
    expect(await METHODS.runText(powerOnly.gw)).toBe("strong");
    const withHint = setup({ row: { ...row, modelHint: "fake:plain" }, config: on });
    expect(await METHODS.runText(withHint.gw)).toBe("plain");
    // A tier still beats the hint: that is what the toggle is for.
    expect(await METHODS.runText(withHint.gw, { tier: "fast" })).toBe("quick");
  });

  it("a row that leaves a field unset inherits the code default's; a row's own value wins", async () => {
    const def = {
      tierModels: { fast: "fake:def-fast", power: "fake:def-power" },
      fallbackModels: ["fake:def-fb"],
    };
    // An adopter's existing row: body only, no such columns.
    const inherits = setup({ row: {}, def, config: on });
    expect(await METHODS.runText(inherits.gw, { tier: "fast" })).toBe("def-fast");
    const overrides = setup({
      row: { tierModels: { fast: "fake:row-fast", power: "fake:row-power" } },
      def,
      config: on,
    });
    expect(await METHODS.runText(overrides.gw, { tier: "fast" })).toBe("row-fast");
    // Half a pair is not a pin.
    const half = setup({
      row: { tierModels: { fast: "fake:only-fast" } as never },
      config: on,
    });
    expect(await METHODS.runText(half.gw, { tier: "fast" })).toBe("chain-a");
  });
});

// ---------------------------------------------------------------------------
describe("slugPinWins: fallbacks, then the chain", () => {
  it.each(methodNames)(
    "%s: a failed slug model falls to fallbackModels, in order",
    async (name) => {
      const { gw, usage } = setup({
        row: { modelHint: "fake:down-primary", fallbackModels: ["fake:down-fb1", "fake:fb2"] },
        config: on,
      });
      expect(await METHODS[name](gw)).toBe("fb2");
      expect(lastRow(usage)).toMatchObject({ model: "fb2", routedBy: "slug-fallback" });
    },
  );

  it("when every slug model fails the call goes to the chain, past the admin pin and the task", async () => {
    const { gw, usage, getOverride } = setup({
      row: { modelHint: "fake:down-primary", fallbackModels: ["fake:down-fb"] },
      adminPin: { provider: "anthropic", model: "claude-sonnet-4-6" },
      chain: ["chain-a"],
      config: { ...on, tasks: { defaults: { triage: "fake:task-model" } } },
    });
    expect(await METHODS.runText(gw, { task: "triage" })).toBe("chain-a");
    expect(lastRow(usage).routedBy).toBe("chain");
    expect(getOverride).not.toHaveBeenCalled();
  });

  it("providerOverride qualifies a bare id; an id with its own prefix overrides it", async () => {
    const { gw } = setup({
      row: {
        providerOverride: "fake",
        modelHint: "down-bare",
        fallbackModels: ["down-also-bare", "vault:prefixed"],
      },
      config: on,
    });
    const r = await gw.runText(call);
    expect(r).toMatchObject({ provider: "vault", model: "prefixed" });
  });
});

// ---------------------------------------------------------------------------
describe("zdr.slugs: a ZDR lock set in code", () => {
  it("locks the slug without slugPinWins and whatever the call says", async () => {
    const { gw, usage } = setup({
      chain: ["open-model"],
      config: {
        zdr: { slugs: ["q"] },
        modelConfig: {
          getOverride: async () => null,
          getChain: async () => [
            { factory: "fake", model: "open-model" },
            { factory: "vault", model: "sealed-model" },
          ],
        },
      },
    });
    // The non-ZDR head of the chain is skipped, not used.
    const r = await gw.runText({ ...call, requireZdr: false });
    expect(r).toMatchObject({ provider: "vault", model: "sealed-model" });
    expect(lastRow(usage).zdrEnforced).toBe(true);
    // A slug that is not locked still uses the head.
    const other = await gw.generateText({
      slug: "unlocked",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(other.model).toBe("open-model");
  });

  it.each(methodNames)(
    "%s refuses a locked slug when nothing in the chain is ZDR",
    async (name) => {
      const { gw } = setup({ config: { zdr: { slugs: ["q"] } } });
      await expect(METHODS[name](gw)).rejects.toThrow(ZdrViolationError);
    },
  );

  it("a locked slug's ineligible model is skipped for an eligible fallback", async () => {
    const { gw, usage } = setup({
      row: { modelHint: "fake:open-model", fallbackModels: ["vault:sealed-model"] },
      config: { ...on, zdr: { slugs: ["q"] } },
    });
    const r = await gw.runText(call);
    expect(r).toMatchObject({ provider: "vault", model: "sealed-model" });
    expect(lastRow(usage).routedBy).toBe("slug-fallback");
    expect(usage.entries.every((e) => e.provider !== "fake")).toBe(true);
  });

  it.each(methodNames)(
    "%s throws when no slug model is eligible, even though the chain has one",
    async (name) => {
      const { gw, usage } = setup({
        row: { modelHint: "fake:open-model", fallbackModels: ["fake:open-fb"] },
        config: {
          ...on,
          zdr: { slugs: ["q"] },
          modelConfig: {
            getOverride: async () => null,
            getChain: async () => [{ factory: "vault", model: "sealed-chain" }],
          },
        },
      });
      // A wrong pin on a locked slug fails loudly instead of running elsewhere.
      await expect(METHODS[name](gw)).rejects.toThrow(ZdrViolationError);
      expect(usage.entries.filter((e) => e.provider === "fake" || e.provider === "vault")).toEqual(
        [],
      );
    },
  );

  it("past an eligible slug model, only ZDR chain links are tried", async () => {
    const { gw } = setup({
      row: { modelHint: "vault:down-sealed" },
      config: {
        ...on,
        zdr: { slugs: ["q"] },
        modelConfig: {
          getOverride: async () => null,
          getChain: async () => [
            { factory: "fake", model: "open-chain" },
            { factory: "vault", model: "sealed-chain" },
          ],
        },
      },
    });
    const r = await gw.runText(call);
    expect(r).toMatchObject({ provider: "vault", model: "sealed-chain" });
  });
});

// ---------------------------------------------------------------------------
describe("batch", () => {
  const batchSetup = (row: Partial<StoredPrompt>, config: Partial<GatewayConfig>) => {
    const submitted: { params: { model: string } }[][] = [];
    const client: BatchClient = {
      async submit(requests) {
        submitted.push(requests as never);
        return { id: "batch_1" };
      },
      async check() {
        return { status: "in_progress" };
      },
      async *results() {},
    };
    const gw = new Gateway({
      usage: new MemoryUsageStore(),
      promptDefaults: [{ slug: "q", body: "Answer: {{q}}", variables: ["q"] }],
      prompts: { getPrompt: async (slug) => ({ slug, body: "Answer: {{q}}", ...row }) },
      providers: {
        apiKeys: { anthropic: "sk-test" },
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        retention: { "anthropic:claude-opus-4-8": { zdr: true } },
      },
      batch: { client, store: new MemoryBatchJobStore() },
      caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
      ...config,
    });
    const submit = (extra: object = {}) =>
      gw.submitBatch(OutSchema, {
        slug: "q",
        items: [{ id: "a", variables: { q: "x" } }],
        cache: false,
        ...extra,
      });
    return { submit, model: () => submitted[0]![0]!.params.model };
  };

  it("uses the slug's model when no model is passed, and an explicit model still wins", async () => {
    const pinned = batchSetup({ modelHint: "claude-opus-4-8" }, on);
    await pinned.submit();
    expect(pinned.model()).toBe("claude-opus-4-8");

    const explicit = batchSetup({ modelHint: "claude-opus-4-8" }, on);
    await explicit.submit({ model: "claude-sonnet-4-6" });
    expect(explicit.model()).toBe("claude-sonnet-4-6");

    const flagOff = batchSetup({ modelHint: "claude-opus-4-8" }, {});
    await flagOff.submit();
    expect(flagOff.model()).toBe("claude-sonnet-4-6");
  });

  it("enforces a slug's ZDR lock", async () => {
    const locked = batchSetup({}, { zdr: { slugs: ["q"] } });
    await expect(locked.submit()).rejects.toThrow(ZdrViolationError);
    const eligible = batchSetup({ modelHint: "claude-opus-4-8" }, { ...on, zdr: { slugs: ["q"] } });
    await eligible.submit();
    expect(eligible.model()).toBe("claude-opus-4-8");
  });
});

// ---------------------------------------------------------------------------
describe("ProviderRegistry.resolveSlugModel", () => {
  const reg = new ProviderRegistry({
    defaultProvider: "anthropic",
    endpoints: { local: { baseURL: "http://localhost:1/v1" } },
    factories: { bedrock: { model: fakeLm } },
  });

  it("takes an endpoint or factory prefix as given", () => {
    expect(reg.resolveSlugModel("local:llama3")).toEqual({ provider: "local", model: "llama3" });
    expect(reg.resolveSlugModel("bedrock:anthropic.claude-v1:0")).toEqual({
      provider: "bedrock",
      model: "anthropic.claude-v1:0",
    });
  });

  it("qualifies a bare id with the row's provider, and lets a prefix override it", () => {
    expect(reg.resolveSlugModel("gpt-4.1", "openai")).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
    expect(reg.resolveSlugModel("llama3", "local")).toEqual({ provider: "local", model: "llama3" });
    expect(reg.resolveSlugModel("openai:gpt-4.1", "anthropic")).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
    // No provider on the row: the configured default provider.
    expect(reg.resolveSlugModel("claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("rejects what is not a model id", () => {
    expect(reg.resolveSlugModel("standard")).toBeUndefined();
    expect(reg.resolveSlugModel("fast", "anthropic")).toBeUndefined();
    expect(reg.resolveSlugModel("  ")).toBeUndefined();
    expect(reg.resolveSlugModel(null)).toBeUndefined();
    expect(reg.resolveSlugModel("gpt-4.1", "anthropic")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("the policy report", () => {
  it("says when the slug names the model and which slugs are locked", async () => {
    const { gw } = setup({ config: { ...on, zdr: { slugs: ["scout-chat", "intake"] } } });
    const report = await gw.describePolicy();
    expect(report.routing.slugPinWins).toBe(true);
    expect(report.zdrLockedSlugs).toEqual(["intake", "scout-chat"]);
    const off = await setup().gw.describePolicy();
    expect(off.routing.slugPinWins).toBe(false);
    expect(off.zdrLockedSlugs).toEqual([]);
  });
});
