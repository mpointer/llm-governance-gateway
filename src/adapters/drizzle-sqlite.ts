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
  inputText: text("input_text"),
  outputText: text("output_text"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const spendCapEvents = sqliteTable("spend_cap_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id"),
  capCents: real("cap_cents").notNull(),
  spentCents: real("spent_cents").notNull(),
  route: text("route"),
  wouldBlock: integer("would_block", { mode: "boolean" }).notNull(),
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
        inputText: entry.inputText ?? null,
        outputText: entry.outputText ?? null,
        createdAt: entry.createdAt,
      })
      .returning({ id: aiUsageLog.id });
    return rows[0]!.id;
  }

  async sumSpendCents(since: Date, userId?: string | null): Promise<number> {
    const conditions = [
      eq(aiUsageLog.cacheHit, false),
      gte(aiUsageLog.createdAt, since),
    ];
    if (userId !== undefined) {
      conditions.push(
        userId === null ? isNull(aiUsageLog.userId) : eq(aiUsageLog.userId, userId),
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
      capCents: event.capCents,
      spentCents: event.spentCents,
      route: event.route ?? null,
      wouldBlock: event.wouldBlock,
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

/** Dev/quick-start convenience: create the three tables if absent. For
 *  production, generate proper migrations from the exported tables. */
export async function ensureTables(db: SqliteDb): Promise<void> {
  await db.run(sql`CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, app TEXT, route TEXT, prompt_slug TEXT,
    provider TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    estimated_cost_cents REAL NOT NULL, cache_hit INTEGER NOT NULL,
    trace_id TEXT NOT NULL, duration_ms INTEGER,
    cache_create_tokens INTEGER, cache_read_tokens INTEGER, web_searches INTEGER,
    input_text TEXT, output_text TEXT, created_at INTEGER NOT NULL
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_spend
    ON ai_usage_log (created_at, cache_hit, user_id)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS spend_cap_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, cap_cents REAL NOT NULL, spent_cents REAL NOT NULL,
    route TEXT, would_block INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS ai_judge_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_log_id INTEGER NOT NULL, rubric TEXT NOT NULL,
    overall_score REAL NOT NULL, created_at INTEGER NOT NULL
  )`);
}
