// Prompt-scoped cache keys (A0 of docs/design/admin-control-plane-package.md).
//
// The bug: cacheKey() never included the prompt, and the cache is read BEFORE
// loadPrompt. So editing a prompt changed nothing for any already-cached input
// until the 24h TTL expired — the admin saw a successful publish, production
// kept serving the old version, and nothing reported a problem.
//
// So the load-bearing test here is not "the key differs". It is: EDIT A PROMPT
// AND SEE DIFFERENT OUTPUT. A key-shape assertion would pass against a build
// that computed a fine key and still served the stale entry.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Gateway, cacheKey, promptFingerprint } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import type { StoredPrompt, PromptStore } from "./types.js";

const OutSchema = z.object({ answer: z.string() });

const RUN = {
  slug: "q",
  schema: OutSchema,
  input: { q: "x" },
  variables: (i: { q: string }) => ({ q: i.q }),
  cacheParts: ["same-input"],
};

/** A prompt store whose body can be edited between calls, like an admin would. */
class EditablePromptStore implements PromptStore {
  reads = 0;
  constructor(public row: StoredPrompt) {}
  async getPrompt(): Promise<StoredPrompt | undefined> {
    this.reads++;
    return this.row;
  }
}

function gw(prompts: PromptStore, scoped: boolean) {
  const usage = new MemoryUsageStore();
  const g = new Gateway({
    usage,
    mock: true,
    prompts,
    promptDefaults: [{ slug: "q", body: "code default {{q}}", variables: ["q"] }],
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
    invalidateCacheOnPromptChange: scoped,
  });
  g.registerMockResponder("q", () => ({ answer: "ok" }));
  return { g, usage };
}

describe("editing a prompt invalidates its cached answers", () => {
  it("scoped: a published edit takes effect immediately", async () => {
    const store = new EditablePromptStore({ slug: "q", body: "VERSION-ONE {{q}}" });
    const { g, usage } = gw(store, true);

    await g.runStructured({ ...RUN });

    // The admin publishes a new body.
    store.row = { slug: "q", body: "VERSION-TWO {{q}}" };

    const second = await g.runStructured({ ...RUN });
    expect(second.cacheHit).toBe(false);

    // What the model was actually asked, per the ledger.
    const sent = usage.entries.filter((e) => e.provider !== "cache").map((e) => e.inputText);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("VERSION-ONE");
    expect(sent[1]).toContain("VERSION-TWO");
  });

  it("UNSCOPED (the default): the edit is invisible until the TTL expires", async () => {
    // Documents the pre-existing behaviour rather than endorsing it. This is
    // the exact failure the flag exists to close, and it stays the default so
    // no existing adopter's cache is invalidated by upgrading.
    const store = new EditablePromptStore({ slug: "q", body: "VERSION-ONE {{q}}" });
    const { g, usage } = gw(store, false);

    await g.runStructured({ ...RUN });
    store.row = { slug: "q", body: "VERSION-TWO {{q}}" };

    const second = await g.runStructured({ ...RUN });
    expect(second.cacheHit).toBe(true);

    // Only ONE generation ever happened, on the old body. The edit reached
    // nothing.
    const sent = usage.entries.filter((e) => e.provider !== "cache").map((e) => e.inputText);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("VERSION-ONE");
  });

  it("scoped: an unchanged prompt still hits the cache", async () => {
    // Invalidation must be driven by real change, not by the mere presence of
    // the fingerprint — otherwise the flag silently disables caching.
    const store = new EditablePromptStore({ slug: "q", body: "STABLE {{q}}" });
    const { g } = gw(store, true);

    await g.runStructured({ ...RUN });
    const second = await g.runStructured({ ...RUN });
    expect(second.cacheHit).toBe(true);
  });

  it("scoped: repointing a prompt at a different model also invalidates", async () => {
    // modelHint changes which model answers, so it changes the answer. A
    // body-only version would miss this.
    const store = new EditablePromptStore({ slug: "q", body: "SAME {{q}}" });
    const { g } = gw(store, true);

    await g.runStructured({ ...RUN });
    store.row = { slug: "q", body: "SAME {{q}}", modelHint: "openai:gpt-4.1" };

    const second = await g.runStructured({ ...RUN });
    expect(second.cacheHit).toBe(false);
  });
});

describe("the cost of the flag, made explicit", () => {
  it("scoped: a cache HIT costs a prompt-store read", async () => {
    const store = new EditablePromptStore({ slug: "q", body: "B {{q}}" });
    const { g } = gw(store, true);
    await g.runStructured({ ...RUN });
    const before = store.reads;
    await g.runStructured({ ...RUN }); // a hit
    expect(store.reads).toBe(before + 1);
  });

  it("unscoped: a cache HIT costs no prompt-store read", async () => {
    // This is the optimisation the default ordering exists to preserve, and
    // the reason the flag is opt-in rather than always on.
    const store = new EditablePromptStore({ slug: "q", body: "B {{q}}" });
    const { g } = gw(store, false);
    await g.runStructured({ ...RUN });
    const before = store.reads;
    await g.runStructured({ ...RUN }); // a hit
    expect(store.reads).toBe(before);
  });
});

describe("key shape stays backward compatible", () => {
  it("no fingerprint = byte-identical to the pre-0.13 key", () => {
    expect(cacheKey("q", ["a"])).toBe(cacheKey("q", ["a"], undefined, undefined));
    expect(cacheKey("q", ["a"])).not.toContain(":p");
    expect(cacheKey("q", ["a"], "org1")).toMatch(/^aicache:org:org1:q:[0-9a-f]{32}$/);
    expect(cacheKey("q", ["a"])).toMatch(/^aicache:q:[0-9a-f]{32}$/);
  });

  it("a fingerprint appends, never rewrites", () => {
    const plain = cacheKey("q", ["a"], "org1");
    expect(cacheKey("q", ["a"], "org1", "deadbeef")).toBe(`${plain}:pdeadbeef`);
  });
});

describe("promptFingerprint", () => {
  it("is stable for equal configs and differs on any field", () => {
    const base = { body: "b", modelHint: "m", providerOverride: "p", temperature: 0.5 };
    expect(promptFingerprint(base)).toBe(promptFingerprint({ ...base }));
    expect(promptFingerprint({ ...base, body: "b2" })).not.toBe(promptFingerprint(base));
    expect(promptFingerprint({ ...base, modelHint: "m2" })).not.toBe(promptFingerprint(base));
    expect(promptFingerprint({ ...base, providerOverride: "p2" })).not.toBe(
      promptFingerprint(base),
    );
    expect(promptFingerprint({ ...base, temperature: 0.6 })).not.toBe(promptFingerprint(base));
  });

  it("does not confuse adjacent fields", () => {
    // Naive concatenation would make {body:"ab", hint:""} and {body:"a", hint:"b"}
    // collide, which would mean an edit that moved text between fields did not
    // invalidate. The null separators prevent it.
    expect(promptFingerprint({ body: "ab" })).not.toBe(
      promptFingerprint({ body: "a", modelHint: "b" }),
    );
  });

  it("distinguishes unset from empty temperature", () => {
    expect(promptFingerprint({ body: "b" })).not.toBe(
      promptFingerprint({ body: "b", temperature: 0 }),
    );
  });
});
