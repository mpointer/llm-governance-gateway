// #57: a ModelConfigStore pin skipped the task layer wholesale, so a
// TaskOverrideStore entry was never read while any pin existed. With
// tasks.overridesBeatPin set, a store entry for the call's task outranks the
// pin. Default (unset) must behave exactly as before.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { ModelConfigStore, TaskOverrideStore } from "./types.js";

function fakeLm(text: string, calls: string[], id: string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      calls.push(id);
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      calls.push(id);
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: text },
        { type: "text-end", id: "1" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

const json = JSON.stringify({ answer: "from-override" });

// The pin points at anthropic with an empty key, so reaching it throws
// deterministically ("No API key") instead of dialling a real provider.
function setup(opts: { overridesBeatPin?: boolean; storeEntries?: Record<string, string> }) {
  const calls: string[] = [];
  const storeReads: (string | null | undefined)[] = [];
  const store: TaskOverrideStore = {
    getOverrides: async (orgId) => {
      storeReads.push(orgId);
      return opts.storeEntries ?? { summarize: "admin:m" };
    },
  };
  // CareerPointers' F-116 shape: never null while a pin row exists, tier or not.
  const modelConfig: ModelConfigStore = {
    getOverride: async () => ({ provider: "anthropic", model: "pinned-model" }),
    getChain: async () => [],
  };
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    promptDefaults: [{ slug: "q", body: "Q {{q}}", variables: ["q"] }],
    modelConfig,
    tasks: {
      defaults: { summarize: "codedefault:m", other: "codedefault:m" },
      store,
      overridesBeatPin: opts.overridesBeatPin,
    },
    providers: {
      apiKeys: { anthropic: "" },
      factories: {
        admin: { model: () => fakeLm(json, calls, "admin") },
        codedefault: { model: () => fakeLm(json, calls, "codedefault") },
      },
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
  return { gw, usage, calls, storeReads };
}

const run = {
  slug: "q",
  schema: z.object({ answer: z.string() }),
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  task: "summarize",
  tier: "fast" as const,
};

describe("#57 TaskOverrideStore vs ModelConfigStore pin", () => {
  it("default: the pin wins and the task store is never read", async () => {
    const { gw, calls, storeReads } = setup({});
    await expect(gw.runStructured(run)).rejects.toThrow(/No API key for provider "anthropic"/);
    expect(calls).toEqual([]);
    expect(storeReads).toEqual([]);
  });

  it("overridesBeatPin: a store entry for the task beats the pin (runStructured)", async () => {
    const { gw, usage, calls } = setup({ overridesBeatPin: true });
    const res = await gw.runStructured(run);
    expect(res.object).toEqual({ answer: "from-override" });
    expect(calls).toEqual(["admin"]);
    expect(usage.entries[0]!.provider).toBe("admin");
  });

  it("overridesBeatPin: same on runText", async () => {
    const { gw, calls } = setup({ overridesBeatPin: true });
    const { schema: _s, ...textRun } = run;
    await gw.runText(textRun);
    expect(calls).toEqual(["admin"]);
  });

  it("overridesBeatPin: same on streamStructured", async () => {
    const { gw, calls } = setup({ overridesBeatPin: true });
    const res = await gw.streamStructured(run);
    expect(await res.object).toEqual({ answer: "from-override" });
    expect(calls).toEqual(["admin"]);
  });

  it("overridesBeatPin: same on streamText", async () => {
    const { gw, calls } = setup({ overridesBeatPin: true });
    const res = await gw.streamText({
      slug: "q",
      task: "summarize",
      messages: [{ role: "user", content: "x" }],
    });
    expect((await res.result).provider).toBe("admin");
    expect(calls).toEqual(["admin"]);
  });

  it("overridesBeatPin: a code default alone still loses to the pin", async () => {
    const { gw, calls } = setup({ overridesBeatPin: true, storeEntries: { other: "admin:m" } });
    await expect(gw.runStructured(run)).rejects.toThrow(/No API key for provider "anthropic"/);
    expect(calls).toEqual([]);
  });
});
