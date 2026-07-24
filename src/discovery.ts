// Live provider/model discovery — model lists come from each vendor's models
// API instead of hardcoded arrays, for every provider with an API key
// configured. When a provider has no key or its API errors, the static
// knownModels() list is returned with source:"fallback" so admin UIs stay
// usable offline.

import type { ProviderRegistry } from "./providers.js";
import { PROVIDER_IDS } from "./providers.js";
import type { ProviderId } from "./types.js";

export interface ProviderModels {
  provider: ProviderId;
  models: string[];
  source: "api" | "fallback";
  /** Set when the provider has a key configured (fallback ≠ unconfigured). */
  configured: boolean;
  error?: string;
}

// OpenAI's /v1/models returns every SKU; keep chat-capable text models only.
const OPENAI_EXCLUDE =
  /(embed|whisper|tts|audio|realtime|image|dall-e|moderation|transcribe|search|davinci|babbage|instruct)/i;

interface OpenRouterModel {
  id: string;
  /** USD per single token, as decimal strings. Negative = dynamic/BYOK. */
  pricing?: { prompt?: string; completion?: string };
}

/**
 * Convert OpenRouter per-token USD strings to cents per 1K tokens.
 * Returns undefined for missing, non-finite, or negative (dynamic) pricing —
 * never register a price we don't actually know.
 */
export function openRouterPricingToCents(
  pricing: OpenRouterModel["pricing"],
): { in: number; out: number } | undefined {
  if (!pricing) return undefined;
  const inUsd = Number(pricing.prompt);
  const outUsd = Number(pricing.completion);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd)) return undefined;
  if (inUsd < 0 || outUsd < 0) return undefined;
  // USD/token → cents/1K tokens: × 1000 tokens × 100 cents.
  return { in: inUsd * 100_000, out: outUsd * 100_000 };
}

interface TogetherModel {
  id: string;
  /** USD per 1M tokens (note: different unit from OpenRouter's per-token). */
  pricing?: { input?: number; output?: number };
}

/** Together prices are USD per 1M tokens → cents per 1K = usd × 0.1. */
export function togetherPricingToCents(
  pricing: TogetherModel["pricing"],
): { in: number; out: number } | undefined {
  if (!pricing) return undefined;
  const inUsd = Number(pricing.input);
  const outUsd = Number(pricing.output);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd)) return undefined;
  if (inUsd < 0 || outUsd < 0) return undefined;
  return { in: inUsd * 0.1, out: outUsd * 0.1 };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchProviderModels(
  provider: ProviderId,
  apiKey: string,
  registry: ProviderRegistry,
): Promise<string[]> {
  switch (provider) {
    case "anthropic": {
      const data = (await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      })) as { data: { id: string }[] };
      return data.data.map((m) => m.id);
    }
    case "openai": {
      const data = (await fetchJson("https://api.openai.com/v1/models", {
        Authorization: `Bearer ${apiKey}`,
      })) as { data: { id: string }[] };
      return data.data
        .map((m) => m.id)
        .filter((id) => /^(gpt-|o\d)/.test(id) && !OPENAI_EXCLUDE.test(id))
        .sort();
    }
    case "google": {
      const data = (await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
        {},
      )) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (data.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .sort();
    }
    case "openrouter": {
      const data = (await fetchJson("https://openrouter.ai/api/v1/models", {
        Authorization: `Bearer ${apiKey}`,
      })) as { data?: OpenRouterModel[] };
      const models = data.data ?? [];
      // OpenRouter's models API includes per-token USD pricing — sync it into
      // the registry so estimateCostCents never falls back for these models.
      for (const m of models) {
        const pricing = openRouterPricingToCents(m.pricing);
        if (pricing) registry.addPricing(m.id, pricing);
      }
      return models.map((m) => m.id).sort();
    }
    case "venice": {
      const data = (await fetchJson("https://api.venice.ai/api/v1/models", {
        Authorization: `Bearer ${apiKey}`,
      })) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id).sort();
    }
    case "together": {
      // Together returns a raw array (not {data}) with $/1M-token pricing.
      const raw = (await fetchJson("https://api.together.xyz/v1/models", {
        Authorization: `Bearer ${apiKey}`,
      })) as
        | TogetherModel[]
        | { data?: TogetherModel[] };
      const models = Array.isArray(raw) ? raw : (raw.data ?? []);
      for (const m of models) {
        const pricing = togetherPricingToCents(m.pricing);
        if (pricing) registry.addPricing(m.id, pricing);
      }
      return models.map((m) => m.id).sort();
    }
    case "huggingface": {
      const data = (await fetchJson("https://router.huggingface.co/v1/models", {
        Authorization: `Bearer ${apiKey}`,
      })) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id).sort();
    }
  }
}

// Provider model lists change rarely; don't hit five vendor APIs on every
// admin page load. A 10-minute lag on a newly released model id is fine.
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<ProviderId, { expiresAt: number; value: ProviderModels }>();

export function __resetModelsListCache(): void {
  cache.clear();
}

export async function listProviderModels(
  registry: ProviderRegistry,
  provider: ProviderId,
): Promise<ProviderModels> {
  const hit = cache.get(provider);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const apiKey = registry.apiKey(provider);
  let value: ProviderModels;
  if (!apiKey) {
    value = {
      provider,
      models: registry.knownModels(provider),
      source: "fallback",
      configured: false,
    };
  } else {
    try {
      const models = await fetchProviderModels(provider, apiKey, registry);
      value =
        models.length > 0
          ? { provider, models, source: "api", configured: true }
          : {
              provider,
              models: registry.knownModels(provider),
              source: "fallback",
              configured: true,
            };
    } catch (err) {
      value = {
        provider,
        models: registry.knownModels(provider),
        source: "fallback",
        configured: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  cache.set(provider, { expiresAt: Date.now() + TTL_MS, value });
  return value;
}

/**
 * Model lists for every provider that has an API key configured (config or
 * env). Pass includeUnconfigured:true to also get static fallback lists for
 * keyless providers (useful for a "connect a provider" admin view).
 */
export async function listAllProviderModels(
  registry: ProviderRegistry,
  opts: { includeUnconfigured?: boolean } = {},
): Promise<ProviderModels[]> {
  const providers = opts.includeUnconfigured
    ? PROVIDER_IDS
    : registry.configuredProviders();
  return Promise.all(providers.map((p) => listProviderModels(registry, p)));
}
