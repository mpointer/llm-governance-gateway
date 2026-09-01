// Pricing key normalisation (issue #9).
//
// The reported failure: an adopter using the scheme-prefix convention the
// README teaches for tasks.defaults and ChainLinkConfig.model registered
// pricing as "openai:gpt-4.1", lookups happened under the bare "gpt-4.1",
// nothing matched, and every call was priced at the fallback estimate — with
// only a per-call console.warn nobody was looking at. It shipped to production
// and was caught by reading providers.ts line by line.
//
// So these tests assert the PRICE, not just that a key exists: the bug was
// never "the map is missing a key", it was "the cost is silently wrong".

import { describe, expect, it, vi, afterEach } from "vitest";
import { ProviderRegistry } from "./providers.js";

const RATE = { in: 1, out: 2 };
// 1000 in + 1000 out at RATE = (1000*1 + 1000*2)/1000 = 3 cents.
const EXPECTED = 3;
// The built-in fallback is 0.3/1.5 → (1000*0.3 + 1000*1.5)/1000 = 1.8 cents.
const FALLBACK = 1.8;

afterEach(() => vi.restoreAllMocks());

describe("pricing accepts both id forms", () => {
  it("addPricing with a prefixed id prices the bare id", () => {
    const r = new ProviderRegistry();
    r.addPricing("openai:gpt-4.1", RATE);
    // The lookup the gateway actually performs uses the bare model.
    expect(r.estimateCostCents("gpt-4.1", 1000, 1000)).toBe(EXPECTED);
  });

  it("addPricing with a bare id still works — unchanged behaviour", () => {
    const r = new ProviderRegistry();
    r.addPricing("gpt-4.1", RATE);
    expect(r.estimateCostCents("gpt-4.1", 1000, 1000)).toBe(EXPECTED);
  });

  it("a prefixed key in ProviderConfig.pricing is normalised too", () => {
    // Same footgun, reached through config instead of the runtime call.
    const r = new ProviderRegistry({ pricing: { "openai:gpt-4.1": RATE } });
    expect(r.estimateCostCents("gpt-4.1", 1000, 1000)).toBe(EXPECTED);
  });

  it("hasPricing answers for either form", () => {
    const r = new ProviderRegistry();
    r.addPricing("openai:gpt-4.1", RATE);
    expect(r.hasPricing("gpt-4.1")).toBe(true);
    expect(r.hasPricing("openai:gpt-4.1")).toBe(true);
    expect(r.hasPricing("gpt-9")).toBe(false);
  });
});

describe("ids that merely contain a colon are left alone", () => {
  it("keeps an OpenRouter variant suffix intact", () => {
    // "meta-llama/llama-3.1-8b-instruct" is not a provider id, so nothing is
    // stripped. Getting this wrong would silently unprice every OpenRouter
    // variant model — the same class of bug in the other direction.
    const r = new ProviderRegistry();
    const id = "meta-llama/llama-3.1-8b-instruct:free";
    r.addPricing(id, RATE);
    expect(r.estimateCostCents(id, 1000, 1000)).toBe(EXPECTED);
    expect(r.hasPricing(id)).toBe(true);
  });

  it("keeps a slash-scoped vendor id intact (the discovery path)", () => {
    const r = new ProviderRegistry();
    r.addPricing("meta-llama/Llama-3.3-70B-Instruct-Turbo", RATE);
    expect(
      r.estimateCostCents("meta-llama/Llama-3.3-70B-Instruct-Turbo", 1000, 1000),
    ).toBe(EXPECTED);
  });
});

describe("the missing-pricing warning", () => {
  it("still falls back rather than throwing — the ledger row must survive", () => {
    // estimateCostCents runs inline inside the usage-row payload, so throwing
    // here would cost the audit trail for a call that already spent money.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ProviderRegistry();
    expect(r.estimateCostCents("unpriced-model", 1000, 1000)).toBe(FALLBACK);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns ONCE per model, not once per call", () => {
    // The old per-call warning was emitted on a hot path, which in production
    // means drowned out or switched off. Either way nobody saw it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ProviderRegistry();
    for (let i = 0; i < 5; i++) r.estimateCostCents("unpriced-model", 10, 10);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns separately for each distinct unpriced model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ProviderRegistry();
    r.estimateCostCents("unpriced-a", 10, 10);
    r.estimateCostCents("unpriced-b", 10, 10);
    r.estimateCostCents("unpriced-a", 10, 10);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("names the prefixed-key mistake, since that is what causes it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ProviderRegistry();
    r.estimateCostCents("unpriced-model", 10, 10);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain("BARE model id");
    expect(msg).toContain("assertPricingComplete");
  });

  it("says nothing for mock and cache rows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ProviderRegistry();
    expect(r.estimateCostCents("mock", 100, 100)).toBe(0);
    expect(r.estimateCostCents("cache", 100, 100)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("startup preflight", () => {
  it("assertPricingComplete throws listing everything missing", () => {
    const r = new ProviderRegistry();
    r.addPricing("openai:gpt-4.1", RATE);
    expect(() =>
      r.assertPricingComplete(["gpt-4.1", "missing-a", "missing-b"]),
    ).toThrow(/missing-a, missing-b/);
  });

  it("passes when every id is priced, in either form", () => {
    const r = new ProviderRegistry();
    r.addPricing("gpt-4.1", RATE);
    expect(() =>
      r.assertPricingComplete(["gpt-4.1", "openai:gpt-4.1"]),
    ).not.toThrow();
  });

  it("missingPricing reports without throwing", () => {
    const r = new ProviderRegistry();
    r.addPricing("gpt-4.1", RATE);
    expect(r.missingPricing(["gpt-4.1", "nope"])).toEqual(["nope"]);
    expect(r.missingPricing([])).toEqual([]);
  });
});
