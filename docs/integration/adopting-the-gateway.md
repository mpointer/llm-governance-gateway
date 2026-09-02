# Adopting the gateway

**How an existing app moves its LLM calls onto `llm-governance-gateway`
without a flag day, and how it proves the move worked.**

Written for an app that already has *something* — its own retry loop, its own
usage table, its own model constants. That app is the hard case, and the common
one. A greenfield app can read the README and skip this.

Requires **0.13.0 or later**. Earlier versions have a cache bug that makes
runtime-editable prompts silently not take effect (§5.2).

---

## 1. What ships, and what you write

This is the whole boundary, and getting it wrong is the most common source of
wasted work. The gateway is plumbing. Everything that decides *policy* is
yours, expressed through interfaces the gateway calls.

| Interface | Required | Ships with the package? |
|---|---|---|
| `UsageStore` | **yes** | Yes — `DrizzlePgUsageStore`, `DrizzleSqliteUsageStore`, `MemoryUsageStore` |
| `CacheStore` | no | Yes — `RedisCacheStore`, `MemoryCacheStore` |
| `RateLimiter` | no | Yes — `RedisRateLimiter`, `MemoryRateLimiter` |
| `PromptStore` | no | `MemoryPromptStore` only — **no persistent one** |
| `ModelConfigStore` | no | **No — you write it** |
| `TaskOverrideStore` | no | **No — you write it** |

The bottom three have no persistent implementation on purpose. They are the SPI
your control plane implements — the seam where an admin UI, a settings table,
or a feature-flag service plugs in. The gateway deliberately grows no admin
surface of its own beyond a thin HTTP skeleton (`/health`, `/run`, `/models`,
`/tasks`, `/prompt-test`), because that surface would collide with the one your
app already has.

They are also all **optional**. An adoption that passes only `usage` is valid
and is the right first step (§4.1).

Each is small — `PromptStore` is one method plus an optional `seedPrompt`,
`ModelConfigStore` is two plus an optional third, `TaskOverrideStore` is one.
They take an optional trailing `orgId`; **a single-tenant app ignores that
parameter entirely** — a function that declares fewer parameters is assignable
to one that declares more, so your implementations stay single-tenant-shaped
until you need otherwise.

---

## 2. Before you start: three facts to establish

Adoption plans go wrong when they are written against what the codebase was
believed to do. Get these from the code, not from memory or a design doc.

1. **Where are the LLM calls?** Every call site, including the ones in scripts
   and cron jobs. The count matters more than the list — it tells you whether
   this is a one-afternoon change or a phased one.
2. **What does the existing usage table record?** If the app already logs
   spend, the gateway's ledger must either replace it or run alongside it. A
   second ledger that disagrees with the first is worse than either alone.
3. **Are prompts editable at runtime today?** If an admin can change a prompt
   without a deploy, §5.2 is load-bearing and not optional.

---

## 3. Schema

The Drizzle adapters export the tables they need. Re-export them from your own
schema so your existing migration tooling generates the migration; do not
hand-write it.

```ts
// db/schema.ts
export {
  aiUsageLog,
  spendCapEvents,
  aiJudgeScores,
} from "llm-governance-gateway/drizzle-pg";
```

Three tables: the usage ledger, spend-cap breach events, and judge scores. If
you never enable the judge, `aiJudgeScores` stays empty — create it anyway, the
store's interface requires the method.

Not on Drizzle? `UsageStore` is six methods, four of them required.
Implementing it against any client is an afternoon; read `src/adapters/drizzle-pg.ts` as the
reference, and note that `sumSpendCents` is the one with real semantics —
`userId === undefined` means *all* identities (the global circuit breaker),
`userId === null` means anonymous only. Getting those two confused silently
breaks your caps.

---

## 4. The phased adoption

The point of phasing is that **each phase is independently verifiable and
independently revertible**. Do not collapse them because the app is small.

### 4.1 Phase 1 — ledger only, nothing enforced

Route calls through `runStructured`/`runText`, keep your existing model
selection, and set every cap to observe:

```ts
const gateway = new Gateway({
  usage: new DrizzlePgUsageStore(db),
  caps: { mode: "observe", userDailyCents: 200, globalDailyCents: 5000 },
  appId: "your-app",
});
```

`mode: "observe"` measures what your thresholds *would* have blocked and writes
a `spend_cap_events` row for each, without blocking anything. This is how you
discover that your first guess at a cap was 10× too low before it takes down
production at 2am.

**Verification:** every call produces a ledger row. Compare a day of the
gateway's `sumSpendCents` against your existing spend number. They should agree
within rounding; if they don't, find out why *now* — the usual cause is §5.1.

### 4.2 Phase 2 — move model selection into the gateway

Replace the app's own chain-walking with `tasks.defaults`, naming the call
sites rather than the models:

```ts
tasks: {
  defaults: {
    summarize: "claude-haiku-4-5-20251001",
    // The array form IS a primary/fallback/backup2 role chain. Positions are
    // the roles; the gateway needs no separate role vocabulary.
    enrich: ["claude-sonnet-4-6", "openai:gpt-4.1", "google:gemini-2.5-pro"],
  },
}
```

Then delete the app's retry/failover code. Leaving both in place gives you two
retry loops multiplying each other's attempts — a 3-link chain inside a 3-try
loop is 9 provider calls for one logical request, and the ledger will show it.

**Verification:** kill a provider key in staging and watch the chain walk in
the ledger — one row per attempt, `provider` and `model` differing per row.

### 4.3 Phase 3 — enforce

Flip `mode` to `"enforce"` (or drop it; enforce is the default) once the
observed breach rate is what you expect. Nothing else changes.

### 4.4 Phase 4 — the control plane

Implement `PromptStore` and `ModelConfigStore` over your existing settings
tables, so an admin can change prompts and pin models without a deploy. This is
the phase that needs §5.2.

---

## 5. Four things that bite

Each of these was a real bug reported by a real adopter, not a hypothetical.

### 5.1 Pricing keys

Register pricing with the **same** model ids you use everywhere else. Since
0.12.0 both the bare (`gpt-4.1`) and prefixed (`openai:gpt-4.1`) forms work and
normalise to the same entry. Before 0.12.0 only the bare form matched, so an
adopter following the convention the README teaches registered prefixed keys,
matched nothing, and priced every call at the fallback estimate. Silently.

Check it at boot rather than trusting it:

```ts
registry.assertPricingComplete(["claude-sonnet-4-6", "openai:gpt-4.1"]);
```

This throws at startup listing anything unpriced. There is deliberately no
strict mode inside the cost calculation itself — `estimateCostCents` runs
inline while building the usage row, so throwing there would lose the ledger
row for a call that already spent money. A wrong cost beats no record.

### 5.2 Editable prompts and the cache

**If prompts are editable at runtime, set
`invalidateCacheOnPromptChange: true`.**

Without it, publishing a new prompt body changes nothing for any input already
cached, until the TTL expires (24h by default). The cache key is built from the
slug and the caller's `cacheParts` — not the prompt — and the cache is read
*before* the prompt is loaded. The admin sees a successful publish, production
keeps serving the old version, and nothing reports a problem.

It is opt-in because turning it on costs a `getPrompt` round-trip on every
cache **hit**. An app with static `promptDefaults` and no prompt store gains
nothing and should leave it off. An app with an admin prompt editor cannot
afford to.

Turning it on invalidates every existing cache entry once, by design.

### 5.3 The native Anthropic path has its own clock

If you pass an `anthropic` client for thinking / prompt caching / web search,
those calls are bounded by the gateway's `attemptMs` (60s default), which
supersedes any `timeout` you configured on your own client. Set
`timeouts.attemptMs` if 60s is wrong for your workload; don't set a competing
timeout on the client.

### 5.4 Cache and PII

`cache: false` skips the cache read **and** the write. Use it on any call whose
input is user-authored text. The cache is keyed on the input, so a cached entry
is a stored copy of that input.

For the ledger's own prompt/output snapshots, pass `encrypt`/`decrypt`/
`isEncrypted` — all three together — rather than turning snapshots off, so you
keep the audit trail without keeping plaintext.

---

## 6. Verification: read the ledger, not the tests

The gateway's own suite proves the gateway works. It cannot prove *your*
adoption works. Every check below reads rows, because a row is the only
evidence that survives a process being killed:

- [ ] Every call site produces exactly one ledger row per attempt, with a
      `route` you can trace back to code.
- [ ] `sumSpendCents` for a day agrees with your existing spend figure.
- [ ] A forced provider failure produces one row per attempted link, then
      either a success row or a failure row — **never zero rows**.
- [ ] A spend-cap breach in observe mode produces a `spend_cap_events` row and
      does *not* block.
- [ ] A cache hit produces a row with `provider: "cache"` and zero cost.
- [ ] If prompts are editable: publish an edit and confirm the *next* call
      sends the new body. Assert this through the ledger's `inputText`, not
      through a key-shape check — a key-shape assertion passes against a build
      that computes a fine key and still serves the stale entry.

That last one is the load-bearing test, and the one most likely to be written
wrong.

---

## 7. What the gateway will not do for you

Stated plainly so it isn't discovered late:

- **No admin UI.** The store interfaces are the SPI; the screens are yours.
- **No prompt library management.** `PromptStore` reads. Writing, versioning,
  and approval belong to your control plane. (The one exception: `seedPrompt`,
  which the gateway calls to make a code default visible to an admin UI.)
- **No hedged or parallel calls yet.** Failover is strictly sequential.
  Shadow calls — serve the primary, run a second model off the critical path
  for comparison — are specced in
  [`docs/design/hedging-and-shadow-calls.md`](../design/hedging-and-shadow-calls.md)
  but not built.
- **Embeddings are OpenAI-only** in the built-in path, with a BYO
  `embeddingModel` seam for anything else.
- **No opinion about your auth.** Identity arrives as a `userId` string you
  supply.

---

## 8. Related

- [`README.md`](../../README.md) — the config surface in full
- [`docs/design/admin-control-plane-package.md`](../design/admin-control-plane-package.md)
  — the shared control-plane package, and why it is gated on two apps'
  implementations being confirmed first
- [`docs/design/timeouts-and-deadlines.md`](../design/timeouts-and-deadlines.md)
- [`CHANGELOG.md`](../../CHANGELOG.md) — read the Upgrade notes before bumping
