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

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchProviderModels(provider: ProviderId, apiKey: string): Promise<string[]> {
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
      })) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id).sort();
    }
    case "venice": {
      const data = (await fetchJson("https://api.venice.ai/api/v1/models", {
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
      const models = await fetchProviderModels(provider, apiKey);
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
