// Schema-validation-aware failover: repair retry on the same link, then fall
// to the next chain link. Uses hand-rolled LanguageModelV2 fakes injected via
// ChainLinkConfig.languageModel (the BYO-model seam).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import { isSchemaValidationError } from "./backoff.js";

const OutSchema = z.object({ answer: z.string() });

// Minimal LanguageModelV2 fake: returns queued raw texts in order and
// records every prompt it receives.
function fakeModel(responses: string[]): {
  model: LanguageModel;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const model = {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown }) {
      calls.push(JSON.stringify(options.prompt));
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("not implemented");
    },
  } as unknown as LanguageModel;
  return { model, calls };
}

function gatewayWithChain(links: { model: LanguageModel }[]) {
  return new Gateway({
    usage: new MemoryUsageStore(),
    promptDefaults: [{ slug: "q", body: "Answer: {{q}}", variables: ["q"] }],
    modelConfig: {
      getOverride: async () => null,
      getChain: async () =>
        links.map((l, idx) => ({
          provider: "anthropic" as const,
          model: `fake-${idx}`,
          languageModel: l.model,
        })),
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });
}

const runOpts = {
  slug: "q",
  schema: OutSchema,
  input: { q: "hi" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cache: false as const,
  anonKey: "t",
};

describe("schema-validation-aware failover", () => {
  it("repairs on the same link: validation error is fed back into the prompt", async () => {
    const bad = `{"wrong_field": 1}`;
    const good = `{"answer": "fixed"}`;
    const { model, calls } = fakeModel([bad, good]);
    const gw = gatewayWithChain([{ model }]);

    const res = await gw.runStructured(runOpts);
    expect(res.object).toEqual({ answer: "fixed" });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("failed schema validation");
  });

  it("falls to the next chain link when repair also fails", async () => {
    const alwaysBad = fakeModel([`not even json`, `still not json`]);
    const good = fakeModel([`{"answer": "from-link-2"}`]);
    const gw = gatewayWithChain([{ model: alwaysBad.model }, { model: good.model }]);

    const res = await gw.runStructured(runOpts);
    expect(res.object).toEqual({ answer: "from-link-2" });
    expect(alwaysBad.calls).toHaveLength(2); // original + repair
    expect(good.calls).toHaveLength(1);
  });

  it("throws the validation error when every link exhausts repair", async () => {
    const bad1 = fakeModel([`{}`]);
    const bad2 = fakeModel([`{}`]);
    const gw = gatewayWithChain([{ model: bad1.model }, { model: bad2.model }]);

    try {
      await gw.runStructured(runOpts);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isSchemaValidationError(e)).toBe(true);
    }
    expect(bad1.calls).toHaveLength(2);
    expect(bad2.calls).toHaveLength(2);
  });
});
