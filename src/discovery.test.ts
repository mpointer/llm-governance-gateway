import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "./providers.js";
import {
  listProviderModels,
  openRouterPricingToCents,
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
