// Adapter interfaces — the seam that replaces the original app's direct
// Drizzle/Turso and Upstash dependencies. Bring your own storage; memory
// implementations (./adapters/memory.js) work out of the box for dev/test.

export interface UsageEntry {
  userId?: string | null;
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
   */
  sumSpendCents(since: Date, userId?: string | null): Promise<number>;
  recordSpendCapEvent(event: SpendCapEvent): Promise<void>;
  saveJudgeScore(score: JudgeScore): Promise<void>;
  /** Per-user daily cap override in cents, or undefined to use config default. */
  getUserDailyCapCents?(userId: string): Promise<number | undefined>;
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
  getPrompt(slug: string): Promise<StoredPrompt | undefined>;
  /** Seed a code default so it becomes visible/editable in an admin UI. */
  seedPrompt?(def: PromptDefault): Promise<void>;
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
  /** Hard-pin override; bypasses the chain entirely. Null = use the chain. */
  getOverride(): Promise<{ provider: ProviderId; model: string } | null>;
  /** Failover chain in priority order (primary → fallback → ...). */
  getChain(): Promise<ChainLinkConfig[]>;
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
  apiKeys?: Partial<Record<ProviderId, string>>;
  defaultProvider?: ProviderId;
  defaultModel?: string;
  /** fast = cheapest tier, power = most capable; merged over built-ins. */
  tiers?: Partial<Record<ProviderId, { fast?: string; power?: string }>>;
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

export interface SpendCapConfig {
  /** Per-user daily cap in cents. 0 disables. Default 200. */
  userDailyCents?: number;
  /** Anonymous-identity daily cap in cents. 0 disables. Default 100. */
  anonDailyCents?: number;
  /** App-wide daily circuit breaker in cents. 0 disables. Default 5000. */
  globalDailyCents?: number;
}

/**
 * Optional dynamic per-task model overrides (e.g. an admin "AI & Cost" table).
 */
export interface TaskOverrideStore {
  /** task name → model id ("claude-sonnet-4-6", "openai:gpt-4.1", ...). */
  getOverrides(): Promise<Record<string, string>>;
}

/**
 * Task-based routing: name the call sites ("enrich", "summarize", "judge"),
 * assign each a default model in code, and optionally let an admin store
 * override models per task at runtime.
 */
export interface TaskRoutingConfig {
  /** task name → default model id. Bare ids are Anthropic; prefix others ("openai:", "google:", "openrouter:", "venice:"). */
  defaults: Record<string, string>;
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
}

/**
 * Bounds on outbound provider calls. See
 * docs/design/timeouts-and-deadlines.md.
 *
 * Streaming uses chunk-relative clocks rather than a total-duration cap: a
 * long stream that is actively producing tokens is healthy, silence is not.
 */
export interface TimeoutConfig {
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
  /** Cache TTL in seconds. Default 24h. */
  cacheTtlSeconds?: number;
  /**
   * Bounds on outbound provider calls. See
   * docs/design/timeouts-and-deadlines.md. Per-call options override these.
   *
   * The per-attempt timeout (`attemptMs`) and whole-operation budget
   * (`deadlineMs`) are stages S3/S4 of that design and are not implemented
   * yet; the streaming clocks below are.
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
