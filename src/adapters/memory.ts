// In-memory adapter implementations. Zero-config defaults for dev, test, and
// single-process deployments. For serverless/multi-instance production, back
// UsageStore with a real database and RateLimiter/CacheStore with Redis —
// in-memory state resets on every cold start, which silently disables
// enforcement.

import type {
  CacheStore,
  JudgeScore,
  PromptDefault,
  PromptStore,
  RateLimiter,
  RateLimitResult,
  SpendCapEvent,
  StoredPrompt,
  UsageEntry,
  UsageStore,
} from "../types.js";

export class MemoryUsageStore implements UsageStore {
  readonly entries: (UsageEntry & { id: number })[] = [];
  readonly capEvents: SpendCapEvent[] = [];
  readonly judgeScores: JudgeScore[] = [];
  readonly userCaps = new Map<string, number>();
  private nextId = 1;

  async logUsage(entry: UsageEntry): Promise<number> {
    const id = this.nextId++;
    this.entries.push({ ...entry, id });
    return id;
  }

  async sumSpendCents(since: Date, userId?: string | null): Promise<number> {
    return this.entries
      .filter((e) => !e.cacheHit && e.createdAt >= since)
      .filter((e) => (userId === undefined ? true : (e.userId ?? null) === userId))
      .reduce((sum, e) => sum + e.estimatedCostCents, 0);
  }

  async recordSpendCapEvent(event: SpendCapEvent): Promise<void> {
    this.capEvents.push(event);
  }

  async saveJudgeScore(score: JudgeScore): Promise<void> {
    this.judgeScores.push(score);
  }

  async getUserDailyCapCents(userId: string): Promise<number | undefined> {
    return this.userCaps.get(userId);
  }
}

export class MemoryPromptStore implements PromptStore {
  private readonly prompts = new Map<string, StoredPrompt>();

  async getPrompt(slug: string): Promise<StoredPrompt | undefined> {
    return this.prompts.get(slug);
  }

  async seedPrompt(def: PromptDefault): Promise<void> {
    if (!this.prompts.has(def.slug)) {
      this.prompts.set(def.slug, {
        slug: def.slug,
        body: def.body,
        modelHint: def.modelHint ?? null,
      });
    }
  }

  /** Test/admin helper: overwrite a prompt body directly. */
  setPrompt(prompt: StoredPrompt): void {
    this.prompts.set(prompt.slug, prompt);
  }
}

export class MemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, { value: unknown; expires: number }>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }

  clear(): void {
    this.store.clear();
  }
}

/** Fixed-window in-memory limiter. Fine for dev/test and single processes. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
  ) {}

  async limit(identifier: string): Promise<RateLimitResult> {
    const now = Date.now();
    const b = this.buckets.get(identifier);
    if (!b || b.reset < now) {
      this.buckets.set(identifier, { count: 1, reset: now + this.windowMs });
      return { success: true, remaining: this.max - 1, limit: this.max };
    }
    b.count += 1;
    return {
      success: b.count <= this.max,
      remaining: Math.max(0, this.max - b.count),
      limit: this.max,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}
