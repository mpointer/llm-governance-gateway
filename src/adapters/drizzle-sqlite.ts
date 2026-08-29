// Reference UsageStore for Drizzle ORM over SQLite/libSQL (Turso).
// Import via the subpath export: "llm-governance-gateway/drizzle-sqlite".
// Requires drizzle-orm (optional peer dependency).
//
// Use the exported tables in your own schema file (re-export them) so
// `drizzle-kit generate` picks them up, or run `ensureTables()` for
// quick-start/dev setups.

import { and, eq, gte, isNull, sql } from "drizzle-orm";
import {
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type {
  JudgeScore,
  SpendCapEvent,
  UsageEntry,
  UsageStore,
} from "../types.js";

export const aiUsageLog = sqliteTable("ai_usage_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  estimatedCostCents: real("estimated_cost_cents").notNull(),
  cacheHit: integer("cache_hit", { mode: "boolean" }).notNull(),
  traceId: text("trace_id").notNull(),
  durationMs: integer("duration_ms"),
  cacheCreateTokens: integer("cache_create_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  webSearches: integer("web_searches"),
  zdrEnforced: integer("zdr_enforced", { mode: "boolean" }),
  inputText: text("input_text"),
  outputText: text("output_text"),
  /** Caller-defined attribution. JSON. NULL before 0.11.0. */
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const spendCapEvents = sqliteTable("spend_cap_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id"),
  /** Tenant. NULL for unscoped (single-tenant) rows. */
  orgId: text("org_id"),
  capCents: real("cap_cents").notNull(),
  spentCents: real("spent_cents").notNull(),
  route: text("route"),
  wouldBlock: integer("would_block", { mode: "boolean" }).notNull(),
  /** Did this breach actually throw? NULL on rows written before 0.11.0. */
  enforced: integer("enforced", { mode: "boolean" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const aiJudgeScores = sqliteTable("ai_judge_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  usageLogId: integer("usage_log_id").notNull(),
  rubric: text("rubric", { mode: "json" }).$type<Record<string, number>>().notNull(),
  overallScore: real("overall_score").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Any drizzle SQLite database — libsql/Turso, better-sqlite3, D1, sql.js.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqliteDb = BaseSQLiteDatabase<"async" | "sync", any, any>;

export class DrizzleSqliteUsageStore implements UsageStore {
  constructor(private readonly db: SqliteDb) {}

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
        inputText: entry.inputText ?? null,
        outputText: entry.outputText ?? null,
        metadata: entry.metadata ?? null,
        createdAt: entry.createdAt,
      })
      .returning({ id: aiUsageLog.id });
    return rows[0]!.id;
  }

  async sumSpendCents(
    since: Date,
    userId?: string | null,
    orgId?: string | null,
  ): Promise<number> {
    const conditions = [
      eq(aiUsageLog.cacheHit, false),
      gte(aiUsageLog.createdAt, since),
    ];
    if (userId !== undefined) {
      conditions.push(
        userId === null ? isNull(aiUsageLog.userId) : eq(aiUsageLog.userId, userId),
      );
    }
    // undefined = unscoped: no org predicate at all, so the query is byte for
    // byte what it was before org scoping existed.
    if (orgId !== undefined) {
      conditions.push(
        orgId === null ? isNull(aiUsageLog.orgId) : eq(aiUsageLog.orgId, orgId),
      );
    }
    const rows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${aiUsageLog.estimatedCostCents}), 0)`,
      })
      .from(aiUsageLog)
      .where(and(...conditions));
    return rows[0]?.total ?? 0;
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

/**
 * Idempotent ALTER. Asks the schema whether the column is already there
 * rather than attempting the ALTER and interpreting the failure: Drizzle
 * wraps driver errors, so the "duplicate column" text is not reliably on the
 * error we catch, and a real failure would be swallowed along with it.
 */
async function addColumnIfMissing(
  db: SqliteDb,
  table: string,
  column: string,
  columnDdl: string,
): Promise<void> {
  const info = (await db.all(
    sql.raw(`PRAGMA table_info(${table})`),
  )) as unknown as { name?: string }[];
  const present = info.some((c) =>
    // sql.js returns positional arrays for PRAGMA; drizzle drivers return
    // objects. Handle both rather than assuming one shape.
    Array.isArray(c) ? c[1] === column : c?.name === column,
  );
  if (present) return;
  await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`));
}

/** Dev/quick-start convenience: create the three tables if absent. For
 *  production, generate proper migrations from the exported tables.
 *
 *  Adopters who generate their own migrations need these additive steps:
 *    ALTER TABLE ai_usage_log     ADD COLUMN org_id TEXT;    -- 0.10.0
 *    ALTER TABLE spend_cap_events ADD COLUMN org_id TEXT;    -- 0.10.0
 *    ALTER TABLE spend_cap_events ADD COLUMN enforced INTEGER; -- 0.11.0
 *    ALTER TABLE ai_usage_log     ADD COLUMN metadata TEXT;      -- 0.11.0
 *  All nullable — existing rows stay unscoped, every unscoped query keeps its
 *  old plan, and a NULL `enforced` reads as "written before the mode existed",
 *  which is exactly what it means. */
export async function ensureTables(db: SqliteDb): Promise<void> {
  await db.run(sql`CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, app TEXT, route TEXT, prompt_slug TEXT,
    provider TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    estimated_cost_cents REAL NOT NULL, cache_hit INTEGER NOT NULL,
    trace_id TEXT NOT NULL, duration_ms INTEGER,
    cache_create_tokens INTEGER, cache_read_tokens INTEGER, web_searches INTEGER,
    zdr_enforced INTEGER,
    input_text TEXT, output_text TEXT, created_at INTEGER NOT NULL,
    org_id TEXT, metadata TEXT
  )`);
  // Additive migration for tables created before org scoping existed. SQLite
  // has no ADD COLUMN IF NOT EXISTS, so a duplicate-column error means the
  // migration already ran and is the success case, not a failure.
  await addColumnIfMissing(db, "ai_usage_log", "org_id", "org_id TEXT");
  await addColumnIfMissing(db, "ai_usage_log", "metadata", "metadata TEXT");
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_spend
    ON ai_usage_log (created_at, cache_hit, user_id)`);
  // Org-scoped spend sums are the hot path in a multi-tenant deployment.
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_spend_org
    ON ai_usage_log (created_at, cache_hit, org_id)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS spend_cap_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, cap_cents REAL NOT NULL, spent_cents REAL NOT NULL,
    route TEXT, would_block INTEGER NOT NULL, created_at INTEGER NOT NULL,
    org_id TEXT, enforced INTEGER
  )`);
  await addColumnIfMissing(db, "spend_cap_events", "org_id", "org_id TEXT");
  await addColumnIfMissing(db, "spend_cap_events", "enforced", "enforced INTEGER");
  await db.run(sql`CREATE TABLE IF NOT EXISTS ai_judge_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_log_id INTEGER NOT NULL, rubric TEXT NOT NULL,
    overall_score REAL NOT NULL, created_at INTEGER NOT NULL
  )`);
}
