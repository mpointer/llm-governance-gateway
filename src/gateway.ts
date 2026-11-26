import { createHash, randomUUID } from "node:crypto";
import {
  embedMany,
  generateObject,
  generateText,
  streamObject,
  streamText as aiStreamText,
} from "ai";
import type {
  LanguageModel,
  ModelMessage,
  Schema,
  StopCondition,
  TextStreamPart,
  ToolSet,
} from "ai";
import { z } from "zod";
import { backoffMs, isRetryable, isSchemaValidationError } from "./backoff.js";
import {
  AttemptTimeoutError,
  DeadlineExceededError,
  type GuardrailError,
  JudgeGateError,
  RateLimitError,
  RunLimitError,
  SpendCapError,
  StreamStallError,
  ZdrViolationError,
} from "./errors.js";
import { createConflatedCell, createQueuedCell, guardStream } from "./stream-guard.js";
import {
  guardrailError,
  runGuardrail,
  type GuardrailConfig,
  type GuardrailRecord,
  type PostGuardrailContext,
} from "./guardrails.js";
import { AttemptBudget, sleep } from "./deadline.js";
import { GovernedRun, type RunSnapshot, type StartRunOptions } from "./run.js";
import { governTools, type ToolDenial, type ToolPolicy } from "./tools.js";
import {
  ProviderRegistry,
  parseModelId,
  type ChainLink,
  type ResolvedModelHint,
} from "./providers.js";
import {
  callNativeAnthropic,
  callNativeAnthropicText,
  extractEmitToolInput,
  streamNativeAnthropicText,
  NativeSchemaError,
  type NativeCallOptions,
  type NativeStreamPart,
} from "./anthropic-native.js";
import {
  batchSchemaToJson,
  buildBatchParams,
  type BatchItemResult,
  type ReconcileResult,
  type SubmitBatchOptions,
  type SubmitBatchResult,
} from "./batch.js";
import {
  buildEmbeddingModel,
  mockEmbedding,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDER_IDS,
  parseEmbeddingModelId,
  type EmbedOptions,
  type EmbedResult,
} from "./embeddings.js";
import type { PolicyModel, PolicyReport } from "./policy.js";
import { PRICING_STALE_AFTER_DAYS } from "./providers.js";
import { TaskRouter } from "./tasks.js";
import { missingPlaceholders, renderTemplate } from "./template.js";
import type {
  GatewayConfig,
  JudgeConfig,
  ObservabilityHooks,
  PromptDefault,
  ProviderId,
  SpendCapEvent,
  JudgeScore,
  UsageEntry,
  StoredPrompt,
  RoutedBy,
  SlugTierModels,
} from "./types.js";
import {
  MemoryCacheStore,
  MemoryPromptStore,
  MemoryRateLimiter,
  MemoryUsageStore,
} from "./adapters/memory.js";

const SNAPSHOT_LIMIT = 2000;
// Streaming clocks. Silence for a minute is never legitimate; a stream that
// is actively producing tokens is never cut off by these.
// See docs/design/timeouts-and-deadlines.md.
const DEFAULT_STREAM_FIRST_CHUNK_MS = 60_000;
const DEFAULT_STREAM_STALL_MS = 60_000;
// Per-attempt bound on a unary provider call. Making this configurable is
// stage S3 of docs/design/timeouts-and-deadlines.md; today it matches the
// value the AI SDK paths have always used, now applied to the native path too.
const DEFAULT_ATTEMPT_MS = 60_000;
const DEFAULT_USER_CAP_CENTS = 200; // unset = conservative default, NOT uncapped
const DEFAULT_ANON_CAP_CENTS = 100;
const DEFAULT_GLOBAL_CAP_CENTS = 5000; // app-wide circuit breaker
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24;

/**
 * The slug's tier and fallback pins, merged per field: a stored row's own
 * value wins, and where the row leaves a field null or absent the code
 * default's applies. Without that, an adopter's existing rows (which have no
 * such column) would silently cancel a code default's pins. `tierModels`
 * counts only when it names both models.
 */
function slugPins(
  row: StoredPrompt | undefined,
  def: PromptDefault | undefined,
): { tierModels?: SlugTierModels; fallbackModels?: string[] } {
  const both = (t: SlugTierModels | null | undefined) => (t?.fast && t?.power ? t : undefined);
  const tierModels = both(row?.tierModels) ?? both(def?.tierModels);
  const fallbackModels = row?.fallbackModels ?? def?.fallbackModels;
  return {
    ...(tierModels ? { tierModels } : {}),
    ...(fallbackModels?.length ? { fallbackModels } : {}),
  };
}

const taskRoute = (source: "override" | "default"): RoutedBy =>
  source === "override" ? "task-override" : "task-default";

function truncate(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > SNAPSHOT_LIMIT ? text.slice(0, SNAPSHOT_LIMIT) + "...[truncated]" : text;
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
  /** Whole-operation clock; supplies each attempt's signal. */
  budget: AttemptBudget = new AttemptBudget(),
  attemptMs = DEFAULT_ATTEMPT_MS,
  /** For error messages only. */
  who: { provider: string; model: string } = { provider: "unknown", model: "unknown" },
  /** Which errors retry on the same link (GatewayConfig.isRetryable). */
  retryable: (err: unknown) => boolean = isRetryable,
): Promise<AttemptResult<O>> {
  let currentPrompt = prompt;
  let repaired = false;
  let transientRetries = 0;
  for (;;) {
    throwIfOutOfBudget(budget, "before-retry");
    // Fresh window per attempt: a retry deserves a full one, not the remains
    // of the previous attempt's.
    const attempt = budget.attempt(attemptMs);
    try {
      const res = await generateObject({
        model,
        schema: zodSchema,
        prompt: currentPrompt,
        ...(system ? { system } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        abortSignal: attempt.signal,
      });
      return {
        object: res.object as O,
        usage: {
          inputTokens: res.usage.inputTokens ?? 0,
          outputTokens: res.usage.outputTokens ?? 0,
        },
      };
    } catch (err) {
      // Our own clock fired. Distinguish by construction, never by sniffing
      // the SDK's abort error (Rule 5).
      if (attempt.timedOut()) {
        // A blown deadline is terminal; a merely slow link is the chain's
        // problem, and is never retried on the same link (Rule 4).
        throwIfOutOfBudget(budget, "in-flight");
        throw new AttemptTimeoutError(who.provider, who.model, attemptMs);
      }
      if (budget.callerSignal?.aborted) throw budget.callerSignal.reason;
      if (isSchemaValidationError(err) && !repaired) {
        repaired = true;
        const detail = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
        currentPrompt =
          prompt +
          "\n\nIMPORTANT: Your previous response failed schema validation with this error:\n" +
          detail +
          "\nRespond again with ONLY JSON that satisfies the schema exactly.";
        continue;
      }
      if (!retryable(err) || transientRetries >= 2) throw err;
      await sleep(budget.clampDelay(backoffMs(transientRetries, err)), budget.callerSignal);
      transientRetries++;
    } finally {
      attempt.dispose();
    }
  }
}

/** Throws DeadlineExceededError when the budget is spent. No-op if unbounded. */
function throwIfOutOfBudget(
  budget: AttemptBudget,
  phase: "before-link" | "before-retry" | "in-flight",
): void {
  if (budget.deadlineMs === undefined) return;
  // Rule 2: refuse to open a connection the budget cannot see through, since
  // a half-open provider call may still bill.
  if (!budget.canStartAttempt() || budget.expired()) {
    throw new DeadlineExceededError(budget.deadlineMs, budget.elapsedMs(), phase);
  }
}

interface PromptConfig {
  body: string;
  modelHint?: string;
  providerOverride?: string;
  temperature?: number;
  tierModels?: SlugTierModels;
  fallbackModels?: string[];
}

/** A chain link that remembers which resolution layer put it there. */
type RoutedLink = ChainLink & { routedBy: RoutedBy };

/** The options every governed unary/stream call shares; what `frontDoor` reads. */
interface FrontDoorOptions<I> {
  slug: string;
  input: I;
  variables: (input: I) => Record<string, string>;
  promptBody?: string;
  cacheParts?: string[];
  cache?: boolean;
  userId?: string;
  anonKey?: string;
  route?: string;
  app?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
  task?: string;
  requireZdr?: boolean;
  temperature?: number;
  system?: string;
  run?: GovernedRun;
}

/** Where a call sits in a governed run. undefined = the call carries no run. */
type Lineage =
  | {
      run: GovernedRun;
      stepIndex: number;
      /**
       * Set by a path that writes several rows over the life of one call (a
       * streamText tool loop). logUsage adds each row's cost here in the same
       * tick it adds it to the run, so the loop's budget check can tell which
       * of its steps the run has already been charged for.
       */
      turn?: { ledgeredCents: number };
    }
  | undefined;

/**
 * What a path hands to `logUsage`. `lineage` is REQUIRED (though it may be
 * undefined) so that a new ledger write cannot forget to say which run it
 * belongs to: the compiler finds every site. The lineage columns themselves
 * are stamped by `logUsage`, never by a path.
 */
type LedgerRow = Omit<UsageEntry, "createdAt" | "runId" | "stepIndex" | "parentRunId"> & {
  lineage: Lineage;
};

/** What `frontDoor` hands back to a path once the governance checks passed. */
interface FrontDoor<V> {
  /** The call's place in its run, for every row the path writes. */
  lineage: Lineage;
  traceId: string;
  orgId: string | undefined;
  requireZdr: boolean;
  /** The slug's model pins; undefined unless `slugPinWins` is on. */
  pins: PromptConfig | undefined;
  /** null when caching is off for this call. */
  key: string | null;
  /** The rendered prompt, after any pre-guardrail transform. */
  prompt: string;
  promptConfig: PromptConfig;
  temperature: number | undefined;
  /** Pre verdicts so far; the path appends its post verdict. */
  guardrailRecords: GuardrailRecord[];
  failOpen: boolean;
  /** Set on a cache hit: the value to return (post-transformed) and its row. */
  cached?: { value: V; usageLogId: string | number };
}

export interface RunStructuredOptions<I, O> {
  /**
   * The governed run this call belongs to (`gateway.startRun()`). The call
   * becomes one step of the run: every usage row it writes carries the run's
   * lineage, its spend counts against the run's budget, and it is refused
   * with `RunLimitError` when the run is out of budget or steps.
   */
  run?: GovernedRun;
  /** Caller-defined attribution logged on every usage row this call writes
   *  (including cache hits and the judge). The gateway never reads it — it is
   *  not part of the cache key and never affects routing. */
  metadata?: Record<string, unknown>;
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
   *
   * **Applies to chain links only, not to `task`.** Tier substitution happens
   * in `buildChain`, which every chain branch calls and no task branch does —
   * a task resolves through `TaskRouter.chainForTask(task, orgId)`, which
   * takes no tier, and its models are built verbatim. Passing `tier` beside
   * `task` does not change which model the task resolves to.
   *
   * **It is still passed to `ModelConfigStore.getOverride(orgId, tier)`.**
   * That is not incidental: a store implementing the pattern this parameter
   * was added for returns `null` when a tier is set, so an explicit
   * capability request falls through to the task/chain instead of being
   * silently downgraded by an admin pin. For such a store, `tier` alongside
   * `task` is load-bearing — removing it as "redundant" makes the store hand
   * back the pin, and the pin outranks the task, so every named call site
   * quietly stops using its task default for as long as a pin row exists.
   * Nothing errors, and it only reproduces when a pin is set.
   */
  tier?: "fast" | "power";
  /**
   * Named task from GatewayConfig.tasks — routes to the task's model
   * (admin-store override → code default). Precedence when set:
   * modelConfig.getOverride() > task > chain > static default. With
   * `tasks.overridesBeatPin`, a task's store entry outranks the pin.
   */
  task?: string;
  /**
   * Require zero-data-retention routing for this call: only links asserted
   * ZDR in ProviderConfig.retention are eligible; chains SKIP non-eligible
   * links and error only when none remain. Also set per task via
   * TaskRoutingConfig.constraints.
   */
  requireZdr?: boolean;
  userId?: string;
  anonKey?: string;
  route?: string;
  /**
   * Caller cancellation (request teardown, client disconnect). Aborts the
   * in-flight provider call. Composed with the gateway's own per-attempt
   * bound; whichever fires first wins.
   */
  signal?: AbortSignal;
  /**
   * Tenant this call belongs to. Scopes the ledger, spend caps, cache key,
   * chain, prompt and task overrides. Falls back to GatewayConfig.orgId;
   * unset on both = unscoped, i.e. single-tenant behavior.
   */
  orgId?: string;
  /** Bound on one provider attempt. Overrides GatewayConfig.timeouts. */
  attemptMs?: number;
  /**
   * Bound on this whole call: every chain link, retry and backoff sleep.
   * Overrides GatewayConfig.timeouts. Unbounded when neither is set.
   */
  deadlineMs?: number;
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

/** One link abandoned mid-stream, in the order it was abandoned. */
export interface StreamFailover {
  provider: string;
  model: string;
  /** Why the link was abandoned. */
  reason: "stall" | "retryable";
  /**
   * True when this link had already emitted partials before it failed.
   * The degradation contract that matters to a UI: the next link restarts
   * the object, so a consumer rendering partials will see the object rebuild
   * rather than continue. Each partial is a complete snapshot, so no
   * information is lost — but the sequence is not monotonic across a failover.
   */
  hadPartialOutput: boolean;
}

export interface StreamStructuredResult<O> {
  /** true = served from cache; the stream emits the full object once. */
  cached: boolean;
  traceId: string;
  /** Progressively larger partials (single emission when cached/mocked). */
  partialObjectStream: AsyncIterable<Partial<O>>;
  /** Resolves AFTER usage logging and cache write complete. */
  object: Promise<O>;
  /**
   * Links abandoned before the one that produced this stream, in order.
   * Populated as failover happens, so read it after `object` settles.
   * Empty on the cache and mock paths.
   */
  failovers: StreamFailover[];
}

/** Appended to a streamText turn that fails after its point of no return. */
export const DEFAULT_DEGRADED_NOTICE =
  "Sorry, I lost my connection partway through that answer. Please try again.";

export interface StreamTextOptions {
  /**
   * The governed run this call belongs to (`gateway.startRun()`). The call
   * becomes one step of the run: every usage row it writes carries the run's
   * lineage, its spend counts against the run's budget, and it is refused
   * with `RunLimitError` when the run is out of budget or steps.
   *
   * The whole turn is one step of the run, however many tool-loop steps the
   * AI SDK takes inside it. Inside that loop the run still governs: when you
   * pass `stopWhen`, a budget condition joins it and stops the loop after
   * the step that spends the run's budget (`result.runStopped`), and each
   * completed tool step is ledgered as soon as it finishes
   * (`metadata.innerStep`), with the closing row carrying only what is left.
   */
  run?: GovernedRun;
  /** Names the call: routing, ledger, guardrails, ZDR. Required. */
  slug: string;
  /** Caller-assembled system prompt; the gateway does not render it. */
  system?: string;
  /** Must end with a user message. */
  messages: ModelMessage[];
  /** Passed through; the AI SDK executes them. */
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  tier?: "fast" | "power";
  task?: string;
  orgId?: string;
  /** Identity and cap scope: same semantics as RunTextOptions. */
  userId?: string;
  anonKey?: string;
  route?: string;
  app?: string;
  temperature?: number;
  requireZdr?: boolean;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  /** Overrides DEFAULT_DEGRADED_NOTICE. */
  degradedNotice?: string;
  /**
   * Stream Anthropic links natively (web search, thinking, system-prompt
   * caching) via GatewayConfig.anthropic. Text messages only, and not
   * combinable with `tools`. Non-Anthropic links in the chain stream through
   * the AI SDK without these features.
   */
  anthropic?: NativeCallOptions;
  /** Time allowed to the first stream part. Overrides GatewayConfig.timeouts. */
  streamFirstChunkMs?: number;
  /** Time allowed between parts (paused while a tool runs). */
  streamStallMs?: number;
  /**
   * Bound on the whole turn, tools included (the stall clock is paused while
   * a tool runs, so this is the only bound on tool runtime). Overrides
   * GatewayConfig.timeouts.deadlineMs.
   */
  deadlineMs?: number;
}

export interface StreamTextOutcome {
  /** Everything the user saw, notice included (post-guardrail transform applied). */
  text: string;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  model: string;
  degraded: boolean;
  failovers: StreamFailover[];
  /**
   * Set when the call carried a governed run and the run's budget (or an
   * ancestor's) ran out inside the tool loop: the loop was stopped after a
   * tool step instead of calling the model again. `text` and `toolResults`
   * hold what was produced; the model did not get to answer from the last
   * tool results. `runId` is the run that ran out. The run's next call is
   * refused with `RunLimitError`.
   */
  runStopped?: { limit: "budget"; runId: string };
  /**
   * Tool calls the loop asked for that were not run: a `ToolPolicy` limit,
   * the run's budget, or a `guardrails.tool` block. The model was told and
   * the turn went on. Absent when none were denied.
   */
  toolDenials?: ToolDenial[];
}

/**
 * `generateText` takes what `streamText` takes, minus the notice shown to a
 * user watching a stream that fails: there is no stream to end.
 */
export type GenerateTextOptions = Omit<StreamTextOptions, "degradedNotice">;

/**
 * What a `generateText` turn produced. The same record `streamText` resolves
 * `result` with, plus the trace id. There is no `degraded`: a turn that fails
 * after a tool has run rejects instead of resolving with a notice.
 */
export type GenerateTextResult = Omit<StreamTextOutcome, "degraded"> & { traceId: string };

export interface StreamTextResult {
  traceId: string;
  /**
   * Text deltas. A provider failure after the point of no return ends the
   * stream with the degraded notice, not an error. It throws on a caller
   * abort, or when no link produced output.
   */
  textStream: AsyncIterable<string>;
  /** Resolves AFTER the ledger row is written. */
  result: Promise<StreamTextOutcome>;
}

/** Plain text of a message: string content, or its text parts joined. */
function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") return m.content;
  return (m.content as { type: string; text?: string }[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

/** The SDK's fullStream minus its own "start" part, which it emits before the
 *  model responds and would otherwise disarm the first-chunk clock. */
async function* modelParts<T extends { type: string }>(src: AsyncIterable<T>): AsyncGenerator<T> {
  for await (const p of src) if (p.type !== "start") yield p;
}

/** `m` with its text replaced by `text`, keeping any image/file parts. */
function withText(m: ModelMessage, text: string): ModelMessage {
  if (typeof m.content === "string") return { ...m, content: text } as ModelMessage;
  const parts = m.content as { type: string }[];
  const at = parts.findIndex((p) => p.type === "text");
  const rest = parts.filter((p) => p.type !== "text");
  rest.splice(at < 0 ? 0 : Math.min(at, rest.length), 0, { type: "text", text } as never);
  return { ...m, content: rest } as ModelMessage;
}

/** A part streamText's loop reads: the AI SDK's, or the native path's. */
type StreamPart = TextStreamPart<ToolSet> | NativeStreamPart;
type NativeExtras = { cacheCreateTokens: number; cacheReadTokens: number; webSearches: number };

/** ModelMessages as Anthropic text messages; the native stream is text-only. */
function nativeMessages(
  messages: ModelMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return messages.map((m) => {
    const textOnly =
      typeof m.content === "string" ||
      (m.content as { type: string }[]).every((p) => p.type === "text");
    if ((m.role !== "user" && m.role !== "assistant") || !textOnly) {
      throw new Error(
        "streamText: `anthropic` native streaming takes text user/assistant messages only",
      );
    }
    return { role: m.role, content: messageText(m) };
  });
}

async function* singleEmission<T>(value: T): AsyncGenerator<T> {
  yield value;
}

export interface RunTextOptions<I> {
  /**
   * The governed run this call belongs to (`gateway.startRun()`). The call
   * becomes one step of the run: every usage row it writes carries the run's
   * lineage, its spend counts against the run's budget, and it is refused
   * with `RunLimitError` when the run is out of budget or steps.
   */
  run?: GovernedRun;
  /** Caller-defined attribution logged on every usage row this call writes
   *  (including cache hits and the judge). The gateway never reads it — it is
   *  not part of the cache key and never affects routing. */
  metadata?: Record<string, unknown>;
  slug: string;
  input: I;
  variables: (input: I) => Record<string, string>;
  /** Inline prompt body — skips the prompt store/defaults lookup. */
  promptBody?: string;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  cacheParts?: string[];
  cache?: boolean;
  /** See RunStructuredOptions.tier — same semantics, same interaction with
   *  `task` and with ModelConfigStore.getOverride. */
  tier?: "fast" | "power";
  task?: string;
  requireZdr?: boolean;
  userId?: string;
  anonKey?: string;
  route?: string;
  app?: string;
  /**
   * Caller cancellation (request teardown, client disconnect). Aborts the
   * in-flight provider call. Composed with the gateway's own per-attempt
   * bound; whichever fires first wins.
   */
  signal?: AbortSignal;
  /**
   * Tenant this call belongs to. Scopes the ledger, spend caps, cache key,
   * chain, prompt and task overrides. Falls back to GatewayConfig.orgId;
   * unset on both = unscoped, i.e. single-tenant behavior.
   */
  orgId?: string;
  /** Bound on one provider attempt. Overrides GatewayConfig.timeouts. */
  attemptMs?: number;
  /**
   * Bound on this whole call: every chain link, retry and backoff sleep.
   * Overrides GatewayConfig.timeouts. Unbounded when neither is set.
   */
  deadlineMs?: number;
  /** Native Anthropic options (web search, thinking, cacheSystem). Applies
   *  on anthropic chain links when GatewayConfig.anthropic is configured;
   *  non-anthropic links in the same chain run the plain AI SDK path, so a
   *  grounded call can still fail over to an ungrounded link rather than
   *  fail outright. */
  anthropic?: NativeCallOptions;
}

export interface RunTextResult {
  text: string;
  /** AI SDK finishReason ("stop", "length", ...). Absent for cache/mock. */
  finishReason?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  traceId: string;
  cacheHit: boolean;
  usageLogId?: string | number;
  /** Server-side web searches the answer used (native Anthropic path). */
  webSearches?: number;
}

const JUDGE_SNIPPET_LIMIT = 4000;
// The judge runs in the request path, so its clock is short and its own.
const JUDGE_DEADLINE_MS = 15_000;

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

/**
 * Cache key. `orgId` namespaces the entry so two tenants asking the same
 * question never see each other's cached answer — a cache hit across a tenant
 * boundary would be a data leak, not just a governance slip.
 *
 * Unscoped keys keep their exact pre-multi-tenant shape, so an existing cache
 * survives the upgrade rather than silently missing on every read.
 */
export function cacheKey(
  slug: string,
  parts: string[],
  orgId?: string | null,
  /** See promptFingerprint. Omitted = the exact pre-0.13 key shape. */
  promptFp?: string,
): string {
  const hash = createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
  const base = orgId ? `aicache:org:${orgId}:${slug}:${hash}` : `aicache:${slug}:${hash}`;
  return promptFp ? `${base}:p${promptFp}` : base;
}

/**
 * Fingerprint of a resolved prompt, for the cache key.
 *
 * Hashing the prompt rather than carrying a version number on `StoredPrompt`
 * is deliberate. A version field is only correct while every writer remembers
 * to bump it, and a writer that forgets reintroduces exactly the bug this
 * closes — silently, which is the property that made the bug expensive. A hash
 * cannot go stale. It also needs nothing of the SPI, so every hand-written
 * PromptStore keeps working untouched.
 *
 * It covers more than the body: `modelHint`, `providerOverride` and
 * `temperature` all change what the model returns, so an admin who repoints a
 * prompt at a different model must invalidate too. A body-only version would
 * miss that.
 */
export function promptFingerprint(cfg: {
  body: string;
  modelHint?: string;
  providerOverride?: string;
  temperature?: number;
  tierModels?: SlugTierModels;
  fallbackModels?: string[];
}): string {
  const hash = createHash("sha256")
    .update(cfg.body)
    .update("\u0000")
    .update(cfg.modelHint ?? "")
    .update("\u0000")
    .update(cfg.providerOverride ?? "")
    .update("\u0000")
    .update(cfg.temperature === undefined ? "" : String(cfg.temperature));
  // The slug's other pins change the model too. Hashed only when present, so
  // a prompt that sets neither keeps the fingerprint (and the cache) it had.
  if (cfg.tierModels || cfg.fallbackModels?.length) {
    hash
      .update("\u0000")
      .update(cfg.tierModels ? `${cfg.tierModels.fast}\u0001${cfg.tierModels.power}` : "")
      .update("\u0000")
      .update((cfg.fallbackModels ?? []).join("\u0001"));
  }
  return hash.digest("hex").slice(0, 12);
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
  private readonly retryable: (err: unknown) => boolean;
  private readonly appId: string | null;
  private readonly cacheTtlSeconds: number;
  private readonly timeouts: GatewayConfig["timeouts"];
  private readonly scopeCacheToPrompt: boolean;
  private readonly orgId: string | undefined;
  private readonly encrypt?: (t: string) => string;
  private readonly judgeDefaults?: GatewayConfig["judge"];
  private readonly guardrails?: GuardrailConfig;
  private readonly toolPolicy?: Record<string, ToolPolicy>;
  private readonly warnedUnpricedTools = new Set<string>();
  private readonly anthropicCfg?: GatewayConfig["anthropic"];
  private readonly batchCfg?: GatewayConfig["batch"];
  private readonly mockResponders = new Map<string, MockResponder>();
  private readonly obs?: ObservabilityHooks;
  private readonly obsWarned = new Set<string>();
  private readonly slugPinWins: boolean;
  private readonly zdrSlugs: ReadonlySet<string>;
  private readonly badModelHintWarned = new Set<string>();

  constructor(cfg: GatewayConfig) {
    this.usage = cfg.usage;
    this.cache = cfg.cache ?? new MemoryCacheStore();
    this.rateLimiter = cfg.rateLimiter ?? new MemoryRateLimiter();
    this.promptDefaults = cfg.promptDefaults ?? [];
    this.prompts = cfg.prompts ?? new MemoryPromptStore();
    this.modelConfig = cfg.modelConfig;
    this.registry = new ProviderRegistry(cfg.providers);
    this.tasks = cfg.tasks
      ? new TaskRouter(cfg.tasks, (id) => this.registry.parseAny(id))
      : undefined;
    this.caps = cfg.caps ?? {};
    this.mock = cfg.mock ?? false;
    this.retryable = cfg.isRetryable ?? isRetryable;
    this.appId = cfg.appId ?? null;
    this.cacheTtlSeconds = cfg.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.timeouts = cfg.timeouts;
    this.scopeCacheToPrompt = cfg.invalidateCacheOnPromptChange === true;
    this.orgId = cfg.orgId;
    this.encrypt = cfg.encrypt;
    this.judgeDefaults = cfg.judge;
    this.guardrails = cfg.guardrails;
    this.toolPolicy = cfg.toolPolicy;
    this.anthropicCfg = cfg.anthropic;
    this.batchCfg = cfg.batch;
    this.obs = cfg.observability;
    this.slugPinWins = cfg.slugPinWins === true;
    this.zdrSlugs = new Set(cfg.zdr?.slugs ?? []);
  }

  /** Fire an observability hook without letting it break the request path:
   *  sync throws and async rejections are swallowed, warned once per hook. */
  private emitObs<T>(
    name: string,
    fn: ((payload: T) => void | Promise<void>) | undefined,
    payload: T,
  ): void {
    if (!fn) return;
    const warn = (err: unknown) => {
      if (this.obsWarned.has(name)) return;
      this.obsWarned.add(name);
      console.warn(
        `[llm-gateway] observability hook ${name} failed (further failures suppressed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    };
    try {
      const r = fn(payload);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(warn);
      }
    } catch (err) {
      warn(err);
    }
  }

  /** Resolve `promptConfig.modelHint` to a literal model id, warning once per
   *  distinct rejected (provider, hint) pair — the same string can be valid
   *  for one provider and rejected for another, and the message names the
   *  provider, so deduping on the hint alone would silence the second case
   *  entirely. See `ProviderRegistry.resolveModelHint` for why this check
   *  exists and what it does and does not reject. */
  private validatedModelHint(
    hint: string | undefined,
    provider?: ProviderId,
  ): ResolvedModelHint | undefined {
    if (!hint) return undefined;
    const resolved = this.registry.resolveModelHint(hint, provider);
    const warnKey = `${provider ?? "*"}\u0000${hint}`;
    if (resolved === undefined && !this.badModelHintWarned.has(warnKey)) {
      this.badModelHintWarned.add(warnKey);
      console.warn(
        `[llm-gateway] promptConfig.modelHint "${hint}" is not usable as a model id` +
          (provider ? ` for provider "${provider}"` : "") +
          ` — ignoring it and using the configured default model instead. That means this ` +
          `call runs a DIFFERENT model than the prompt asked for. If "${hint}" is a cost ` +
          `tier rather than a literal model id, resolve it to a real model id before it ` +
          `reaches the Gateway.`,
      );
    }
    return resolved;
  }

  /**
   * Link resolution shared by the streaming paths: admin pin (single, hard
   * pin) > task chain > config chain > default, then the ZDR filter.
   */
  private async resolveStreamLinks(
    orgId: string | undefined,
    opts: { slug: string; tier?: "fast" | "power"; task?: string },
    requireZdr: boolean,
    /** The slug's model pins (`FrontDoor.pins`). */
    pins: PromptConfig | undefined,
    /** Keep these providers' links even with no AI SDK key (native path). */
    keepKeyless?: ProviderId[],
  ): Promise<RoutedLink[]> {
    // The slug's own chain outranks everything below (slugPinWins).
    const pinned = await this.slugChain({
      slug: opts.slug,
      pins,
      tier: opts.tier,
      orgId,
      requireZdr,
      ...(keepKeyless ? { keepKeyless } : {}),
    });
    if (pinned) return pinned;

    const adminOverride = await this.adminPin(orgId, opts.tier, opts.task);
    let links: RoutedLink[];
    if (adminOverride) {
      links = [{ ...this.registry.resolveDefault(adminOverride), routedBy: "admin-pin" }];
    } else if (opts.task && this.tasks) {
      const taskChain = await this.tasks.chainForTask(opts.task, orgId);
      links = taskChain.map((t) => ({
        provider: t.provider,
        model: t.model,
        languageModel: this.registry.buildAny(t.provider, t.model) ?? undefined,
        routedBy: taskRoute(t.source),
      }));
    } else {
      const chainCfg = (await this.modelConfig?.getChain(orgId)) ?? [];
      const built = this.registry.buildChain(chainCfg, opts.tier, keepKeyless);
      links =
        built.length > 0
          ? built.map((l) => ({ ...l, routedBy: "chain" as const }))
          : [{ ...this.registry.resolveDefault(), routedBy: "default" }];
    }
    if (requireZdr) {
      const eligible = links.filter((l) => this.registry.isZdr(l.provider, l.model));
      if (eligible.length === 0) {
        throw new ZdrViolationError(links[0]!.provider, links[0]!.model, "streaming chain");
      }
      links = eligible;
    }
    return links;
  }

  /** Per call > gateway config > unscoped. */
  private org(opts?: { orgId?: string }): string | undefined {
    return opts?.orgId ?? this.orgId;
  }

  /**
   * One whole-operation clock per governed call. Precedence matches every
   * other knob: per call > config > built-in default. `deadlineMs` has no
   * built-in default — unbounded is the pre-S4 behavior and stays the default.
   */
  private newBudget(opts: { signal?: AbortSignal; attemptMs?: number; deadlineMs?: number }): {
    budget: AttemptBudget;
    attemptMs: number;
  } {
    const deadlineMs = opts.deadlineMs ?? this.timeouts?.deadlineMs;
    return {
      budget: new AttemptBudget(deadlineMs, opts.signal),
      attemptMs: opts.attemptMs ?? this.timeouts?.attemptMs ?? DEFAULT_ATTEMPT_MS,
    };
  }

  /**
   * Ledger an attempt that was cut short by our own clock.
   *
   * Rule 1 in spirit: a provider call that may have spent money leaves an
   * audit trail even though nothing usable came back. Zero tokens, zero cost —
   * the row exists so a chronically slow provider shows up in the data the
   * cost page already reads, not only in logs.
   *
   * Deliberately NOT called for a caller abort: a client disconnect is the
   * caller's own choice and carries no signal about the provider, so it would
   * add rows with no cost information to every dashboard.
   */
  private async logAbortedAttempt(
    opts: {
      app?: string;
      userId?: string;
      route?: string;
      slug: string;
      orgId?: string;
      metadata?: Record<string, unknown>;
      lineage: Lineage;
    },
    provider: string,
    model: string,
    traceId: string,
    durationMs: number,
    prompt: string,
  ): Promise<void> {
    await this.logUsage({
      metadata: opts.metadata,
      orgId: opts.orgId,
      app: opts.app,
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: opts.slug,
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 0,
      cacheHit: false,
      traceId,
      durationMs,
      inputText: prompt,
      outputText: null,
      lineage: opts.lineage,
    });
  }

  private async recordCapEvent(event: SpendCapEvent): Promise<void> {
    await this.usage.recordSpendCapEvent(event);
    this.emitObs("onSpendCapEvent", this.obs?.onSpendCapEvent, event);
  }

  private async saveJudge(score: JudgeScore): Promise<void> {
    await this.usage.saveJudgeScore(score);
    this.emitObs("onJudgeScore", this.obs?.onJudgeScore, score);
  }

  // ===========================================================================
  // Governed embeddings — same front door (rate limit, caps, ZDR, ledger).
  // Embedding spend at document-pipeline volume is real money; it must not
  // bypass governance just because it isn't chat.
  // ===========================================================================

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    const traceId = randomUUID();
    const orgId = this.org(opts);
    if (texts.length === 0) {
      return {
        embeddings: [],
        provider: "none",
        model: "none",
        inputTokens: 0,
        traceId,
      };
    }
    const identifier = opts.userId ?? (opts.anonKey ? `anon:${opts.anonKey}` : "anon");
    const rl = await this.rateLimiter.limit(identifier);
    if (!rl.success) throw new RateLimitError(rl.limit, rl.remaining);
    await this.checkSpendCap(opts.userId, opts.route, 0, orgId);
    const lineage = await this.enterRun(opts.run, {
      traceId,
      orgId,
      userId: opts.userId,
      route: opts.route,
      app: opts.app,
      slug: null,
      metadata: opts.metadata,
    });

    const modelId = opts.model ?? DEFAULT_EMBEDDING_MODEL;
    const { provider, model } = parseEmbeddingModelId(modelId, (id) => this.registry.parseAny(id));
    if (opts.requireZdr && !this.mock && !this.registry.isZdr(provider, model)) {
      throw new ZdrViolationError(provider, model, "embed");
    }

    let embeddings: number[][];
    let inputTokens: number;
    let usedProvider = provider;
    let usedModel = model;

    if (this.mock) {
      const dims = opts.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
      embeddings = texts.map((t) => mockEmbedding(t, dims));
      inputTokens = texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
      usedProvider = "mock";
      usedModel = "mock";
    } else {
      const em = opts.embeddingModel ?? buildEmbeddingModel(this.registry, provider, model);
      if (!em) {
        throw new Error(
          `embed: no embedding model for "${provider}/${model}". Natively supported: ` +
            `${EMBEDDING_PROVIDER_IDS.map((p) => `${p}:*`).join(", ")} ` +
            `(each needs its API key in config or env). Pass opts.embeddingModel for anything else.`,
        );
      }
      // Bounded like every other provider call, rather than relying on the
      // caller to pass a signal. embed() is single-shot, so the attempt bound
      // is the whole bound.
      const embedAttempt = new AttemptBudget(
        opts.deadlineMs ?? this.timeouts?.deadlineMs,
        opts.signal,
      ).attempt(opts.attemptMs ?? this.timeouts?.attemptMs ?? DEFAULT_ATTEMPT_MS);
      let res: Awaited<ReturnType<typeof embedMany>>;
      try {
        res = await embedMany({
          model: em,
          values: texts,
          // The AI SDK's own maxRetries (default 2) is left alone: embed() has
          // no gateway-level retry loop, so it is the only one there is.
          abortSignal: embedAttempt.signal,
          ...(opts.dimensions !== undefined
            ? { providerOptions: { openai: { dimensions: opts.dimensions } } }
            : {}),
        });
      } catch (err) {
        if (embedAttempt.timedOut()) {
          throw new AttemptTimeoutError(
            usedProvider,
            usedModel,
            opts.attemptMs ?? this.timeouts?.attemptMs ?? DEFAULT_ATTEMPT_MS,
          );
        }
        throw err;
      } finally {
        embedAttempt.dispose();
      }
      embeddings = res.embeddings as number[][];
      inputTokens = res.usage?.tokens ?? texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
    }

    const usageLogId = await this.logUsage({
      metadata: opts.metadata,
      orgId,
      app: opts.app,
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: null,
      provider: usedProvider,
      model: usedModel,
      inputTokens,
      outputTokens: 0,
      estimatedCostCents: this.registry.estimateForLink(usedProvider, usedModel, inputTokens, 0),
      cacheHit: false,
      traceId,
      zdrEnforced: opts.requireZdr ? true : null,
      lineage,
    });

    return {
      embeddings,
      provider: usedProvider,
      model: usedModel,
      inputTokens,
      traceId,
      usageLogId,
    };
  }

  // ===========================================================================
  // Governed TEXT generation — same front door as runStructured, generateText
  // body. Added for adopters whose call sites are text-first (summaries,
  // JSON-by-convention parsing done caller-side). No schema repair (nothing
  // to validate); chain failover on transient errors only.
  // ===========================================================================

  async runText<I>(opts: RunTextOptions<I>): Promise<RunTextResult> {
    // A post transform on the text path must hand back text.
    const validate = (raw: unknown): string => {
      if (typeof raw !== "string")
        throw new Error("a runText post hook must transform to a string");
      return raw;
    };
    const fd = await this.frontDoor<I, string>("runText", opts, validate);
    if (fd.cached) {
      return {
        text: fd.cached.value,
        provider: "cache",
        model: "cache",
        inputTokens: 0,
        outputTokens: 0,
        traceId: fd.traceId,
        cacheHit: true,
        usageLogId: fd.cached.usageLogId,
      };
    }
    const { traceId, orgId, requireZdr, key, prompt, temperature, guardrailRecords, failOpen } = fd;
    const { lineage } = fd;

    // Native features must never silently not apply (same rule as runStructured).
    if (opts.anthropic && !this.anthropicCfg && !this.mock) {
      throw new Error(
        "runText received `anthropic` native options but GatewayConfig.anthropic is not configured.",
      );
    }

    const { budget, attemptMs } = this.newBudget(opts);

    let text: string;
    let finishReason: string | undefined;
    let inputTokens: number;
    let outputTokens: number;
    let provider: string;
    let model: string;
    let routedBy: RoutedBy | undefined;
    let durationMs: number;
    let extras:
      | { cacheCreateTokens: number; cacheReadTokens: number; webSearches: number }
      | undefined;

    const attemptNativeText = async (
      linkProvider: string,
      linkModel: string,
      linkTemp?: number | null,
    ) => {
      const effTemp = linkTemp === null ? undefined : (linkTemp ?? temperature);
      for (let retry = 0; ; ) {
        throwIfOutOfBudget(budget, "before-retry");
        const attempt = budget.attempt(attemptMs);
        try {
          return await callNativeAnthropicText(this.anthropicCfg!, {
            model: linkModel,
            prompt,
            system: opts.system,
            ...(effTemp !== undefined ? { temperature: effTemp } : {}),
            ...(opts.maxOutputTokens !== undefined ? { maxTokens: opts.maxOutputTokens } : {}),
            native: opts.anthropic!,
            signal: attempt.signal,
          });
        } catch (err) {
          if (attempt.timedOut()) {
            throwIfOutOfBudget(budget, "in-flight");
            throw new AttemptTimeoutError(linkProvider, linkModel, attemptMs);
          }
          if (budget.callerSignal?.aborted) throw budget.callerSignal.reason;
          if (!this.retryable(err) || retry >= 2) throw err;
          await sleep(budget.clampDelay(backoffMs(retry, err)), budget.callerSignal);
          retry++;
        } finally {
          attempt.dispose();
        }
      }
    };

    const attemptText = async (
      linkProvider: string,
      linkModel: string,
      lm: LanguageModel,
      linkTemp?: number | null,
    ) => {
      const effTemp = linkTemp === null ? undefined : (linkTemp ?? temperature);
      for (let retry = 0; ; ) {
        throwIfOutOfBudget(budget, "before-retry");
        const attempt = budget.attempt(attemptMs);
        try {
          const res = await generateText({
            model: lm,
            prompt,
            ...(opts.system ? { system: opts.system } : {}),
            ...(effTemp !== undefined ? { temperature: effTemp } : {}),
            ...(opts.maxOutputTokens !== undefined
              ? { maxOutputTokens: opts.maxOutputTokens }
              : {}),
            abortSignal: attempt.signal,
          });
          return res;
        } catch (err) {
          if (attempt.timedOut()) {
            throwIfOutOfBudget(budget, "in-flight");
            throw new AttemptTimeoutError(linkProvider, linkModel, attemptMs);
          }
          if (budget.callerSignal?.aborted) throw budget.callerSignal.reason;
          if (!this.retryable(err) || retry >= 2) throw err;
          await sleep(budget.clampDelay(backoffMs(retry, err)), budget.callerSignal);
          retry++;
        } finally {
          attempt.dispose();
        }
      }
    };

    if (this.mock) {
      const responder = this.mockResponders.get(opts.slug);
      if (!responder) {
        throw new Error(`Mock mode is on but no responder registered for "${opts.slug}".`);
      }
      text = String(responder(opts.input));
      inputTokens = Math.ceil(prompt.length / 4);
      outputTokens = Math.ceil(text.length / 4);
      provider = "mock";
      model = "mock";
      durationMs = 0;
    } else {
      // The slug's own chain first, when the slug pins a model (slugPinWins);
      // otherwise single-link resolution + ZDR-filtered chain, parallel to
      // runStructured.
      const pinned = await this.slugChain({
        slug: opts.slug,
        pins: fd.pins,
        tier: opts.tier,
        orgId,
        requireZdr,
        ...(opts.anthropic && this.anthropicCfg ? { keepKeyless: ["anthropic" as const] } : {}),
      });
      const adminOverride = pinned ? null : await this.adminPin(orgId, opts.tier, opts.task);
      let links: {
        provider: string;
        model: string;
        languageModel?: LanguageModel;
        routedBy?: RoutedBy;
      }[];
      if (pinned) {
        links = pinned;
      } else if (adminOverride) {
        links = [{ ...this.registry.resolveDefault(adminOverride), routedBy: "admin-pin" }];
      } else if (opts.task && this.tasks) {
        // Per-task failover chain. A single-model task yields one link, which
        // is the pre-chain behavior; a task configured with an ordered chain
        // is walked by the same loop below that the main chain uses.
        const taskChain = await this.tasks.chainForTask(opts.task, orgId);
        links = taskChain.map((t) => ({
          provider: t.provider,
          model: t.model,
          languageModel: this.registry.buildAny(t.provider, t.model) ?? undefined,
          routedBy: taskRoute(t.source),
        }));
        // ZDR filtering now applies to task chains too. Previously task
        // routing collapsed to one link BEFORE this filter ran, so an
        // ineligible task model errored instead of skipping to an eligible one.
        if (requireZdr) {
          const eligible = links.filter((l) => this.registry.isZdr(l.provider, l.model));
          if (links.length > 0 && eligible.length === 0) {
            throw new ZdrViolationError(
              links[0]!.provider,
              links[0]!.model,
              `task "${opts.task}" chain`,
            );
          }
          links = eligible;
        }
      } else {
        const chainCfg = (await this.modelConfig?.getChain(orgId)) ?? [];
        const full = this.registry.buildChain(chainCfg, opts.tier);
        links =
          full.length > 0
            ? full.map((l) => ({ ...l, routedBy: "chain" as const }))
            : [{ ...this.registry.resolveDefault(), routedBy: "default" }];
        if (requireZdr) {
          const eligible = links.filter((l) => this.registry.isZdr(l.provider, l.model));
          if (links.length > 0 && eligible.length === 0) {
            throw new ZdrViolationError(links[0]!.provider, links[0]!.model, "runText chain");
          }
          links = eligible;
        }
      }
      if (
        links.length === 1 &&
        requireZdr &&
        !this.registry.isZdr(links[0]!.provider, links[0]!.model)
      ) {
        throw new ZdrViolationError(links[0]!.provider, links[0]!.model, "runText link");
      }

      const start = Date.now();
      let lastErr: unknown;
      let done = false;
      text = "";
      inputTokens = 0;
      outputTokens = 0;
      provider = "";
      model = "";
      durationMs = 0;
      for (const link of links) {
        const nativeApplies = opts.anthropic && link.provider === "anthropic" && this.anthropicCfg;
        if (!link.languageModel && !nativeApplies) {
          lastErr = new Error(
            `No API key for provider "${link.provider}" (and native execution does not apply).`,
          );
          continue;
        }
        // Rule 2: do not open a connection the budget cannot see through.
        throwIfOutOfBudget(budget, "before-link");
        try {
          if (nativeApplies) {
            const res = await attemptNativeText(
              link.provider,
              link.model,
              (link as ChainLink).temperature,
            );
            text = res.text;
            finishReason = res.finishReason;
            inputTokens = res.inputTokens;
            outputTokens = res.outputTokens;
            extras = {
              cacheCreateTokens: res.cacheCreateTokens,
              cacheReadTokens: res.cacheReadTokens,
              webSearches: res.webSearches,
            };
          } else {
            const res = await attemptText(
              link.provider,
              link.model,
              link.languageModel!,
              (link as ChainLink).temperature,
            );
            text = res.text;
            finishReason = res.finishReason;
            inputTokens = res.usage.inputTokens ?? 0;
            outputTokens = res.usage.outputTokens ?? 0;
            extras = undefined;
          }
          provider = link.provider;
          model = link.model;
          routedBy = link.routedBy;
          durationMs = Date.now() - start;
          done = true;
          break;
        } catch (err) {
          lastErr = err;
          // A blown deadline and a caller abort are terminal — no further
          // links, no "trying next" (Rule 4).
          if (err instanceof DeadlineExceededError) throw err;
          if (budget.callerSignal?.aborted) throw err;
          // Aligned with callWithChain as of S4: advance only on a retryable
          // error or an attempt timeout. Previously runText also fell through
          // on NON-retryable errors whenever the chain had more than one link,
          // so a 400 burned a call on the next provider too.
          const advance = this.retryable(err) || err instanceof AttemptTimeoutError;
          if (!advance) throw err;
          console.warn(
            `[llm-gateway] runText "${link.provider}/${link.model}" failed (${
              err instanceof AttemptTimeoutError ? "attempt-timeout" : "retryable"
            }), trying next link`,
          );
        }
      }
      if (!done) throw lastErr ?? new Error("runText: no provider produced a result");
    }

    // Post guardrail on the text, before the cache write. Same contract as
    // runStructured: a transform is what gets cached and returned; a block
    // writes the row with the spent tokens, then throws with the text attached.
    const textRow = () => ({
      lineage,
      metadata: opts.metadata,
      orgId,
      app: opts.app,
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: opts.slug,
      provider,
      model,
      routedBy,
      inputTokens,
      outputTokens,
      estimatedCostCents: this.registry.estimateForLink(
        provider,
        model,
        inputTokens,
        outputTokens,
        extras,
      ),
      cacheHit: false,
      traceId,
      durationMs,
      cacheCreateTokens: extras?.cacheCreateTokens ?? null,
      cacheReadTokens: extras?.cacheReadTokens ?? null,
      webSearches: extras?.webSearches ?? null,
      zdrEnforced: requireZdr ? true : null,
      inputText: prompt,
    });
    if (this.guardrails?.post) {
      const out = await this.applyPostGuardrail(
        this.postCtx(opts, prompt, traceId, orgId, text, provider, model),
        text,
        validate,
        failOpen,
        guardrailRecords,
      );
      text = out.value;
      if (out.blocked) {
        await this.logUsage({ ...textRow(), outputText: text, guardrails: guardrailRecords });
        throw guardrailError(out.blocked, text);
      }
    }

    if (key) await this.cache.set(key, text, this.cacheTtlSeconds);
    const usageLogId = await this.logUsage({
      ...textRow(),
      outputText: text,
      guardrails: guardrailRecords.length > 0 ? guardrailRecords : null,
    });

    return {
      text,
      finishReason,
      provider,
      model,
      inputTokens,
      outputTokens,
      traceId,
      cacheHit: false,
      usageLogId,
      ...(extras ? { webSearches: extras.webSearches } : {}),
    };
  }

  // ===========================================================================
  // Streaming — same governance front door, streamObject body.
  //
  // Failover: on a stall or a retryable mid-stream error the driver advances
  // to the next eligible link and continues. DEGRADATION CONTRACT:
  //   - Each link restarts the object, so a consumer rendering partials sees
  //     the object rebuild rather than continue. Every partial is a complete
  //     snapshot, so no information is lost, but the sequence is NOT monotonic
  //     across a failover. `result.failovers[].hadPartialOutput` says whether
  //     a given failover was visible to the consumer that way.
  //   - When the chain is exhausted, the LAST link's error surfaces on both
  //     the iterator and the object promise.
  //   - Every attempted link leaves a zero-token ledger row before the driver
  //     moves on, so an abandoned attempt is still audited.
  //   - A caller abort and a non-retryable error are terminal: no failover.
  // Remaining v1 constraints: no repair retry, no judge, no native-Anthropic
  // options on the streaming path.
  // ===========================================================================

  async streamStructured<I, O>(
    opts: Omit<RunStructuredOptions<I, O>, "judge" | "anthropic" | "schema"> & {
      schema: z.ZodType<O>;
      /**
       * Time allowed to the stream's FIRST emission. Default 60_000.
       * 0 disables. Overrides GatewayConfig.timeouts.
       */
      streamFirstChunkMs?: number;
      /**
       * Time allowed since the stream's LAST emission. Default 60_000.
       * 0 disables. A stream actively producing tokens never trips this.
       */
      streamStallMs?: number;
    },
  ): Promise<StreamStructuredResult<O>> {
    const validate = (raw: unknown): O => opts.schema.parse(raw);
    const fd = await this.frontDoor<I, O>("streamStructured", opts, validate);
    if (fd.cached) {
      return {
        cached: true,
        traceId: fd.traceId,
        partialObjectStream: singleEmission(fd.cached.value as Partial<O>),
        object: Promise.resolve(fd.cached.value),
        failovers: [],
      };
    }
    const { traceId, orgId, key, prompt, temperature, guardrailRecords, failOpen, lineage } = fd;
    // Which layer a row's model came from; set once the links are resolved.
    let routeOf = (_provider: string, _model: string): RoutedBy | undefined => undefined;

    // Post guardrail, cache write, usage row — once, for the link that
    // completed. A post block on a stream can only stop the FINAL object: the
    // partials were already visible to the consumer. The row is written with
    // the spent tokens and the block is returned (not thrown) so the driver
    // can tell a policy stop from a link failure; a block never fails over.
    const finalize = async (
      object: O,
      inTok: number,
      outTok: number,
      provider: string,
      model: string,
      durationMs: number,
    ): Promise<{ object: O; blocked?: GuardrailError }> => {
      const row = () => ({
        lineage,
        metadata: opts.metadata,
        orgId,
        app: opts.app,
        userId: opts.userId ?? null,
        route: opts.route ?? null,
        promptSlug: opts.slug,
        provider,
        model,
        routedBy: routeOf(provider, model),
        inputTokens: inTok,
        outputTokens: outTok,
        estimatedCostCents: this.registry.estimateCostCents(model, inTok, outTok),
        cacheHit: false,
        traceId,
        durationMs,
        inputText: prompt,
      });
      if (this.guardrails?.post) {
        const out = await this.applyPostGuardrail(
          this.postCtx(opts, prompt, traceId, orgId, object, provider, model),
          object,
          validate,
          failOpen,
          guardrailRecords,
        );
        object = out.value;
        if (out.blocked) {
          await this.logUsage({
            ...row(),
            outputText: JSON.stringify(object),
            guardrails: guardrailRecords,
          });
          return { object, blocked: guardrailError(out.blocked, object) };
        }
      }
      if (key) await this.cache.set(key, object, this.cacheTtlSeconds);
      await this.logUsage({
        ...row(),
        outputText: JSON.stringify(object),
        guardrails: guardrailRecords.length > 0 ? guardrailRecords : null,
      });
      return { object };
    };

    if (this.mock) {
      const responder = this.mockResponders.get(opts.slug);
      if (!responder) {
        throw new Error(`Mock mode is on but no responder registered for "${opts.slug}".`);
      }
      const raw = opts.schema.parse(responder(opts.input));
      const fin = await finalize(
        raw,
        Math.ceil(prompt.length / 4),
        Math.ceil(JSON.stringify(raw).length / 4),
        "mock",
        "mock",
        0,
      );
      if (fin.blocked) throw fin.blocked;
      return {
        cached: false,
        traceId,
        partialObjectStream: singleEmission(fin.object as Partial<O>),
        object: Promise.resolve(fin.object),
        failovers: [],
      };
    }

    let links = await this.resolveStreamLinks(orgId, opts, fd.requireZdr, fd.pins);
    links = links.filter((l) => l.languageModel);
    if (links.length === 0) {
      throw new Error("No API key for any streaming link.");
    }
    routeOf = (p, m) => links.find((l) => l.provider === p && l.model === m)?.routedBy;

    const start = Date.now();
    const firstChunkMs =
      opts.streamFirstChunkMs ?? this.timeouts?.streamFirstChunkMs ?? DEFAULT_STREAM_FIRST_CHUNK_MS;
    const stallMs = opts.streamStallMs ?? this.timeouts?.streamStallMs ?? DEFAULT_STREAM_STALL_MS;

    // The consumer-facing channel. The driver below owns iteration for the
    // same reason guardStream does: streamObject runs eagerly, so a consumer
    // that only awaits `object` would otherwise never advance the loop.
    const out = createConflatedCell<Partial<O>>();
    let resolveObject!: (o: O) => void;
    let rejectObject!: (e: unknown) => void;
    const objectPromise = new Promise<O>((res, rej) => {
      resolveObject = res;
      rejectObject = rej;
    });
    const failovers: StreamFailover[] = [];

    // Ledger-first: an attempt that produced nothing usable still spent money,
    // so it leaves a zero-token row before we move on. Same rule as the
    // unary paths (see logAbortedAttempt).
    const ledgerFailedLink = async (provider: string, model: string, ms: number) => {
      await this.logUsage({
        lineage,
        metadata: opts.metadata,
        orgId,
        app: opts.app,
        userId: opts.userId ?? null,
        route: opts.route ?? null,
        promptSlug: opts.slug,
        provider,
        model,
        routedBy: routeOf(provider, model),
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostCents: 0,
        cacheHit: false,
        traceId,
        durationMs: ms,
        inputText: prompt,
        outputText: null,
      });
    };

    void (async () => {
      let lastErr: unknown;
      for (let i = 0; i < links.length; i++) {
        const link = links[i]!;
        const linkStart = Date.now();
        const controller = new AbortController();
        const stream = streamObject({
          model: link.languageModel!,
          schema: opts.schema,
          prompt,
          abortSignal: controller.signal,
          ...(opts.system ? { system: opts.system } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        });
        const guard = guardStream<Partial<O>>(
          stream.partialObjectStream as AsyncIterable<Partial<O>>,
          {
            controller,
            firstChunkMs,
            stallMs,
            ...(opts.signal ? { callerSignal: opts.signal } : {}),
            onTrip: (phase, waitedMs) =>
              new StreamStallError(phase, waitedMs, link.provider, link.model),
            onCallerAbort: (reason) =>
              reason instanceof Error ? reason : new Error("Stream aborted by caller"),
          },
        );
        // These reject when a link is abandoned; the race below surfaces the
        // real reason, so mark them handled to avoid unhandled rejections.
        void stream.object.catch(() => {});
        void stream.usage.catch(() => {});

        let emittedThisLink = false;
        try {
          const completed = await Promise.race([
            (async () => {
              for await (const partial of guard.stream) {
                emittedThisLink = true;
                out.publish(partial);
              }
              const object = await stream.object; // schema-validated by the SDK
              const usage = await stream.usage;
              return { object, usage };
            })(),
            guard.tripped.then((err) => {
              throw err;
            }),
          ]);
          const fin = await finalize(
            completed.object,
            completed.usage.inputTokens ?? 0,
            completed.usage.outputTokens ?? 0,
            link.provider,
            link.model,
            Date.now() - start,
          );
          if (fin.blocked) {
            // Policy, not a link failure: no failover, the consumer sees the
            // GuardrailError on both the iterator and the object promise.
            out.fail(fin.blocked);
            rejectObject(fin.blocked);
            return;
          }
          // A transformed final object is published as the last partial so a
          // consumer rendering partials converges on what `object` resolves to.
          if (fin.object !== completed.object) out.publish(fin.object as Partial<O>);
          out.close();
          resolveObject(fin.object);
          return;
        } catch (err) {
          lastErr = err;
          await ledgerFailedLink(link.provider, link.model, Date.now() - linkStart);

          // A caller abort is terminal: they asked to stop, not to retry
          // somewhere else.
          const callerAborted = opts.signal?.aborted === true;
          const advanceable =
            !callerAborted && (err instanceof StreamStallError || this.retryable(err));
          const hasNext = i < links.length - 1;
          if (advanceable && hasNext) {
            const failover: StreamFailover = {
              provider: link.provider,
              model: link.model,
              reason: err instanceof StreamStallError ? "stall" : "retryable",
              hadPartialOutput: emittedThisLink,
            };
            failovers.push(failover);
            this.emitObs("onStreamFailover", this.obs?.onStreamFailover, {
              traceId,
              ...failover,
            });
            console.warn(
              `[llm-gateway] stream "${link.provider}/${link.model}" failed (${failover.reason}), failing over to next link`,
            );
            continue;
          }
          break;
        } finally {
          guard.dispose();
        }
      }
      // Chain exhausted (or a terminal error). Degradation contract: the
      // consumer sees the LAST link's error on both the iterator and the
      // object promise, and every attempted link already has a ledger row.
      const err =
        lastErr instanceof Error
          ? lastErr
          : new Error("streamStructured: no link produced a result");
      out.fail(err);
      rejectObject(err);
    })();

    return {
      cached: false,
      traceId,
      partialObjectStream: out.stream,
      object: objectPromise,
      failovers,
    };
  }

  // ===========================================================================
  // streamText — governed text stream with tool calling (#14, Scout half).
  // See docs/design/streaming-text.md. No cache, no judge.
  // ===========================================================================

  async streamText(opts: StreamTextOptions): Promise<StreamTextResult> {
    return this.textTurn(opts, false);
  }

  /**
   * `streamText` for a caller that does not stream: the same governed turn
   * and tool loop, awaited. Everything a run, a tool policy and the guardrail
   * hooks do inside `streamText` they do here, because it is the same loop:
   * the run's budget stops it between steps, each completed tool step and
   * each tool call is ledgered as it finishes.
   *
   * Two things differ, both because nobody is watching partial text:
   *  - A link that fails after producing text, but before any tool has run,
   *    is failed over like any other. Its text was shown to no one.
   *  - A turn that fails after a tool has run rejects with the error. It is
   *    not failed over, since that would run the tool again, and there is no
   *    notice to append. What it spent is ledgered first.
   *
   * It reads the provider's streaming endpoint to do this; the stall clocks
   * (`streamFirstChunkMs`, `streamStallMs`) therefore apply.
   */
  async generateText(opts: GenerateTextOptions): Promise<GenerateTextResult> {
    const turn = await this.textTurn(opts, true);
    const { degraded: _degraded, ...outcome } = await turn.result;
    return { traceId: turn.traceId, ...outcome };
  }

  /** The turn behind `streamText` and, buffered, behind `generateText`. */
  private async textTurn(opts: StreamTextOptions, buffered: boolean): Promise<StreamTextResult> {
    const name = buffered ? "generateText" : "streamText";
    const last = opts.messages.at(-1);
    const lastUserText = last?.role === "user" ? messageText(last) : "";
    if (!lastUserText) throw new Error(`${name}: messages must end with a user message`);
    if (opts.anthropic && opts.tools) {
      throw new Error(
        `${name}: \`anthropic\` native options cannot be combined with AI SDK \`tools\``,
      );
    }
    if (opts.anthropic && !this.anthropicCfg && !this.mock) {
      throw new Error(
        `${name} received \`anthropic\` native options but GatewayConfig.anthropic is not configured.`,
      );
    }

    const validate = (raw: unknown): string => {
      if (typeof raw !== "string")
        throw new Error(`a ${name} post hook must transform to a string`);
      return raw;
    };
    // The front door renders `promptBody` as the prompt: here, the last user
    // message, so the pre-guardrail sees it and a transform replaces it.
    const fdOpts: FrontDoorOptions<undefined> = {
      ...opts,
      input: undefined,
      variables: () => ({}),
      promptBody: lastUserText,
      cache: false,
    };
    const fd = await this.frontDoor<undefined, string>(name, fdOpts, validate);
    const { traceId, orgId, prompt, temperature, guardrailRecords, failOpen, lineage } = fd;
    // Which layer a row's model came from; set once the links are resolved.
    let routeOf = (_provider: string, _model: string): RoutedBy | undefined => undefined;
    // What this turn has had ledgered so far, for the in-loop budget check.
    const turn = { ledgeredCents: 0 };
    const rowLineage: Lineage = lineage ? { ...lineage, turn } : undefined;
    const messages: ModelMessage[] = [
      ...opts.messages.slice(0, -1),
      prompt === lastUserText ? last! : withText(last!, prompt),
    ];

    const row = (f: {
      provider: string;
      model: string;
      inTok: number;
      outTok: number;
      durationMs: number;
      text: string;
      toolCalls: number;
      degraded?: boolean;
      aborted?: boolean;
      extras?: NativeExtras;
      /** Index of a completed tool step ledgered on its own (run calls only). */
      innerStep?: number;
      /** On the turn's closing row: how many inner steps the turn ran. */
      innerSteps?: number;
    }) => ({
      lineage: rowLineage,
      ...(f.extras ?? {}),
      metadata: {
        ...opts.metadata,
        toolCalls: f.toolCalls,
        ...(f.innerStep !== undefined ? { innerStep: f.innerStep } : {}),
        ...(f.innerSteps !== undefined ? { innerSteps: f.innerSteps } : {}),
      },
      ...(f.degraded ? { degraded: true } : {}),
      ...(f.aborted ? { aborted: true } : {}),
      guardrails: guardrailRecords.length > 0 ? guardrailRecords : null,
      orgId,
      app: opts.app,
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: opts.slug,
      provider: f.provider,
      model: f.model,
      routedBy: routeOf(f.provider, f.model),
      inputTokens: f.inTok,
      outputTokens: f.outTok,
      estimatedCostCents: this.registry.estimateCostCents(f.model, f.inTok, f.outTok, f.extras),
      cacheHit: false,
      traceId,
      durationMs: f.durationMs,
      inputText: prompt,
      outputText: f.text,
    });

    if (this.mock) {
      const responder = this.mockResponders.get(opts.slug);
      if (!responder) {
        throw new Error(`Mock mode is on but no responder registered for "${opts.slug}".`);
      }
      const text = String(responder({ system: opts.system, messages } as never));
      const usage = {
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(text.length / 4),
      };
      await this.logUsage(
        row({
          provider: "mock",
          model: "mock",
          inTok: usage.inputTokens,
          outTok: usage.outputTokens,
          durationMs: 0,
          text,
          toolCalls: 0,
        }),
      );
      return {
        traceId,
        textStream: singleEmission(text),
        result: Promise.resolve({
          text,
          toolCalls: [],
          toolResults: [],
          usage,
          provider: "mock",
          model: "mock",
          degraded: false,
          failovers: [],
        }),
      };
    }

    // A link streams natively when the caller asked for native features and
    // it is an Anthropic link; native links need no AI SDK key.
    const native = (l: ChainLink) => !!opts.anthropic && l.provider === "anthropic";
    const links = (
      await this.resolveStreamLinks(
        orgId,
        opts,
        fd.requireZdr,
        fd.pins,
        opts.anthropic ? ["anthropic"] : undefined,
      )
    ).filter((l) => l.languageModel || native(l));
    if (links.length === 0) throw new Error("No API key for any streaming link.");
    routeOf = (p, m) => links.find((l) => l.provider === p && l.model === m)?.routedBy;

    const start = Date.now();
    const firstChunkMs =
      opts.streamFirstChunkMs ?? this.timeouts?.streamFirstChunkMs ?? DEFAULT_STREAM_FIRST_CHUNK_MS;
    const stallMs = opts.streamStallMs ?? this.timeouts?.streamStallMs ?? DEFAULT_STREAM_STALL_MS;

    const out = createQueuedCell<string>();
    let resolveResult!: (o: StreamTextOutcome) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<StreamTextOutcome>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    void result.catch(() => {});
    const failovers: StreamFailover[] = [];

    // Input size of the first model call, for estimating a cut-off step's
    // cost. Later steps also carry every earlier step's output and tool I/O.
    const inputChars = (opts.system ?? "").length + messages.map(messageText).join("").length;
    const deadlineMs = opts.deadlineMs ?? this.timeouts?.deadlineMs;

    // Ledger-first, as in streamStructured: an abandoned link still spent.
    const ledgerFailedLink = async (provider: string, model: string, ms: number) => {
      await this.logUsage(
        row({ provider, model, inTok: 0, outTok: 0, durationMs: ms, text: "", toolCalls: 0 }),
      );
    };

    // Tool governance (src/tools.ts): on when a tool policy or a tool hook is
    // configured. Each executed tool call is capped, hooked and ledgered on a
    // row of its own. The row carries the call's plain lineage, not the
    // turn-counted one: its cost is charged to the run at once, and must not
    // be mistaken by the in-loop budget check for a model step already paid.
    const toolDenials: ToolDenial[] = [];
    let currentInnerStep = 0;
    const turnToolUse = new Map<string, { calls: number; cents: number }>();
    const tools =
      opts.tools && (this.toolPolicy !== undefined || this.guardrails?.tool !== undefined)
        ? governTools(opts.tools, {
            policy: this.toolPolicy ?? {},
            ...(this.guardrails?.tool ? { hook: this.guardrails.tool } : {}),
            failOpen,
            enforced: this.caps.mode !== "observe",
            ...(lineage ? { run: lineage.run } : {}),
            use: (name) => {
              if (lineage) return lineage.run.toolUse(name);
              let use = turnToolUse.get(name);
              if (!use) {
                use = { calls: 0, cents: 0 };
                turnToolUse.set(name, use);
              }
              return use;
            },
            hookCtx: {
              slug: opts.slug,
              traceId,
              userId: opts.userId ?? null,
              orgId: orgId ?? null,
              route: opts.route ?? null,
              task: opts.task,
              ...(lineage ? { runId: lineage.run.id } : {}),
            },
            onUnpriced: (name) => {
              // Only a configured policy can be incomplete; a hook alone prices nothing.
              if (this.toolPolicy === undefined || this.warnedUnpricedTools.has(name)) return;
              this.warnedUnpricedTools.add(name);
              console.warn(
                `[llm-gateway] no ToolPolicy for tool "${name}": its calls are ledgered at 0¢ and ` +
                  `uncapped. Add it to GatewayConfig.toolPolicy, or call gateway.preflightTools() ` +
                  `at startup to make this an error. Warned once per tool.`,
              );
            },
            onDenial: (d) => toolDenials.push(d),
            ledger: async (e) => {
              await this.logUsage({
                lineage,
                metadata: {
                  ...opts.metadata,
                  toolCallId: e.toolCallId,
                  innerStep: currentInnerStep,
                  ...(e.denied ? { toolDenied: e.denied } : {}),
                  ...(e.wouldDeny ? { toolWouldDeny: e.wouldDeny } : {}),
                  ...(e.error !== undefined ? { toolError: e.error } : {}),
                },
                guardrails: e.guardrail ? [e.guardrail] : null,
                orgId,
                app: opts.app,
                userId: opts.userId ?? null,
                route: opts.route ?? null,
                promptSlug: opts.slug,
                provider: "tool",
                model: e.tool,
                inputTokens: 0,
                outputTokens: 0,
                estimatedCostCents: e.costCents,
                cacheHit: false,
                traceId,
                durationMs: e.durationMs,
                inputText: JSON.stringify(e.input ?? null),
                outputText: e.output === undefined ? null : JSON.stringify(e.output),
              });
            },
          })
        : opts.tools;

    void (async () => {
      let lastErr: unknown;
      for (let i = 0; i < links.length; i++) {
        const link = links[i]!;
        const linkStart = Date.now();
        const controller = new AbortController();
        // In-loop run budget. The front door checks the budget before the
        // call; a tool loop can spend many times that inside one call. When
        // the caller passed a stop condition (so the loop runs more than one
        // step) and the run chain has a budget, this condition joins theirs:
        // after each step it prices the turn's steps so far, subtracts what
        // the run has already been charged for them, and stops the loop when
        // the rest would put the run (or an ancestor) at its budget.
        let budgetOver: GovernedRun | undefined;
        const budgetEnforced = this.caps.mode !== "observe";
        const runStop: StopCondition<ToolSet> | undefined =
          lineage && opts.stopWhen && lineage.run.remainingCents() !== undefined
            ? ({ steps }) => {
                const turnCents = steps.reduce(
                  (sum, st) =>
                    sum +
                    this.registry.estimateCostCents(
                      link.model,
                      st.usage.inputTokens ?? 0,
                      st.usage.outputTokens ?? 0,
                    ),
                  0,
                );
                const over = lineage.run.exhausted(turnCents - turn.ledgeredCents);
                if (!over) return false;
                budgetOver ??= over;
                // Observe mode measures: the breach is recorded, the loop goes on.
                return budgetEnforced;
              }
            : undefined;
        const stopWhen = runStop
          ? [...(Array.isArray(opts.stopWhen) ? opts.stopWhen : [opts.stopWhen!]), runStop]
          : opts.stopWhen;
        const source = native(link)
          ? streamNativeAnthropicText(this.anthropicCfg!, {
              model: link.model,
              messages: nativeMessages(messages),
              ...(opts.system ? { system: opts.system } : {}),
              ...(temperature !== undefined ? { temperature } : {}),
              native: opts.anthropic!,
              signal: controller.signal,
            })
          : null;
        const stream = source
          ? null
          : aiStreamText({
              model: link.languageModel!,
              messages,
              abortSignal: controller.signal,
              // The gateway owns failover. streamStructured keeps the SDK
              // default (2) for compatibility; it predates chain failover.
              maxRetries: 0,
              onError: () => {}, // surfaced via the part stream; the SDK default logs it again
              ...(opts.system ? { system: opts.system } : {}),
              ...(tools ? { tools } : {}),
              ...(stopWhen ? { stopWhen } : {}),
              ...(temperature !== undefined ? { temperature } : {}),
            });
        const guard = guardStream<StreamPart>(source ?? modelParts(stream!.fullStream), {
          controller,
          firstChunkMs,
          stallMs,
          mode: "queue",
          ...(opts.signal ? { callerSignal: opts.signal } : {}),
          onTrip: (phase, waitedMs) =>
            new StreamStallError(phase, waitedMs, link.provider, link.model),
          onCallerAbort: (reason) =>
            reason instanceof Error ? reason : new Error("Stream aborted by caller"),
        });
        let text = "";
        let stepText = ""; // output of the step in flight, for the cut-off estimate
        const toolCalls: unknown[] = [];
        const toolResults: unknown[] = [];
        let total = { inputTokens: 0, outputTokens: 0 };
        let extras: NativeExtras | undefined; // native path only
        const done = { inputTokens: 0, outputTokens: 0 }; // completed steps
        // After the first text delta or tool call, a new link would repeat
        // text the user saw or run a tool twice: degrade instead (spec).
        // Buffered, nobody has seen the text, so only a tool call is past
        // the point of no return; `sawOutput` still marks that the link spent.
        let pastNoReturn = false;
        let sawOutput = false;
        let pendingTools = 0;
        let carried = 0; // chars earlier steps add to the next step's input
        let stepChars = 0;
        let streamDone = false;
        // Inner steps. With a run, a completed TOOL step is ledgered as soon
        // as it finishes (ledger-first: a turn killed mid-loop keeps the audit
        // trail of what it had spent), and the turn's closing row then carries
        // only what is left. Without a run nothing is ledgered early and the
        // closing row is the single row it always was.
        let innerSteps = 0;
        currentInnerStep = 0;
        let stepToolCalls = 0;
        let lastStepHadTools = false;
        let stepStart = Date.now();
        const ledgered = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
        const rest = (u: { inputTokens: number; outputTokens: number }) => ({
          inTok: Math.max(0, u.inputTokens - ledgered.inputTokens),
          outTok: Math.max(0, u.outputTokens - ledgered.outputTokens),
          toolCalls: toolCalls.length - ledgered.toolCalls,
          ...(ledgered.toolCalls > 0 || ledgered.inputTokens > 0 ? { innerSteps } : {}),
        });
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline =
            deadlineMs === undefined
              ? new Promise<never>(() => {})
              : new Promise<never>((_, reject) => {
                  const elapsed = Date.now() - start;
                  deadlineTimer = setTimeout(
                    () => {
                      const err = new DeadlineExceededError(deadlineMs, Date.now() - start);
                      controller.abort(err);
                      reject(err);
                    },
                    Math.max(0, deadlineMs - elapsed),
                  );
                });
          await Promise.race([
            deadline,
            (async () => {
              for await (const part of guard.stream) {
                if (part.type === "text-delta") {
                  sawOutput = true;
                  text += part.text;
                  stepText += part.text;
                  stepChars += part.text.length;
                  if (!buffered) {
                    pastNoReturn = true;
                    out.publish(part.text);
                  }
                } else if (part.type === "tool-call") {
                  sawOutput = true;
                  pastNoReturn = true;
                  toolCalls.push(part);
                  stepToolCalls++;
                  stepChars += JSON.stringify(part.input ?? null).length;
                  // A running tool is not a silent provider.
                  if (pendingTools++ === 0) guard.pauseClock();
                } else if (part.type === "tool-result" || part.type === "tool-error") {
                  if (part.type === "tool-result") {
                    toolResults.push(part);
                    stepChars += JSON.stringify(part.output ?? null).length;
                  }
                  if (--pendingTools === 0) guard.resumeClock();
                } else if (part.type === "finish-step") {
                  const stepIn = part.usage.inputTokens ?? 0;
                  const stepOut = part.usage.outputTokens ?? 0;
                  done.inputTokens += stepIn;
                  done.outputTokens += stepOut;
                  if (rowLineage && stepToolCalls > 0) {
                    await this.logUsage(
                      row({
                        provider: link.provider,
                        model: link.model,
                        inTok: stepIn,
                        outTok: stepOut,
                        durationMs: Date.now() - stepStart,
                        text: stepText,
                        toolCalls: stepToolCalls,
                        innerStep: innerSteps,
                      }),
                    );
                    ledgered.inputTokens += stepIn;
                    ledgered.outputTokens += stepOut;
                    ledgered.toolCalls += stepToolCalls;
                  }
                  lastStepHadTools = stepToolCalls > 0;
                  innerSteps++;
                  currentInnerStep = innerSteps;
                  stepToolCalls = 0;
                  stepStart = Date.now();
                  stepText = "";
                  carried += stepChars;
                  stepChars = 0;
                } else if (part.type === "finish") {
                  total = {
                    inputTokens: part.totalUsage.inputTokens ?? 0,
                    outputTokens: part.totalUsage.outputTokens ?? 0,
                  };
                  if ("extras" in part) extras = part.extras;
                } else if (part.type === "error") throw part.error;
              }
            })(),
            guard.tripped.then((err) => {
              throw err;
            }),
          ]);
          streamDone = true;
          // Post hook on the final text. The deltas are already out, so a
          // block can only reject `result`; a transform changes result.text.
          let finalText = text;
          let blocked: GuardrailError | undefined;
          if (this.guardrails?.post) {
            const post = await this.applyPostGuardrail(
              this.postCtx(fdOpts, prompt, traceId, orgId, text, link.provider, link.model),
              text,
              validate,
              failOpen,
              guardrailRecords,
            );
            finalText = post.value;
            if (post.blocked) blocked = guardrailError(post.blocked, text);
          }
          await this.logUsage(
            row({
              provider: link.provider,
              model: link.model,
              ...rest(total),
              durationMs: Date.now() - start,
              text: finalText,
              ...(extras ? { extras } : {}),
            }),
          );
          // The run ran out inside the loop. Recorded like the front door's
          // breach, after the closing row so `spentCents` is the ledger's.
          const over = budgetOver as GovernedRun | undefined;
          if (over) {
            await this.recordCapEvent({
              userId: opts.userId ?? null,
              orgId: orgId ?? null,
              capCents: over.budgetCents!,
              spentCents: over.spentCents,
              route: opts.route ? `run:${opts.route}` : "run",
              runId: over.id,
              wouldBlock: true,
              enforced: budgetEnforced,
              createdAt: new Date(),
            });
          }
          out.close();
          if (blocked) {
            rejectResult(blocked);
            return;
          }
          resolveResult({
            text: finalText,
            toolCalls,
            toolResults,
            usage: total,
            provider: link.provider,
            model: link.model,
            degraded: false,
            failovers,
            // Only when the loop was actually cut: the last step asked for
            // tools and the model was not called again.
            ...(over && budgetEnforced && lastStepHadTools
              ? { runStopped: { limit: "budget" as const, runId: over.id } }
              : {}),
            ...(toolDenials.length > 0 ? { toolDenials } : {}),
          });
          return;
        } catch (err) {
          if (streamDone) {
            // The model finished; the failure is ours (post hook, ledger).
            // Not a link failure: no notice, no failover.
            out.close();
            rejectResult(err);
            return;
          }
          lastErr = err;
          const callerAborted = opts.signal?.aborted === true;
          const used = {
            inputTokens: done.inputTokens + Math.ceil((inputChars + carried) / 4),
            outputTokens: done.outputTokens + Math.ceil(stepText.length / 4),
          };
          if (pastNoReturn && callerAborted) {
            // They asked to stop: no notice, but the spend is real.
            await this.logUsage(
              row({
                provider: link.provider,
                model: link.model,
                ...rest(used),
                durationMs: Date.now() - start,
                text,
                aborted: true,
              }),
            );
            break;
          }
          if (pastNoReturn && buffered) {
            // A tool has run, so no failover; and no one is reading a stream,
            // so no notice. Ledger what the turn spent, then fail the call.
            await this.logUsage(
              row({
                provider: link.provider,
                model: link.model,
                ...rest(used),
                durationMs: Date.now() - start,
                text,
                degraded: true,
              }),
            );
            break;
          }
          if (pastNoReturn) {
            const notice = opts.degradedNotice ?? DEFAULT_DEGRADED_NOTICE;
            const delta = text ? `\n\n${notice}` : notice;
            out.publish(delta);
            text += delta;
            await this.logUsage(
              row({
                provider: link.provider,
                model: link.model,
                ...rest(used),
                durationMs: Date.now() - start,
                text,
                degraded: true,
              }),
            );
            out.close();
            resolveResult({
              text,
              toolCalls,
              toolResults,
              usage: used,
              provider: link.provider,
              model: link.model,
              degraded: true,
              failovers,
              ...(toolDenials.length > 0 ? { toolDenials } : {}),
            });
            return;
          }
          if (sawOutput) {
            // Buffered only: the link produced text and then failed. Nothing
            // was shown, so it can be failed over, but it spent.
            await this.logUsage(
              row({
                provider: link.provider,
                model: link.model,
                ...rest(used),
                durationMs: Date.now() - linkStart,
                text,
                ...(callerAborted ? { aborted: true } : {}),
              }),
            );
          } else {
            await ledgerFailedLink(link.provider, link.model, Date.now() - linkStart);
          }
          const advanceable =
            !callerAborted && (err instanceof StreamStallError || this.retryable(err));
          if (advanceable && i < links.length - 1) {
            const failover: StreamFailover = {
              provider: link.provider,
              model: link.model,
              reason: err instanceof StreamStallError ? "stall" : "retryable",
              hadPartialOutput: sawOutput,
            };
            failovers.push(failover);
            this.emitObs("onStreamFailover", this.obs?.onStreamFailover, { traceId, ...failover });
            continue;
          }
          break;
        } finally {
          clearTimeout(deadlineTimer);
          guard.dispose();
        }
      }
      const e =
        lastErr instanceof Error ? lastErr : new Error(`${name}: no link produced a result`);
      out.fail(e);
      // The caller's own reason, as given (it need not be an Error).
      rejectResult(opts.signal?.aborted ? opts.signal.reason : e);
    })().catch((e: unknown) => {
      // Last resort (e.g. the ledger itself failing on an error path): settle
      // both ends rather than leave the consumer hanging.
      const err = e instanceof Error ? e : new Error(String(e));
      out.fail(err);
      rejectResult(err);
    });

    return { traceId, textStream: out.stream, result };
  }

  // ===========================================================================
  // Batch processing — see docs/design/batch-processing.md
  // ===========================================================================

  private requireBatch() {
    if (!this.batchCfg) {
      throw new Error("Batch requires GatewayConfig.batch ({ client, store }).");
    }
    return this.batchCfg;
  }

  /** Governed batch submit: cache pre-check, estimate + optional hard
   *  ceiling, spend-cap check WITH the projected reservation, then submit
   *  and log the reservation row. */
  async submitBatch<I, O>(
    schema: z.ZodType<O>,
    opts: SubmitBatchOptions<I>,
  ): Promise<SubmitBatchResult> {
    const cfg = this.requireBatch();
    const orgId = this.org(opts);
    const discount = cfg.discount ?? 0.5;
    const allowance = cfg.outputAllowanceTokens ?? 1024;

    // Rate limit (one submit = one governed action).
    const identifier = opts.userId ?? "anon";
    const rl = await this.rateLimiter.limit(identifier);
    if (!rl.success) throw new RateLimitError(rl.limit, rl.remaining);

    // A slug locked in code is ZDR-required on the batch path too.
    const requireZdr = opts.requireZdr === true || this.zdrSlugs.has(opts.slug);

    // Model resolution: explicit > slug pin > task > default. Must be
    // Anthropic. A batch runs on one model, so of the slug's chain only its
    // own models count here (the first ZDR-eligible one), not the chain.
    const pinned =
      opts.model || !this.slugPinWins
        ? null
        : await this.slugChain({
            slug: opts.slug,
            pins: await this.loadSlugPins(opts.slug, orgId),
            tier: undefined,
            orgId,
            requireZdr,
          });
    const slugModel = pinned?.find((l) => l.routedBy !== "chain");
    let provider: string;
    let model: string;
    if (opts.model) {
      ({ provider, model } = parseModelId(opts.model));
    } else if (slugModel) {
      ({ provider, model } = slugModel);
    } else if (opts.task && this.tasks) {
      const t = await this.tasks.modelForTask(opts.task, orgId);
      provider = t.provider;
      model = t.model;
    } else {
      const d = this.registry.resolveDefault();
      provider = d.provider;
      model = d.model;
    }
    if (provider !== "anthropic") {
      throw new Error(`Batch supports Anthropic models only (resolved "${provider}/${model}").`);
    }
    if (requireZdr && !this.registry.isZdr(provider, model)) {
      throw new ZdrViolationError(provider, model, "batch submit");
    }

    const promptConfig = await this.loadPrompt(opts.slug, orgId);
    const jsonSchema = batchSchemaToJson(schema);
    const useCache = opts.cache !== false;

    // Pre guardrail per item, then cache pre-check: serve hits now, submit
    // only misses. A blocked item is excluded from the batch and reported in
    // `blocked`; it leaves a zero-token row of its own (traceId
    // "batch:guardrail:<slug>:<item id>") because nothing else would carry
    // the verdict. Allow/transform verdicts ride the reservation row, one
    // record per item, tagged with the item id in `detail.batchItemId`.
    const failOpen = this.guardrails?.failOpen === true;
    const blocked: { id: string; reason: string }[] = [];
    const submitRecords: GuardrailRecord[] = [];
    const cached: { id: string; object: unknown }[] = [];
    const misses: { id: string; prompt: string; cacheK: string | null }[] = [];
    for (const item of opts.items) {
      let prompt = renderTemplate(promptConfig.body, item.variables);
      if (this.guardrails?.pre) {
        const itemTrace = `batch:guardrail:${opts.slug}:${item.id}`;
        const { verdict, record } = await runGuardrail(
          this.guardrails.pre,
          "pre",
          {
            slug: opts.slug,
            prompt,
            system: opts.system,
            input: item.input,
            traceId: itemTrace,
            userId: opts.userId ?? null,
            orgId: orgId ?? null,
            route: opts.route ?? null,
            task: opts.task,
          },
          failOpen,
        );
        if (verdict.action === "block") {
          await this.logUsage({
            lineage: undefined, // batch is not a run path in this version
            metadata: opts.metadata,
            orgId,
            app: opts.app,
            userId: opts.userId ?? null,
            route: opts.route ?? `batch:${opts.slug}`,
            promptSlug: opts.slug,
            provider: "guardrail",
            model: "pre",
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostCents: 0,
            cacheHit: false,
            traceId: itemTrace,
            durationMs: record.durationMs,
            inputText: prompt,
            outputText: null,
            guardrails: [record],
          });
          blocked.push({ id: item.id, reason: record.reason ?? "blocked" });
          continue;
        }
        if (verdict.action === "transform" && typeof verdict.prompt === "string") {
          prompt = verdict.prompt;
        }
        submitRecords.push({ ...record, detail: { ...record.detail, batchItemId: item.id } });
      }
      const k = useCache
        ? cacheKey(
            opts.slug,
            [JSON.stringify(item.variables)],
            orgId,
            this.scopeCacheToPrompt ? promptFingerprint(promptConfig) : undefined,
          )
        : null;
      if (k) {
        const hit = await this.cache.get<O>(k);
        if (hit !== undefined) {
          cached.push({ id: item.id, object: hit });
          continue;
        }
      }
      misses.push({ id: item.id, prompt, cacheK: k });
    }
    if (misses.length === 0) {
      return { batchId: null, cached, blocked, submittedCount: 0, reservedCents: 0 };
    }

    // Submit-time ESTIMATE (documented as such — maxCostCents is the
    // guarantee, the estimate is not).
    let estimateCents = 0;
    for (const m of misses) {
      estimateCents +=
        this.registry.estimateCostCents(model, Math.ceil(m.prompt.length / 4), allowance) *
        discount;
    }
    if (opts.maxCostCents !== undefined && estimateCents > opts.maxCostCents) {
      throw new Error(
        `Batch estimate ${estimateCents.toFixed(2)}¢ exceeds maxCostCents ${opts.maxCostCents}¢ (${misses.length} items). Split the batch or raise the ceiling.`,
      );
    }
    await this.checkSpendCap(opts.userId, opts.route ?? `batch:${opts.slug}`, estimateCents, orgId);

    const requests = misses.map((m) => ({
      customId: m.id,
      params: buildBatchParams({
        model,
        prompt: m.prompt,
        system: opts.system,
        jsonSchema,
        temperature: opts.temperature ?? promptConfig.temperature,
        maxTokens: cfg.maxTokensPerItem ?? 4096,
      }),
    }));

    const { id: batchId } = await cfg.client.submit(requests);

    // Reservation row: committed money counts against caps immediately.
    await this.logUsage({
      lineage: undefined,
      metadata: opts.metadata,
      orgId,
      app: opts.app,
      userId: opts.userId ?? null,
      route: `batch:reserve:${opts.slug}`,
      promptSlug: opts.slug,
      provider: "anthropic",
      model,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: estimateCents,
      cacheHit: false,
      traceId: `batch:${batchId}`,
      guardrails: submitRecords.length > 0 ? submitRecords : null,
    });

    await cfg.store.createJob({
      batchId,
      slug: opts.slug,
      model,
      status: "submitted",
      itemCount: misses.length,
      cachedCount: cached.length,
      reservedCents: estimateCents,
      metadata: opts.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      batchId,
      cached,
      blocked,
      submittedCount: misses.length,
      reservedCents: estimateCents,
    };
  }

  /** Poll provider status and sync the job store. Cron/queue-friendly. */
  async pollBatch(batchId: string): Promise<{ status: string; ready: boolean }> {
    const cfg = this.requireBatch();
    const job = await cfg.store.getJob(batchId);
    if (!job) throw new Error(`Unknown batch job "${batchId}"`);
    if (job.status === "reconciled") return { status: "reconciled", ready: false };
    const { status } = await cfg.client.check(batchId);
    if (status === "ended" && job.status === "submitted") {
      await cfg.store.updateJob(batchId, { status: "ended" });
    }
    return { status, ready: status === "ended" };
  }

  /**
   * Stream results, validate each item, log per-item actuals (discounted),
   * release the reservation. Idempotent by job state: a reconciled job
   * returns { alreadyReconciled: true } without re-logging. (Cache write-back
   * of batch results is a caller concern in v1 — the job store doesn't
   * persist per-item cache keys.)
   */
  async reconcileBatch<O>(batchId: string, schema: z.ZodType<O>): Promise<ReconcileResult<O>> {
    const cfg = this.requireBatch();
    const discount = cfg.discount ?? 0.5;
    const job = await cfg.store.getJob(batchId);
    if (!job) throw new Error(`Unknown batch job "${batchId}"`);
    if (job.status === "reconciled") {
      return { results: [], costCents: job.reconciledCents ?? 0, alreadyReconciled: true };
    }
    await cfg.store.updateJob(batchId, { status: "reconciling" });

    // Phase 1: stream + validate (no side effects yet).
    const results: BatchItemResult<O>[] = [];
    const usageRows: Omit<UsageEntry, "createdAt">[] = [];
    let totalCents = 0;

    for await (const item of cfg.client.results(batchId)) {
      if (item.result.type !== "succeeded") {
        results.push({
          id: item.customId,
          ok: false,
          reason: item.result.type,
          ...(item.result.type === "errored"
            ? { error: String((item.result as { error: unknown }).error).slice(0, 300) }
            : {}),
        });
        continue; // unprocessed items are not billed and log no usage
      }
      const msg = item.result.message;
      const u = msg.usage ?? {};
      const cents =
        this.registry.estimateCostCents(job.model, u.input_tokens ?? 0, u.output_tokens ?? 0, {
          cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
        }) * discount;
      totalCents += cents;
      const row: Omit<UsageEntry, "createdAt"> = {
        userId: null,
        route: `batch:${job.slug}`,
        promptSlug: job.slug,
        provider: "anthropic",
        model: job.model,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        estimatedCostCents: cents,
        cacheHit: false,
        traceId: `${batchId}:${item.customId}`, // deterministic — duplicates detectable
        cacheCreateTokens: u.cache_creation_input_tokens ?? null,
        cacheReadTokens: u.cache_read_input_tokens ?? null,
      };
      usageRows.push(row);
      let object: O;
      try {
        object = schema.parse(extractEmitToolInput(msg));
      } catch (err) {
        results.push({
          id: item.customId,
          ok: false,
          reason: "schema",
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
        continue;
      }
      // Post guardrail at reconcile time, per item. The job store carries no
      // per-item prompt or input in v1, so the hook sees `prompt: ""` and
      // `input: undefined`; a hook that grounds against the input (TrustGate's
      // grounder) has nothing to ground against here and should be configured
      // to allow. The verdict rides the item's usage row.
      if (this.guardrails?.post) {
        const records: GuardrailRecord[] = [];
        const out = await this.applyPostGuardrail(
          {
            slug: job.slug,
            prompt: "",
            input: undefined,
            output: object,
            provider: "anthropic",
            model: job.model,
            traceId: row.traceId,
            userId: null,
            orgId: null,
            route: row.route ?? null,
          },
          object,
          (raw) => schema.parse(raw),
          this.guardrails.failOpen === true,
          records,
        );
        row.guardrails = records;
        if (out.blocked) {
          results.push({
            id: item.customId,
            ok: false,
            reason: "guardrail",
            error: out.blocked.reason ?? "blocked",
          });
          continue;
        }
        object = out.value;
      }
      results.push({ id: item.customId, ok: true, object });
    }

    // Phase 2: side effects — per-item actuals, then reservation release.
    for (const row of usageRows) await this.logUsage({ ...row, lineage: undefined });
    await this.logUsage({
      lineage: undefined,
      metadata: job.metadata,
      userId: null,
      route: `batch:release:${job.slug}`,
      promptSlug: job.slug,
      provider: "anthropic",
      model: job.model,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: -job.reservedCents, // compensating row
      cacheHit: false,
      traceId: `batch:${batchId}:release`,
    });
    await cfg.store.updateJob(batchId, { status: "reconciled", reconciledCents: totalCents });

    return { results, costCents: totalCents, alreadyReconciled: false };
  }

  // ---------------------------------------------------------------------------
  // Unified single-link executor: native Anthropic when the call requests
  // native features AND the link is Anthropic AND a native client is
  // configured; AI SDK generateObject otherwise. Native failures reuse the
  // same repair/transient semantics as attemptGenerate.
  // ---------------------------------------------------------------------------
  private async execLink<O>(
    link: {
      provider: string;
      model: string;
      languageModel?: LanguageModel;
      temperature?: number | null;
    },
    schema: OutputSchema<O>,
    prompt: string,
    system: string | undefined,
    callTemperature: number | undefined,
    native: NativeCallOptions | undefined,
    /** Whole-operation clock; supplies each attempt's signal. */
    budget: AttemptBudget = new AttemptBudget(),
    attemptMs = DEFAULT_ATTEMPT_MS,
  ): Promise<
    AttemptResult<O> & {
      extras?: { cacheCreateTokens: number; cacheReadTokens: number; webSearches: number };
    }
  > {
    // Per-link temperature: link (incl. null = never send) > call > prompt.
    const temperature =
      link.temperature === null ? undefined : (link.temperature ?? callTemperature);
    if (native && link.provider === "anthropic" && this.anthropicCfg) {
      let currentPrompt = prompt;
      let repaired = false;
      let transientRetries = 0;
      for (;;) {
        throwIfOutOfBudget(budget, "before-retry");
        const attempt = budget.attempt(attemptMs);
        try {
          const res = await callNativeAnthropic(this.anthropicCfg, {
            model: link.model,
            prompt: currentPrompt,
            system,
            schema: schema as Parameters<typeof callNativeAnthropic>[1]["schema"],
            temperature,
            native,
            signal: attempt.signal,
          });
          // Validate the tool input; wrap failures so the shared
          // isSchemaValidationError machinery sees them.
          let object: O;
          if (isZodSchema(schema)) {
            try {
              object = schema.parse(res.object);
            } catch (err) {
              throw new NativeSchemaError(err instanceof Error ? err.message : String(err));
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
          if (attempt.timedOut()) {
            throwIfOutOfBudget(budget, "in-flight");
            throw new AttemptTimeoutError(link.provider, link.model, attemptMs);
          }
          if (budget.callerSignal?.aborted) throw budget.callerSignal.reason;
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
          if (!this.retryable(err) || transientRetries >= 2) throw err;
          await sleep(budget.clampDelay(backoffMs(transientRetries, err)), budget.callerSignal);
          transientRetries++;
        } finally {
          attempt.dispose();
        }
      }
    }

    if (!link.languageModel) {
      throw new Error(
        `No API key for provider "${link.provider}" (and native execution does not apply).`,
      );
    }
    const result = await attemptGenerate(
      link.languageModel,
      schema,
      prompt,
      temperature,
      system,
      budget,
      attemptMs,
      { provider: link.provider, model: link.model },
      this.retryable,
    );
    return result;
  }

  // ===========================================================================
  // Governed runs — see src/run.ts and docs/design/run-governance.md.
  // ===========================================================================

  /**
   * Start a governed run. Pass the returned run as `run` to `runStructured`,
   * `runText`, `streamStructured`, `streamText` or `embed`; each such call is
   * one step. The run's rows share a `runId` in the ledger, their spend
   * counts against `budgetCents`, and `maxSteps` bounds how many there are.
   */
  startRun(opts: StartRunOptions = {}): GovernedRun {
    return new GovernedRun(opts);
  }

  /** Continue a run from `run.snapshot()`, for a run that spans processes. */
  resumeRun(snapshot: RunSnapshot, opts: { parent?: GovernedRun } = {}): GovernedRun {
    return GovernedRun.fromSnapshot(snapshot, opts);
  }

  /**
   * Admit a call into its run, or refuse it. Runs after the rate limit and
   * the daily caps, before the cache and before any provider spend.
   *
   * Budget: refused when the run, or the nearest ancestor with a budget, has
   * spent it. Recorded as a spend-cap event carrying the run id; under
   * `caps.mode: "observe"` recorded and let through, like every other cap.
   * Step ceiling: always enforced, and the refusal leaves a zero-token usage
   * row (`provider: "run"`), because a denial the ledger cannot see is not
   * auditable.
   */
  private async enterRun(
    run: GovernedRun | undefined,
    ctx: {
      traceId: string;
      orgId?: string | null;
      userId?: string;
      route?: string;
      app?: string;
      slug?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Lineage> {
    if (!run) return undefined;
    const over = run.exhausted();
    if (over) {
      const enforced = this.caps.mode !== "observe";
      await this.recordCapEvent({
        userId: ctx.userId ?? null,
        orgId: ctx.orgId ?? null,
        capCents: over.budgetCents!,
        spentCents: over.spentCents,
        route: ctx.route ? `run:${ctx.route}` : "run",
        runId: over.id,
        wouldBlock: true,
        enforced,
        createdAt: new Date(),
      });
      if (enforced) {
        throw new RunLimitError("budget", over.id, {
          spentCents: over.spentCents,
          budgetCents: over.budgetCents,
          steps: over.steps,
          ...(over.maxSteps !== undefined ? { maxSteps: over.maxSteps } : {}),
        });
      }
    }
    if (run.atStepCeiling()) {
      await this.logUsage({
        metadata: ctx.metadata,
        orgId: ctx.orgId ?? undefined,
        app: ctx.app,
        userId: ctx.userId ?? null,
        route: ctx.route ?? null,
        promptSlug: ctx.slug ?? null,
        provider: "run",
        model: "step-limit",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostCents: 0,
        cacheHit: false,
        traceId: ctx.traceId,
        // The index the refused call would have had.
        lineage: { run, stepIndex: run.steps },
      });
      throw new RunLimitError("steps", run.id, {
        spentCents: run.spentCents,
        ...(run.budgetCents !== undefined ? { budgetCents: run.budgetCents } : {}),
        steps: run.steps,
        maxSteps: run.maxSteps,
      });
    }
    return { run, stepIndex: run.beginStep() };
  }

  /**
   * What this gateway is configured to enforce, as plain data: spend limits,
   * guardrail hooks, the model chain behind each task with its ZDR and
   * pricing status, tool policy, data handling and timeouts, plus `findings`,
   * the settings a reviewer should look at. `renderPolicyMarkdown()` turns it
   * into a document; `llm-gateway policy` prints it.
   *
   * It reads configuration and the two stores that decide routing (the task
   * override store and the chain). It calls no provider and reports no API
   * key and no endpoint URL. Chains are as resolved for `orgId` now; a store
   * can change them afterwards. `now` dates the pricing-staleness check.
   */
  async describePolicy(opts: { orgId?: string; now?: Date } = {}): Promise<PolicyReport> {
    const orgId = this.org(opts);
    const reg = this.registry.describe();
    const staleBefore = (opts.now ?? new Date()).getTime() - PRICING_STALE_AFTER_DAYS * 86_400_000;
    const describeModel = (provider: string, model: string): PolicyModel => {
      const kind = this.registry.isEndpoint(provider)
        ? "endpoint"
        : this.registry.isFactory(provider)
          ? "factory"
          : "provider";
      const asOf = kind === "endpoint" ? undefined : this.registry.pricingAsOf(model);
      return {
        provider,
        model,
        kind,
        zdr: this.registry.isZdr(provider, model),
        // A custom endpoint is self-hosted and ledgered at no charge.
        priced: kind === "endpoint" || this.registry.hasPricing(model),
        ...(asOf ? { pricingAsOf: asOf, pricingStale: Date.parse(asOf) < staleBefore } : {}),
      };
    };

    // The chain behind a call with no task: the store's, else the default.
    const stored = ((await this.modelConfig?.getChain(orgId)) ?? [])
      .map((l) => ({ provider: l.factory ?? l.endpoint ?? l.provider, model: l.model }))
      .filter((l): l is { provider: string; model: string } => !!l.provider);
    const defaultChain =
      stored.length > 0
        ? stored.map((l) => describeModel(l.provider, l.model))
        : [describeModel(reg.defaultModel.provider, reg.defaultModel.model)];
    const defaultChainSource =
      stored.length > 0 ? ("model config store" as const) : reg.defaultModel.source;

    const tasks: PolicyReport["tasks"] = [];
    for (const task of this.tasks?.tasks() ?? []) {
      const chain = await this.tasks!.chainForTask(task, orgId);
      tasks.push({
        task,
        label: this.tasks!.label(task),
        requireZdr: this.tasks!.requiresZdr(task),
        source: chain[0]!.source,
        chain: chain.map((c) => describeModel(c.provider, c.model)),
      });
    }

    const toolsGoverned = this.toolPolicy !== undefined || this.guardrails?.tool !== undefined;
    const caps = {
      mode: this.caps.mode === "observe" ? ("observe" as const) : ("enforce" as const),
      userDailyCents: this.caps.userDailyCents ?? DEFAULT_USER_CAP_CENTS,
      anonDailyCents: this.caps.anonDailyCents ?? DEFAULT_ANON_CAP_CENTS,
      globalDailyCents: this.caps.globalDailyCents ?? DEFAULT_GLOBAL_CAP_CENTS,
    };
    const routerInfo = this.tasks?.describe();
    const hooks = this.obs ?? {};

    // Findings: settings that weaken a control or make a number unreliable.
    // Facts about this configuration, worst first.
    const findings: string[] = [];
    if (this.mock) findings.push("Mock mode is on: no provider is called and no spend is real.");
    if (this.usage instanceof MemoryUsageStore) {
      findings.push(
        "The usage ledger is in memory: it is lost on restart, and the spend limits reset with it.",
      );
    }
    if (caps.mode === "observe") {
      findings.push(
        "Spend limits are in observe mode: a breach is recorded and the call is not refused.",
      );
    }
    const off = [
      caps.userDailyCents === 0 ? "per-user" : null,
      caps.anonDailyCents === 0 ? "anonymous" : null,
      caps.globalDailyCents === 0 ? "global" : null,
    ].filter(Boolean);
    if (off.length > 0) findings.push(`These daily spend limits are off: ${off.join(", ")}.`);
    if (this.guardrails?.failOpen) {
      findings.push("Guardrail hooks fail open: a hook that throws lets the call through.");
    }
    if (!this.encrypt) {
      findings.push(
        `No encrypt hook: prompt and output snapshots (first ${SNAPSHOT_LIMIT.toLocaleString("en-US")} ` +
          "characters of each) are stored as plaintext.",
      );
    }
    for (const t of tasks) {
      if (!t.requireZdr) continue;
      const not = t.chain.filter((m) => !m.zdr);
      if (not.length === t.chain.length) {
        findings.push(
          `Task "${t.task}" requires ZDR and no model in its chain is ZDR-asserted: every call to it is refused.`,
        );
      } else if (not.length > 0) {
        findings.push(
          `Task "${t.task}" requires ZDR: ${not.length} of the ${t.chain.length} models in its chain ` +
            `${not.length === 1 ? "is not ZDR-asserted and is" : "are not ZDR-asserted and are"} skipped ` +
            `(${not.map((m) => `${m.provider}:${m.model}`).join(", ")}).`,
        );
      }
    }
    const everyModel = new Map<string, PolicyModel>();
    for (const m of [...defaultChain, ...tasks.flatMap((t) => t.chain)]) {
      everyModel.set(`${m.provider}:${m.model}`, m);
    }
    for (const [id, m] of everyModel) {
      if (!m.priced) {
        findings.push(
          `${id} has no pricing: its cost is estimated from the fallback rate, so spend limits can undercount it.`,
        );
      } else if (m.pricingStale) {
        findings.push(
          `Pricing for ${id} is dated ${m.pricingAsOf}, more than ${PRICING_STALE_AFTER_DAYS} days old.`,
        );
      }
    }
    if (stored.length === 0 && reg.defaultModel.source === "library fallback") {
      findings.push(
        `No default model is configured: a call with no task uses the library's fallback, ` +
          `${reg.defaultModel.provider}:${reg.defaultModel.model}.`,
      );
    }
    if (this.rateLimiter instanceof MemoryRateLimiter) {
      findings.push(
        "The rate limiter is in memory: its limits are per process, not shared across instances.",
      );
    }

    return {
      app: this.appId,
      org: orgId ?? null,
      mock: this.mock,
      spendCaps: {
        ...caps,
        ...(this.caps.orgDailyCents !== undefined
          ? { orgDailyCents: this.caps.orgDailyCents }
          : {}),
        storeOverrides: {
          user: typeof this.usage.getUserDailyCapCents === "function",
          org: typeof this.usage.getOrgDailyCapCents === "function",
        },
      },
      guardrails: {
        pre: this.guardrails?.pre !== undefined,
        post: this.guardrails?.post !== undefined,
        tool: this.guardrails?.tool !== undefined,
        failOpen: this.guardrails?.failOpen === true,
      },
      judge: {
        ...(this.judgeDefaults?.model ? { model: this.judgeDefaults.model } : {}),
        ...(this.judgeDefaults?.sampleRate !== undefined
          ? { sampleRate: this.judgeDefaults.sampleRate }
          : {}),
      },
      ledger: {
        store: this.usage.constructor.name,
        snapshotsEncrypted: this.encrypt !== undefined,
        snapshotLimitChars: SNAPSHOT_LIMIT,
      },
      cache: {
        store: this.cache.constructor.name,
        ttlSeconds: this.cacheTtlSeconds,
        invalidatedOnPromptChange: this.scopeCacheToPrompt,
      },
      rateLimiter: this.rateLimiter.constructor.name,
      timeouts: {
        attemptMs: this.timeouts?.attemptMs ?? DEFAULT_ATTEMPT_MS,
        ...(this.timeouts?.deadlineMs !== undefined
          ? { deadlineMs: this.timeouts.deadlineMs }
          : {}),
        streamFirstChunkMs: this.timeouts?.streamFirstChunkMs ?? DEFAULT_STREAM_FIRST_CHUNK_MS,
        streamStallMs: this.timeouts?.streamStallMs ?? DEFAULT_STREAM_STALL_MS,
      },
      routing: {
        defaultChain,
        defaultChainSource,
        adminPin: this.modelConfig !== undefined,
        taskOverrideStore: routerInfo?.overrideStore ?? false,
        overridesBeatPin: routerInfo?.overridesBeatPin ?? false,
        slugPinWins: this.slugPinWins,
      },
      zdrLockedSlugs: [...this.zdrSlugs].sort(),
      tasks,
      ...(toolsGoverned
        ? {
            tools: Object.entries(this.toolPolicy ?? {}).map(([tool, p]) => ({
              tool,
              costCents:
                typeof p.costCents === "function" ? ("by arguments" as const) : (p.costCents ?? 0),
              ...(p.maxCalls !== undefined ? { maxCalls: p.maxCalls } : {}),
              ...(p.maxCents !== undefined ? { maxCents: p.maxCents } : {}),
            })),
          }
        : {}),
      retention: reg.retention,
      providers: {
        withKeys: this.registry.configuredProviders(),
        endpoints: reg.endpoints,
        factories: reg.factories,
        nativeAnthropic: this.anthropicCfg !== undefined,
        batch: this.batchCfg !== undefined,
      },
      pricingStaleAfterDays: PRICING_STALE_AFTER_DAYS,
      observability: (Object.keys(hooks) as (keyof ObservabilityHooks)[]).filter(
        (k) => typeof hooks[k] === "function",
      ),
      findings,
    };
  }

  /**
   * Throw unless every named tool has a `ToolPolicy` entry. Call it at
   * startup with the tools your agent uses (names, or the `tools` object
   * itself): a tool the policy forgot runs uncapped at 0¢, and that should
   * be a deploy-time error, not a warning nobody is reading.
   */
  preflightTools(tools: readonly string[] | Record<string, unknown>): void {
    const names = Array.isArray(tools) ? tools : Object.keys(tools);
    const missing = names.filter((n) => !(n in (this.toolPolicy ?? {})));
    if (missing.length === 0) return;
    throw new Error(
      `[llm-gateway] no ToolPolicy for: ${missing.join(", ")}. Add them to ` +
        `GatewayConfig.toolPolicy (an empty entry, {}, declares a free, uncapped tool).`,
    );
  }

  /** Register a deterministic responder used when mock mode is on. */
  registerMockResponder(slug: string, fn: (input: never) => unknown): void {
    this.mockResponders.set(slug, fn as MockResponder);
  }

  // -------------------------------------------------------------------------
  // Spend caps: global circuit breaker first (per-identity caps can't see
  // N users × cap on a viral day), then the per-identity cap.
  // -------------------------------------------------------------------------
  private async checkSpendCap(
    userId: string | undefined,
    route: string | undefined,
    /** Projected additional spend (batch reservations) counted against caps. */
    projectedCents = 0,
    /** Tenant scope. undefined = unscoped, i.e. today's behavior exactly. */
    orgId?: string | null,
  ) {
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);

    // Observe mode records the breach and lets the call through, so an adopter
    // can measure what their thresholds would have blocked before trusting
    // them. It deliberately keeps evaluating the remaining caps rather than
    // returning at the first breach: the whole point is complete data.
    const enforced = this.caps.mode !== "observe";
    const breach = async (
      event: Omit<SpendCapEvent, "createdAt" | "wouldBlock" | "enforced">,
      err: SpendCapError,
    ): Promise<void> => {
      await this.recordCapEvent({
        ...event,
        wouldBlock: true,
        enforced,
        createdAt: new Date(),
      });
      if (enforced) throw err;
    };

    // The circuit breaker. Scoped to the org when there is one: summing every
    // tenant's spend would let a busy tenant trip a quiet tenant's breaker,
    // which is the isolation failure org scoping exists to prevent.
    const globalCap = this.caps.globalDailyCents ?? DEFAULT_GLOBAL_CAP_CENTS;
    if (globalCap) {
      const total = (await this.usage.sumSpendCents(todayUtc, undefined, orgId)) + projectedCents;
      if (total >= globalCap) {
        await breach(
          {
            userId: userId ?? null,
            orgId: orgId ?? null,
            capCents: globalCap,
            spentCents: total,
            route: route ? `global:${route}` : "global",
          },
          new SpendCapError(total, globalCap, "global"),
        );
      }
    }

    // Optional explicit per-org cap, on top of the org-scoped breaker.
    if (orgId) {
      const orgCap = (await this.usage.getOrgDailyCapCents?.(orgId)) ?? this.caps.orgDailyCents;
      if (orgCap) {
        const orgSpent =
          (await this.usage.sumSpendCents(todayUtc, undefined, orgId)) + projectedCents;
        if (orgSpent >= orgCap) {
          await breach(
            {
              userId: userId ?? null,
              orgId,
              capCents: orgCap,
              spentCents: orgSpent,
              route: route ? `org:${route}` : "org",
            },
            new SpendCapError(orgSpent, orgCap, "global"),
          );
        }
      }
    }

    let capCents: number;
    if (userId) {
      capCents =
        (await this.usage.getUserDailyCapCents?.(userId, orgId)) ??
        this.caps.userDailyCents ??
        DEFAULT_USER_CAP_CENTS;
    } else {
      capCents = this.caps.anonDailyCents ?? DEFAULT_ANON_CAP_CENTS;
    }
    if (!capCents) return; // explicit 0 = deliberate opt-out

    const spent =
      (await this.usage.sumSpendCents(todayUtc, userId ?? null, orgId)) + projectedCents;
    if (spent >= capCents) {
      await breach(
        {
          userId: userId ?? null,
          orgId: orgId ?? null,
          capCents,
          spentCents: spent,
          route: route ?? null,
        },
        new SpendCapError(spent, capCents),
      );
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
  /**
   * Resolve the prompt early when the cache key must include it.
   *
   * The default ordering reads the cache BEFORE loading the prompt, which
   * saves a store round-trip on every hit. That optimisation is exactly why a
   * prompt edit does not invalidate anything, so scoping the key to the prompt
   * necessarily gives it up — for the calls that opt in, and only those.
   *
   * An inline `promptBody` needs no store read at all: the prompt is already
   * in hand, so it is fingerprinted without any extra cost.
   */
  private async prefetchPromptForKey(
    opts: { slug: string; promptBody?: string },
    orgId: string | null | undefined,
    useCache: boolean,
  ): Promise<PromptConfig | undefined> {
    if (!useCache || !this.scopeCacheToPrompt) return undefined;
    if (opts.promptBody) return { body: opts.promptBody };
    return await this.loadPrompt(opts.slug, orgId);
  }

  private async loadPrompt(slug: string, orgId?: string | null): Promise<PromptConfig> {
    const def = this.promptDefaults.find((d) => d.slug === slug);

    let row: StoredPrompt | undefined;
    try {
      row = await this.prompts.getPrompt(slug, orgId);
    } catch (err) {
      if (!def) throw err;
      console.warn(
        `[llm-gateway] prompt store unreachable for "${slug}", using code default:`,
        err instanceof Error ? err.message : err,
      );
      return { body: def.body, modelHint: def.modelHint, ...slugPins(undefined, def) };
    }

    if (!row) {
      if (!def) {
        throw new Error(`prompt "${slug}" not found in store or promptDefaults.`);
      }
      await this.prompts
        .seedPrompt?.(def, orgId)
        ?.catch((err: unknown) =>
          console.warn(`[llm-gateway] auto-seed of "${slug}" failed:`, err),
        );
      return { body: def.body, modelHint: def.modelHint, ...slugPins(undefined, def) };
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
      ...slugPins(row, def),
    };
  }

  /**
   * The slug's model fields for a call that did not load its prompt from the
   * store (an inline `promptBody`, or `streamText`, whose caller assembles
   * the prompt). The slug names the model on those calls too. A slug with no
   * row and no code default simply pins nothing.
   */
  private async loadSlugPins(
    slug: string,
    orgId?: string | null,
  ): Promise<PromptConfig | undefined> {
    const def = this.promptDefaults.find((d) => d.slug === slug);
    let row: StoredPrompt | undefined;
    try {
      row = await this.prompts.getPrompt(slug, orgId);
    } catch (err) {
      // Same rule as loadPrompt: an unreachable store degrades to the code
      // default, it does not fail the call.
      console.warn(
        `[llm-gateway] prompt store unreachable for "${slug}", using the code default's model:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (!row && !def) return undefined;
    return {
      body: "",
      modelHint: row ? (row.modelHint ?? undefined) : def?.modelHint,
      providerOverride: row?.providerOverride ?? undefined,
      ...slugPins(row, def),
    };
  }

  /**
   * The slug's own chain under `slugPinWins`: its model, its fallbacks, then
   * the configured chain, each link tagged with the layer it came from.
   * Null when the flag is off or the slug pins nothing, and the caller then
   * resolves as it always has.
   *
   * ZDR filters every layer. A ZDR-required call whose slug models are all
   * ineligible throws: a wrong pin on a locked slug must fail loudly rather
   * than quietly run somewhere else.
   */
  private async slugChain(args: {
    slug: string;
    pins: PromptConfig | undefined;
    tier: "fast" | "power" | undefined;
    orgId: string | undefined;
    requireZdr: boolean;
    keepKeyless?: ProviderId[];
  }): Promise<RoutedLink[] | null> {
    if (!this.slugPinWins || !args.pins) return null;
    const { pins, tier } = args;
    const head =
      pins.tierModels && tier ? pins.tierModels[tier] : (pins.modelHint ?? pins.tierModels?.power);
    if (!head) return null;

    const resolve = (id: string) => {
      const r = this.registry.resolveSlugModel(id, pins.providerOverride);
      const warnKey = `slug\u0000${args.slug}\u0000${id}`;
      if (!r && !this.badModelHintWarned.has(warnKey)) {
        this.badModelHintWarned.add(warnKey);
        console.warn(
          `[llm-gateway] slug "${args.slug}" pins "${id}", which is not usable as a model id` +
            (pins.providerOverride ? ` for provider "${pins.providerOverride}"` : "") +
            ` — skipping it. Fix the prompt row: a pin that is skipped means the call runs ` +
            `on a model the slug did not name.`,
        );
      }
      return r;
    };
    const first = resolve(head);
    // An unusable head is not a pin: fall through to ordinary resolution,
    // which is what a bad `modelHint` has always done.
    if (!first) return null;

    const link = (m: { provider: string; model: string }, routedBy: RoutedBy): RoutedLink => ({
      provider: m.provider,
      model: m.model,
      languageModel: this.registry.buildAny(m.provider, m.model) ?? undefined,
      routedBy,
    });
    const slugLinks: RoutedLink[] = [link(first, "slug")];
    for (const id of pins.fallbackModels ?? []) {
      const m = resolve(id);
      if (m) slugLinks.push(link(m, "slug-fallback"));
    }

    const isZdr = (l: ChainLink) => this.registry.isZdr(l.provider, l.model);
    const eligible = args.requireZdr ? slugLinks.filter(isZdr) : slugLinks;
    if (eligible.length === 0) {
      throw new ZdrViolationError(first.provider, first.model, `slug "${args.slug}" pin`);
    }

    // Past the slug's own models the call goes straight to the chain. The
    // admin pin and the task are skipped: the slug outranks both.
    const chainCfg = (await this.modelConfig?.getChain(args.orgId)) ?? [];
    const chain = this.registry
      .buildChain(chainCfg, tier, args.keepKeyless)
      .filter((l) => !args.requireZdr || isZdr(l))
      .map((l): RoutedLink => ({ ...l, routedBy: "chain" }));
    const seen = new Set(eligible.map((l) => `${l.provider}\u0000${l.model}`));
    return [...eligible, ...chain.filter((l) => !seen.has(`${l.provider}\u0000${l.model}`))];
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
    budget: AttemptBudget = new AttemptBudget(),
    attemptMs = DEFAULT_ATTEMPT_MS,
    /** Called for each link cut short by our own clock, so it is ledgered. */
    onAttemptTimeout?: (provider: string, model: string, durationMs: number) => Promise<void>,
  ) {
    const start = Date.now();
    let lastErr: unknown;
    for (const link of chain) {
      // Rule 2: do not open a connection the budget cannot see through.
      throwIfOutOfBudget(budget, "before-link");
      const linkStart = Date.now();
      try {
        const result = await this.execLink(
          link,
          zodSchema,
          prompt,
          system,
          temperature,
          native,
          budget,
          attemptMs,
        );
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
        // A blown deadline and a caller abort are terminal (Rule 4).
        if (err instanceof DeadlineExceededError) throw err;
        if (budget.callerSignal?.aborted) throw err;
        // Fall to the next link on transient errors, on persistent schema
        // invalidity (a different model may satisfy the schema where this one
        // couldn't, post-repair), and on an attempt timeout — but never retry
        // a link that just proved it is slow. Anything else is a caller error.
        const timedOut = err instanceof AttemptTimeoutError;
        if (timedOut) {
          await onAttemptTimeout?.(link.provider, link.model, Date.now() - linkStart);
        }
        if (!timedOut && !this.retryable(err) && !isSchemaValidationError(err)) throw err;
        const reason = timedOut
          ? "attempt-timeout"
          : isSchemaValidationError(err)
            ? "schema-invalid"
            : "retryable";
        console.warn(
          `[llm-gateway] "${link.provider}/${link.model}" failed (${reason}), trying next in chain`,
        );
      }
    }
    throw lastErr ?? new Error("AI chain exhausted with no result");
  }

  // ===========================================================================
  // The front door, shared by runStructured, runText and streamStructured:
  // identity → rate limit → spend cap → cache key → prompt → pre guardrail →
  // cache read (post guardrail on a hit). One implementation, so a check added
  // to the pipeline lands on every path at once. 0.16.0 put the guardrail hooks
  // on runStructured only because each path carried its own copy of this
  // sequence; that is the gap this closes. Batch has its own shape (per-item
  // prompts, a reservation row) and runs the hooks in submitBatch/reconcileBatch.
  // ===========================================================================

  private async frontDoor<I, V>(
    kind: "runStructured" | "runText" | "streamStructured" | "streamText" | "generateText",
    opts: FrontDoorOptions<I>,
    validate: (raw: unknown) => V,
  ): Promise<FrontDoor<V>> {
    const traceId = randomUUID();
    const orgId = this.org(opts);
    const identifier = opts.userId ?? (opts.anonKey ? `anon:${opts.anonKey}` : "anon");
    const requireZdr =
      opts.requireZdr === true ||
      (opts.task !== undefined && (this.tasks?.requiresZdr(opts.task) ?? false)) ||
      // A lock set in code: the slug is ZDR-required whatever the call says.
      this.zdrSlugs.has(opts.slug);

    // 1. Rate limit
    const rl = await this.rateLimiter.limit(identifier);
    if (!rl.success) throw new RateLimitError(rl.limit, rl.remaining);

    // 2. Spend cap
    await this.checkSpendCap(opts.userId, opts.route, 0, orgId);

    // 2b. Run limits: the run's budget and step ceiling, then this call
    // becomes the run's next step.
    const lineage = await this.enterRun(opts.run, {
      traceId,
      orgId,
      userId: opts.userId,
      route: opts.route,
      app: opts.app,
      slug: opts.slug,
      metadata: opts.metadata,
    });

    // 3. Cache key
    const useCache = opts.cache !== false;
    if (useCache && !opts.cacheParts) {
      throw new Error(`${kind}: cacheParts is required unless cache:false is set.`);
    }
    const prefetched = await this.prefetchPromptForKey(opts, orgId, useCache);
    const key = useCache
      ? cacheKey(
          opts.slug,
          opts.cacheParts!,
          orgId,
          prefetched ? promptFingerprint(prefetched) : undefined,
        )
      : null;

    const failOpen = this.guardrails?.failOpen === true;
    const guardrailRecords: GuardrailRecord[] = [];
    const rowBase = {
      metadata: opts.metadata,
      orgId,
      app: opts.app,
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: opts.slug,
      traceId,
      zdrEnforced: requireZdr ? true : null,
      lineage,
    };

    // 4. Prompt. Loaded lazily: before the cache read when a hook needs the
    // rendered prompt (so policy applies to hits too), otherwise after it, so
    // a plain cache hit still costs no prompt-store read.
    let promptConfig: PromptConfig | undefined = prefetched;
    let prompt: string | undefined;
    const loadAndRender = async () => {
      promptConfig ??= opts.promptBody
        ? { body: opts.promptBody }
        : await this.loadPrompt(opts.slug, orgId);
      prompt = renderTemplate(promptConfig.body, opts.variables(opts.input));
    };

    // 4b. Pre guardrail: policy on the rendered prompt, before the cache read
    // and before any provider spend. A block costs no tokens but still writes
    // a zero-token usage row carrying the verdict — an audit that cannot see
    // blocked calls is not an audit. A transform replaces the prompt that goes
    // out. Runs in mock mode too, so CI can test policy.
    if (this.guardrails?.pre) {
      await loadAndRender();
      const { verdict, record } = await runGuardrail(
        this.guardrails.pre,
        "pre",
        {
          slug: opts.slug,
          prompt: prompt!,
          system: opts.system,
          input: opts.input,
          traceId,
          userId: opts.userId ?? null,
          orgId: orgId ?? null,
          route: opts.route ?? null,
          task: opts.task,
        },
        failOpen,
      );
      guardrailRecords.push(record);
      if (verdict.action === "block") {
        await this.logUsage({
          ...rowBase,
          provider: "guardrail",
          model: "pre",
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostCents: 0,
          cacheHit: false,
          durationMs: record.durationMs,
          inputText: prompt!,
          outputText: null,
          guardrails: guardrailRecords,
        });
        throw guardrailError(record);
      }
      if (verdict.action === "transform" && typeof verdict.prompt === "string") {
        prompt = verdict.prompt;
      }
    }

    // 4c. Cache read. A hit runs the post hook too: policy applies to what the
    // caller receives, whether a provider produced it just now or last week.
    // A transformed hit is returned but not written back; a blocked hit writes
    // the cache row with the verdict and throws.
    if (key) {
      const cached = await this.cache.get<V>(key);
      if (cached !== undefined) {
        let value: V = cached as V;
        if (this.guardrails?.post) {
          if (prompt === undefined) await loadAndRender();
          const out = await this.applyPostGuardrail(
            this.postCtx(opts, prompt!, traceId, orgId, value, "cache", "cache"),
            value,
            validate,
            failOpen,
            guardrailRecords,
          );
          value = out.value;
          if (out.blocked) {
            await this.logUsage({
              ...rowBase,
              provider: "cache",
              model: "cache",
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostCents: 0,
              cacheHit: true,
              outputText: typeof value === "string" ? value : JSON.stringify(value),
              guardrails: guardrailRecords,
            });
            throw guardrailError(out.blocked, value);
          }
        }
        const usageLogId = await this.logUsage({
          ...rowBase,
          provider: "cache",
          model: "cache",
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostCents: 0,
          cacheHit: true,
          guardrails: guardrailRecords.length > 0 ? guardrailRecords : null,
        });
        return {
          lineage,
          traceId,
          orgId,
          requireZdr,
          pins: undefined, // a cache hit resolves no model
          key,
          prompt: prompt ?? "",
          promptConfig: promptConfig ?? { body: "" },
          temperature: opts.temperature ?? promptConfig?.temperature,
          guardrailRecords,
          failOpen,
          cached: { value, usageLogId },
        };
      }
    }

    // 4d. Prompt for the generation paths (inline promptBody skips the store).
    if (prompt === undefined) await loadAndRender();
    // The slug's model pins. An inline body skipped the store, so they are
    // read on their own; either way the slug still names the model.
    const pins = !this.slugPinWins
      ? undefined
      : opts.promptBody
        ? await this.loadSlugPins(opts.slug, orgId)
        : promptConfig!;
    return {
      lineage,
      traceId,
      orgId,
      requireZdr,
      pins,
      key,
      prompt: prompt!,
      promptConfig: promptConfig!,
      temperature: opts.temperature ?? promptConfig!.temperature,
      guardrailRecords,
      failOpen,
    };
  }

  /** The post-hook context for a unary or stream call. */
  private postCtx<I>(
    opts: FrontDoorOptions<I>,
    prompt: string,
    traceId: string,
    orgId: string | undefined,
    output: unknown,
    provider: string,
    model: string,
  ): PostGuardrailContext {
    return {
      slug: opts.slug,
      prompt,
      system: opts.system,
      input: opts.input,
      output,
      provider,
      model,
      traceId,
      userId: opts.userId ?? null,
      orgId: orgId ?? null,
      route: opts.route ?? null,
      task: opts.task,
    };
  }

  /**
   * Run the post hook on `value` and apply its verdict. A transform must still
   * satisfy the caller's shape (`validate`): a scrubber that breaks it would
   * otherwise hand the caller (and the cache) a value the type system says
   * cannot exist, so an invalid transform is a block, or under `failOpen` an
   * allow of the original value with the error recorded. Never throws; the
   * caller writes the usage row and throws on `blocked`.
   */
  private async applyPostGuardrail<V>(
    ctx: PostGuardrailContext,
    value: V,
    validate: (raw: unknown) => V,
    failOpen: boolean,
    records: GuardrailRecord[],
  ): Promise<{ value: V; blocked?: GuardrailRecord }> {
    const { verdict, record } = await runGuardrail(this.guardrails!.post!, "post", ctx, failOpen);
    let blocked: GuardrailRecord | undefined;
    if (verdict.action === "transform" && verdict.output !== undefined) {
      try {
        value = validate(verdict.output);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record.error = `transform produced schema-invalid output: ${message}`;
        if (!failOpen) {
          record.action = "block";
          record.reason = record.error;
          blocked = record;
        } else {
          record.action = "allow";
        }
      }
    } else if (verdict.action === "block") {
      blocked = record;
    }
    records.push(record);
    return { value, blocked };
  }

  private readonly warnedShadowedTasks = new Set<string>();

  /**
   * The admin pin, `ModelConfigStore.getOverride()`. By default a pin
   * outranks task routing entirely, `TaskOverrideStore` entries included —
   * but a call that names a task and silently gets the pin instead is the
   * shape of issue #57. With `tasks.overridesBeatPin`, a task's store entry
   * wins (null here); otherwise warn once per shadowed task.
   */
  private async adminPin(
    orgId: string | undefined,
    tier: "fast" | "power" | undefined,
    task: string | undefined,
  ): Promise<{ provider: ProviderId; model: string } | null> {
    if (task !== undefined && (await this.tasks?.beatsPin(task, orgId))) return null;
    const pin = (await this.modelConfig?.getOverride(orgId, tier)) ?? null;
    if (pin && task !== undefined && !this.warnedShadowedTasks.has(task)) {
      this.warnedShadowedTasks.add(task);
      console.warn(
        `[llm-gateway] task "${task}" is shadowed: ModelConfigStore.getOverride() returned a pin ` +
          `(${pin.provider}/${pin.model}), and a pin outranks task routing, TaskOverrideStore ` +
          `entries included. Return null from getOverride() to let tasks route. Warned once per task. (#57)`,
      );
    }
    return pin;
  }

  private async logUsage(row: LedgerRow): Promise<string | number> {
    const enc = (t: string | null) => (t != null && this.encrypt ? this.encrypt(t) : t);
    const { lineage, ...f } = row;
    const entry: UsageEntry = {
      ...f,
      // Run lineage, stamped here and nowhere else. Absent (not null) outside
      // a run, so rows written without one are shaped exactly as before.
      ...(lineage
        ? {
            runId: lineage.run.id,
            stepIndex: lineage.stepIndex,
            parentRunId: lineage.run.parentRunId ?? null,
          }
        : {}),
      app: f.app ?? this.appId,
      // Stamped like appId: a row without a tenant is unscoped, which is what
      // a single-tenant deployment produces and what it produced before.
      orgId: f.orgId ?? this.orgId ?? null,
      // Prompts and outputs can carry user PII. When an encrypt hook is
      // configured, the encrypted-at-rest guarantee holds for telemetry too.
      inputText: enc(truncate(f.inputText)),
      outputText: enc(truncate(f.outputText)),
      createdAt: new Date(),
    };
    // Routing is recorded only once the adopter has opted in; with the flag
    // off a row is shaped exactly as it was.
    if (!this.slugPinWins || entry.routedBy == null) delete entry.routedBy;
    const id = await this.usage.logUsage(entry);
    // The run's spend is counted from the row that was just written, so the
    // run and the ledger cannot disagree. Cache hits cost nothing by
    // construction and are excluded the same way sumSpendCents excludes them.
    if (lineage && !entry.cacheHit) {
      lineage.run.record(entry.estimatedCostCents);
      if (lineage.turn) lineage.turn.ledgeredCents += entry.estimatedCostCents;
    }
    this.emitObs("onUsage", this.obs?.onUsage, { ...entry, id });
    return id;
  }

  async runStructured<I, O>(opts: RunStructuredOptions<I, O>): Promise<RunStructuredResult<O>> {
    const validate = (raw: unknown): O =>
      isZodSchema(opts.schema) ? opts.schema.parse(raw) : (raw as O);
    // 1-4b. Rate limit, spend cap, cache key, prompt, pre guardrail, cache read.
    const fd = await this.frontDoor<I, O>("runStructured", opts, validate);
    if (fd.cached) {
      return {
        object: fd.cached.value,
        traceId: fd.traceId,
        cacheHit: true,
        usageLogId: fd.cached.usageLogId,
      };
    }
    const { traceId, orgId, requireZdr, key, prompt, promptConfig, temperature } = fd;
    const { guardrailRecords, failOpen, lineage } = fd;
    const assertZdr = (p: string, m: string, context: string) => {
      if (requireZdr && !this.registry.isZdr(p, m)) {
        throw new ZdrViolationError(p, m, context);
      }
    };

    // Native features must never silently not apply.
    if (opts.anthropic && !this.anthropicCfg && !this.mock) {
      throw new Error(
        "runStructured received `anthropic` native options but GatewayConfig.anthropic is not configured.",
      );
    }

    const { budget, attemptMs } = this.newBudget(opts);
    const ledgerAbortedAttempt = (p: string, m: string, ms: number) =>
      this.logAbortedAttempt(
        {
          app: opts.app,
          userId: opts.userId,
          route: opts.route,
          slug: opts.slug,
          orgId,
          metadata: opts.metadata,
          lineage,
        },
        p,
        m,
        traceId,
        ms,
        prompt,
      ).then(() => undefined);

    /**
     * Single-link paths (task routing, admin override, static default) have no
     * chain loop to catch a timeout, so they ledger here. Without this a
     * task-routed call — the shape the first adopter uses for everything —
     * would be the one path where a timed-out attempt left no audit trail.
     */
    const ledgerOnAttemptTimeout = async <T>(
      p: string,
      m: string,
      run: () => Promise<T>,
    ): Promise<T> => {
      const linkStart = Date.now();
      try {
        return await run();
      } catch (err) {
        if (err instanceof AttemptTimeoutError) {
          await ledgerAbortedAttempt(p, m, Date.now() - linkStart);
        }
        throw err;
      }
    };

    // 5. Generate
    let object: O;
    let inputTokens: number;
    let outputTokens: number;
    let provider: string;
    let model: string;
    let routedBy: RoutedBy | undefined;
    let durationMs: number;
    let extras:
      | { cacheCreateTokens: number; cacheReadTokens: number; webSearches: number }
      | undefined;

    if (this.mock) {
      const responder = this.mockResponders.get(opts.slug);
      if (!responder) {
        throw new Error(`Mock mode is on but no responder registered for "${opts.slug}".`);
      }
      {
        const raw = responder(opts.input);
        object = isZodSchema(opts.schema) ? opts.schema.parse(raw) : (raw as O);
      }
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
      // With `slugPinWins`, a slug that pins a model outranks all four: its
      // own model, its fallbacks, then the chain (see slugChain).
      const pinned = await this.slugChain({
        slug: opts.slug,
        pins: fd.pins,
        tier: opts.tier,
        orgId,
        requireZdr,
        ...(opts.anthropic && this.anthropicCfg ? { keepKeyless: ["anthropic" as const] } : {}),
      });
      const adminOverride = pinned ? null : await this.adminPin(orgId, opts.tier, opts.task);

      if (pinned) {
        const usable = pinned.filter(
          (l) =>
            l.languageModel || (opts.anthropic && l.provider === "anthropic" && this.anthropicCfg),
        );
        if (usable.length === 0) {
          throw new Error(
            `Slug "${opts.slug}" pins "${pinned[0]!.provider}/${pinned[0]!.model}" but that provider has no API key, and no chain link is usable either.`,
          );
        }
        // Walked by the same loop as any chain: repair retries, transient
        // retries, schema-invalid fall-through and timeout ledgering.
        const gen = await this.callWithChain(
          usable,
          opts.schema,
          prompt,
          temperature,
          opts.system,
          opts.anthropic,
          budget,
          attemptMs,
          ledgerAbortedAttempt,
        );
        object = gen.object;
        inputTokens = gen.inputTokens;
        outputTokens = gen.outputTokens;
        provider = gen.provider;
        model = gen.model;
        durationMs = gen.durationMs;
        extras = gen.extras;
        routedBy = usable.find((l) => l.provider === provider && l.model === model)?.routedBy;
      } else if (!adminOverride && opts.task) {
        if (!this.tasks) {
          throw new Error(
            `runStructured received task "${opts.task}" but GatewayConfig.tasks is not configured.`,
          );
        }
        // Per-task failover chain, walked by the same callWithChain loop the
        // main chain uses — so a task gets repair retries, transient retries,
        // schema-invalid fall-through and timeout ledgering identically.
        const taskChain = await this.tasks.chainForTask(opts.task, orgId);
        routedBy = taskRoute(taskChain[0]!.source);
        let taskLinks: ChainLink[] = taskChain.map((t) => ({
          provider: t.provider,
          model: t.model,
          languageModel: this.registry.buildAny(t.provider, t.model) ?? undefined,
        }));

        // ZDR now filters the chain rather than hard-failing the first link:
        // task routing used to collapse to one link BEFORE this ran, so an
        // ineligible task model errored instead of skipping to an eligible one.
        if (requireZdr) {
          const eligible = taskLinks.filter((l) => this.registry.isZdr(l.provider, l.model));
          if (eligible.length === 0) {
            throw new ZdrViolationError(
              taskLinks[0]!.provider,
              taskLinks[0]!.model,
              `task "${opts.task}" chain`,
            );
          }
          taskLinks = eligible;
        }

        const usable = taskLinks.filter(
          (l) =>
            l.languageModel || (opts.anthropic && l.provider === "anthropic" && this.anthropicCfg),
        );
        if (usable.length === 0) {
          throw new Error(
            `Task "${opts.task}" routes to "${taskLinks[0]!.provider}/${taskLinks[0]!.model}" but that provider has no API key.`,
          );
        }

        const gen = await this.callWithChain(
          usable,
          opts.schema,
          prompt,
          temperature,
          opts.system,
          opts.anthropic,
          budget,
          attemptMs,
          ledgerAbortedAttempt,
        );
        object = gen.object;
        inputTokens = gen.inputTokens;
        outputTokens = gen.outputTokens;
        provider = gen.provider;
        model = gen.model;
        durationMs = gen.durationMs;
        extras = gen.extras;
      } else if (adminOverride) {
        routedBy = "admin-pin";
        // The hint is validated against the admin's pinned provider, so it
        // can only name a model for that provider — the pin stays in force.
        const adminHint = this.validatedModelHint(promptConfig.modelHint, adminOverride.provider);
        const resolved = this.registry.resolveDefault({
          provider: adminOverride.provider,
          model: adminHint?.model ?? adminOverride.model,
        });
        assertZdr(resolved.provider, resolved.model, "admin model override");
        const nativeApplies =
          opts.anthropic && resolved.provider === "anthropic" && this.anthropicCfg;
        if (!resolved.languageModel && !nativeApplies) {
          throw new Error(`No API key for provider "${resolved.provider}".`);
        }
        const start = Date.now();
        const result = await ledgerOnAttemptTimeout(resolved.provider, resolved.model, () =>
          this.execLink(
            resolved,
            opts.schema,
            prompt,
            opts.system,
            temperature,
            opts.anthropic,
            budget,
            attemptMs,
          ),
        );
        object = result.object;
        inputTokens = result.usage.inputTokens;
        outputTokens = result.usage.outputTokens;
        provider = resolved.provider;
        model = resolved.model;
        durationMs = Date.now() - start;
        extras = result.extras;
      } else {
        const chainCfg = (await this.modelConfig?.getChain(orgId)) ?? [];
        const fullChain = this.registry.buildChain(
          chainCfg,
          opts.tier,
          opts.anthropic && this.anthropicCfg ? ["anthropic"] : undefined,
        );
        // ZDR: SKIP non-eligible links; error only when the constraint
        // eliminated every link that would otherwise have run.
        const chain = requireZdr
          ? fullChain.filter((l) => this.registry.isZdr(l.provider, l.model))
          : fullChain;
        if (requireZdr && fullChain.length > 0 && chain.length === 0) {
          throw new ZdrViolationError(
            fullChain[0]!.provider,
            fullChain[0]!.model,
            `all ${fullChain.length} chain link(s) filtered out`,
          );
        }

        routedBy = chain.length === 0 ? "default" : "chain";
        if (chain.length === 0) {
          const rowProvider = promptConfig.providerOverride as ProviderId | undefined;
          const validHint = this.validatedModelHint(promptConfig.modelHint, rowProvider);
          // A provider is only ever passed together with a model for it.
          // `resolveDefault` fills an absent model from `defaultModel`, so
          // handing it a provider on its own pairs, say, providerOverride
          // "openai" with the configured default "claude-sonnet-4-6" and
          // 404s — which is how a row with no usable hint reached the
          // provider API before. Without a usable hint the whole override is
          // dropped and the configured default PAIR resolves, exactly as it
          // did when `modelHint` was absent in 0.14.0.
          const hintProvider = validHint?.provider ?? rowProvider;
          const resolved = this.registry.resolveDefault(
            validHint
              ? {
                  model: validHint.model,
                  ...(hintProvider ? { provider: hintProvider } : {}),
                }
              : undefined,
          );
          assertZdr(resolved.provider, resolved.model, "default model resolution");
          const nativeApplies =
            opts.anthropic && resolved.provider === "anthropic" && this.anthropicCfg;
          if (!resolved.languageModel && !nativeApplies) {
            throw new Error(
              "No AI provider configured. Set an API key (config or env) or provide a ModelConfigStore.",
            );
          }
          const start = Date.now();
          const result = await ledgerOnAttemptTimeout(resolved.provider, resolved.model, () =>
            this.execLink(
              resolved,
              opts.schema,
              prompt,
              opts.system,
              temperature,
              opts.anthropic,
              budget,
              attemptMs,
            ),
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
            budget,
            attemptMs,
            ledgerAbortedAttempt,
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

    // 5b. Post guardrail: policy on the schema-valid object, before the cache
    // write (a transformed object is what gets cached) and before the judge
    // (the judge scores what the caller will receive). A block writes the
    // usage row first — the tokens were spent — then throws with the object
    // attached, so a reviewer can still be shown what was rejected.
    if (this.guardrails?.post) {
      const out = await this.applyPostGuardrail(
        this.postCtx(opts, prompt, traceId, orgId, object, provider, model),
        object,
        validate,
        failOpen,
        guardrailRecords,
      );
      object = out.value;
      if (out.blocked) {
        await this.logUsage({
          lineage,
          metadata: opts.metadata,
          orgId,
          app: opts.app,
          userId: opts.userId ?? null,
          route: opts.route ?? null,
          promptSlug: opts.slug,
          provider,
          model,
          routedBy,
          inputTokens,
          outputTokens,
          estimatedCostCents: this.registry.estimateForLink(
            provider,
            model,
            inputTokens,
            outputTokens,
            extras,
          ),
          cacheHit: false,
          traceId,
          durationMs,
          cacheCreateTokens: extras?.cacheCreateTokens ?? null,
          cacheReadTokens: extras?.cacheReadTokens ?? null,
          webSearches: extras?.webSearches ?? null,
          zdrEnforced: requireZdr ? true : null,
          inputText: prompt,
          outputText: JSON.stringify(object),
          guardrails: guardrailRecords,
        });
        throw guardrailError(out.blocked, object);
      }
    }

    // 6. Cache write
    if (key) await this.cache.set(key, object, this.cacheTtlSeconds);

    // 7. Usage log
    const usageLogId = await this.logUsage({
      lineage,
      metadata: opts.metadata,
      orgId,
      app: opts.app,
      userId: opts.userId ?? null,
      route: opts.route ?? null,
      promptSlug: opts.slug,
      provider,
      model,
      routedBy,
      inputTokens,
      outputTokens,
      estimatedCostCents: this.registry.estimateForLink(
        provider,
        model,
        inputTokens,
        outputTokens,
        extras,
      ),
      cacheHit: false,
      traceId,
      durationMs,
      cacheCreateTokens: extras?.cacheCreateTokens ?? null,
      cacheReadTokens: extras?.cacheReadTokens ?? null,
      webSearches: extras?.webSearches ?? null,
      zdrEnforced: requireZdr ? true : null,
      inputText: prompt,
      outputText: JSON.stringify(object),
      guardrails: guardrailRecords.length > 0 ? guardrailRecords : null,
    });

    // 8a. Free caller-computed rubric
    if (opts.judgeRubric) {
      const rubric = opts.judgeRubric(object);
      const values = Object.values(rubric);
      const overall = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      await this.saveJudge({
        usageLogId,
        rubric,
        overallScore: overall,
        createdAt: new Date(),
      });
    }

    // 8b. Model-graded judge (sampled, budget-aware, may gate)
    if (opts.judge) {
      await this.runJudge(opts, prompt, object, usageLogId, requireZdr, lineage);
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
    requireZdr = false,
    lineage: Lineage = undefined,
  ): Promise<void> {
    const judge = opts.judge!;
    const orgId = this.org(opts);
    const criteria = Object.keys(judge.criteria);
    if (criteria.length === 0) return;

    const sampleRate = judge.sampleRate ?? this.judgeDefaults?.sampleRate ?? 1;
    const rng = this.judgeDefaults?.random ?? Math.random;
    if (sampleRate <= 0 || rng() >= sampleRate) return;

    // Resolution: per-call > admin-pinned judge tier > gateway judge default
    // > the default provider's judge tier (which falls back to its fast tier).
    //
    // The admin pin is what makes the judge a first-class tier rather than
    // something coupled to the default provider: an operator can put the
    // judge on a cheap, ZDR-compliant model from a DIFFERENT provider without
    // touching the generation chain. Store failures degrade to config rather
    // than failing the call — a judge is never the thing that breaks a
    // response (the same rule PR 20 established for judge timeouts).
    let adminJudgeModel: string | null | undefined;
    try {
      adminJudgeModel = await this.modelConfig?.getJudgeModel?.(orgId);
    } catch (err) {
      console.warn(
        "[llm-gateway] judge model store unreachable, using configured default:",
        err instanceof Error ? err.message : err,
      );
    }

    const modelId =
      judge.model ??
      adminJudgeModel ??
      this.judgeDefaults?.model ??
      (() => {
        const d = this.registry.resolveDefault();
        const t = this.registry.tierModel(d.provider, "judge");
        return t ? `${d.provider === "anthropic" ? "" : d.provider + ":"}${t}` : null;
      })();
    if (!modelId) {
      console.warn("[llm-gateway] judge skipped: no judge model resolvable");
      return;
    }
    const { provider, model } = this.registry.parseAny(modelId);

    // The judge sees the same data as the main call — the retention
    // constraint applies to it too. Skip (never fail the main response).
    if (requireZdr && !this.mock && !this.registry.isZdr(provider, model)) {
      console.warn(
        `[llm-gateway] judge skipped for "${opts.slug}": judge model "${provider}/${model}" is not asserted ZDR and this call requires it`,
      );
      return;
    }

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
        console.warn(`[llm-gateway] mock mode: no "judge:${opts.slug}" responder — judge skipped`);
        return;
      }
      scores = scoreSchema.parse(responder(object));
      inputTokens = Math.ceil(judgePrompt.length / 4);
      outputTokens = criteria.length * 12;
      judgeProvider = "mock";
      judgeModel = "mock";
      durationMs = 0;
    } else {
      const lm = this.registry.buildAny(provider, model);
      if (!lm) {
        console.warn(`[llm-gateway] judge skipped: no API key for "${provider}"`);
        return;
      }
      const start = Date.now();
      // The judge gets its OWN small budget rather than sharing the main
      // call's: sharing means a slow main call starves the judge into a
      // timeout, so judge coverage would silently drop exactly when calls are
      // slow — the moment the scoring data is most wanted. Skipping is the
      // judge's established failure mode (it already self-skips under spend
      // pressure), so a judge that runs out of clock must never fail the main
      // response. Consequence, accepted: total wall-clock can exceed the
      // caller's deadlineMs by up to this budget.
      const judgeBudget = new AttemptBudget(JUDGE_DEADLINE_MS);
      let result: AttemptResult<z.infer<typeof scoreSchema>>;
      try {
        result = await attemptGenerate(
          lm,
          scoreSchema,
          judgePrompt,
          undefined,
          undefined,
          judgeBudget,
          Math.min(JUDGE_DEADLINE_MS, this.timeouts?.attemptMs ?? DEFAULT_ATTEMPT_MS),
          { provider, model },
          this.retryable,
        );
      } catch (err) {
        // A judge that ran out of clock SKIPS. It must never be the reason a
        // main response fails — that would make a governance check the thing
        // that breaks the request it was watching.
        if (err instanceof AttemptTimeoutError || err instanceof DeadlineExceededError) {
          console.warn(`[llm-gateway] judge skipped for "${opts.slug}": ${err.message}`);
          return;
        }
        throw err;
      }
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
    // The judge row carries the judged call's lineage: its spend is the run's.
    await this.logUsage({
      lineage,
      metadata: opts.metadata,
      app: opts.app,
      userId: opts.userId ?? null,
      route: `judge:${opts.route ?? opts.slug}`,
      promptSlug: opts.slug,
      provider: judgeProvider,
      model: judgeModel,
      inputTokens,
      outputTokens,
      estimatedCostCents: this.registry.estimateForLink(
        judgeProvider,
        judgeModel,
        inputTokens,
        outputTokens,
      ),
      cacheHit: false,
      traceId: randomUUID(),
      durationMs,
    });
    await this.saveJudge({
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
    const orgId = this.org(opts);
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
      let resolvedProvider: string;
      let resolvedModel: string;
      let lm: LanguageModel | undefined;
      if (opts.model) {
        const parsed = this.registry.parseAny(opts.model);
        resolvedProvider = parsed.provider;
        resolvedModel = parsed.model;
        lm = this.registry.buildAny(parsed.provider, parsed.model) ?? undefined;
      } else if (opts.task && this.tasks) {
        const t = await this.tasks.modelForTask(opts.task, orgId);
        resolvedProvider = t.provider;
        resolvedModel = t.model;
        lm = this.registry.buildAny(t.provider, t.model) ?? undefined;
      } else {
        const r = this.registry.resolveDefault();
        resolvedProvider = r.provider;
        resolvedModel = r.model;
        lm = r.languageModel;
      }
      if (!lm) {
        throw new Error(`Prompt test: no API key for provider "${resolvedProvider}".`);
      }
      const start = Date.now();
      // One composition mechanism across the codebase, so nobody later wires
      // this one into an AbortSignal.any (see src/deadline.ts for why).
      const attempt = new AttemptBudget().attempt(this.timeouts?.attemptMs ?? DEFAULT_ATTEMPT_MS);
      let res: Awaited<ReturnType<typeof generateText>>;
      try {
        res = await generateText({
          model: lm,
          prompt,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          abortSignal: attempt.signal,
        });
      } finally {
        attempt.dispose();
      }
      text = res.text;
      inputTokens = res.usage.inputTokens ?? 0;
      outputTokens = res.usage.outputTokens ?? 0;
      provider = resolvedProvider;
      model = resolvedModel;
      durationMs = Date.now() - start;
    }

    const costCents = this.registry.estimateCostCents(model, inputTokens, outputTokens);
    const usageLogId = await this.logUsage({
      lineage: undefined, // the admin test bench is not a run path
      metadata: opts.metadata,
      orgId,
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
  /** Caller-defined attribution logged on every usage row this call writes
   *  (including cache hits and the judge). The gateway never reads it — it is
   *  not part of the cache key and never affects routing. */
  metadata?: Record<string, unknown>;
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
  /** Tenant whose task routing / prompts to test against. */
  orgId?: string;
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
