import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { InvalidModelHintError } from "./errors.js";
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
  /** Per-link temperature override; null = never send. See ChainLinkConfig. */
  temperature?: number | null;
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
  // gemini-2.0-flash retired by Google 2026-07 (API returns "no longer
  // available"); 3.1-flash-lite is Google's recommended replacement,
  // verified live 2026-07.
  google: { fast: "gemini-3.1-flash-lite", power: "gemini-2.5-pro" },
  openai: { fast: "gpt-4.1-mini", power: "gpt-4.1" },
};

// Cents per 1K tokens. Extend/override via ProviderConfig.pricing.
const BUILTIN_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { in: 0.3, out: 1.5 },
  "claude-opus-4-8": { in: 1.5, out: 7.5 },
  "claude-haiku-4-5-20251001": { in: 0.08, out: 0.4 },
  "gemini-2.5-pro": { in: 0.125, out: 0.5 },
  "gemini-2.5-flash": { in: 0.015, out: 0.06 },
  "gemini-3.1-flash-lite": { in: 0.025, out: 0.15 }, // paid-tier ceiling, ai.google.dev pricing 2026-07
  "gpt-4.1": { in: 0.2, out: 0.8 },
  "gpt-4.1-mini": { in: 0.04, out: 0.16 },
  "gpt-4.1-nano": { in: 0.01, out: 0.04 },
  // Embeddings (no output tokens).
  "text-embedding-3-small": { in: 0.002, out: 0 },
  "text-embedding-3-large": { in: 0.013, out: 0 },
};

/**
 * Pricing is keyed on the BARE model id, because that is what a chain link
 * carries and what `estimateCostCents` is called with. An adopter who uses the
 * scheme-prefix convention everywhere else — as the README tells them to for
 * `tasks.defaults` and `ChainLinkConfig.model` — would otherwise register
 * "openai:gpt-4.1" and have nothing ever look it up, silently falling back to
 * the estimate. Normalising on the way in means both forms work.
 *
 * Ids without a RECOGNISED provider prefix pass through untouched, so vendor
 * ids that merely contain a colon keep their shape: OpenRouter's ":free" and
 * ":beta" variants split on a prefix that is not a provider id, and
 * slash-scoped ids ("meta-llama/Llama-3.3-70B") contain no colon at all.
 */
function pricingKey(id: string): string {
  return parseModelId(id).model;
}

const DEFAULT_FALLBACK_PRICING: ModelPricing = { in: 0.3, out: 1.5 };

// The library's last-resort default. Deliberately named rather than inlined,
// so it is greppable as "the thing an adopter should override" instead of
// looking like a recommendation. See resolveDefault.
const FALLBACK_PROVIDER: ProviderId = "anthropic";
const FALLBACK_MODEL = "claude-sonnet-4-6";

// Providers `resolveModelHint` can check a hint against — the ones the
// library has any static knowledge of (see `knownModels`). Aggregators and
// proxies are intentionally excluded: they route arbitrary upstream model
// strings by design, so there is nothing to validate a hint against.
const VALIDATABLE_HINT_PROVIDERS = new Set<ProviderId>(["anthropic", "google", "openai"]);

/**
 * Does this string have the shape of a model id at all?
 *
 * Every chat model these providers ship carries a version in its id: a digit
 * ("gpt-4.1", "o4-mini", "claude-opus-4-8"), a separator
 * ("meta-llama/llama-3.3-70b"), or both. A cost-tier label — "standard",
 * "economy", "premium", and the library's own "fast"/"power"/"judge" — is a
 * bare word with neither.
 *
 * This is deliberately a NARROW reject rule and not a known-model allowlist.
 * Rejecting a hint is not free: the call then runs a DIFFERENT model than the
 * prompt asked for, and unlike a 404 nothing downstream can tell that it
 * happened. An allowlist built from `knownModels` — a best-effort list of
 * `BUILTIN_TIERS` plus prefix-matched pricing keys — would reject every id
 * the library has not shipped a pricing entry for: "o4-mini" (registered
 * pricing, no "gpt" prefix), an adopter's configured tier model, and every
 * model released after the installed version. So a hint is rejected only
 * when it cannot plausibly be a model id, and anything else passes through
 * to fail loudly upstream if it is wrong.
 */
function looksLikeModelId(id: string): boolean {
  return /[0-9]/.test(id) || /[-_./]/.test(id);
}

// The id prefix each validatable provider's models carry. Used both to
// attribute pricing keys to a provider (`knownModels`) and, in
// `resolveModelHint`, as positive evidence that an id belongs to a provider
// OTHER than the one it is about to be sent to.
const PROVIDER_MODEL_PREFIXES: Partial<Record<ProviderId, string>> = {
  anthropic: "claude",
  google: "gemini",
  openai: "gpt",
};

/**
 * The provider whose ids start this way, if any.
 *
 * Unlike a known-model lookup this keeps working for models the installed
 * version has never heard of: "claude-opus-9" is recognisably Anthropic's
 * whether or not it is in the pricing table, which is what lets a
 * cross-provider mismatch be rejected without also rejecting every new
 * release (see `resolveModelHint`).
 */
function providerByModelPrefix(model: string): ProviderId | undefined {
  for (const [provider, prefix] of Object.entries(PROVIDER_MODEL_PREFIXES)) {
    if (model.startsWith(prefix)) return provider as ProviderId;
  }
  return undefined;
}

/** A `modelHint` accepted as a literal model id. `provider` is set only when
 *  the hint named one itself via a scheme prefix ("openai:gpt-4.1"); the
 *  caller supplies the provider otherwise. */
export interface ResolvedModelHint {
  provider?: ProviderId;
  model: string;
}

export class ProviderRegistry {
  private readonly cfg: ProviderConfig;
  private readonly pricing: Record<string, ModelPricing>;
  private warnedMissingDefault = false;
  /** Models already warned about, so the warning is loud once, not per call. */
  private readonly warnedMissingPricing = new Set<string>();

  constructor(cfg: ProviderConfig = {}) {
    this.cfg = cfg;
    this.pricing = { ...BUILTIN_PRICING };
    // Normalised on the way in: a configured "openai:gpt-4.1" key is the same
    // footgun as a prefixed addPricing() call, and just as invisible.
    for (const [id, rate] of Object.entries(cfg.pricing ?? {})) {
      this.pricing[pricingKey(id)] = rate;
    }
  }

  apiKey(provider: ProviderId): string | undefined {
    return this.cfg.apiKeys?.[provider] ?? process.env[ENV_KEYS[provider]] ?? undefined;
  }

  /**
   * Key for a provider that is not one of the built-in chat providers —
   * today, the embedding-only ones. Config wins over env, same as apiKey().
   */
  namedApiKey(name: string, envVar: string): string | undefined {
    return this.cfg.apiKeys?.[name] ?? process.env[envVar] ?? undefined;
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

  /** Is this name a configured provider factory? */
  isFactory(name: string): boolean {
    return !!this.cfg.factories?.[name];
  }

  /** Namespace-aware model-id parse: built-in prefixes win, then endpoint
   *  names, then factory names, then bare = Anthropic. */
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
      if (this.isFactory(prefix)) {
        return { provider: prefix, model: id.slice(idx + 1), endpoint: false };
      }
    }
    const p = parseModelId(id);
    return { provider: p.provider, model: p.model, endpoint: false };
  }

  buildFactoryModel(name: string, model: string): LanguageModel | null {
    const f = this.cfg.factories?.[name];
    if (!f) return null;
    return f.model(model);
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

  /** Build for a built-in provider, custom endpoint, or provider factory. */
  buildAny(provider: string, model: string): LanguageModel | null {
    if (this.isEndpoint(provider)) return this.buildEndpointModel(provider, model);
    if (this.isFactory(provider)) return this.buildFactoryModel(provider, model);
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
    const prefix = PROVIDER_MODEL_PREFIXES[provider];
    const fromTiers = Object.values(BUILTIN_TIERS[provider] ?? {});
    const fromPricing = prefix
      ? Object.keys(this.pricing).filter((m) => m.startsWith(prefix))
      : [];
    return Array.from(new Set([...fromTiers, ...fromPricing]));
  }

  /**
   * The provider a bare model id would be sent to — `resolveDefault`'s own
   * precedence, so a hint is validated against the provider that will
   * actually receive it.
   */
  private effectiveDefaultProvider(): ProviderId {
    return (
      this.cfg.defaultProvider ??
      (process.env.AI_DEFAULT_PROVIDER as ProviderId | undefined) ??
      FALLBACK_PROVIDER
    );
  }

  /**
   * Split a recognised "provider:model" prefix off a hint.
   *
   * Returns `undefined` for a bare id or a colon that is not a namespace at
   * all (OpenRouter's ":free"/":beta" variants), and "unsupported" for a
   * prefix naming a custom endpoint or provider factory: those are real
   * namespaces, but the override `resolveDefault` takes can only express a
   * built-in ProviderId, so such a hint cannot be honoured here.
   */
  private hintScheme(
    id: string,
  ): { provider: ProviderId; model: string } | "unsupported" | undefined {
    const idx = id.indexOf(":");
    if (idx <= 0) return undefined;
    const prefix = id.slice(0, idx);
    if ((PROVIDER_IDS as string[]).includes(prefix)) {
      return { provider: prefix as ProviderId, model: id.slice(idx + 1) };
    }
    if (this.isEndpoint(prefix) || this.isFactory(prefix)) return "unsupported";
    return undefined;
  }

  /**
   * A hint was present, examined, and found unusable.
   *
   * Throws when the adopter opted in via
   * `ProviderConfig.throwOnInvalidModelHint`; otherwise returns `undefined`
   * so the caller falls through to its own default. Same warn-by-default,
   * throw-on-request shape `resolveDefault` uses for `requireExplicitDefault`.
   *
   * Only reached for a hint that was actually rejected — an ABSENT hint is
   * not an invalid one and never throws, whatever the flag says.
   */
  private rejectHint(hint: string, provider: ProviderId): undefined {
    if (this.cfg.throwOnInvalidModelHint) {
      throw new InvalidModelHintError(hint, provider);
    }
    return undefined;
  }

  /**
   * Validate a prompt's `modelHint` before it is trusted as a literal model
   * id. `modelHint` is documented (see gateway.ts's `promptFingerprint`) as a
   * per-prompt model override — a real, callable id like "gpt-4.1" — but the
   * column it comes from is admin-editable free text, and nothing here ever
   * checked that an edit actually put a model id in it rather than a cost-tier
   * label like "standard"/"economy"/"premium". A tier label reached the
   * provider API unchanged and 404'd (AI_APICallError: model: standard,
   * reported against a downstream adopter's staging deployment, 2026-09).
   *
   * What is checked, and against what:
   *
   * - A hint carrying a scheme prefix ("openai:gpt-4.1" — the form the README
   *   documents for every other model-id field) names its own provider, and
   *   the returned `provider` says so. A prompt-level hint may change the
   *   model within the provider a call is already pinned to; it may not move
   *   the call to a different provider, so a prefix that disagrees with the
   *   `provider` argument is rejected rather than silently obeyed.
   * - Everything else is validated against the provider the model will
   *   actually be paired with: the `provider` argument when the caller has
   *   one, otherwise the configured default. Checking "does ANY provider know
   *   this id" would accept "gpt-4.1-mini" under a `defaultProvider` of
   *   anthropic and reproduce the very 404 this exists to prevent.
   * - Aggregator/proxy providers (openrouter/venice/together/huggingface)
   *   accept arbitrary upstream model strings by design — the same trust
   *   boundary `resolveModelId` already gives them — so a hint headed to one
   *   passes through unchecked, whether it got there by argument or by being
   *   the configured default.
   * - The check itself is `looksLikeModelId`, not membership of
   *   `knownModels`. See that function for why an allowlist is the wrong
   *   shape here.
   *
   * Returns the hint, parsed, when it is plausibly a literal model id;
   * otherwise `undefined` so the caller falls through to its own default
   * instead of forwarding a tier label to the provider.
   */
  resolveModelHint(
    hint: string | undefined,
    provider?: ProviderId,
  ): ResolvedModelHint | undefined {
    const raw = hint?.trim();
    // No hint at all is not an invalid hint: nothing to reject, nothing to
    // throw, the caller just uses its own default.
    if (!raw) return undefined;

    const fallbackTarget = provider ?? this.effectiveDefaultProvider();
    const scheme = this.hintScheme(raw);
    if (scheme === "unsupported") return this.rejectHint(raw, fallbackTarget);

    const explicit = scheme?.provider;
    const model = scheme ? scheme.model : raw;
    if (!model) return this.rejectHint(raw, fallbackTarget);
    if (explicit && provider && explicit !== provider) return this.rejectHint(raw, provider);

    const target = explicit ?? fallbackTarget;
    if (!VALIDATABLE_HINT_PROVIDERS.has(target)) {
      return explicit ? { provider: explicit, model } : { model };
    }

    // Known good for the provider it is actually going to.
    if (
      this.knownModels(target).includes(model) ||
      Object.values(this.cfg.tiers?.[target] ?? {}).includes(model)
    ) {
      return explicit ? { provider: explicit, model } : { model };
    }

    // Positive evidence it belongs to a DIFFERENT provider: "gpt-4.1-mini"
    // under a `defaultProvider` of anthropic is not a model this call can
    // run, and sending it produces exactly the 404 this check exists to
    // prevent. Prefix ownership rather than a known-model lookup, so an id
    // the installed version has never seen is still attributed correctly.
    const owner = providerByModelPrefix(model);
    if (owner && owner !== target) return this.rejectHint(raw, target);

    // Otherwise: reject only what cannot be a model id at all.
    if (!looksLikeModelId(model)) return this.rejectHint(raw, target);
    return explicit ? { provider: explicit, model } : { model };
  }

  /**
   * Resolve a named tier for a provider.
   *
   * `judge` has no built-in per-provider model — deliberately, since baking
   * one in would be the same out-of-box provider bias finding 3.6 objects to.
   * An unset judge tier falls back to that provider's `fast` model, which is
   * exactly what the judge used before the tier existed.
   */
  tierModel(provider: ProviderId, tier: "fast" | "power" | "judge"): string | undefined {
    const configured = this.cfg.tiers?.[provider]?.[tier];
    if (configured) return configured;
    if (tier === "judge") {
      return this.cfg.tiers?.[provider]?.fast ?? BUILTIN_TIERS[provider]?.fast;
    }
    return BUILTIN_TIERS[provider]?.[tier];
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

  /**
   * Resolve the fallback provider/model when nothing else routed the call.
   *
   * The built-in `anthropic`/`claude-sonnet-4-6` is a LAST RESORT, not a
   * recommendation. Inheriting it silently is how an adopter ends up with an
   * out-of-box bias toward one provider without ever deciding to — the bug
   * class the hardcoded-model objective exists to close. So reaching it warns
   * loudly (once), naming the assumption and how to configure it, and
   * `ProviderConfig.requireExplicitDefault` upgrades that warning to a throw
   * for deployments that want the bias to be impossible rather than merely
   * discouraged.
   *
   * Config and env overrides are unchanged and silence the warning entirely.
   */
  resolveDefault(override?: { provider?: ProviderId; model?: string }): ResolvedModel {
    const configuredProvider =
      override?.provider ??
      this.cfg.defaultProvider ??
      (process.env.AI_DEFAULT_PROVIDER as ProviderId | undefined);
    const configuredModel =
      override?.model ?? this.cfg.defaultModel ?? process.env.AI_DEFAULT_MODEL;

    if (configuredProvider === undefined || configuredModel === undefined) {
      const missing = [
        configuredProvider === undefined ? "provider" : null,
        configuredModel === undefined ? "model" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      const detail =
        `No default ${missing} configured, falling back to ` +
        `"${FALLBACK_PROVIDER}/${FALLBACK_MODEL}". Set ProviderConfig.defaultProvider/` +
        `defaultModel (or AI_DEFAULT_PROVIDER/AI_DEFAULT_MODEL) so this deployment ` +
        `picks its own model rather than inheriting the library's.`;
      if (this.cfg.requireExplicitDefault) {
        throw new Error(`[llm-gateway] ${detail}`);
      }
      // Once per registry: a per-call warning would be noise on a hot path.
      if (!this.warnedMissingDefault) {
        this.warnedMissingDefault = true;
        console.warn(`[llm-gateway] ${detail}`);
      }
    }

    const provider = configuredProvider ?? FALLBACK_PROVIDER;
    const model = configuredModel ?? FALLBACK_MODEL;
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
      const name = link.factory ?? link.endpoint ?? link.provider;
      if (!name) continue; // one of provider/endpoint/factory is required
      if (link.languageModel) {
        // BYO model: tier re-routing doesn't apply (we can't rebuild it).
        out.push({ provider: name, model: link.model, languageModel: link.languageModel, temperature: link.temperature });
        continue;
      }
      if (link.factory) {
        const lm = this.buildFactoryModel(link.factory, link.model);
        if (lm) out.push({ provider: link.factory, model: link.model, languageModel: lm, temperature: link.temperature });
        continue;
      }
      if (link.endpoint) {
        const lm = this.buildEndpointModel(link.endpoint, link.model);
        if (lm) out.push({ provider: link.endpoint, model: link.model, languageModel: lm, temperature: link.temperature });
        continue;
      }
      const model = (tier ? this.tierModel(link.provider!, tier) : undefined) ?? link.model;
      const lm = this.buildLanguageModel(link.provider!, model, link.apiKey);
      if (lm) out.push({ provider: link.provider!, model, languageModel: lm, temperature: link.temperature });
      else if (keepKeyless?.includes(link.provider!)) out.push({ provider: link.provider!, model, temperature: link.temperature });
    }
    return out;
  }

  /**
   * Register/override pricing at runtime (e.g. synced from a vendor's models
   * API).
   *
   * Accepts either form: "gpt-4.1" or "openai:gpt-4.1" both register under the
   * bare id that lookups use. Passing the prefixed form used to register a key
   * nothing read, which cost adopters their cost data silently.
   */
  addPricing(model: string, pricing: ModelPricing): void {
    this.pricing[pricingKey(model)] = pricing;
  }

  /** True when `model` has real pricing. Accepts bare or prefixed ids. */
  hasPricing(model: string): boolean {
    return pricingKey(model) in this.pricing;
  }

  /**
   * The subset of `modelIds` with no real pricing, in the order given.
   * Accepts bare or prefixed ids. Empty means every id would be priced.
   */
  missingPricing(modelIds: readonly string[]): string[] {
    return modelIds.filter((id) => !this.hasPricing(id));
  }

  /**
   * Throw unless every id has real pricing. **Call this at startup or in a
   * test**, never per request.
   *
   * This is the strict mode, and it lives here rather than inside
   * `estimateCostCents` deliberately. Estimation runs inline in the
   * `estimatedCostCents` field of a usage-row payload, so throwing there would
   * mean a pricing gap costs you the LEDGER ROW — trading a wrong cost for no
   * record at all, on a call that already spent money. A pre-flight fails where
   * a misconfiguration should fail: at boot, before anything is billed.
   */
  assertPricingComplete(modelIds: readonly string[]): void {
    const missing = this.missingPricing(modelIds);
    if (missing.length === 0) return;
    throw new Error(
      `[llm-gateway] no pricing configured for: ${missing.join(", ")}. ` +
        `Add them to ProviderConfig.pricing or call registry.addPricing(). ` +
        `Ids may be bare ("gpt-4.1") or prefixed ("openai:gpt-4.1").`,
    );
  }

  estimateCostCents(
    model: string,
    inputTokens: number,
    outputTokens: number,
    extras?: { cacheCreateTokens?: number; cacheReadTokens?: number; webSearches?: number },
  ): number {
    if (model === "mock" || model === "cache") return 0;
    let rate = this.pricing[pricingKey(model)];
    if (!rate) {
      rate = this.cfg.fallbackPricing ?? DEFAULT_FALLBACK_PRICING;
      // Don't silently log $0 — a missing pricing entry must be visible. Once
      // per model, not once per call: the old per-call warning was emitted on a
      // hot path, which in production means it is either drowned out or turned
      // off, and either way nobody sees it. The message names the mistake that
      // actually causes this (a prefixed key) because that is the one an
      // adopter shipped to production without noticing.
      if (!this.warnedMissingPricing.has(model)) {
        this.warnedMissingPricing.add(model);
        console.warn(
          `[llm-gateway] no pricing for "${model}" — every cost for it is the ` +
            `fallback estimate (${rate.in}/${rate.out} cents per 1K in/out), not real. ` +
            `Add it to ProviderConfig.pricing or call registry.addPricing(). ` +
            `Pricing is keyed on the BARE model id: "openai:gpt-4.1" registers as "gpt-4.1". ` +
            `Use registry.assertPricingComplete([...]) at startup to catch this before it bills.`,
        );
      }
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
