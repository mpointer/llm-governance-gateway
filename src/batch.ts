// Governed batch processing (Anthropic Message Batches, ~50% token cost).
// Design: docs/design/batch-processing.md. Key invariants:
//   - Two-phase spend accounting: an estimated reservation is logged at
//     submit (a submitted batch is committed money) and released with a
//     compensating negative row at reconcile; per-item actuals are logged
//     from results. Net spend = actuals.
//   - Idempotent-by-state reconcile: a reconciled job returns its stored
//     summary without re-logging. A crash DURING the usage-logging phase can
//     leave partial rows (job stays "reconciling"); item traceIds are the
//     deterministic `${batchId}:${customId}` so duplicates are detectable.
//   - No inline repair at sync prices: schema-invalid items come back as
//     { ok:false, reason:"schema" } — callers choose requeue or sync fallback.

import type { z } from "zod";
import { toJSONSchema } from "zod";
import type { AnthropicMessage } from "./anthropic-native.js";
import { EMIT_TOOL, extractEmitToolInput } from "./anthropic-native.js";

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface BatchRequestItem {
  customId: string;
  params: Record<string, unknown>;
}

export type BatchResultOutcome =
  | { type: "succeeded"; message: AnthropicMessage }
  | { type: "errored"; error: unknown }
  | { type: "canceled" }
  | { type: "expired" };

export interface BatchResultItem {
  customId: string;
  result: BatchResultOutcome;
}

/** Structural batch transport. Use anthropicBatchClient() to wrap the SDK. */
export interface BatchClient {
  submit(requests: BatchRequestItem[]): Promise<{ id: string }>;
  check(batchId: string): Promise<{ status: string }>; // "in_progress" | "ended" | ...
  results(batchId: string): AsyncIterable<BatchResultItem>;
}

/** Wrap an @anthropic-ai/sdk instance (structural — no dependency). */
export function anthropicBatchClient(sdk: {
  messages: {
    batches: {
      create(p: { requests: { custom_id: string; params: unknown }[] }): Promise<{ id: string }>;
      retrieve(id: string): Promise<{ processing_status: string }>;
      results(id: string): Promise<AsyncIterable<{ custom_id: string; result: BatchResultOutcome }>>;
    };
  };
}): BatchClient {
  return {
    async submit(requests) {
      return sdk.messages.batches.create({
        requests: requests.map((r) => ({ custom_id: r.customId, params: r.params })),
      });
    },
    async check(batchId) {
      const b = await sdk.messages.batches.retrieve(batchId);
      return { status: b.processing_status };
    },
    async *results(batchId) {
      for await (const item of await sdk.messages.batches.results(batchId)) {
        yield { customId: item.custom_id, result: item.result };
      }
    },
  };
}

export type BatchJobStatus =
  | "submitted"
  | "ended"
  | "reconciling"
  | "reconciled"
  | "failed";

export interface BatchJob {
  batchId: string;
  slug: string;
  model: string;
  status: BatchJobStatus;
  itemCount: number;
  cachedCount: number;
  reservedCents: number;
  reconciledCents?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchJobStore {
  createJob(job: BatchJob): Promise<void>;
  getJob(batchId: string): Promise<BatchJob | undefined>;
  updateJob(
    batchId: string,
    patch: Partial<Pick<BatchJob, "status" | "reconciledCents">>,
  ): Promise<void>;
  listOpen(): Promise<BatchJob[]>;
}

export class MemoryBatchJobStore implements BatchJobStore {
  readonly jobs = new Map<string, BatchJob>();
  async createJob(job: BatchJob): Promise<void> {
    this.jobs.set(job.batchId, { ...job });
  }
  async getJob(batchId: string): Promise<BatchJob | undefined> {
    const j = this.jobs.get(batchId);
    return j ? { ...j } : undefined;
  }
  async updateJob(
    batchId: string,
    patch: Partial<Pick<BatchJob, "status" | "reconciledCents">>,
  ): Promise<void> {
    const j = this.jobs.get(batchId);
    if (!j) throw new Error(`Unknown batch job "${batchId}"`);
    Object.assign(j, patch, { updatedAt: new Date() });
  }
  async listOpen(): Promise<BatchJob[]> {
    return [...this.jobs.values()].filter(
      (j) => j.status !== "reconciled" && j.status !== "failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Config + call shapes
// ---------------------------------------------------------------------------

export interface BatchConfig {
  client: BatchClient;
  store: BatchJobStore;
  /** Batch discount multiplier on token cost. Anthropic: 0.5. */
  discount?: number;
  /** Output-token allowance per item for the submit-time ESTIMATE. The
   *  reservation is an estimate — maxCostCents is the guarantee. Default 1024. */
  outputAllowanceTokens?: number;
  /** max_tokens sent per item. Default 4096. */
  maxTokensPerItem?: number;
}

export interface SubmitBatchOptions<I> {
  slug: string;
  /** Items share the batch's prompt/schema; each brings its variables. */
  items: { id: string; variables: Record<string, string>; input?: I }[];
  /** Explicit model id (must resolve to Anthropic) — or omit to use the
   *  task/default resolution. */
  model?: string;
  task?: string;
  system?: string;
  temperature?: number;
  /** Default true: items with cached results are served immediately and
   *  excluded from the submitted batch. */
  cache?: boolean;
  /** Hard ceiling on the submit-time estimate — fail fast if exceeded. */
  maxCostCents?: number;
  userId?: string;
  route?: string;
  app?: string;
}

export interface SubmitBatchResult {
  /** null when every item was served from cache (nothing submitted). */
  batchId: string | null;
  cached: { id: string; object: unknown }[];
  submittedCount: number;
  reservedCents: number;
}

export type BatchItemResult<O> =
  | { id: string; ok: true; object: O }
  | { id: string; ok: false; reason: "schema" | "errored" | "canceled" | "expired"; error?: string };

export interface ReconcileResult<O> {
  results: BatchItemResult<O>[];
  /** Actual reconciled cost in cents (discounted). */
  costCents: number;
  alreadyReconciled: boolean;
}

/** Build the per-item Anthropic Message params with forced structured output.
 *  Thinking is deliberately unsupported in batch v1 (forced tool_choice and
 *  thinking are incompatible; repair loops don't exist in batch). */
export function buildBatchParams(args: {
  model: string;
  prompt: string;
  system?: string;
  jsonSchema: Record<string, unknown>;
  temperature?: number;
  maxTokens: number;
}): Record<string, unknown> {
  return {
    model: args.model,
    max_tokens: args.maxTokens,
    ...(args.system
      ? { system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }] }
      : {}),
    messages: [{ role: "user", content: args.prompt }],
    tools: [
      {
        name: EMIT_TOOL,
        description: "Emit the final structured result. Call exactly once.",
        input_schema: args.jsonSchema,
      },
    ],
    tool_choice: { type: "tool", name: EMIT_TOOL },
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function batchSchemaToJson(schema: z.ZodType<any>): Record<string, unknown> {
  return toJSONSchema(schema, { reused: "inline" }) as Record<string, unknown>;
}

export { extractEmitToolInput };
