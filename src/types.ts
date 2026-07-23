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

export type ProviderId = "anthropic" | "google" | "openai" | "openrouter" | "venice";

export interface ChainLinkConfig {
  provider: ProviderId;
  model: string;
  /** Falls back to the provider's configured/env API key when omitted. */
  apiKey?: string;
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
}

export interface ProviderConfig {
  apiKeys?: Partial<Record<ProviderId, string>>;
  defaultProvider?: ProviderId;
  defaultModel?: string;
  /** fast = cheapest tier, power = most capable; merged over built-ins. */
  tiers?: Partial<Record<ProviderId, { fast?: string; power?: string }>>;
  /** Merged over built-in pricing; add entries for models you use. */
  pricing?: Record<string, ModelPricing>;
  /** Fallback pricing for unknown models (default: conservative mid-tier). */
  fallbackPricing?: ModelPricing;
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
  store?: TaskOverrideStore;
  /** Override cache TTL ms (default 30s). */
  overrideTtlMs?: number;
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
  /** Deterministic mock mode: no provider calls; responders supply outputs. */
  mock?: boolean;
  /** Tag written to every usage row (multi-app deployments). */
  appId?: string;
  /** Cache TTL in seconds. Default 24h. */
  cacheTtlSeconds?: number;
  /**
   * Optional at-rest encryption for logged prompt/output snapshots and cached
   * values. Both must be provided together.
   */
  encrypt?: (plaintext: string) => string;
  decrypt?: (ciphertext: string) => string;
  /** Returns true when a stored string is ciphertext from `encrypt`. */
  isEncrypted?: (value: string) => boolean;
}
