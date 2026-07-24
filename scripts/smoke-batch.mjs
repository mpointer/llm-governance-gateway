// Live batch smoke test — submits a REAL Anthropic Message Batch (3 tiny
// Haiku items ≈ well under a cent at the 50% batch rate), polls until it
// ends, reconciles, and verifies the two-phase spend accounting.
//
//   npm run smoke:batch
//
// Requires ANTHROPIC_API_KEY (env or .env.local). Batches typically finish
// in a few minutes but Anthropic only guarantees <24h — this script polls
// for up to 30 minutes, then prints the batch id and exits 2 (the batch is
// still valid; rerunning won't resume it because the demo job store is
// in-memory, but the spend is real and tiny either way).

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  Gateway,
  MemoryUsageStore,
  MemoryBatchJobStore,
  anthropicBatchClient,
  loadEnvFiles,
} from "../dist/index.js";

loadEnvFiles();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required (env or .env.local).");
  process.exit(1);
}

const MODEL = process.env.SMOKE_BATCH_MODEL ?? "claude-haiku-4-5-20251001";
const POLL_MS = 15_000;
const TIMEOUT_MS = 30 * 60_000;

const Schema = z.object({ animal: z.string(), sound: z.string() });
const usage = new MemoryUsageStore();
const store = new MemoryBatchJobStore();

const gw = new Gateway({
  usage,
  promptDefaults: [
    {
      slug: "animal_sound",
      body: "What sound does a {{animal}} make? Reply via the tool.",
      variables: ["animal"],
    },
  ],
  batch: {
    client: anthropicBatchClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })),
    store,
  },
  caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
});

const items = ["cow", "duck", "cat"].map((animal) => ({
  id: animal,
  variables: { animal },
}));

console.log(`Submitting batch of ${items.length} items on ${MODEL}...`);
const sub = await gw.submitBatch(Schema, {
  slug: "animal_sound",
  model: MODEL,
  items,
  cache: false,
  maxCostCents: 5, // hard ceiling: 5¢ — fail fast if the estimate exceeds it
  route: "smoke:batch",
});
console.log(
  `Submitted: batchId=${sub.batchId}, items=${sub.submittedCount}, reserved=${sub.reservedCents.toFixed(4)}¢ (ESTIMATE — the ceiling is the guarantee)`,
);

const started = Date.now();
for (;;) {
  const { status, ready } = await gw.pollBatch(sub.batchId);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`  poll @${mins}min: ${status}`);
  if (ready) break;
  if (Date.now() - started > TIMEOUT_MS) {
    console.error(`Timed out after 30min. Batch ${sub.batchId} is still processing at Anthropic.`);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

console.log("Reconciling...");
const rec = await gw.reconcileBatch(sub.batchId, Schema);
for (const r of rec.results) {
  console.log(
    r.ok
      ? `  ✓ ${r.id}: ${JSON.stringify(r.object)}`
      : `  ✗ ${r.id}: ${r.reason}${r.error ? ` — ${r.error}` : ""}`,
  );
}

// Verify two-phase accounting: net spend must equal reconciled actuals
// (reservation logged at submit, released by the compensating row).
const dayStart = new Date();
dayStart.setUTCHours(0, 0, 0, 0);
const net = await usage.sumSpendCents(dayStart);
const okCount = rec.results.filter((r) => r.ok).length;
console.log(`\nActual cost (50% batch rate): ${rec.costCents.toFixed(4)}¢`);
console.log(`Net ledger after release:      ${net.toFixed(4)}¢`);
console.log(`Reserved was:                  ${sub.reservedCents.toFixed(4)}¢`);

const accountingOk = Math.abs(net - rec.costCents) < 1e-9;
const idempotent = (await gw.reconcileBatch(sub.batchId, Schema)).alreadyReconciled;
console.log(`Accounting net==actuals: ${accountingOk ? "PASS" : "FAIL"}`);
console.log(`Second reconcile is no-op: ${idempotent ? "PASS" : "FAIL"}`);

if (okCount === items.length && accountingOk && idempotent) {
  console.log(`\nAll ${okCount}/${items.length} items succeeded. Batch pipeline verified live.`);
  process.exit(0);
}
console.error(`\n${okCount}/${items.length} ok; see failures above.`);
process.exit(1);
