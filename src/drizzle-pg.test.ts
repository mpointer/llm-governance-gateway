// Integration: the Drizzle Postgres reference store against real Postgres.
//
// The same suite runs on two targets:
//   - PGlite: Postgres compiled to WASM, in process. Always runs, so the
//     adapter is covered wherever `npm test` runs.
//   - node-postgres against a server, when PG_TEST_URL is set (CI sets it).
//     This is the driver adopters deploy, with a real pool and real type
//     parsing. Skipped, visibly, when the variable is absent.
//
// The schema is created from the adapter's exported table definitions, the
// same source drizzle-kit reads, so what is tested is what adopters migrate to.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { stepCountIs, tool, type LanguageModel } from "ai";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import { z } from "zod";
import {
  DrizzlePgUsageStore,
  aiJudgeScores,
  aiUsageLog,
  spendCapEvents,
  type PgDb,
} from "./adapters/drizzle-pg.js";
import { SpendCapError } from "./errors.js";
import { Gateway } from "./gateway.js";
import type { GatewayConfig, UsageEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Targets

interface Handle {
  db: PgDb;
  close(): Promise<void>;
}

interface Target {
  name: string;
  available: boolean;
  /** An empty database namespace of its own. */
  open(opts?: { timeZone?: string }): Promise<Handle>;
}

const PG_TEST_URL = process.env.PG_TEST_URL;

const targets: Target[] = [
  {
    name: "PGlite",
    available: true,
    async open({ timeZone } = {}) {
      const client = new PGlite();
      if (timeZone) await client.exec(`SET TIME ZONE '${timeZone}'`);
      return { db: drizzlePglite(client), close: () => client.close() };
    },
  },
  {
    name: "node-postgres",
    available: Boolean(PG_TEST_URL), // an empty value means unset
    async open({ timeZone } = {}) {
      // A schema per handle: reruns and parallel files cannot collide, and
      // nothing is left behind in the database the URL points at.
      const schema = `gw_test_${Math.random().toString(36).slice(2, 12)}`;
      const admin = new pg.Pool({ connectionString: PG_TEST_URL, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const options = [`-c search_path=${schema}`, timeZone ? `-c timezone=${timeZone}` : ""];
      const pool = new pg.Pool({ connectionString: PG_TEST_URL, options: options.join(" ") });
      return {
        db: drizzleNodePg(pool),
        async close() {
          await pool.end();
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Schema, from the exported table definitions

const TABLES = [aiUsageLog, spendCapEvents, aiJudgeScores];

function createTableSql(table: PgTable, omit: string[] = []): string {
  const { name, columns } = getTableConfig(table);
  const defs = columns
    .filter((c) => !omit.includes(c.name))
    .map((c) => {
      const constraints = `${c.primary ? " PRIMARY KEY" : ""}${c.notNull ? " NOT NULL" : ""}`;
      return `"${c.name}" ${c.getSQLType()}${constraints}`;
    });
  return `CREATE TABLE "${name}" (${defs.join(", ")})`;
}

async function rows<T = Record<string, unknown>>(db: PgDb, query: string): Promise<T[]> {
  const res = (await db.execute(sql.raw(query))) as unknown as { rows: T[] };
  return res.rows;
}

function createIndexSql(table: PgTable): string[] {
  const { name, indexes } = getTableConfig(table);
  return indexes.map((idx) => {
    const columns = idx.config.columns.map((c) => `"${(c as { name: string }).name}"`);
    return `CREATE INDEX "${idx.config.name}" ON "${name}" (${columns.join(", ")})`;
  });
}

async function createTables(
  db: PgDb,
  opts: { omit?: Record<string, string[]>; indexes?: boolean } = {},
): Promise<void> {
  for (const table of TABLES) {
    await rows(db, createTableSql(table, opts.omit?.[getTableConfig(table).name]));
    if (opts.indexes === false) continue;
    for (const statement of createIndexSql(table)) await rows(db, statement);
  }
}

const describeColumns = (db: PgDb) =>
  rows(
    db,
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY table_name, column_name`,
  );

/** Every index in the schema, without the schema name its definition carries. */
const describeIndexes = (db: PgDb) =>
  rows<{ indexname: string; tablename: string; def: string }>(
    db,
    `SELECT indexname, tablename, substring(indexdef FROM 'USING .*$') AS def
       FROM pg_indexes
      WHERE schemaname = current_schema()
      ORDER BY indexname`,
  );

// The hand-migration list in the header of adapters/drizzle-pg.ts. Keep the
// two in step: this test fails when a column or an index is added to the
// table definitions without a line here.
const ADDED_SINCE_0_10 = {
  ai_usage_log: ["org_id", "metadata", "guardrails", "run_id", "step_index", "parent_run_id"],
  spend_cap_events: ["org_id", "enforced", "run_id"],
};
const HAND_MIGRATIONS = [
  "ALTER TABLE ai_usage_log     ADD COLUMN org_id text",
  "ALTER TABLE spend_cap_events ADD COLUMN org_id text",
  "ALTER TABLE spend_cap_events ADD COLUMN enforced boolean",
  "ALTER TABLE ai_usage_log     ADD COLUMN metadata jsonb",
  "ALTER TABLE ai_usage_log     ADD COLUMN guardrails jsonb",
  "ALTER TABLE ai_usage_log     ADD COLUMN run_id text",
  "ALTER TABLE ai_usage_log     ADD COLUMN step_index integer",
  "ALTER TABLE ai_usage_log     ADD COLUMN parent_run_id text",
  "ALTER TABLE spend_cap_events ADD COLUMN run_id text",
  "CREATE INDEX idx_ai_usage_spend     ON ai_usage_log (created_at, cache_hit, user_id)",
  "CREATE INDEX idx_ai_usage_spend_org ON ai_usage_log (created_at, cache_hit, org_id)",
  "CREATE INDEX idx_ai_usage_run       ON ai_usage_log (run_id, step_index)",
];

// ---------------------------------------------------------------------------
// Fixtures

const OutSchema = z.object({ answer: z.string() });

function mockGateway(store: DrizzlePgUsageStore, extra: Partial<GatewayConfig> = {}) {
  const gw = new Gateway({
    usage: store,
    promptDefaults: [{ slug: "greet", body: "Hello {{name}}.", variables: ["name"] }],
    mock: true,
    appId: "it",
    ...extra,
  });
  gw.registerMockResponder("greet", () => ({ answer: "hi" }));
  return gw;
}

const call = (userId: string, cachePart: string, name = "x") => ({
  slug: "greet",
  schema: OutSchema,
  input: { name },
  variables: () => ({ name }),
  cacheParts: [cachePart],
  userId,
});

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    userId: "u1",
    provider: "anthropic",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostCents: 1,
    cacheHit: false,
    traceId: "t",
    createdAt: new Date(),
    ...over,
  };
}

/** A model that plays back scripted steps: one tool call, then text. */
function scriptedModel(steps: unknown[][]): LanguageModel {
  let calls = 0;
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "priced",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not used");
    },
    async doStream() {
      const parts = steps[Math.min(calls++, steps.length - 1)]!;
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });
const TOOL_STEP = [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: '{"q":"weather"}' },
  { type: "finish", finishReason: "tool-calls", usage: usage(4, 1) },
];
const TEXT_STEP = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "done" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: "stop", usage: usage(3, 2) },
];

// ---------------------------------------------------------------------------

for (const target of targets) {
  describe.skipIf(!target.available)(`DrizzlePgUsageStore on ${target.name}`, () => {
    let handle: Handle;
    let db: PgDb;
    let store: DrizzlePgUsageStore;

    beforeAll(async () => {
      handle = await target.open();
      db = handle.db;
      await createTables(db);
      store = new DrizzlePgUsageStore(db);
    });
    afterAll(() => handle?.close());
    beforeEach(async () => {
      await rows(db, "TRUNCATE ai_usage_log, spend_cap_events, ai_judge_scores RESTART IDENTITY");
    });

    describe("a governed call", () => {
      it("is ledgered with a serial id, the app tag and a timestamptz that reads back as a Date", async () => {
        const before = Date.now();
        const res = await mockGateway(store).runStructured(call("u1", "a"));
        expect(res.usageLogId).toBe(1);
        const [row] = await db.select().from(aiUsageLog);
        expect(row).toMatchObject({
          id: 1,
          userId: "u1",
          orgId: null,
          app: "it",
          promptSlug: "greet",
          provider: "mock",
          cacheHit: false,
          metadata: null,
          guardrails: null,
          runId: null,
          stepIndex: null,
          parentRunId: null,
        });
        expect(row!.createdAt).toBeInstanceOf(Date);
        expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(row!.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      });

      it("is refused once the user's spend in the table is over the cap, and the breach is recorded", async () => {
        await store.logUsage(entry({ estimatedCostCents: 500 }));
        const gw = mockGateway(store, { caps: { userDailyCents: 200, globalDailyCents: 0 } });
        await expect(gw.runStructured(call("u1", "b"))).rejects.toThrow(SpendCapError);
        expect(await db.select().from(aiUsageLog)).toHaveLength(1); // nothing new was spent
        const events = await db.select().from(spendCapEvents);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          userId: "u1",
          capCents: 200,
          spentCents: 500,
          wouldBlock: true,
          enforced: true,
          runId: null,
        });
        expect(events[0]!.createdAt).toBeInstanceOf(Date);
      });

      it("goes through in observe mode, with the breach recorded as not enforced", async () => {
        await store.logUsage(entry({ estimatedCostCents: 500 }));
        const gw = mockGateway(store, {
          caps: { userDailyCents: 200, globalDailyCents: 0, mode: "observe" },
        });
        await gw.runStructured(call("u1", "c"));
        expect(await db.select().from(aiUsageLog)).toHaveLength(2);
        const events = await db.select().from(spendCapEvents);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ wouldBlock: true, enforced: false });
      });

      it("stores metadata and guardrail verdicts as jsonb that SQL can query into", async () => {
        const gw = mockGateway(store, {
          guardrails: { pre: () => ({ action: "allow", reason: "clean", detail: { score: 0.2 } }) },
        });
        await gw.runStructured({
          ...call("u1", "d"),
          metadata: { team: "billing", tags: ["a", "b"], nested: { n: 1 } },
        });
        const [row] = await db.select().from(aiUsageLog);
        expect(row!.metadata).toEqual({ team: "billing", tags: ["a", "b"], nested: { n: 1 } });
        expect(row!.guardrails).toHaveLength(1);
        expect(row!.guardrails![0]).toMatchObject({
          hook: "pre",
          action: "allow",
          reason: "clean",
          detail: { score: 0.2 },
          failOpen: false,
        });
        // A double-encoded value would be a jsonb *string* here, and the
        // ->> lookups would come back NULL.
        const [probe] = await rows(
          db,
          `SELECT jsonb_typeof(metadata) AS meta_type,
                  metadata->>'team' AS team,
                  metadata->'nested'->>'n' AS n,
                  jsonb_typeof(guardrails) AS guard_type,
                  guardrails->0->>'reason' AS reason
             FROM ai_usage_log`,
        );
        expect(probe).toEqual({
          meta_type: "object",
          team: "billing",
          n: "1",
          guard_type: "array",
          reason: "clean",
        });
      });

      it("writes the caller's rubric to the judge table against the usage row", async () => {
        const res = await mockGateway(store).runStructured({
          ...call("u1", "e"),
          judgeRubric: () => ({ quality: 5, tone: 4 }),
        });
        const scores = await db.select().from(aiJudgeScores);
        expect(scores).toHaveLength(1);
        expect(scores[0]).toMatchObject({
          usageLogId: res.usageLogId,
          rubric: { quality: 5, tone: 4 },
          overallScore: 4.5,
        });
        const [joined] = await rows(
          db,
          `SELECT u.prompt_slug, s.rubric->>'tone' AS tone
             FROM ai_judge_scores s JOIN ai_usage_log u ON u.id = s.usage_log_id`,
        );
        expect(joined).toEqual({ prompt_slug: "greet", tone: "4" });
      });

      it("keeps the row when the prompt carries a NUL byte, which Postgres cannot store", async () => {
        const res = await mockGateway(store).runStructured({
          ...call("u1", "f", "scan\u0000ned"),
          metadata: {
            source: "page\u00001.pdf",
            half: "cut \ud83c",
            "key\u0000": "v",
            pages: ["p\u00001", 2],
            whole: "🎉",
            at: new Date("2026-01-02T03:04:05.000Z"),
          },
        });
        expect(res.usageLogId).toBe(1);
        const [row] = await db.select().from(aiUsageLog);
        expect(row!.inputText).toBe("Hello scan\ufffdned.");
        expect(row!.metadata).toEqual({
          source: "page\ufffd1.pdf",
          half: "cut \ufffd",
          "key\ufffd": "v",
          pages: ["p\ufffd1", 2],
          whole: "🎉",
          at: "2026-01-02T03:04:05.000Z",
        });
      });
    });

    describe("a governed run", () => {
      it("ties its rows together by run id and step, and a child run to its parent", async () => {
        const gw = mockGateway(store);
        const parent = gw.startRun({ id: "run-x", maxSteps: 3 });
        await gw.runStructured({ ...call("u1", "r1"), run: parent });
        const child = gw.startRun({ id: "run-child", parent });
        await gw.runStructured({ ...call("u1", "r2"), run: child });
        await gw.runStructured({ ...call("u1", "r3"), run: parent });
        await gw.runStructured(call("u1", "r4")); // no run

        const all = await db.select().from(aiUsageLog).orderBy(asc(aiUsageLog.id));
        expect(all.map((r) => [r.runId, r.stepIndex, r.parentRunId])).toEqual([
          ["run-x", 0, null],
          ["run-child", 0, "run-x"],
          ["run-x", 1, null],
          [null, null, null],
        ]);
        // The query lineage exists for: every row of one run, in order.
        const ofRun = await db
          .select({ step: aiUsageLog.stepIndex })
          .from(aiUsageLog)
          .where(eq(aiUsageLog.runId, "run-x"))
          .orderBy(asc(aiUsageLog.stepIndex));
        expect(ofRun.map((r) => r.step)).toEqual([0, 1]);
      });

      it("ledgers a tool loop row by row, and the run's spend equals the sum of its rows", async () => {
        const model = scriptedModel([TOOL_STEP, TEXT_STEP]);
        const gw = new Gateway({
          usage: store,
          modelConfig: {
            getOverride: async () => null,
            getChain: async () => [
              { provider: "anthropic" as const, model: "priced", languageModel: model },
            ],
          },
          providers: { pricing: { priced: { in: 1000, out: 1000 } } }, // 1 cent per token
          caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
          toolPolicy: { lookup: { costCents: 0.35 } },
        });
        const lookup = tool({
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ temp: 21 }),
        });
        const run = gw.startRun({ id: "turn", budgetCents: 100 });
        const res = await gw.streamText({
          slug: "agent",
          messages: [{ role: "user", content: "go" }],
          userId: "u1",
          route: "agent",
          stopWhen: stepCountIs(10),
          tools: { lookup },
          run,
        });
        for await (const _ of res.textStream) {
          // drain
        }
        await res.result;

        const ledger = await db
          .select()
          .from(aiUsageLog)
          .where(eq(aiUsageLog.runId, "turn"))
          .orderBy(asc(aiUsageLog.id));
        expect(ledger).toHaveLength(3);
        const toolRow = ledger.find((r) => r.provider === "tool")!;
        expect(toolRow).toMatchObject({
          model: "lookup",
          estimatedCostCents: 0.35,
          stepIndex: 0,
          inputText: '{"q":"weather"}',
        });
        expect(toolRow.metadata).toMatchObject({ toolCallId: "c1" });
        const modelRows = ledger.filter((r) => r.provider !== "tool");
        expect(modelRows.map((r) => r.estimatedCostCents)).toEqual([5, 5]);
        expect(modelRows[0]!.metadata).toMatchObject({ innerStep: 0 });

        const summed = await store.sumSpendCents(new Date(0), "u1");
        expect(summed).toBeCloseTo(10.35, 10);
        expect(run.spentCents).toBeCloseTo(summed, 10);
      });

      it("records which run's budget a cap event belongs to", async () => {
        await store.recordSpendCapEvent({
          userId: "u1",
          capCents: 50,
          spentCents: 61.5,
          route: "run:agent",
          wouldBlock: true,
          enforced: true,
          runId: "turn",
          createdAt: new Date(),
        });
        const [event] = await db.select().from(spendCapEvents);
        expect(event).toMatchObject({ runId: "turn", route: "run:agent", spentCents: 61.5 });
      });
    });

    describe("sumSpendCents", () => {
      it("returns the number 0 for an empty table", async () => {
        const total = await store.sumSpendCents(new Date(0));
        expect(total).toBe(0);
        expect(typeof total).toBe("number");
      });

      it("sums per user, for anonymous rows, and globally, leaving cache hits out", async () => {
        await store.logUsage(entry({ userId: "u1", estimatedCostCents: 100 }));
        await store.logUsage(entry({ userId: "u1", estimatedCostCents: 50, cacheHit: true }));
        await store.logUsage(entry({ userId: "u2", estimatedCostCents: 30 }));
        await store.logUsage(entry({ userId: null, estimatedCostCents: 7 }));
        const since = new Date(Date.now() - 60_000);
        expect(await store.sumSpendCents(since, "u1")).toBe(100);
        expect(await store.sumSpendCents(since, null)).toBe(7);
        expect(await store.sumSpendCents(since)).toBe(137);
        expect(await store.sumSpendCents(since, "nobody")).toBe(0);
      });

      it("scopes by org: a named org, the unscoped rows, or no org predicate at all", async () => {
        await store.logUsage(entry({ orgId: "acme", estimatedCostCents: 10 }));
        await store.logUsage(entry({ orgId: "acme", userId: "u2", estimatedCostCents: 5 }));
        await store.logUsage(entry({ orgId: "globex", estimatedCostCents: 3 }));
        await store.logUsage(entry({ orgId: null, estimatedCostCents: 1 }));
        const since = new Date(0);
        expect(await store.sumSpendCents(since, undefined, "acme")).toBe(15);
        expect(await store.sumSpendCents(since, "u1", "acme")).toBe(10);
        expect(await store.sumSpendCents(since, undefined, null)).toBe(1);
        expect(await store.sumSpendCents(since)).toBe(19);
      });

      it("adds fractional cents as doubles, not as integers or decimal strings", async () => {
        for (const cents of [0.1, 0.2, 0.0375, 1e-7]) {
          await store.logUsage(entry({ estimatedCostCents: cents }));
        }
        const total = await store.sumSpendCents(new Date(0));
        expect(typeof total).toBe("number");
        expect(total).toBeCloseTo(0.3375001, 12);
      });

      it("counts a row written exactly at the window start, and not one a millisecond before", async () => {
        await expectWindowIsInclusive(store);
      });
    });

    it("gives every concurrent write its own id and loses none", async () => {
      const ids = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          store.logUsage(entry({ userId: `u${i % 4}`, estimatedCostCents: 0.25 })),
        ),
      );
      expect(new Set(ids).size).toBe(40);
      expect(await store.sumSpendCents(new Date(0))).toBe(10);
      expect(await store.sumSpendCents(new Date(0), "u3")).toBe(2.5);
    });

    it("replaces a NUL byte in a model's text output, and leaves ordinary text alone", async () => {
      await store.logUsage(entry({ outputText: "\u0000bin\u0000ary" }));
      await store.logUsage(entry({ inputText: "héllo 🎉 日本", outputText: "half \ud83c" }));
      const got = await db.select().from(aiUsageLog).orderBy(asc(aiUsageLog.id));
      expect(got[0]!.outputText).toBe("\ufffdbin\ufffdary");
      expect(got[1]!.inputText).toBe("héllo 🎉 日本");
      // An unpaired surrogate is not valid UTF-8 either way: the driver
      // already encodes it as U+FFFD, and the write does not fail.
      expect(got[1]!.outputText).toBe("half \ufffd");
    });

    it("declares the indexes the spend sums and the run lookup are served by", async () => {
      const declared = (await describeIndexes(db)).filter((i) => i.indexname.startsWith("idx_"));
      expect(declared).toEqual([
        {
          indexname: "idx_ai_usage_run",
          tablename: "ai_usage_log",
          def: "USING btree (run_id, step_index)",
        },
        {
          indexname: "idx_ai_usage_spend",
          tablename: "ai_usage_log",
          def: "USING btree (created_at, cache_hit, user_id)",
        },
        {
          indexname: "idx_ai_usage_spend_org",
          tablename: "ai_usage_log",
          def: "USING btree (created_at, cache_hit, org_id)",
        },
      ]);
    });

    it("keeps the day boundary right when the session time zone is not UTC", async () => {
      const zoned = await target.open({ timeZone: "Asia/Kolkata" });
      try {
        await createTables(zoned.db);
        const zonedStore = new DrizzlePgUsageStore(zoned.db);
        await expectWindowIsInclusive(zonedStore);
        // The session really is on +05:30, and the instant survived it.
        const [row] = await rows<{ shown: string; epoch_ms: string }>(
          zoned.db,
          `SELECT created_at::text AS shown,
                  (extract(epoch FROM created_at) * 1000)::bigint::text AS epoch_ms
             FROM ai_usage_log ORDER BY id LIMIT 1`,
        );
        expect(row!.shown).toMatch(/\+05:30$/);
        expect(Number(row!.epoch_ms)).toBe(WINDOW_START.getTime());
        const [read] = await zoned.db.select().from(aiUsageLog).orderBy(asc(aiUsageLog.id));
        expect(read!.createdAt.getTime()).toBe(WINDOW_START.getTime());
      } finally {
        await zoned.close();
      }
    });

    it("reaches today's schema from the original tables through the documented migrations", async () => {
      const legacy = await target.open();
      try {
        await createTables(legacy.db, { omit: ADDED_SINCE_0_10, indexes: false });
        for (const statement of HAND_MIGRATIONS) await rows(legacy.db, statement);
        expect(await describeColumns(legacy.db)).toEqual(await describeColumns(db));
        expect(await describeIndexes(legacy.db)).toEqual(await describeIndexes(db));

        const migrated = new DrizzlePgUsageStore(legacy.db);
        const gw = mockGateway(migrated);
        await gw.runStructured({
          ...call("u1", "m"),
          run: gw.startRun({ id: "migrated" }),
          metadata: { k: "v" },
        });
        const [row] = await legacy.db.select().from(aiUsageLog);
        expect(row).toMatchObject({ runId: "migrated", stepIndex: 0, metadata: { k: "v" } });
      } finally {
        await legacy.close();
      }
    });
  });
}

const WINDOW_START = new Date("2026-03-01T00:00:00.000Z");

async function expectWindowIsInclusive(store: DrizzlePgUsageStore): Promise<void> {
  const at = WINDOW_START.getTime();
  await store.logUsage(entry({ estimatedCostCents: 4, createdAt: new Date(at) }));
  await store.logUsage(entry({ estimatedCostCents: 2, createdAt: new Date(at - 1) }));
  expect(await store.sumSpendCents(new Date(at))).toBe(4);
  expect(await store.sumSpendCents(new Date(at - 1))).toBe(6);
  expect(await store.sumSpendCents(new Date(at + 1))).toBe(0);
}
