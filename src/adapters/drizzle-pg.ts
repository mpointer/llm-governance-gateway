// Reference UsageStore for Drizzle ORM over PostgreSQL.
// Import via the subpath export: "llm-governance-gateway/drizzle-pg".
// Requires drizzle-orm (optional peer dependency).
//
// Mirrors drizzle-sqlite.ts — same table/column names, Postgres types.
// Re-export the tables in your schema file so drizzle-kit generates
// migrations for them.
//
// If you write migrations by hand instead, these are the additive steps from
// 0.10.0 on, in Postgres types. All nullable, no backfill:
//   ALTER TABLE ai_usage_log     ADD COLUMN org_id text;           -- 0.10.0
//   ALTER TABLE spend_cap_events ADD COLUMN org_id text;           -- 0.10.0
//   ALTER TABLE spend_cap_events ADD COLUMN enforced boolean;      -- 0.11.0
//   ALTER TABLE ai_usage_log     ADD COLUMN metadata jsonb;        -- 0.11.0
//   ALTER TABLE ai_usage_log     ADD COLUMN guardrails jsonb;      -- 0.16.0
//   ALTER TABLE ai_usage_log     ADD COLUMN run_id text;           -- 0.18.0
//   ALTER TABLE ai_usage_log     ADD COLUMN step_index integer;    -- 0.18.0
//   ALTER TABLE ai_usage_log     ADD COLUMN parent_run_id text;    -- 0.18.0
//   ALTER TABLE spend_cap_events ADD COLUMN run_id text;           -- 0.18.0
//   ALTER TABLE ai_usage_log     ADD COLUMN routed_by text;        -- 0.22.0
// And the indexes the usage table declares. On a large live table, add
// CONCURRENTLY so the build does not block writes:
//   CREATE INDEX idx_ai_usage_spend     ON ai_usage_log (created_at, cache_hit, user_id);
//   CREATE INDEX idx_ai_usage_spend_org ON ai_usage_log (created_at, cache_hit, org_id);
//   CREATE INDEX idx_ai_usage_run       ON ai_usage_log (run_id, step_index);
// src/drizzle-pg.test.ts applies exactly this list to the original tables and
// checks the result against the definitions below.

import { and, eq, gte, isNull, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { GuardrailRecord } from "../guardrails.js";
import type { JudgeScore, SpendCapEvent, UsageEntry, UsageStore } from "../types.js";

export const aiUsageLog = pgTable(
  "ai_usage_log",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id"),
    /** Tenant. NULL for unscoped (single-tenant) rows. */
    orgId: text("org_id"),
    app: text("app"),
    route: text("route"),
    promptSlug: text("prompt_slug"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    estimatedCostCents: doublePrecision("estimated_cost_cents").notNull(),
    cacheHit: boolean("cache_hit").notNull(),
    traceId: text("trace_id").notNull(),
    durationMs: integer("duration_ms"),
    cacheCreateTokens: integer("cache_create_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    webSearches: integer("web_searches"),
    zdrEnforced: boolean("zdr_enforced"),
    inputText: text("input_text"),
    outputText: text("output_text"),
    /** Caller-defined attribution. NULL before 0.11.0. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** Guardrail verdicts for the call. JSON. NULL before 0.16.0. */
    guardrails: jsonb("guardrails").$type<GuardrailRecord[]>(),
    /** Run lineage. NULL on rows outside a governed run and before 0.18.0. */
    runId: text("run_id"),
    stepIndex: integer("step_index"),
    parentRunId: text("parent_run_id"),
    /** Which resolution layer chose the model. NULL unless `slugPinWins` is on. */
    routedBy: text("routed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  // The same three indexes ensureTables() creates on SQLite, under the same
  // names. The spend sums run before every governed call, filtered on
  // created_at since the start of the UTC day; without an index each one is a
  // scan of the whole ledger.
  (t) => [
    index("idx_ai_usage_spend").on(t.createdAt, t.cacheHit, t.userId),
    index("idx_ai_usage_spend_org").on(t.createdAt, t.cacheHit, t.orgId),
    // "Every row of this run, in order" is the query run lineage exists for.
    index("idx_ai_usage_run").on(t.runId, t.stepIndex),
  ],
);

export const spendCapEvents = pgTable("spend_cap_events", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  /** Tenant. NULL for unscoped (single-tenant) rows. */
  orgId: text("org_id"),
  capCents: doublePrecision("cap_cents").notNull(),
  spentCents: doublePrecision("spent_cents").notNull(),
  route: text("route"),
  wouldBlock: boolean("would_block").notNull(),
  /** Did this breach actually throw? NULL on rows written before 0.11.0. */
  enforced: boolean("enforced"),
  /** The governed run whose budget was hit. NULL for the daily caps. */
  runId: text("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const aiJudgeScores = pgTable("ai_judge_scores", {
  id: serial("id").primaryKey(),
  usageLogId: integer("usage_log_id").notNull(),
  rubric: jsonb("rubric").$type<Record<string, number>>().notNull(),
  overallScore: doublePrecision("overall_score").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// Postgres cannot store U+0000 in `text` or `jsonb`, and `jsonb` also rejects
// an unpaired surrogate. SQLite stores both, so nothing upstream filters them.
// The row is written after the model call has been paid for: an insert that
// throws on one unstorable character loses the ledger row for money already
// spent. Prompts built from extracted documents do carry NUL bytes, so each
// such character is replaced with U+FFFD and the row is kept.
const REPLACEMENT = "\ufffd";
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function storableText(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text.includes("\u0000") ? text.replaceAll("\u0000", REPLACEMENT) : text;
}

function storableJson<T>(value: T | null | undefined): T | null {
  if (value == null) return null;
  // JSON.stringify writes both as escapes, so one scan of the serialized form
  // tells whether anything needs replacing. Almost always nothing does, and
  // the value is handed to the driver untouched.
  if (!/\\u0000|\\ud[89a-f]/i.test(JSON.stringify(value))) return value;
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replaceAll("\u0000", REPLACEMENT).replace(LONE_SURROGATE, REPLACEMENT);
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), clean(x)]));
    }
    return v;
  };
  // Round-trip first so the walk sees what the driver would have serialized
  // (a Date is its ISO string by then, not an object with no own keys).
  return clean(JSON.parse(JSON.stringify(value))) as T;
}

// Any drizzle pg database (node-postgres, postgres.js, neon, vercel).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PgDb = PgDatabase<any, any, any>;

export class DrizzlePgUsageStore implements UsageStore {
  constructor(private readonly db: PgDb) {}

  async logUsage(entry: UsageEntry): Promise<number> {
    const rows = await this.db
      .insert(aiUsageLog)
      .values({
        userId: entry.userId ?? null,
        orgId: entry.orgId ?? null,
        app: entry.app ?? null,
        route: entry.route ?? null,
        promptSlug: entry.promptSlug ?? null,
        provider: entry.provider,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        estimatedCostCents: entry.estimatedCostCents,
        cacheHit: entry.cacheHit,
        traceId: entry.traceId,
        durationMs: entry.durationMs ?? null,
        cacheCreateTokens: entry.cacheCreateTokens ?? null,
        cacheReadTokens: entry.cacheReadTokens ?? null,
        webSearches: entry.webSearches ?? null,
        zdrEnforced: entry.zdrEnforced ?? null,
        // Stored as received, deliberately. Gateway.logUsage() has already
        // applied truncate() and the configured encrypt hook, so encrypting
        // here would double-wrap: nothing throws, and no decrypt unwraps it.
        inputText: storableText(entry.inputText),
        outputText: storableText(entry.outputText),
        metadata: storableJson(entry.metadata),
        guardrails: storableJson(entry.guardrails),
        runId: entry.runId ?? null,
        stepIndex: entry.stepIndex ?? null,
        parentRunId: entry.parentRunId ?? null,
        routedBy: entry.routedBy ?? null,
        createdAt: entry.createdAt,
      })
      .returning({ id: aiUsageLog.id });
    return rows[0]!.id;
  }

  async sumSpendCents(since: Date, userId?: string | null, orgId?: string | null): Promise<number> {
    const conditions = [eq(aiUsageLog.cacheHit, false), gte(aiUsageLog.createdAt, since)];
    if (userId !== undefined) {
      conditions.push(userId === null ? isNull(aiUsageLog.userId) : eq(aiUsageLog.userId, userId));
    }
    // undefined = unscoped: no org predicate at all, so the query is byte for
    // byte what it was before org scoping existed.
    if (orgId !== undefined) {
      conditions.push(orgId === null ? isNull(aiUsageLog.orgId) : eq(aiUsageLog.orgId, orgId));
    }
    const rows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${aiUsageLog.estimatedCostCents}), 0)`,
      })
      .from(aiUsageLog)
      .where(and(...conditions));
    return Number(rows[0]?.total ?? 0);
  }

  async recordSpendCapEvent(event: SpendCapEvent): Promise<void> {
    await this.db.insert(spendCapEvents).values({
      userId: event.userId ?? null,
      orgId: event.orgId ?? null,
      capCents: event.capCents,
      spentCents: event.spentCents,
      route: event.route ?? null,
      wouldBlock: event.wouldBlock,
      enforced: event.enforced ?? null,
      runId: event.runId ?? null,
      createdAt: event.createdAt,
    });
  }

  async saveJudgeScore(score: JudgeScore): Promise<void> {
    await this.db.insert(aiJudgeScores).values({
      usageLogId: Number(score.usageLogId),
      rubric: score.rubric,
      overallScore: score.overallScore,
      createdAt: score.createdAt,
    });
  }
}
