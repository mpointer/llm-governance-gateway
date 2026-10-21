// Fails when the built-in pricing table has not been checked in a quarter.
//
// Run by .github/workflows/pricing-staleness.yml on a monthly schedule, and
// by hand: `npm run build && node scripts/pricing-staleness.mjs`.
//
// Deliberately NOT a vitest test: a check that trips on the calendar would
// turn every unrelated PR red the day it fires. A scheduled job fails on its
// own and names the fix.

import {
  BUILTIN_PRICING,
  PRICING_STALE_AFTER_DAYS,
  newestBuiltinPricingDate,
} from "../dist/providers.js";

const newest = newestBuiltinPricingDate();
if (!newest) {
  console.error("No built-in pricing row carries an asOf date.");
  process.exit(1);
}

const ageDays = Math.floor((Date.now() - Date.parse(newest)) / 86_400_000);
const rows = Object.entries(BUILTIN_PRICING)
  .map(([model, rate]) => `  ${rate.asOf ?? "undated   "}  ${model}`)
  .sort();

console.log(`Built-in pricing: ${rows.length} rows, newest check ${newest} (${ageDays} days ago).`);
console.log(rows.join("\n"));

if (ageDays > PRICING_STALE_AFTER_DAYS) {
  console.error(
    `\nStale: the newest as-of date is ${ageDays} days old, over the ${PRICING_STALE_AFTER_DAYS}-day limit.\n` +
      `Re-check every row in src/providers.ts BUILTIN_PRICING against the vendor price pages,\n` +
      `fix any rate that moved, and bump each row's asOf to today whether or not it changed.`,
  );
  process.exit(1);
}
console.log("Fresh.");
