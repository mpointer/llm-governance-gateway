// Redis-backed CacheStore and RateLimiter over a minimal client interface.
// Works with @upstash/redis, ioredis (with a thin wrapper), or anything that
// implements RedisLike — the package takes no hard Redis dependency.

import type { CacheStore, RateLimiter, RateLimitResult } from "../types.js";

export interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  /** Atomic increment; returns the new value. */
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RedisCacheOptions {
  /** Optional at-rest encryption for cached values. Provide all three. */
  encrypt?: (plaintext: string) => string;
  decrypt?: (ciphertext: string) => string;
  isEncrypted?: (value: string) => boolean;
}

export class RedisCacheStore implements CacheStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly opts: RedisCacheOptions = {},
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const hit = await this.redis.get(key);
    if (hit == null) return undefined;
    if (typeof hit === "string") {
      if (this.opts.isEncrypted?.(hit) && this.opts.decrypt) {
        try {
          return JSON.parse(this.opts.decrypt(hit)) as T;
        } catch {
          return undefined; // rotated key or corrupt entry = cache miss
        }
      }
      try {
        return JSON.parse(hit) as T;
      } catch {
        return hit as unknown as T;
      }
    }
    return hit as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const json = JSON.stringify(value);
    const stored = this.opts.encrypt ? this.opts.encrypt(json) : json;
    await this.redis.set(key, stored, { ex: ttlSeconds });
  }
}

/**
 * Fixed-window Redis rate limiter (INCR + EXPIRE). Simple and adequate for
 * per-user AI-call ceilings; swap in @upstash/ratelimit's sliding window via
 * a custom RateLimiter if you need smoother behavior at the boundary.
 *
 * Fails OPEN on Redis errors: a transient blip should not 500 every AI call.
 * The store-backed spend cap (independent of Redis) still bounds cost.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly max = 20,
    private readonly windowSeconds = 60,
    private readonly prefix = "airl",
  ) {}

  async limit(identifier: string): Promise<RateLimitResult> {
    const windowStart = Math.floor(Date.now() / (this.windowSeconds * 1000));
    const key = `${this.prefix}:${identifier}:${windowStart}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, this.windowSeconds);
      return {
        success: count <= this.max,
        remaining: Math.max(0, this.max - count),
        limit: this.max,
      };
    } catch (e) {
      console.error(
        `[llm-gateway] Redis rate limit failed for "${identifier}", failing open: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { success: true, remaining: this.max, limit: this.max };
    }
  }
}
