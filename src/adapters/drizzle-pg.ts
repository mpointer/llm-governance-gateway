// Reference UsageStore for Drizzle ORM over PostgreSQL.
// Import via the subpath export: "llm-governance-gateway/drizzle-pg".
// Requires drizzle-orm (optional peer dependency).
//
// Mirrors drizzle-sqlite.ts — same table/column names, Postgres types.
// Re-export the tables in your schema file so drizzle-kit generates
// migrations for them.

import { and, eq, gte, isNull, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  JudgeScore,
  SpendCapEvent,
  UsageEntry,
  UsageStore,
} from "../types.js";

export const aiUsageLog = pgTable("ai_usage_log", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
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
  inputText: text("input_text"),
  outputText: text("output_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const spendCapEvents = pgTable("spend_cap_events", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  capCents: doublePrecision("cap_cents").notNull(),
  spentCents: doublePrecision("spent_cents").notNull(),
  route: text("route"),
  wouldBlock: boolean("would_block").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const aiJudgeScores = pgTable("ai_judge_scores", {
  id: serial("id").primaryKey(),
  usageLogId: integer("usage_log_id").notNull(),
  rubric: jsonb("rubric").$type<Record<string, number>>().notNull(),
  overallScore: doublePrecision("overall_score").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

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
    return Number(rows[0]?.total ?? 0);
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
