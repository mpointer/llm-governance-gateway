// Adapter interfaces — the seam that replaces the original app's direct
// Drizzle/Turso and Upstash dependencies. Bring your own storage; memory
// implementations (./adapters/memory.js) work out of the box for dev/test.

export interface UsageEntry {
  userId?: string | null;
  /** Tenant this row belongs to. null/undefined = unscoped (single-tenant). */
  orgId?: string | null;
  app?: string | null;
  route?: string | null;
  promptSlug?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCents: number;
  cacheHit: boolean;
  traceId: string;
  durationMs?: number | null;
  /** Prompt-cache token counts (native Anthropic path). */
  cacheCreateTokens?: number | null;
  cacheReadTokens?: number | null;
  /** Server-side web searches performed (billed per request). */
  webSearches?: number | null;
  /** true when a requireZdr constraint was enforced on this call (audit). */
  zdrEnforced?: boolean | null;
  /** Already passed through the configured encrypt hook (if any). */
  inputText?: string | null;
  outputText?: string | null;
  createdAt: Date;
}

export interface SpendCapEvent {
  userId?: string | null;
  /** Tenant whose cap was hit. null/undefined = unscoped (single-tenant). */
  orgId?: string | null;
  capCents: number;
  spentCents: number;
  route?: string | null;
  wouldBlock: boolean;
  createdAt: Date;
}

export interface JudgeScore {
  usageLogId: string | number;
  rubric: Record<string, number>;
  overallScore: number;
  createdAt: Date;
}

/** Persistence for usage accounting, spend-cap events, and judge scores. */
export interface UsageStore {
  logUsage(entry: UsageEntry): Promise<string | number>;
  /**
   * Sum of estimatedCostCents since `since`, excluding cache hits.
   * userId === undefined → ALL identities (global circuit breaker).
   * userId === null      → anonymous-only spend.
   *
   * `orgId` scopes the sum to one tenant. undefined = unscoped, which is
   * exactly the pre-multi-tenant behavior; a store that ignores the argument
   * keeps working as a single-tenant store. When set, the "global" circuit
   * breaker becomes per-org — one tenant's spend must never trip another's.
   */
  sumSpendCents(
    since: Date,
    userId?: string | null,
    orgId?: string | null,
  ): Promise<number>;
  recordSpendCapEvent(event: SpendCapEvent): Promise<void>;
  saveJudgeScore(score: JudgeScore): Promise<void>;
  /** Per-user daily cap override in cents, or undefined to use config default. */
  getUserDailyCapCents?(userId: string, orgId?: string | null): Promise<number | undefined>;
  /**
   * Per-org daily cap override in cents. Optional; when absent the gateway
   * falls back to SpendCapConfig.orgDailyCents.
   */
  getOrgDailyCapCents?(orgId: string): Promise<number | undefined>;
}

export interface PromptDefault {
  slug: string;
  body: string;
  description?: string;
  category?: string;
  /** Required {{placeholder}} names; used to validate edited bodies. */
  variables: string[];
  modelHint?: string;
}

export interface StoredPrompt {
  slug: string;
  body: string;
  modelHint?: string | null;
  providerOverride?: string | null;
  temperature?: number | null;
}

/**
 * Prompt override layer (DB-as-override, code-as-fallback). Optional — when
 * absent, prompt bodies come solely from config.promptDefaults.
 */
export interface PromptStore {
  /** `orgId` scopes the lookup to one tenant; undefined = the global prompt. */
  getPrompt(slug: string, orgId?: string | null): Promise<StoredPrompt | undefined>;
  /** Seed a code default so it becomes visible/editable in an admin UI. */
  seedPrompt?(def: PromptDefault, orgId?: string | null): Promise<void>;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  limit: number;
}

export interface RateLimiter {
  limit(identifier: string): Promise<RateLimitResult>;
}

export type ProviderId =
  | "anthropic"
  | "google"
  | "openai"
  | "openrouter"
  | "venice"
  | "together"
  | "huggingface";

export interface ChainLinkConfig {
  provider?: ProviderId;
  /** Custom endpoint name (ProviderConfig.endpoints or ollama/vllm/lmstudio
   *  preset). Mutually exclusive with `provider` and `factory`. */
  endpoint?: string;
  /** Provider factory name (ProviderConfig.factories). Mutually exclusive
   *  with `provider` and `endpoint`. */
  factory?: string;
  model: string;
  /** Falls back to the provider's configured/env API key when omitted. */
  apiKey?: string;
  /**
   * Per-link temperature. `null` = NEVER send temperature on this link (for
   * models that 400 on non-default values, e.g. claude-sonnet-5); a number
   * pins it. Resolution: link (incl. null) > call-level > prompt-config.
   * Note: an unsupported-temperature 4xx is deliberately non-retryable, so
   * without this override a bad temperature on the primary link fails the
   * call rather than falling through the chain.
   */
  temperature?: number | null;
  /**
   * Bring-your-own AI SDK model (Azure, Bedrock, custom base URLs, test
   * fakes). When set, provider/model are used for attribution/pricing only.
   */
  languageModel?: import("ai").LanguageModel;
}

/**
 * Optional dynamic model configuration (e.g. an admin table). When absent,
 * the static config/env fallback path is used.
 */
export interface ModelConfigStore {
  /**
   * Hard-pin override; bypasses the chain entirely. Null = use the chain.
   * `orgId` scopes the pin to one tenant; undefined = the global pin.
   */
  getOverride(orgId?: string | null): Promise<{ provider: ProviderId; model: string } | null>;
  /**
   * Failover chain in priority order (primary → fallback → ...).
   * `orgId` scopes the chain to one tenant; undefined = the global chain.
   */
  getChain(orgId?: string | null): Promise<ChainLinkConfig[]>;
  /**
   * Admin-pinned model id for the model-graded judge, e.g.
   * "openai:gpt-4.1-mini". Optional: a store that does not implement it is
   * unchanged, and the judge falls back to config then to the default
   * provider's fast tier.
   *
   * This is what lets an operator pin the judge to a cheap, ZDR-compliant
   * model on a DIFFERENT provider than the default — the coupling finding
   * 3.4 objected to.
   */
  getJudgeModel?(orgId?: string | null): Promise<string | null | undefined>;
}

export interface ModelPricing {
  /** Cents per 1K input tokens. */
  in: number;
  /** Cents per 1K output tokens. */
  out: number;
  /** Cents per 1K cache-write tokens. Default: 1.25 × in (Anthropic ratio). */
  cacheWrite?: number;
  /** Cents per 1K cache-read tokens. Default: 0.1 × in (Anthropic ratio). */
  cacheRead?: number;
}

export interface ProviderConfig {
  /**
   * Keys for the built-in chat providers, and for embedding-only providers
   * such as `voyage`. Widened from the ProviderId-only map so an
   * embeddings provider does not have to masquerade as a chat provider to
   * carry a key; the narrower shape is still assignable.
   */
  apiKeys?: Partial<Record<ProviderId, string>> & Record<string, string | undefined>;
  defaultProvider?: ProviderId;
  defaultModel?: string;
  /** fast = cheapest tier, power = most capable; merged over built-ins. */
  tiers?: Partial<Record<ProviderId, ProviderTiers>>;
  /**
   * Throw instead of warning when a call falls through to the library's
   * last-resort default provider/model. Off by default so existing callers
   * are unaffected; on for deployments that want an inherited provider bias
   * to be impossible rather than merely discouraged.
   */
  requireExplicitDefault?: boolean;
  /** Merged over built-in pricing; add entries for models you use. */
  pricing?: Record<string, ModelPricing>;
  /**
   * Custom OpenAI-compatible endpoints (local/self-hosted serving: Ollama,
   * vLLM, LM Studio, or anything speaking the protocol). Model ids use the
   * endpoint name as prefix: "ollama:llama3.3", "vllm:qwen2.5-72b".
   * Presets exist for ollama/vllm/lmstudio with localhost defaults.
   * Endpoint tokens are logged but cost $0 and never count against spend
   * caps — caps are about real money. Endpoints default to ZDR (self-hosted);
   * override via `retention` if yours is shared infrastructure.
   */
  endpoints?: Record<string, { baseURL: string; apiKey?: string; apiKeyEnv?: string }>;
  /**
   * Provider factories for clouds that need structured auth/config (Bedrock,
   * Azure, Vertex, watsonx — see docs/design/enterprise-providers.md). BYO
   * cloud SDK: the factory returns a ready AI SDK LanguageModel. Model ids
   * use the factory name as prefix: "bedrock:anthropic.claude-...".
   * Unlike local endpoints, factory models cost REAL money: pricing comes
   * from `pricing` entries (fallback warns, never silent $0) and factories
   * are NOT ZDR unless asserted in `retention`.
   */
  factories?: Record<
    string,
    {
      model: (modelId: string) => import("ai").LanguageModel;
      /** Optional discovery hook for doctor/admin UIs. */
      listModels?: () => Promise<string[]>;
    }
  >;
  /** Fallback pricing for unknown models (default: conservative mid-tier). */
  fallbackPricing?: ModelPricing;
  /** Cents per server-side web search request. Default 1 (≈$10/1k). */
  webSearchCentsPerCall?: number;
  /**
   * CALLER-ASSERTED zero-data-retention status, keyed by provider id or
   * "provider:model". ZDR is a contractual property of YOUR account (e.g. an
   * Anthropic ZDR addendum) — the library cannot detect it and will not
   * pretend to. Missing entry = NOT ZDR (fail closed).
   */
  retention?: Record<string, { zdr: boolean; note?: string }>;
}

/**
 * Named model tiers per provider. `judge` is a first-class tier alongside
 * fast/power: the model-graded judge runs in the request path on every
 * sampled call, so which model it uses is a governance decision an operator
 * makes deliberately — not something it should inherit from whichever
 * provider happens to be the default.
 *
 * There is no BUILT-IN judge model for any provider. An unset judge tier
 * falls back to that provider's `fast` tier, which is the pre-tier behavior.
 */
export interface ProviderTiers {
  fast?: string;
  power?: string;
  judge?: string;
}

export interface SpendCapConfig {
  /** Per-user daily cap in cents. 0 disables. Default 200. */
  userDailyCents?: number;
  /** Anonymous-identity daily cap in cents. 0 disables. Default 100. */
  anonDailyCents?: number;
  /**
   * App-wide daily circuit breaker in cents. 0 disables. Default 5000.
   *
   * When a call carries an orgId, this breaker is evaluated against THAT
   * ORG's spend only — one tenant must never trip another tenant's breaker.
   * Unscoped calls keep summing everything, exactly as before.
   */
  globalDailyCents?: number;
  /**
   * Per-org daily cap in cents. 0 disables. Unset = no separate org cap
   * (the org-scoped circuit breaker above still applies). Only consulted for
   * calls that carry an orgId.
   */
  orgDailyCents?: number;
}

/**
 * Optional dynamic per-task model overrides (e.g. an admin "AI & Cost" table).
 */
export interface TaskOverrideStore {
  /**
   * task name → model id ("claude-sonnet-4-6", "openai:gpt-4.1", ...), or an
   * ordered chain. A store returning the single-id form is unchanged and
   * still assignable.
   * `orgId` scopes the overrides to one tenant; undefined = global.
   */
  getOverrides(orgId?: string | null): Promise<Record<string, TaskModelSpec>>;
}

/**
 * Task-based routing: name the call sites ("enrich", "summarize", "judge"),
 * assign each a default model in code, and optionally let an admin store
 * override models per task at runtime.
 */
/**
 * A task's model: a single id, or an ordered failover chain the gateway walks
 * on retryable errors and attempt timeouts.
 *
 * The array form IS the role chain FMA and CareerPointers already model as
 * primary/fallback/backup2 — the roles are positions, so the gateway needs no
 * separate role vocabulary to express them:
 *   ["claude-sonnet-4-6", "openai:gpt-4.1", "google:gemini-2.5-pro"]
 *      primary             fallback          backup2
 */
export type TaskModelSpec = string | string[];

export interface TaskRoutingConfig {
  /** task name → default model id, or an ordered chain. Bare ids are Anthropic; prefix others ("openai:", "google:", "openrouter:", "venice:"). */
  defaults: Record<string, TaskModelSpec>;
  /** Human labels for admin UIs. */
  labels?: Record<string, string>;
  /** Per-task governance constraints (e.g. { intake: { requireZdr: true } }). */
  constraints?: Record<string, { requireZdr?: boolean }>;
  store?: TaskOverrideStore;
  /** Override cache TTL ms (default 30s). */
  overrideTtlMs?: number;
}

/**
 * Model-graded judge configuration (per-call, with gateway-level defaults).
 * Distinct from the legacy `judgeRubric` callback, which is caller-computed
 * and free; this one spends real tokens and is therefore sampled and
 * budget-aware.
 */
export interface JudgeConfig {
  /** Criterion name → plain-language description given to the judge model. */
  criteria: Record<string, string>;
  /** Fraction of eligible calls judged (0..1). Default from gateway, else 1. */
  sampleRate?: number;
  /** Prefixed model id for the judge. Default: gateway judge model, else the
   *  default provider's fast tier. Use a cheap model — this runs in-path. */
  model?: string;
  /** "observe" (default): record scores. "gate": throw JudgeGateError when
   *  overallScore falls below threshold (scores are still persisted first). */
  mode?: "observe" | "gate";
  /** Minimum acceptable overall score (0-5 scale) for gate mode. Default 3. */
  threshold?: number;
}

export interface JudgeDefaults {
  model?: string;
  sampleRate?: number;
  /** Injectable RNG for deterministic sampling in tests. Default Math.random. */
  random?: () => number;
}

/**
 * Observability export hooks: integrate with OTel/Langfuse/metrics, don't
 * compete with them. Hooks fire AFTER the durable UsageStore write,
 * fire-and-forget: a throwing or rejecting hook is swallowed (warned once
 * per hook) and never breaks or slows the governed call. Note `inputText`/
 * `outputText` on the entry are already encrypted when an encrypt hook is
 * configured — the at-rest guarantee extends to whatever your exporter does.
 */
export interface ObservabilityHooks {
  /** Every usage row: generations, embeddings, cache hits, judge calls. */
  onUsage?: (entry: UsageEntry & { id: string | number }) => void | Promise<void>;
  /** A spend cap blocked a call. */
  onSpendCapEvent?: (event: SpendCapEvent) => void | Promise<void>;
  /** A judge (caller rubric or model-graded) scored a response. */
  onJudgeScore?: (score: JudgeScore) => void | Promise<void>;
  /**
   * A streaming link was abandoned and the gateway failed over to the next.
   * Fire-and-forget, like the others — an export hook must never break the
   * stream it is reporting on.
   */
  onStreamFailover?: (event: {
    traceId: string;
    provider: string;
    model: string;
    reason: "stall" | "retryable";
    hadPartialOutput: boolean;
  }) => void | Promise<void>;
}

/**
 * Bounds on outbound provider calls. See
 * docs/design/timeouts-and-deadlines.md.
 *
 * Streaming uses chunk-relative clocks rather than a total-duration cap: a
 * long stream that is actively producing tokens is healthy, silence is not.
 */
export interface TimeoutConfig {
  /**
   * Bound on ONE provider attempt. Default 60_000 — the value the AI SDK
   * paths have always used. Each retry gets a fresh window.
   */
  attemptMs?: number;
  /**
   * Bound on the WHOLE governed operation: every chain link, retry, and
   * backoff sleep within one runStructured/runText call.
   *
   * Default undefined = unbounded, which is the pre-S4 behavior. Worth
   * setting on a platform with its own function deadline (a 3-link chain can
   * otherwise run for minutes), since the usage row is written after
   * generation returns and a platform kill loses it.
   */
  deadlineMs?: number;
  /** Time allowed to a stream's FIRST emission. Default 60_000. 0 disables. */
  streamFirstChunkMs?: number;
  /** Time allowed since a stream's LAST emission. Default 60_000. 0 disables. */
  streamStallMs?: number;
}

export interface GatewayConfig {
  usage: UsageStore;
  cache?: CacheStore;
  rateLimiter?: RateLimiter;
  prompts?: PromptStore;
  promptDefaults?: PromptDefault[];
  modelConfig?: ModelConfigStore;
  tasks?: TaskRoutingConfig;
  providers?: ProviderConfig;
  caps?: SpendCapConfig;
  /** Gateway-level defaults for the model-graded judge. */
  judge?: JudgeDefaults;
  /**
   * Native Anthropic path (opt-in). Pass a @anthropic-ai/sdk client (or
   * structural equivalent). Calls that set `anthropic:` options route
   * Anthropic links through this client for thinking / prompt caching /
   * web search; every other provider stays on the AI SDK path.
   */
  anthropic?: import("./anthropic-native.js").NativeAnthropicConfig;
  /** Governed batch processing (Anthropic Message Batches). See
   *  docs/design/batch-processing.md. */
  batch?: import("./batch.js").BatchConfig;
  /** Deterministic mock mode: no provider calls; responders supply outputs. */
  mock?: boolean;
  /** Tag written to every usage row (multi-app deployments). */
  appId?: string;
  /**
   * Default tenant for every call this instance makes. Per-call `orgId` wins.
   *
   * Leave unset for a single-tenant deployment — behavior is then identical to
   * before org scoping existed. Set it when one gateway instance serves one
   * tenant; pass per-call `orgId` when one instance serves many.
   */
  orgId?: string;
  /** Cache TTL in seconds. Default 24h. */
  cacheTtlSeconds?: number;
  /**
   * Bounds on outbound provider calls. See
   * docs/design/timeouts-and-deadlines.md. Per-call options override these:
   * per call > this config > built-in default.
   */
  timeouts?: TimeoutConfig;
  /**
   * Optional at-rest encryption for logged prompt/output snapshots and cached
   * values. Both must be provided together.
   */
  encrypt?: (plaintext: string) => string;
  decrypt?: (ciphertext: string) => string;
  /** Returns true when a stored string is ciphertext from `encrypt`. */
  isEncrypted?: (value: string) => boolean;
  /** Export hooks for OTel/Langfuse/metrics. See ObservabilityHooks. */
  observability?: ObservabilityHooks;
}
