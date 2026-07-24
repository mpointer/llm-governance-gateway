import { createHash, randomUUID } from "node:crypto";
import { generateObject, generateText } from "ai";
import type { LanguageModel, Schema } from "ai";
import { z } from "zod";
import { backoffMs, isRetryable, isSchemaValidationError } from "./backoff.js";
import { JudgeGateError, RateLimitError, SpendCapError } from "./errors.js";
import { ProviderRegistry, parseModelId, type ChainLink } from "./providers.js";
import {
  callNativeAnthropic,
  NativeSchemaError,
  type NativeCallOptions,
} from "./anthropic-native.js";
import { TaskRouter } from "./tasks.js";
import { missingPlaceholders, renderTemplate } from "./template.js";
import type {
  GatewayConfig,
  JudgeConfig,
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

/** Zod schema or a raw JSON Schema wrapped with ai's jsonSchema() — the
 *  latter is what remote HTTP callers send (they keep Zod client-side). */
export type OutputSchema<O> = z.ZodType<O> | Schema<O>;

function isZodSchema<O>(s: OutputSchema<O>): s is z.ZodType<O> {
  return typeof (s as z.ZodType<O>).parse === "function";
}

// Single-link generate with 60s timeout, up to 2 retries on transient errors
// (429/5xx), and ONE schema-repair retry: when the model returns output that
// fails schema validation, the validation error is fed back into the prompt
// so the model can correct itself before we give up on this link.
async function attemptGenerate<O>(
  model: LanguageModel,
  zodSchema: OutputSchema<O>,
  prompt: string,
  temperature?: number,
  system?: string,
): Promise<AttemptResult<O>> {
  let currentPrompt = prompt;
  let repaired = false;
  let transientRetries = 0;
  for (;;) {
    try {
      const res = await generateObject({
        model,
        schema: zodSchema,
        prompt: currentPrompt,
        ...(system ? { system } : {}),
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
      if (isSchemaValidationError(err) && !repaired) {
        repaired = true;
        const detail =
          err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
        currentPrompt =
          prompt +
          "\n\nIMPORTANT: Your previous response failed schema validation with this error:\n" +
          detail +
          "\nRespond again with ONLY JSON that satisfies the schema exactly.";
        continue;
      }
      if (!isRetryable(err) || transientRetries >= 2) throw err;
      await new Promise<void>((r) => setTimeout(r, backoffMs(transientRetries, err)));
      transientRetries++;
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
  schema: OutputSchema<O>;
  input: I;
  /**
   * Inline prompt body — skips the prompt store/defaults lookup entirely
   * (still {{variable}}-rendered). Used by HTTP callers that render or manage
   * prompts client-side; `slug` then only attributes the usage log.
   */
  promptBody?: string;
  /** Overrides the stored/default prompt's temperature when set. */
  temperature?: number;
  /** System prompt (AI SDK `system`, or native Anthropic system block). */
  system?: string;
  /**
   * Native Anthropic features for this call: thinking, prompt-caching
   * cache_control, server-side web search. Requires GatewayConfig.anthropic
   * (throws otherwise — features must never silently not apply). Only affects
   * links whose provider is "anthropic"; other chain links use the AI SDK.
   */
  anthropic?: NativeCallOptions;
  /** Per-call app tag for the usage log; defaults to GatewayConfig.appId. */
  app?: string;
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
  /**
   * Named task from GatewayConfig.tasks — routes to the task's model
   * (admin-store override → code default). Precedence when set:
   * modelConfig.getOverride() > task > chain > static default.
   */
  task?: string;
  userId?: string;
  anonKey?: string;
  route?: string;
  /** Free, caller-computed rubric (no tokens spent). Kept for simple cases. */
  judgeRubric?: (object: O) => Record<string, number>;
  /** Model-graded judge: sampled, budget-aware, runs in the request path. */
  judge?: JudgeConfig;
}

export interface RunStructuredResult<O> {
  object: O;
  traceId: string;
  cacheHit: boolean;
  usageLogId?: string | number;
}

type MockResponder = (input: unknown) => unknown;

const JUDGE_SNIPPET_LIMIT = 4000;

function buildJudgePrompt(
  criteria: Record<string, string>,
  mainPrompt: string,
  object: unknown,
): string {
  const criteriaList = Object.entries(criteria)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join("\n");
  const clip = (s: string) =>
    s.length > JUDGE_SNIPPET_LIMIT ? s.slice(0, JUDGE_SNIPPET_LIMIT) + "\n...[truncated]" : s;
  return [
    "You are a strict quality judge. Score the RESPONSE against each criterion",
    "on a 0-5 scale (0 = complete failure, 3 = acceptable, 5 = excellent).",
    "Judge only what is present; do not reward verbosity.",
    "",
    "Criteria:",
    criteriaList,
    "",
    "=== ORIGINAL REQUEST ===",
    clip(mainPrompt),
    "",
    "=== RESPONSE (JSON) ===",
    clip(JSON.stringify(object)),
  ].join("\n");
}

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
  readonly tasks?: TaskRouter;
  readonly registry: ProviderRegistry;
  private readonly caps;
  private readonly mock: boolean;
  private readonly appId: string | null;
  private readonly cacheTtlSeconds: number;
  private readonly encrypt?: (t: string) => string;
  private readonly judgeDefaults?: GatewayConfig["judge"];
  private readonly anthropicCfg?: GatewayConfig["anthropic"];
  private readonly mockResponders = new Map<string, MockResponder>();

  constructor(cfg: GatewayConfig) {
    this.usage = cfg.usage;
    this.cache = cfg.cache ?? new MemoryCacheStore();
    this.rateLimiter = cfg.rateLimiter ?? new MemoryRateLimiter();
    this.promptDefaults = cfg.promptDefaults ?? [];
    this.prompts = cfg.prompts ?? new MemoryPromptStore();
    this.modelConfig = cfg.modelConfig;
    this.tasks = cfg.tasks ? new TaskRouter(cfg.tasks) : undefined;
    this.registry = new ProviderRegistry(cfg.providers);
    this.caps = cfg.caps ?? {};
    this.mock = cfg.mock ?? false;
    this.appId = cfg.appId ?? null;
    this.cacheTtlSeconds = cfg.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.encrypt = cfg.encrypt;
    this.judgeDefaults = cfg.judge;
    this.anthropicCfg = cfg.anthropic;
  }

  // ---------------------------------------------------------------------------
  // Unified single-link executor: native Anthropic when the call requests
  // native features AND the link is Anthropic AND a native client is
  // configured; AI SDK generateObject otherwise. Native failures reuse the
  // same repair/transient semantics as attemptGenerate.
  // ---------------------------------------------------------------------------
  private async execLink<O>(
    link: { provider: string; model: string; languageModel?: LanguageModel },
    schema: OutputSchema<O>,
    prompt: string,
    system: string | undefined,
    temperature: number | undefined,
    native: NativeCallOptions | undefined,
  ): Promise<AttemptResult<O> & { extras?: { cacheCreateTokens: number; cacheReadTokens: number; webSearches: number } }> {
    if (native && link.provider === "anthropic" && this.anthropicCfg) {
      let currentPrompt = prompt;
      let repaired = false;
      let transientRetries = 0;
      for (;;) {
        try {
          const res = await callNativeAnthropic(this.anthropicCfg, {
            model: link.model,
            prompt: currentPrompt,
            system,
            schema: schema as Parameters<typeof callNativeAnthropic>[1]["schema"],
            temperature,
            native,
          });
          // Validate the tool input; wrap failures so the shared
          // isSchemaValidationError machinery sees them.
          let object: O;
          if (isZodSchema(schema)) {
            try {
              object = schema.parse(res.object);
            } catch (err) {
              throw new NativeSchemaError(
                err instanceof Error ? err.message : String(err),
              );
            }
          } else {
            object = res.object as O;
          }
          return {
            object,
            usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens },
            extras: {
              cacheCreateTokens: res.cacheCreateTokens,
              cacheReadTokens: res.cacheReadTokens,
              webSearches: res.webSearches,
            },
          };
        } catch (err) {
          if (isSchemaValidationError(err) && !repaired) {
            repaired = true;
            const detail =
              err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
            currentPrompt =
              prompt +
              "\n\nIMPORTANT: Your previous response failed schema validation with this error:\n" +
              detail +
              "\nCall the tool again with input that satisfies the schema exactly.";
            continue;
          }
          if (!isRetryable(err) || transientRetries >= 2) throw err;
          await new Promise<void>((r) => setTimeout(r, backoffMs(transientRetries, err)));
          transientRetries++;
        }
      }
    }

    if (!link.languageModel) {
      throw new Error(
        `No API key for provider "${link.provider}" (and native execution does not apply).`,
      );
    }
    const result = await attemptGenerate(link.languageModel, schema, prompt, temperature, system);
    return result;
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
    zodSchema: OutputSchema<O>,
    prompt: string,
    temperature?: number,
    system?: string,
    native?: NativeCallOptions,
  ) {
    const start = Date.now();
    let lastErr: unknown;
    for (const link of chain) {
      try {
        const result = await this.execLink(link, zodSchema, prompt, system, temperature, native);
        return {
          object: result.object,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          provider: link.provider,
          model: link.model,
          durationMs: Date.now() - start,
          extras: result.extras,
        };
      } catch (err) {
        lastErr = err;
        // Fall to the next link on transient errors AND on persistent schema
        // invalidity — a different model may satisfy the schema where this
        // one couldn't (post-repair). Anything else is a caller error.
        if (!isRetryable(err) && !isSchemaValidationError(err)) throw err;
        const reason = isSchemaValidationError(err) ? "schema-invalid" : "retryable";
        console.warn(
          `[llm-gateway] "${link.provider}/${link.model}" failed (${reason}), trying next in chain`,
        );
      }
    }
    throw lastErr ?? new Error("AI chain exhausted with no result");
  }

  private async logUsage(f: Omit<UsageEntry, "createdAt">): Promise<string | number> {
    const enc = (t: string | null) =>
      t != null && this.encrypt ? this.encrypt(t) : t;
    return this.usage.logUsage({
      ...f,
      app: f.app ?? this.appId,
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
          app: opts.app,
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

    // 4. Load prompt (inline promptBody skips the store/defaults lookup)
    const promptConfig: PromptConfig = opts.promptBody
      ? { body: opts.promptBody }
      : await this.loadPrompt(opts.slug);
    const prompt = renderTemplate(promptConfig.body, opts.variables(opts.input));
    const temperature = opts.temperature ?? promptConfig.temperature;

    // Native features must never silently not apply.
    if (opts.anthropic && !this.anthropicCfg && !this.mock) {
      throw new Error(
        "runStructured received `anthropic` native options but GatewayConfig.anthropic is not configured.",
      );
    }

    // 5. Generate
    let object: O;
    let inputTokens: number;
    let outputTokens: number;
    let provider: string;
    let model: string;
    let durationMs: number;
    let extras: { cacheCreateTokens: number; cacheReadTokens: number; webSearches: number } | undefined;

    if (this.mock) {
      const responder = this.mockResponders.get(opts.slug);
      if (!responder) {
        throw new Error(
          `Mock mode is on but no responder registered for "${opts.slug}".`,
        );
      }
      { const raw = responder(opts.input); object = isZodSchema(opts.schema) ? opts.schema.parse(raw) : (raw as O); }
      inputTokens = Math.ceil(prompt.length / 4);
      outputTokens = Math.ceil(JSON.stringify(object).length / 4);
      provider = "mock";
      model = "mock";
      durationMs = 0;
    } else {
      // Resolution order:
      //   a. modelConfig.getOverride() — admin hard-pin, no failover
      //   b. task routing              — per-task override/default
      //   c. modelConfig.getChain()    — primary → fallback → ...
      //   d. Static/env default        — no dynamic config present
      const adminOverride = (await this.modelConfig?.getOverride()) ?? null;

      if (!adminOverride && opts.task) {
        if (!this.tasks) {
          throw new Error(
            `runStructured received task "${opts.task}" but GatewayConfig.tasks is not configured.`,
          );
        }
        const resolved = await this.tasks.modelForTask(opts.task);
        const lm = this.registry.buildLanguageModel(resolved.provider, resolved.model);
        const nativeApplies =
          opts.anthropic && resolved.provider === "anthropic" && this.anthropicCfg;
        if (!lm && !nativeApplies) {
          throw new Error(
            `Task "${opts.task}" routes to "${resolved.provider}/${resolved.model}" but that provider has no API key.`,
          );
        }
        const start = Date.now();
        const result = await this.execLink(
          { provider: resolved.provider, model: resolved.model, languageModel: lm ?? undefined },
          opts.schema,
          prompt,
          opts.system,
          temperature,
          opts.anthropic,
        );
        object = result.object;
        inputTokens = result.usage.inputTokens;
        outputTokens = result.usage.outputTokens;
        provider = resolved.provider;
        model = resolved.model;
        durationMs = Date.now() - start;
        extras = result.extras;
      } else if (adminOverride) {
        const resolved = this.registry.resolveDefault({
          provider: adminOverride.provider,
          model: promptConfig.modelHint ?? adminOverride.model,
        });
        const nativeApplies =
          opts.anthropic && resolved.provider === "anthropic" && this.anthropicCfg;
        if (!resolved.languageModel && !nativeApplies) {
          throw new Error(`No API key for provider "${resolved.provider}".`);
        }
        const start = Date.now();
        const result = await this.execLink(
          resolved,
          opts.schema,
          prompt,
          opts.system,
          temperature,
          opts.anthropic,
        );
        object = result.object;
        inputTokens = result.usage.inputTokens;
        outputTokens = result.usage.outputTokens;
        provider = resolved.provider;
        model = resolved.model;
        durationMs = Date.now() - start;
        extras = result.extras;
      } else {
        const chainCfg = (await this.modelConfig?.getChain()) ?? [];
        const chain = this.registry.buildChain(
          chainCfg,
          opts.tier,
          opts.anthropic && this.anthropicCfg ? ["anthropic"] : undefined,
        );

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
          const nativeApplies =
            opts.anthropic && resolved.provider === "anthropic" && this.anthropicCfg;
          if (!resolved.languageModel && !nativeApplies) {
            throw new Error(
              "No AI provider configured. Set an API key (config or env) or provide a ModelConfigStore.",
            );
          }
          const start = Date.now();
          const result = await this.execLink(
            resolved,
            opts.schema,
            prompt,
            opts.system,
            temperature,
            opts.anthropic,
          );
          object = result.object;
          inputTokens = result.usage.inputTokens ?? 0;
          outputTokens = result.usage.outputTokens ?? 0;
          provider = resolved.provider;
          model = resolved.model;
          durationMs = Date.now() - start;
          extras = result.extras;
        } else {
          const gen = await this.callWithChain(
            chain,
            opts.schema,
            prompt,
            temperature,
            opts.system,
            opts.anthropic,
          );
          object = gen.object;
          inputTokens = gen.inputTokens;
          outputTokens = gen.outputTokens;
          provider = gen.provider;
          model = gen.model;
          durationMs = gen.durationMs;
          extras = gen.extras;
        }
      }
    }

    // 6. Cache write
    if (key) await this.cache.set(key, object, this.cacheTtlSeconds);

    // 7. Usage log
    const usageLogId = await this.logUsage({
      app: opts.app,
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: opts.slug,
      provider,
      model,
      inputTokens,
      outputTokens,
      estimatedCostCents: this.registry.estimateCostCents(model, inputTokens, outputTokens, extras),
      cacheHit: false,
      traceId,
      durationMs,
      cacheCreateTokens: extras?.cacheCreateTokens ?? null,
      cacheReadTokens: extras?.cacheReadTokens ?? null,
      webSearches: extras?.webSearches ?? null,
      inputText: prompt,
      outputText: JSON.stringify(object),
    });

    // 8a. Free caller-computed rubric
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

    // 8b. Model-graded judge (sampled, budget-aware, may gate)
    if (opts.judge) {
      await this.runJudge(opts, prompt, object, usageLogId);
    }

    return { object, traceId, cacheHit: false, usageLogId };
  }

  // ---------------------------------------------------------------------------
  // Judge-in-the-request-path. Rules:
  //   - Sampled: only sampleRate of eligible calls spend judge tokens.
  //   - Budget-aware: if the estimated judge cost would cross the global cap,
  //     the judge is SKIPPED (with a warning) — a governance check must never
  //     be the thing that blows the budget or fails the main response.
  //   - Gate mode throws JudgeGateError AFTER persisting scores and usage, so
  //     the audit trail exists even for rejected responses.
  // ---------------------------------------------------------------------------
  private async runJudge<I, O>(
    opts: RunStructuredOptions<I, O>,
    mainPrompt: string,
    object: O,
    mainUsageLogId: string | number,
  ): Promise<void> {
    const judge = opts.judge!;
    const criteria = Object.keys(judge.criteria);
    if (criteria.length === 0) return;

    const sampleRate = judge.sampleRate ?? this.judgeDefaults?.sampleRate ?? 1;
    const rng = this.judgeDefaults?.random ?? Math.random;
    if (sampleRate <= 0 || rng() >= sampleRate) return;

    const modelId =
      judge.model ??
      this.judgeDefaults?.model ??
      (() => {
        const d = this.registry.resolveDefault();
        const fast = this.registry.tierModel(d.provider, "fast");
        return fast ? `${d.provider === "anthropic" ? "" : d.provider + ":"}${fast}` : null;
      })();
    if (!modelId) {
      console.warn("[llm-gateway] judge skipped: no judge model resolvable");
      return;
    }
    const { provider, model } = parseModelId(modelId);

    const judgePrompt = buildJudgePrompt(judge.criteria, mainPrompt, object);

    // Budget-awareness: estimate the judge call and skip if it would cross
    // the global breaker. Uses prompt-length heuristic (4 chars/token) plus a
    // small output allowance — coarse, but the point is "don't judge when
    // we're at the cliff edge", not exact accounting.
    const globalCap = this.caps.globalDailyCents ?? DEFAULT_GLOBAL_CAP_CENTS;
    if (globalCap) {
      const todayUtc = new Date();
      todayUtc.setUTCHours(0, 0, 0, 0);
      const spent = await this.usage.sumSpendCents(todayUtc);
      const estCost = this.registry.estimateCostCents(
        model,
        Math.ceil(judgePrompt.length / 4),
        criteria.length * 12,
      );
      if (spent + estCost >= globalCap) {
        console.warn(
          `[llm-gateway] judge skipped for "${opts.slug}": estimated cost would cross the global cap`,
        );
        return;
      }
    }

    const scoreSchema = z.object(
      Object.fromEntries(criteria.map((k) => [k, z.number().min(0).max(5)])),
    ) as z.ZodType<Record<string, number>>;

    let scores: Record<string, number>;
    let inputTokens: number;
    let outputTokens: number;
    let judgeProvider: string;
    let judgeModel: string;
    let durationMs: number;

    if (this.mock) {
      const responder = this.mockResponders.get(`judge:${opts.slug}`);
      if (!responder) {
        console.warn(
          `[llm-gateway] mock mode: no "judge:${opts.slug}" responder — judge skipped`,
        );
        return;
      }
      scores = scoreSchema.parse(responder(object));
      inputTokens = Math.ceil(judgePrompt.length / 4);
      outputTokens = criteria.length * 12;
      judgeProvider = "mock";
      judgeModel = "mock";
      durationMs = 0;
    } else {
      const lm = this.registry.buildLanguageModel(provider, model);
      if (!lm) {
        console.warn(`[llm-gateway] judge skipped: no API key for "${provider}"`);
        return;
      }
      const start = Date.now();
      const result = await attemptGenerate(lm, scoreSchema, judgePrompt);
      scores = result.object;
      inputTokens = result.usage.inputTokens;
      outputTokens = result.usage.outputTokens;
      judgeProvider = provider;
      judgeModel = model;
      durationMs = Date.now() - start;
    }

    const values = Object.values(scores);
    const overall = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

    // Persist BEFORE gating: rejected responses must still leave an audit trail.
    await this.logUsage({
      app: opts.app,
      userId: opts.userId ?? null,
      route: `judge:${opts.route ?? opts.slug}`,
      promptSlug: opts.slug,
      provider: judgeProvider,
      model: judgeModel,
      inputTokens,
      outputTokens,
      estimatedCostCents: this.registry.estimateCostCents(judgeModel, inputTokens, outputTokens),
      cacheHit: false,
      traceId: randomUUID(),
      durationMs,
    });
    await this.usage.saveJudgeScore({
      usageLogId: mainUsageLogId,
      rubric: scores,
      overallScore: overall,
      createdAt: new Date(),
    });

    if ((judge.mode ?? "observe") === "gate") {
      const threshold = judge.threshold ?? 3;
      if (overall < threshold) {
        throw new JudgeGateError(scores, overall, threshold, object);
      }
    }
  }

  /**
   * Admin prompt-library "test run": renders the template with sample
   * variables, executes ONE plain-text generation against the resolved model,
   * and logs the spend (route "admin:prompt-test") so test traffic shows up
   * in the cost dashboard instead of hiding from it. Deliberately bypasses
   * the response cache (a test must hit the model) but not usage logging.
   * Bypasses rate limit and spend caps too — it's an admin tool.
   */
  async runPromptTest(opts: PromptTestOptions): Promise<PromptTestResult> {
    const traceId = randomUUID();
    const prompt = renderTemplate(opts.body, opts.variables);

    let text: string;
    let provider: string;
    let model: string;
    let inputTokens: number;
    let outputTokens: number;
    let durationMs: number;

    if (this.mock) {
      text = `[mock] ${prompt.slice(0, 200)}`;
      provider = "mock";
      model = "mock";
      inputTokens = Math.ceil(prompt.length / 4);
      outputTokens = Math.ceil(text.length / 4);
      durationMs = 0;
    } else {
      // Routing: explicit model id > task > static/env default.
      let resolvedProvider;
      let resolvedModel: string;
      let lm: LanguageModel | undefined;
      if (opts.model) {
        const parsed = parseModelId(opts.model);
        resolvedProvider = parsed.provider;
        resolvedModel = parsed.model;
        lm = this.registry.buildLanguageModel(parsed.provider, parsed.model) ?? undefined;
      } else if (opts.task && this.tasks) {
        const t = await this.tasks.modelForTask(opts.task);
        resolvedProvider = t.provider;
        resolvedModel = t.model;
        lm = this.registry.buildLanguageModel(t.provider, t.model) ?? undefined;
      } else {
        const r = this.registry.resolveDefault();
        resolvedProvider = r.provider;
        resolvedModel = r.model;
        lm = r.languageModel;
      }
      if (!lm) {
        throw new Error(
          `Prompt test: no API key for provider "${resolvedProvider}".`,
        );
      }
      const start = Date.now();
      const res = await generateText({
        model: lm,
        prompt,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        abortSignal: AbortSignal.timeout(60_000),
      });
      text = res.text;
      inputTokens = res.usage.inputTokens ?? 0;
      outputTokens = res.usage.outputTokens ?? 0;
      provider = resolvedProvider;
      model = resolvedModel;
      durationMs = Date.now() - start;
    }

    const costCents = this.registry.estimateCostCents(model, inputTokens, outputTokens);
    const usageLogId = await this.logUsage({
      userId: opts.userId ?? null,
      route: "admin:prompt-test",
      promptSlug: opts.slug ?? null,
      provider,
      model,
      inputTokens,
      outputTokens,
      estimatedCostCents: costCents,
      cacheHit: false,
      traceId,
      durationMs,
      inputText: prompt,
      outputText: text,
    });

    return {
      text,
      prompt,
      provider,
      model,
      inputTokens,
      outputTokens,
      costCents,
      durationMs,
      usageLogId,
    };
  }
}

export interface PromptTestOptions {
  /** Library slug being tested (usage-log attribution only). */
  slug?: string;
  /** Template body to test — may include unsaved editor changes. */
  body: string;
  /** {{placeholder}} sample values supplied by the admin. */
  variables: Record<string, string>;
  /** Explicit (possibly prefixed) model id; beats task and default. */
  model?: string;
  /** Route via task registry when no explicit model is given. */
  task?: string;
  temperature?: number;
  /** Admin running the test — attributed in the usage log. */
  userId?: string;
}

export interface PromptTestResult {
  text: string;
  prompt: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  durationMs: number;
  usageLogId: string | number;
}
