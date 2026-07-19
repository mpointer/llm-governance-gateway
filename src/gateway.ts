import { createHash, randomUUID } from "node:crypto";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { z } from "zod";
import { backoffMs, isRetryable } from "./backoff.js";
import { RateLimitError, SpendCapError } from "./errors.js";
import { ProviderRegistry, type ChainLink } from "./providers.js";
import { missingPlaceholders, renderTemplate } from "./template.js";
import type {
  GatewayConfig,
  PromptDefault,
  ProviderId,
  UsageEntry,
} from "./types.js";
import {
  MemoryCacheStore,
  MemoryPromptStore,
  MemoryRateLimiter,
} from "./adapters/memory.js";

const SNAPSHOT_LIMIT = 2000;
const DEFAULT_USER_CAP_CENTS = 200; // unset = conservative default, NOT uncapped
const DEFAULT_ANON_CAP_CENTS = 100;
const DEFAULT_GLOBAL_CAP_CENTS = 5000; // app-wide circuit breaker
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24;

function truncate(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > SNAPSHOT_LIMIT
    ? text.slice(0, SNAPSHOT_LIMIT) + "...[truncated]"
    : text;
}

interface AttemptResult<O> {
  object: O;
  usage: { inputTokens: number; outputTokens: number };
}

// Single-link generate with 60s timeout and up to 2 retries on the same model.
async function attemptGenerate<O>(
  model: LanguageModel,
  zodSchema: z.ZodType<O>,
  prompt: string,
  temperature?: number,
): Promise<AttemptResult<O>> {
  for (let retry = 0; ; retry++) {
    try {
      const res = await generateObject({
        model,
        schema: zodSchema,
        prompt,
        ...(temperature !== undefined ? { temperature } : {}),
        abortSignal: AbortSignal.timeout(60_000),
      });
      return {
        object: res.object as O,
        usage: {
          inputTokens: res.usage.inputTokens ?? 0,
          outputTokens: res.usage.outputTokens ?? 0,
        },
      };
    } catch (err) {
      if (!isRetryable(err) || retry >= 2) throw err;
      await new Promise<void>((r) => setTimeout(r, backoffMs(retry, err)));
    }
  }
}

interface PromptConfig {
  body: string;
  modelHint?: string;
  providerOverride?: string;
  temperature?: number;
}

export interface RunStructuredOptions<I, O> {
  slug: string;
  schema: z.ZodType<O>;
  input: I;
  /**
   * Values substituted into the prompt body's {{placeholders}} at call time.
   * Conditional blocks are passed as pre-rendered "section" variables (""
   * when absent) so the template stays a flat substitution.
   */
  variables: (input: I) => Record<string, string>;
  cacheParts?: string[];
  /**
   * Default true. Set false to bypass cache entirely (no read AND no write).
   * Required for calls whose input/output carries PII.
   */
  cache?: boolean;
  /**
   * 'fast' routes to the cheapest model tier per provider; 'power' to the
   * most capable. Omit to use each chain link's configured model as-is.
   */
  tier?: "fast" | "power";
  userId?: string;
  anonKey?: string;
  route?: string;
  judgeRubric?: (object: O) => Record<string, number>;
}

export interface RunStructuredResult<O> {
  object: O;
  traceId: string;
  cacheHit: boolean;
  usageLogId?: string | number;
}

type MockResponder = (input: unknown) => unknown;

export function cacheKey(slug: string, parts: string[]): string {
  const hash = createHash("sha256")
    .update(parts.join(" "))
    .digest("hex")
    .slice(0, 32);
  return `aicache:${slug}:${hash}`;
}

export class Gateway {
  private readonly usage;
  private readonly cache;
  private readonly rateLimiter;
  private readonly prompts;
  private readonly promptDefaults: PromptDefault[];
  private readonly modelConfig;
  private readonly registry: ProviderRegistry;
  private readonly caps;
  private readonly mock: boolean;
  private readonly appId: string | null;
  private readonly cacheTtlSeconds: number;
  private readonly encrypt?: (t: string) => string;
  private readonly mockResponders = new Map<string, MockResponder>();

  constructor(cfg: GatewayConfig) {
    this.usage = cfg.usage;
    this.cache = cfg.cache ?? new MemoryCacheStore();
    this.rateLimiter = cfg.rateLimiter ?? new MemoryRateLimiter();
    this.promptDefaults = cfg.promptDefaults ?? [];
    this.prompts = cfg.prompts ?? new MemoryPromptStore();
    this.modelConfig = cfg.modelConfig;
    this.registry = new ProviderRegistry(cfg.providers);
    this.caps = cfg.caps ?? {};
    this.mock = cfg.mock ?? false;
    this.appId = cfg.appId ?? null;
    this.cacheTtlSeconds = cfg.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.encrypt = cfg.encrypt;
  }

  /** Register a deterministic responder used when mock mode is on. */
  registerMockResponder(slug: string, fn: (input: never) => unknown): void {
    this.mockResponders.set(slug, fn as MockResponder);
  }

  // -------------------------------------------------------------------------
  // Spend caps: global circuit breaker first (per-identity caps can't see
  // N users × cap on a viral day), then the per-identity cap.
  // -------------------------------------------------------------------------
  private async checkSpendCap(userId: string | undefined, route: string | undefined) {
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);

    const globalCap = this.caps.globalDailyCents ?? DEFAULT_GLOBAL_CAP_CENTS;
    if (globalCap) {
      const total = await this.usage.sumSpendCents(todayUtc);
      if (total >= globalCap) {
        await this.usage.recordSpendCapEvent({
          userId: userId ?? null,
          capCents: globalCap,
          spentCents: total,
          route: route ? `global:${route}` : "global",
          wouldBlock: true,
          createdAt: new Date(),
        });
        throw new SpendCapError(total, globalCap, "global");
      }
    }

    let capCents: number;
    if (userId) {
      capCents =
        (await this.usage.getUserDailyCapCents?.(userId)) ??
        this.caps.userDailyCents ??
        DEFAULT_USER_CAP_CENTS;
    } else {
      capCents = this.caps.anonDailyCents ?? DEFAULT_ANON_CAP_CENTS;
    }
    if (!capCents) return; // explicit 0 = deliberate opt-out

    const spent = await this.usage.sumSpendCents(todayUtc, userId ?? null);
    if (spent >= capCents) {
      await this.usage.recordSpendCapEvent({
        userId: userId ?? null,
        capCents,
        spentCents: spent,
        route: route ?? null,
        wouldBlock: true,
        createdAt: new Date(),
      });
      throw new SpendCapError(spent, capCents);
    }
  }

  // -------------------------------------------------------------------------
  // Prompt loading: store-as-override, code-as-fallback.
  //   - Stored prompt present and structurally valid → use it (admin edits win).
  //   - Stored body missing a required {{placeholder}} → warn, use code default
  //     body (the row's model/temperature knobs still apply).
  //   - Slug missing but known in promptDefaults → auto-seed and use default.
  //   - Store unreachable but slug known → warn, use default.
  //   - Slug unknown to both → throw.
  // -------------------------------------------------------------------------
  private async loadPrompt(slug: string): Promise<PromptConfig> {
    const def = this.promptDefaults.find((d) => d.slug === slug);

    let row;
    try {
      row = await this.prompts.getPrompt(slug);
    } catch (err) {
      if (!def) throw err;
      console.warn(
        `[llm-gateway] prompt store unreachable for "${slug}", using code default:`,
        err instanceof Error ? err.message : err,
      );
      return { body: def.body, modelHint: def.modelHint };
    }

    if (!row) {
      if (!def) {
        throw new Error(
          `prompt "${slug}" not found in store or promptDefaults.`,
        );
      }
      await this.prompts
        .seedPrompt?.(def)
        ?.catch((err: unknown) =>
          console.warn(`[llm-gateway] auto-seed of "${slug}" failed:`, err),
        );
      return { body: def.body, modelHint: def.modelHint };
    }

    let body = row.body;
    if (def) {
      const missing = missingPlaceholders(body, def.variables);
      if (missing.length > 0) {
        console.warn(
          `[llm-gateway] prompt "${slug}" body is missing {{${missing.join("}}, {{")}}} — using the code default body instead.`,
        );
        body = def.body;
      }
    }

    return {
      body,
      modelHint: row.modelHint ?? undefined,
      providerOverride: row.providerOverride ?? undefined,
      temperature: row.temperature ?? undefined,
    };
  }

  // Walk the provider chain (primary → fallback → ...). Throws the last error
  // only after all links are exhausted.
  private async callWithChain<O>(
    chain: ChainLink[],
    zodSchema: z.ZodType<O>,
    prompt: string,
    temperature?: number,
  ) {
    const start = Date.now();
    let lastErr: unknown;
    for (const link of chain) {
      try {
        const result = await attemptGenerate(link.languageModel, zodSchema, prompt, temperature);
        return {
          object: result.object,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          provider: link.provider,
          model: link.model,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
        console.warn(
          `[llm-gateway] "${link.provider}/${link.model}" failed (retryable), trying next in chain`,
        );
      }
    }
    throw lastErr ?? new Error("AI chain exhausted with no result");
  }

  private async logUsage(f: Omit<UsageEntry, "app" | "createdAt">): Promise<string | number> {
    const enc = (t: string | null) =>
      t != null && this.encrypt ? this.encrypt(t) : t;
    return this.usage.logUsage({
      ...f,
      app: this.appId,
      // Prompts and outputs can carry user PII. When an encrypt hook is
      // configured, the encrypted-at-rest guarantee holds for telemetry too.
      inputText: enc(truncate(f.inputText)),
      outputText: enc(truncate(f.outputText)),
      createdAt: new Date(),
    });
  }

  async runStructured<I, O>(
    opts: RunStructuredOptions<I, O>,
  ): Promise<RunStructuredResult<O>> {
    const traceId = randomUUID();
    const identifier =
      opts.userId ?? (opts.anonKey ? `anon:${opts.anonKey}` : "anon");

    // 1. Rate limit
    const rl = await this.rateLimiter.limit(identifier);
    if (!rl.success) throw new RateLimitError(rl.limit, rl.remaining);

    // 2. Spend cap
    await this.checkSpendCap(opts.userId, opts.route);

    // 3. Cache read
    const useCache = opts.cache !== false;
    if (useCache && !opts.cacheParts) {
      throw new Error(
        "runStructured: cacheParts is required unless cache:false is set.",
      );
    }
    const key = useCache ? cacheKey(opts.slug, opts.cacheParts!) : null;
    if (key) {
      const cached = await this.cache.get<O>(key);
      if (cached !== undefined) {
        const usageLogId = await this.logUsage({
          userId: opts.userId ?? null,
          route: opts.route ?? null,
          promptSlug: opts.slug,
          provider: "cache",
          model: "cache",
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostCents: 0,
          cacheHit: true,
          traceId,
        });
        return { object: cached, traceId, cacheHit: true, usageLogId };
      }
    }

    // 4. Load prompt
    const promptConfig = await this.loadPrompt(opts.slug);
    const prompt = renderTemplate(promptConfig.body, opts.variables(opts.input));

    // 5. Generate
    let object: O;
    let inputTokens: number;
    let outputTokens: number;
    let provider: string;
    let model: string;
    let durationMs: number;

    if (this.mock) {
      const responder = this.mockResponders.get(opts.slug);
      if (!responder) {
        throw new Error(
          `Mock mode is on but no responder registered for "${opts.slug}".`,
        );
      }
      object = opts.schema.parse(responder(opts.input));
      inputTokens = Math.ceil(prompt.length / 4);
      outputTokens = Math.ceil(JSON.stringify(object).length / 4);
      provider = "mock";
      model = "mock";
      durationMs = 0;
    } else {
      // Resolution order:
      //   a. modelConfig.getOverride() — admin hard-pin, no failover
      //   b. modelConfig.getChain()    — primary → fallback → ...
      //   c. Static/env default        — no dynamic config present
      const adminOverride = (await this.modelConfig?.getOverride()) ?? null;

      if (adminOverride) {
        const resolved = this.registry.resolveDefault({
          provider: adminOverride.provider,
          model: promptConfig.modelHint ?? adminOverride.model,
        });
        if (!resolved.languageModel) {
          throw new Error(`No API key for provider "${resolved.provider}".`);
        }
        const start = Date.now();
        const result = await attemptGenerate(
          resolved.languageModel,
          opts.schema,
          prompt,
          promptConfig.temperature,
        );
        object = result.object;
        inputTokens = result.usage.inputTokens;
        outputTokens = result.usage.outputTokens;
        provider = resolved.provider;
        model = resolved.model;
        durationMs = Date.now() - start;
      } else {
        const chainCfg = (await this.modelConfig?.getChain()) ?? [];
        const chain = this.registry.buildChain(chainCfg, opts.tier);

        if (chain.length === 0) {
          const resolved = this.registry.resolveDefault(
            promptConfig.modelHint
              ? {
                  model: promptConfig.modelHint,
                  ...(promptConfig.providerOverride
                    ? { provider: promptConfig.providerOverride as ProviderId }
                    : {}),
                }
              : undefined,
          );
          if (!resolved.languageModel) {
            throw new Error(
              "No AI provider configured. Set an API key (config or env) or provide a ModelConfigStore.",
            );
          }
          const start = Date.now();
          const result = await attemptGenerate(
            resolved.languageModel,
            opts.schema,
            prompt,
            promptConfig.temperature,
          );
          object = result.object;
          inputTokens = result.usage.inputTokens ?? 0;
          outputTokens = result.usage.outputTokens ?? 0;
          provider = resolved.provider;
          model = resolved.model;
          durationMs = Date.now() - start;
        } else {
          const gen = await this.callWithChain(
            chain,
            opts.schema,
            prompt,
            promptConfig.temperature,
          );
          object = gen.object;
          inputTokens = gen.inputTokens;
          outputTokens = gen.outputTokens;
          provider = gen.provider;
          model = gen.model;
          durationMs = gen.durationMs;
        }
      }
    }

    // 6. Cache write
    if (key) await this.cache.set(key, object, this.cacheTtlSeconds);

    // 7. Usage log
    const usageLogId = await this.logUsage({
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: opts.slug,
      provider,
      model,
      inputTokens,
      outputTokens,
      estimatedCostCents: this.registry.estimateCostCents(model, inputTokens, outputTokens),
      cacheHit: false,
      traceId,
      durationMs,
      inputText: prompt,
      outputText: JSON.stringify(object),
    });

    // 8. Judge
    if (opts.judgeRubric) {
      const rubric = opts.judgeRubric(object);
      const values = Object.values(rubric);
      const overall =
        values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      await this.usage.saveJudgeScore({
        usageLogId,
        rubric,
        overallScore: overall,
        createdAt: new Date(),
      });
    }

    return { object, traceId, cacheHit: false, usageLogId };
  }
}
