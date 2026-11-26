// Integration: full Gateway lifecycle against a REAL SQLite database
// (libSQL :memory:) through the Drizzle reference store — proves the
// UsageStore contract holds beyond the memory mocks.

import { beforeEach, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sql-js";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { SpendCapError } from "./errors.js";
import { DrizzleSqliteUsageStore, ensureTables, aiUsageLog } from "./adapters/drizzle-sqlite.js";

const OutSchema = z.object({ answer: z.string() });

const SQL = await initSqlJs();

async function makeDbStore() {
  const db = drizzle(new SQL.Database());
  await ensureTables(db);
  return { db, store: new DrizzleSqliteUsageStore(db) };
}

function makeGateway(store: DrizzleSqliteUsageStore, caps = {}) {
  const gw = new Gateway({
    usage: store,
    promptDefaults: [{ slug: "greet", body: "Hello {{name}}.", variables: ["name"] }],
    mock: true,
    appId: "it",
    caps,
  });
  gw.registerMockResponder("greet", () => ({ answer: "hi" }));
  return gw;
}

const opts = (userId: string, cacheParts: string[]) => ({
  slug: "greet",
  schema: OutSchema,
  input: { name: "x" },
  variables: () => ({ name: "x" }),
  cacheParts,
  userId,
});

describe("DrizzleSqliteUsageStore integration", () => {
  let store: DrizzleSqliteUsageStore;
  let db: Awaited<ReturnType<typeof makeDbStore>>["db"];

  beforeEach(async () => {
    ({ db, store } = await makeDbStore());
  });

  it("logs usage rows with real ids and app tag", async () => {
    const gw = makeGateway(store);
    const res = await gw.runStructured(opts("u1", ["a"]));
    expect(typeof res.usageLogId).toBe("number");
    const rows = await db.select().from(aiUsageLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.app).toBe("it");
    expect(rows[0]!.provider).toBe("mock");
    expect(rows[0]!.cacheHit).toBe(false);
  });

  it("sums spend per-user and globally, excluding cache hits", async () => {
    const now = new Date();
    await store.logUsage(mkEntry("u1", 100, false, now));
    await store.logUsage(mkEntry("u1", 50, true, now)); // cache hit — excluded
    await store.logUsage(mkEntry("u2", 30, false, now));
    await store.logUsage(mkEntry(null, 7, false, now));
    const dayStart = new Date(now.getTime() - 1000);
    expect(await store.sumSpendCents(dayStart, "u1")).toBe(100);
    expect(await store.sumSpendCents(dayStart, null)).toBe(7); // anon only
    expect(await store.sumSpendCents(dayStart)).toBe(137); // global
  });

  it("enforces the spend cap end-to-end and records the event", async () => {
    await store.logUsage(mkEntry("u1", 500, false, new Date()));
    const gw = makeGateway(store, { userDailyCents: 200, globalDailyCents: 0 });
    await expect(gw.runStructured(opts("u1", ["b"]))).rejects.toThrow(SpendCapError);
    expect(await store.sumSpendCents(new Date(0), "u1")).toBe(500);
  });

  it("persists judge scores keyed to the usage row", async () => {
    const gw = makeGateway(store);
    const res = await gw.runStructured({
      ...opts("u1", ["c"]),
      judgeRubric: () => ({ quality: 5 }),
    });
    expect(res.usageLogId).toBeDefined();
  });

  it("persists run lineage on usage rows and the run id on a run cap event", async () => {
    const gw = makeGateway(store);
    const run = gw.startRun({ id: "run-x", maxSteps: 2 });
    await gw.runStructured({ ...opts("u1", ["r1"]), run });
    await gw.runStructured({ ...opts("u1", ["r2"]), run });
    await gw.runStructured(opts("u1", ["r3"])); // no run
    const rows = await db.select().from(aiUsageLog);
    expect(rows.map((r) => [r.runId, r.stepIndex, r.parentRunId])).toEqual([
      ["run-x", 0, null],
      ["run-x", 1, null],
      [null, null, null],
    ]);
  });

  it("persists which resolution layer chose the model, and NULL when none is recorded", async () => {
    await store.logUsage({ ...mkEntry("u1", 1, false, new Date()), routedBy: "slug-fallback" });
    await store.logUsage(mkEntry("u1", 1, false, new Date()));
    const rows = await db.select().from(aiUsageLog);
    expect(rows.map((r) => r.routedBy)).toEqual(["slug-fallback", null]);
  });

  it("ensureTables builds exactly the indexes the table definition declares", async () => {
    // sql.js returns positional arrays, other drivers objects.
    const cell = (row: unknown, i: number, key: string) =>
      Array.isArray(row) ? row[i] : (row as Record<string, unknown>)[key];
    const names = await db.all(
      sql.raw(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'ai_usage_log' AND name LIKE 'idx_%'
          ORDER BY name`,
      ),
    );
    const built = [];
    for (const row of names) {
      const name = String(cell(row, 0, "name"));
      const info = await db.all(sql.raw(`PRAGMA index_info(${name})`));
      built.push({ name, columns: info.map((r) => cell(r, 2, "name")) });
    }
    const declared = getTableConfig(aiUsageLog)
      .indexes.map((i) => ({
        name: i.config.name,
        columns: i.config.columns.map((c) => (c as { name: string }).name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(built).toEqual(declared);
    expect(declared).toEqual([
      { name: "idx_ai_usage_run", columns: ["run_id", "step_index"] },
      { name: "idx_ai_usage_spend", columns: ["created_at", "cache_hit", "user_id"] },
      { name: "idx_ai_usage_spend_org", columns: ["created_at", "cache_hit", "org_id"] },
    ]);
  });

  it("ensureTables adds the lineage columns to a table created before 0.18.0", async () => {
    const old = drizzle(new SQL.Database());
    old.run(
      sql`CREATE TABLE ai_usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, app TEXT, route TEXT,
        prompt_slug TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        estimated_cost_cents REAL NOT NULL, cache_hit INTEGER NOT NULL,
        trace_id TEXT NOT NULL, duration_ms INTEGER, cache_create_tokens INTEGER,
        cache_read_tokens INTEGER, web_searches INTEGER, zdr_enforced INTEGER,
        input_text TEXT, output_text TEXT, created_at INTEGER NOT NULL
      )`,
    );
    await ensureTables(old);
    await ensureTables(old); // idempotent
    const gw = makeGateway(new DrizzleSqliteUsageStore(old));
    await gw.runStructured({ ...opts("u1", ["m"]), run: gw.startRun({ id: "migrated" }) });
    const rows = await old.select().from(aiUsageLog);
    expect(rows[0]!.runId).toBe("migrated");
    // The 0.22.0 column was added to the old table too.
    expect(rows[0]!.routedBy).toBeNull();
  });
});

function mkEntry(userId: string | null, cents: number, cacheHit: boolean, at: Date) {
  return {
    userId,
    provider: "anthropic",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostCents: cents,
    cacheHit,
    traceId: "t",
    createdAt: at,
  };
}
