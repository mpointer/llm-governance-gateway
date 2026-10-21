// Built-in pricing carries an as-of date per row.
//
// The staleness check itself (newest date more than a quarter old) is NOT a
// test: a test that fails on the calendar would turn every unrelated PR red
// the day it trips. It lives in scripts/pricing-staleness.mjs, run by the
// monthly pricing-staleness workflow. These tests pin the invariants that
// script relies on, which never depend on today's date.

import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRICING,
  PRICING_STALE_AFTER_DAYS,
  ProviderRegistry,
  newestBuiltinPricingDate,
} from "./providers.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("built-in pricing as-of dates", () => {
  it("every built-in rate carries a valid ISO as-of date", () => {
    for (const [model, rate] of Object.entries(BUILTIN_PRICING)) {
      expect(rate.asOf, `${model} has no asOf`).toMatch(ISO_DATE);
      expect(Number.isNaN(Date.parse(rate.asOf!)), `${model} asOf unparseable`).toBe(false);
    }
  });

  it("newestBuiltinPricingDate is the max over the table", () => {
    const dates = Object.values(BUILTIN_PRICING)
      .map((r) => r.asOf!)
      .sort();
    expect(newestBuiltinPricingDate()).toBe(dates[dates.length - 1]);
  });

  it("the staleness window is one quarter", () => {
    expect(PRICING_STALE_AFTER_DAYS).toBe(90);
  });

  it("pricingAsOf reads through prefixed ids and returns undefined for unknown rates", () => {
    const r = new ProviderRegistry();
    expect(r.pricingAsOf("openai:gpt-4.1")).toBe(BUILTIN_PRICING["gpt-4.1"]!.asOf);
    expect(r.pricingAsOf("gpt-4.1")).toBe(BUILTIN_PRICING["gpt-4.1"]!.asOf);
    expect(r.pricingAsOf("no-such-model")).toBeUndefined();
  });

  it("a rate registered without asOf stays undated rather than inheriting one", () => {
    const r = new ProviderRegistry({ pricing: { "my-model": { in: 1, out: 2 } } });
    expect(r.hasPricing("my-model")).toBe(true);
    expect(r.pricingAsOf("my-model")).toBeUndefined();
  });
});
