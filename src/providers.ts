import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type {
  ChainLinkConfig,
  ModelPricing,
  ProviderConfig,
  ProviderId,
} from "./types.js";

export interface ResolvedModel {
  provider: ProviderId;
  model: string;
  /** undefined in mock mode or when no API key resolves. */
  languageModel?: LanguageModel;
}

export interface ChainLink {
  provider: ProviderId;
  model: string;
  /** Absent only for links kept keyless (native-Anthropic execution path). */
  languageModel?: LanguageModel;
}

export const PROVIDER_IDS: ProviderId[] = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "venice",
];

// OpenAI-compatible endpoints for aggregator providers.
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const VENICE_BASE = "https://api.venice.ai/api/v1";

const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  venice: "VENICE_API_KEY",
};

/**
 * Model-id scheme (LocalNewsBuddy convention): a bare id is Anthropic;
 * other providers use a scheme prefix — "openai:gpt-4.1",
 * "google:gemini-2.5-pro", "openrouter:meta-llama/llama-3.3-70b",
 * "venice:mistral-31-24b".
 */
export function parseModelId(id: string): { provider: ProviderId; model: string } {
  const idx = id.indexOf(":");
  if (idx > 0) {
    const prefix = id.slice(0, idx);
    if ((PROVIDER_IDS as string[]).includes(prefix)) {
      return { provider: prefix as ProviderId, model: id.slice(idx + 1) };
    }
  }
  return { provider: "anthropic", model: id };
}

// fast = cheapest/quickest tier, power = most capable. Override via
// ProviderConfig.tiers as models evolve. Aggregators have no built-in tiers.
const BUILTIN_TIERS: Partial<Record<ProviderId, { fast: string; power: string }>> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", power: "claude-sonnet-4-6" },
  google: { fast: "gemini-2.0-flash", power: "gemini-2.5-pro" },
  openai: { fast: "gpt-4.1-mini", power: "gpt-4.1" },
};

// Cents per 1K tokens. Extend/override via ProviderConfig.pricing.
const BUILTIN_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { in: 0.3, out: 1.5 },
  "claude-opus-4-8": { in: 1.5, out: 7.5 },
  "claude-haiku-4-5-20251001": { in: 0.08, out: 0.4 },
  "gemini-2.5-pro": { in: 0.125, out: 0.5 },
  "gemini-2.5-flash": { in: 0.015, out: 0.06 },
  "gemini-2.0-flash": { in: 0.01, out: 0.04 },
  "gpt-4.1": { in: 0.2, out: 0.8 },
  "gpt-4.1-mini": { in: 0.04, out: 0.16 },
  "gpt-4.1-nano": { in: 0.01, out: 0.04 },
};

const DEFAULT_FALLBACK_PRICING: ModelPricing = { in: 0.3, out: 1.5 };

export class ProviderRegistry {
  private readonly cfg: ProviderConfig;
  private readonly pricing: Record<string, ModelPricing>;

  constructor(cfg: ProviderConfig = {}) {
    this.cfg = cfg;
    this.pricing = { ...BUILTIN_PRICING, ...cfg.pricing };
  }

  apiKey(provider: ProviderId): string | undefined {
    return this.cfg.apiKeys?.[provider] ?? process.env[ENV_KEYS[provider]] ?? undefined;
  }

  /** Providers that currently have an API key resolvable (config or env). */
  configuredProviders(): ProviderId[] {
    return PROVIDER_IDS.filter((p) => !!this.apiKey(p));
  }

  /**
   * Known model ids per provider from the static maps (tier routing +
   * pricing). Fallback when a provider's models API is unreachable.
   */
  knownModels(provider: ProviderId): string[] {
    const prefixes: Partial<Record<ProviderId, string>> = {
      anthropic: "claude",
      google: "gemini",
      openai: "gpt",
    };
    const prefix = prefixes[provider];
    const fromTiers = Object.values(BUILTIN_TIERS[provider] ?? {});
    const fromPricing = prefix
      ? Object.keys(this.pricing).filter((m) => m.startsWith(prefix))
      : [];
    return Array.from(new Set([...fromTiers, ...fromPricing]));
  }

  tierModel(provider: ProviderId, tier: "fast" | "power"): string | undefined {
    return this.cfg.tiers?.[provider]?.[tier] ?? BUILTIN_TIERS[provider]?.[tier];
  }

  buildLanguageModel(
    provider: ProviderId,
    model: string,
    apiKey?: string,
  ): LanguageModel | null {
    const key = apiKey ?? this.apiKey(provider);
    if (!key) return null;
    switch (provider) {
      case "anthropic":
        return createAnthropic({ apiKey: key })(model);
      case "google":
        return createGoogleGenerativeAI({ apiKey: key })(model);
      case "openai":
        return createOpenAI({ apiKey: key })(model);
      case "openrouter":
        return createOpenAI({ apiKey: key, baseURL: OPENROUTER_BASE }).chat(model);
      case "venice":
        return createOpenAI({ apiKey: key, baseURL: VENICE_BASE }).chat(model);
      default:
        return null;
    }
  }

  /** Resolve a (possibly prefixed) model id to a ready LanguageModel. */
  resolveModelId(id: string): ResolvedModel {
    const { provider, model } = parseModelId(id);
    const lm = this.buildLanguageModel(provider, model);
    return { provider, model, languageModel: lm ?? undefined };
  }

  resolveDefault(override?: { provider?: ProviderId; model?: string }): ResolvedModel {
    const provider =
      override?.provider ??
      this.cfg.defaultProvider ??
      (process.env.AI_DEFAULT_PROVIDER as ProviderId | undefined) ??
      "anthropic";
    const model =
      override?.model ??
      this.cfg.defaultModel ??
      process.env.AI_DEFAULT_MODEL ??
      "claude-sonnet-4-6";
    const lm = this.buildLanguageModel(provider, model);
    return { provider, model, languageModel: lm ?? undefined };
  }

  buildChain(
    links: ChainLinkConfig[],
    tier?: "fast" | "power",
    /** Providers to keep in the chain even without a resolvable API key
     *  (the native execution path brings its own client). */
    keepKeyless?: ProviderId[],
  ): ChainLink[] {
    const out: ChainLink[] = [];
    for (const link of links) {
      if (link.languageModel) {
        // BYO model: tier re-routing doesn't apply (we can't rebuild it).
        out.push({
          provider: link.provider,
          model: link.model,
          languageModel: link.languageModel,
        });
        continue;
      }
      const model = (tier ? this.tierModel(link.provider, tier) : undefined) ?? link.model;
      const lm = this.buildLanguageModel(link.provider, model, link.apiKey);
      if (lm) out.push({ provider: link.provider, model, languageModel: lm });
      else if (keepKeyless?.includes(link.provider)) out.push({ provider: link.provider, model });
    }
    return out;
  }

  /** Register/override pricing at runtime (e.g. synced from a vendor's models API). */
  addPricing(model: string, pricing: ModelPricing): void {
    this.pricing[model] = pricing;
  }

  hasPricing(model: string): boolean {
    return model in this.pricing;
  }

  estimateCostCents(
    model: string,
    inputTokens: number,
    outputTokens: number,
    extras?: { cacheCreateTokens?: number; cacheReadTokens?: number; webSearches?: number },
  ): number {
    if (model === "mock" || model === "cache") return 0;
    let rate = this.pricing[model];
    if (!rate) {
      rate = this.cfg.fallbackPricing ?? DEFAULT_FALLBACK_PRICING;
      // Don't silently log $0 — a missing pricing entry must be visible.
      console.warn(
        `[llm-gateway] no pricing for "${model}" — using fallback estimate. Add it to ProviderConfig.pricing.`,
      );
    }
    // Anthropic ratios as defaults: cache write 1.25× input, cache read 0.1×.
    const cacheWriteRate = rate.cacheWrite ?? rate.in * 1.25;
    const cacheReadRate = rate.cacheRead ?? rate.in * 0.1;
    const tokenCents =
      (inputTokens * rate.in +
        outputTokens * rate.out +
        (extras?.cacheCreateTokens ?? 0) * cacheWriteRate +
        (extras?.cacheReadTokens ?? 0) * cacheReadRate) /
      1000;
    const searchCents =
      (extras?.webSearches ?? 0) * (this.cfg.webSearchCentsPerCall ?? 1);
    return tokenCents + searchCents;
  }
}
