import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "./providers.js";
import {
  listProviderModels,
  openRouterPricingToCents,
  togetherPricingToCents,
  __resetModelsListCache,
} from "./discovery.js";

describe("openRouterPricingToCents", () => {
  it("converts USD/token strings to cents per 1K tokens", () => {
    // gpt-4o-mini class pricing: $0.15/M in, $0.60/M out
    expect(openRouterPricingToCents({ prompt: "0.00000015", completion: "0.0000006" }))
      .toEqual({ in: 0.015, out: 0.06 });
  });
  it("rejects missing, non-numeric, and negative (dynamic) pricing", () => {
    expect(openRouterPricingToCents(undefined)).toBeUndefined();
    expect(openRouterPricingToCents({ prompt: "abc", completion: "1" })).toBeUndefined();
    expect(openRouterPricingToCents({ prompt: "-1", completion: "0.000001" })).toBeUndefined();
    expect(openRouterPricingToCents({ prompt: "0.000001" })).toBeUndefined();
  });
  it("accepts zero pricing (free models) without falling back", () => {
    expect(openRouterPricingToCents({ prompt: "0", completion: "0" })).toEqual({ in: 0, out: 0 });
  });
});

describe("togetherPricingToCents", () => {
  it("converts USD/1M-token numbers to cents per 1K tokens", () => {
    // $0.88/M in, $0.88/M out (Llama 70B class)
    const p = togetherPricingToCents({ input: 0.88, output: 0.88 })!;
    expect(p.in).toBeCloseTo(0.088, 10);
    expect(p.out).toBeCloseTo(0.088, 10);
  });
  it("rejects missing and negative pricing", () => {
    expect(togetherPricingToCents(undefined)).toBeUndefined();
    expect(togetherPricingToCents({ input: -1, output: 1 })).toBeUndefined();
  });
});

describe("together discovery handles raw-array response + pricing sync", () => {
  it("parses the array shape and registers pricing", async () => {
    __resetModelsListCache();
    const { vi } = await import("vitest");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", pricing: { input: 0.88, output: 0.88 } },
          ]),
          { status: 200 },
        ),
      ),
    );
    try {
      const registry = new ProviderRegistry({ apiKeys: { together: "tk" } });
      const res = await listProviderModels(registry, "together");
      expect(res.source).toBe("api");
      expect(registry.hasPricing("meta-llama/Llama-3.3-70B-Instruct-Turbo")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      __resetModelsListCache();
    }
  });
});

describe("openrouter discovery pricing sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetModelsListCache();
  });

  it("registers vendor pricing so estimateCostCents stops falling back", async () => {
    __resetModelsListCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "openai/gpt-4o-mini", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
              { id: "some/dynamic-model", pricing: { prompt: "-1", completion: "-1" } },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const registry = new ProviderRegistry({ apiKeys: { openrouter: "sk-or-test" } });
    const res = await listProviderModels(registry, "openrouter");

    expect(res.source).toBe("api");
    expect(res.models).toContain("openai/gpt-4o-mini");
    expect(registry.hasPricing("openai/gpt-4o-mini")).toBe(true);
    expect(registry.hasPricing("some/dynamic-model")).toBe(false);
    // 100 in + 200 out tokens at 0.015/0.06 cents per 1K
    const warn = vi.spyOn(console, "warn");
    expect(registry.estimateCostCents("openai/gpt-4o-mini", 100, 200)).toBeCloseTo(
      (100 * 0.015 + 200 * 0.06) / 1000,
      10,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
