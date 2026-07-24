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
  /** Built-in ProviderId or custom endpoint name. */
  provider: string;
  model: string;
  /** Absent only for links kept keyless (native-Anthropic execution path). */
  languageModel?: LanguageModel;
}

/** Localhost presets for common self-hosted serving stacks — usable with
 *  zero config; override via ProviderConfig.endpoints. */
const LOCAL_PRESETS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  vllm: "http://localhost:8000/v1",
  lmstudio: "http://localhost:1234/v1",
};

export const PROVIDER_IDS: ProviderId[] = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "venice",
  "together",
  "huggingface",
];

// OpenAI-compatible endpoints for aggregator providers.
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const VENICE_BASE = "https://api.venice.ai/api/v1";
const TOGETHER_BASE = "https://api.together.xyz/v1";
const HF_ROUTER_BASE = "https://router.huggingface.co/v1";

const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  venice: "VENICE_API_KEY",
  together: "TOGETHER_API_KEY",
  huggingface: "HF_TOKEN",
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
   * Caller-asserted ZDR status. "provider:model" beats "provider"; missing
   * entry = NOT ZDR (fail closed). "mock" and "cache" are trivially ZDR.
   * Custom endpoints default to ZDR (self-hosted) unless overridden.
   */
  isZdr(provider: string, model: string): boolean {
    if (provider === "mock" || provider === "cache") return true;
    const r = this.cfg.retention;
    const entry = r?.[`${provider}:${model}`] ?? r?.[provider];
    if (entry) return entry.zdr === true;
    return this.isEndpoint(provider); // self-hosted default: ZDR
  }

  /** Is this name a configured custom endpoint or a local preset? */
  isEndpoint(name: string): boolean {
    return !!(this.cfg.endpoints?.[name] ?? LOCAL_PRESETS[name]);
  }

  /** Endpoint-aware model-id parse: built-in prefixes win, then endpoint
   *  names, then bare = Anthropic. */
  parseAny(id: string): { provider: string; model: string; endpoint: boolean } {
    const idx = id.indexOf(":");
    if (idx > 0) {
      const prefix = id.slice(0, idx);
      if ((PROVIDER_IDS as string[]).includes(prefix)) {
        return { provider: prefix, model: id.slice(idx + 1), endpoint: false };
      }
      if (this.isEndpoint(prefix)) {
        return { provider: prefix, model: id.slice(idx + 1), endpoint: true };
      }
    }
    const p = parseModelId(id);
    return { provider: p.provider, model: p.model, endpoint: false };
  }

  buildEndpointModel(name: string, model: string): LanguageModel | null {
    const cfg = this.cfg.endpoints?.[name];
    const baseURL = cfg?.baseURL ?? LOCAL_PRESETS[name];
    if (!baseURL) return null;
    const apiKey =
      cfg?.apiKey ??
      (cfg?.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ??
      "local-no-key"; // local servers typically ignore auth; SDK requires a string
    return createOpenAI({ apiKey, baseURL }).chat(model);
  }

  /** Build for a built-in provider OR a custom endpoint. */
  buildAny(provider: string, model: string): LanguageModel | null {
    if (this.isEndpoint(provider)) return this.buildEndpointModel(provider, model);
    if ((PROVIDER_IDS as string[]).includes(provider)) {
      return this.buildLanguageModel(provider as ProviderId, model);
    }
    return null;
  }

  /** Link-aware cost estimate: custom endpoints cost $0 (tokens are still
   *  logged) so spend caps stay about real money. */
  estimateForLink(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    extras?: { cacheCreateTokens?: number; cacheReadTokens?: number; webSearches?: number },
  ): number {
    if (this.isEndpoint(provider)) return 0;
    return this.estimateCostCents(model, inputTokens, outputTokens, extras);
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
      case "together":
        return createOpenAI({ apiKey: key, baseURL: TOGETHER_BASE }).chat(model);
      case "huggingface":
        return createOpenAI({ apiKey: key, baseURL: HF_ROUTER_BASE }).chat(model);
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
      const name = link.endpoint ?? link.provider;
      if (!name) continue; // one of provider/endpoint is required
      if (link.languageModel) {
        // BYO model: tier re-routing doesn't apply (we can't rebuild it).
        out.push({ provider: name, model: link.model, languageModel: link.languageModel });
        continue;
      }
      if (link.endpoint) {
        const lm = this.buildEndpointModel(link.endpoint, link.model);
        if (lm) out.push({ provider: link.endpoint, model: link.model, languageModel: lm });
        continue;
      }
      const model = (tier ? this.tierModel(link.provider!, tier) : undefined) ?? link.model;
      const lm = this.buildLanguageModel(link.provider!, model, link.apiKey);
      if (lm) out.push({ provider: link.provider!, model, languageModel: lm });
      else if (keepKeyless?.includes(link.provider!)) out.push({ provider: link.provider!, model });
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
