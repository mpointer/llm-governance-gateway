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
  languageModel: LanguageModel;
}

// fast = cheapest/quickest tier, power = most capable. Override via
// ProviderConfig.tiers as models evolve.
const BUILTIN_TIERS: Record<ProviderId, { fast: string; power: string }> = {
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
    const fromCfg = this.cfg.apiKeys?.[provider];
    if (fromCfg) return fromCfg;
    switch (provider) {
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "google":
        return process.env.GOOGLE_API_KEY;
      case "openai":
        return process.env.OPENAI_API_KEY;
    }
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
      default:
        return null;
    }
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

  buildChain(links: ChainLinkConfig[], tier?: "fast" | "power"): ChainLink[] {
    const out: ChainLink[] = [];
    for (const link of links) {
      const model = (tier ? this.tierModel(link.provider, tier) : undefined) ?? link.model;
      const lm = this.buildLanguageModel(link.provider, model, link.apiKey);
      if (lm) out.push({ provider: link.provider, model, languageModel: lm });
    }
    return out;
  }

  estimateCostCents(model: string, inputTokens: number, outputTokens: number): number {
    if (model === "mock" || model === "cache") return 0;
    const rate = this.pricing[model];
    if (!rate) {
      const fb = this.cfg.fallbackPricing ?? DEFAULT_FALLBACK_PRICING;
      // Don't silently log $0 — a missing pricing entry must be visible.
      console.warn(
        `[llm-gateway] no pricing for "${model}" — using fallback estimate. Add it to ProviderConfig.pricing.`,
      );
      return (inputTokens * fb.in + outputTokens * fb.out) / 1000;
    }
    return (inputTokens * rate.in + outputTokens * rate.out) / 1000;
  }
}
