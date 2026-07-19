# llm-governance-gateway

A governed structured-output pipeline for LLM calls. Every call runs through:

```
rate limit → spend caps (per-user + global circuit breaker) → cache
→ provider-chain failover → Zod-validated generateObject → usage log → LLM-judge
```

Built on the [Vercel AI SDK](https://sdk.vercel.ai) (Anthropic, Google, OpenAI). Storage is pluggable — memory adapters work out of the box; bring your own database and Redis for production.

## Why

- **Spend caps that actually hold.** Per-user daily caps plus an app-wide daily circuit breaker, checked against your usage store before every call. Unset ≠ uncapped: defaults are conservative, and only an explicit `0` opts out.
- **Failover chains.** primary → fallback → backup providers, with 429/5xx-aware retries, `Retry-After` honoring, and equal-jitter backoff.
- **Deterministic CI.** Mock mode replaces providers with registered responders — your AI-dependent test suite runs offline with zero keys.
- **Prompt library pattern.** Store-as-override, code-as-fallback: admins can edit prompts at runtime; a broken edit (missing `{{placeholder}}`) falls back to the code default instead of silently sending a malformed prompt.
- **Judge + telemetry.** Optional per-call rubric scoring and full usage accounting (tokens, cost, latency, trace IDs), with an optional at-rest encryption hook for logged prompt/output snapshots.

## Quickstart

```ts
import { z } from "zod";
import { Gateway, MemoryUsageStore } from "llm-governance-gateway";

const gw = new Gateway({
  usage: new MemoryUsageStore(),
  promptDefaults: [
    {
      slug: "summarize",
      body: "Summarize in one sentence:\n\n{{text}}",
      variables: ["text"],
    },
  ],
  providers: { apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! } },
  caps: { userDailyCents: 200, globalDailyCents: 5000 },
});

const { object } = await gw.runStructured({
  slug: "summarize",
  schema: z.object({ summary: z.string() }),
  input: { text: "..." },
  variables: (i) => ({ text: i.text }),
  cacheParts: ["..."], // or cache: false for PII-bearing calls
  userId: "user-123",
});
```

### Testing without API keys

```ts
const gw = new Gateway({ usage, promptDefaults, mock: true });
gw.registerMockResponder("summarize", () => ({ summary: "stub" }));
```

### Production storage

Implement `UsageStore` over your database (one table for usage, one for cap events, one for judge scores — see `src/types.ts`), and pass Redis-backed cache/rate limiting:

```ts
import { Redis } from "@upstash/redis";
import { RedisCacheStore, RedisRateLimiter } from "llm-governance-gateway";

const redis = Redis.fromEnv();
const gw = new Gateway({
  usage: myDrizzleUsageStore,
  cache: new RedisCacheStore(redis),
  rateLimiter: new RedisRateLimiter(redis, 20, 60),
});
```

`RedisLike` is a four-method interface (`get/set/incr/expire`) — `@upstash/redis` satisfies it directly; ioredis needs a thin wrapper. The package has no hard Redis dependency.

### Failover chains and tiers

Provide a `ModelConfigStore` (e.g. an admin-editable table) to control routing at runtime:

```ts
const gw = new Gateway({
  usage,
  modelConfig: {
    getOverride: async () => null, // hard-pin escape hatch
    getChain: async () => [
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "openai", model: "gpt-4.1" },
    ],
  },
});

// tier: "fast" re-routes every chain link to its provider's cheapest model
await gw.runStructured({ ...opts, tier: "fast" });
```

## Design notes

- **Fail-open rate limiting, fail-closed spend caps.** A Redis blip should not 500 every AI call — the limiter fails open with an alert, while the store-backed spend cap (independent of Redis) still bounds cost.
- **Global breaker before per-user caps.** Per-identity caps can't see N users × cap on a viral day.
- **Cache is opt-out per call**, and `cache: false` skips both read *and* write — required for PII-bearing calls.
- **In-memory defaults are for dev/single-process only.** On serverless they reset every cold start, which silently disables enforcement.

## Status

Extracted from a production system (three independent in-house implementations converged on this design). API may shift before 1.0. Roadmap: standalone HTTP gateway (Hono/Workers) exposing `/run` for multi-app deployments, Drizzle/Postgres reference `UsageStore`, streaming support.

## License

MIT
