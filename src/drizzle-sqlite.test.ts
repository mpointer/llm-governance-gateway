// Integration: full Gateway lifecycle against a REAL SQLite database
// (libSQL :memory:) through the Drizzle reference store — proves the
// UsageStore contract holds beyond the memory mocks.

import { beforeEach, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import { z } from "zod";
import { Gateway } from "./gateway.js";
import { SpendCapError } from "./errors.js";
import {
  DrizzleSqliteUsageStore,
  ensureTables,
  aiUsageLog,
} from "./adapters/drizzle-sqlite.js";

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
