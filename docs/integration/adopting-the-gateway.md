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

## 2. Before you start: four facts to establish

Adoption plans go wrong when they are written against what the codebase was
believed to do. Get these from the code, not from memory or a design doc.

**These four facts are load-bearing.** Each one selects a branch further down;
the section that consumes it is named alongside it. If you skip this section,
you will take the greenfield path through a step where you already have the
thing being installed, and every one of those is a silent regression rather
than an additive change.

1. **Where are the LLM calls?** Every call site, including the ones in scripts
   and cron jobs. The count matters more than the list — it tells you whether
   this is a one-afternoon change or a phased one.
2. **What does the existing usage table record?** If the app already logs
   spend, the gateway's ledger must either replace it or run alongside it. A
   second ledger that disagrees with the first is worse than either alone.
   → **branches §3.**
3. **Are prompts editable at runtime today?** If an admin can change a prompt
   without a deploy, §5.2 is load-bearing and not optional.
4. **Do you enforce a spend cap today?** Not "do you measure spend" — does
   something in your code path today *refuse* a call on budget grounds? If
   yes, §4.1 and §4.3 have a different shape for you, and taking the
   greenfield path there removes a live control. → **branches §4.1 / §4.3.**

A fifth question decides a smaller branch: **does an admin choose models at
runtime today?** If a settings table drives model selection, §4.2 names the
store that keeps that working.

---

## 3. Schema

**This section branches on §2's second fact.** If you have no usage table
today, take the first path. If you already have one, the first path forks your
ledger rather than adopting it, and nothing reports the problem.

### 3.1 No existing ledger — re-export the tables

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

### 3.2 You already have a usage ledger — decide before you migrate

Running §3.1 as written gives you **three new empty tables beside your three
populated ones**, and your migration tool reports nothing wrong, because
nothing is wrong at the schema level. The collision is in the TypeScript
identifiers only; the underlying columns differ.

The shipped adapter's tables are `ai_usage_log` / `spend_cap_events` /
`ai_judge_scores`, snake_case, with `created_at` in **milliseconds** (see
`src/adapters/drizzle-sqlite.ts`). An existing ledger is quite likely camelCase
with a `createdAt` in **seconds**. Nothing collides, so nothing complains.

Decide *first*, then migrate:

- **The gateway's ledger replaces yours** — backfill it, and repoint your admin
  views, your spend queries, and your account-deletion path at the new tables.
- **Yours stays and the gateway's is retired** — implement `UsageStore` over
  your existing tables instead (§3.3) and do not re-export.

Two failure modes to name, because both are quiet:

- **A forked ledger escapes your data-subject deletion path.** If your deletion
  code runs `DELETE FROM <your table> WHERE userId = ?`, the gateway's
  `ai_usage_log` is not in it — and its `input_text` holds the same prompt
  snapshots your own table holds. An adopter with a deletion or retention
  obligation now has a second copy of user-authored text that no existing code
  path reaches. This is the consequence worth checking before the migration,
  not after.
- **Seconds versus milliseconds does not throw.** It returns a plausible
  number over a window off by 1000×. See §3.3.

### 3.3 Writing your own `UsageStore`

Not on Drizzle, or keeping your own tables? `UsageStore` is six methods, four
of them required. Implementing it against any client is an afternoon; read
`src/adapters/drizzle-pg.ts` as the reference.

Two things about it have real semantics, and both fail silently:

- **`sumSpendCents`'s identity argument.** `userId === undefined` means *all*
  identities (the global circuit breaker); `userId === null` means anonymous
  only. Getting those two confused silently breaks your caps.
- **The time unit.** The shipped adapters store `created_at` in milliseconds.
  If your column is in seconds and you window against it with a millisecond
  `since`, you get a number back rather than an error — the same failure shape
  as the identity confusion above.

---

## 4. The phased adoption

The point of phasing is that **each phase is independently verifiable and
independently revertible**. Do not collapse them because the app is small.

### 4.1 Phase 1 — ledger only

Route calls through `runStructured`/`runText` and keep your existing model
selection. **How you configure `caps` depends on §2's fourth fact.**

#### If you do not enforce a spend cap today

Set every cap to observe:

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

#### If you already enforce a spend cap — keep enforcing it

`observe` does not mean "measure before enforcing." It means **do not block**:
internally the mode sets one flag — `const enforced = this.caps.mode !==
"observe"` — and a breach in observe mode writes its row and returns. For an adopter who already refuses calls on budget grounds, taking the
greenfield path above **switches a live enforcement control off, and leaves it
off for the whole Phase 1 → Phase 3 window.** There is no first guess to
validate here; the thresholds are the ones already running in production.

Keep your existing pre-flight check in front of the gateway call, and let the
gateway observe behind it:

```ts
// Your existing control stays in the path — unchanged, still enforcing.
await assertWithinBudget(userId);

const { object } = await gw.runStructured({ ...opts, userId });
```

with the gateway configured exactly as above. Both run for the whole window.
The gateway's `spend_cap_events` rows still give you the comparison the phase
exists for — what *its* accounting would have blocked, measured against what
yours actually blocked — and enforcement never lapses.

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

#### If an admin picks models at runtime — implement `TaskOverrideStore` now

`tasks.defaults` is **code**. If your model choice currently lives in a
settings table an admin edits without a deploy, moving it into `defaults` and
stopping there doesn't replace your chain-walking — it relocates a runtime
control into a deploy. The admin UI keeps rendering, keeps writing rows, and
those rows stop affecting any named call site. Nothing errors.

The answer is `TaskOverrideStore`, and it belongs in **this** phase, not §4.4.
`TaskRouter.chainForTask()` reads the override store first and the store wins
over the code default, so one small store over the settings table you already
have keeps the UI live throughout:

```ts
const gateway = new Gateway({
  // ...
  tasks: {
    defaults: { summarize: "claude-haiku-4-5-20251001" },
    store: myTaskOverrideStore,   // admin edits win over defaults
  },
});
```

`TaskOverrideStore` is one method, `getOverrides(orgId?)`. Code defaults become
the fallback for when the store is empty or unreachable, rather than the only
answer — `loadOverrides` returns `{}` when no store is configured, which is
exactly today's behaviour.

Two operational details worth knowing up front: overrides are cached for 30s
(`tasks.overrideTtlMs` to change it), and `TaskRouter.invalidateOverrides()`
clears that cache, so an admin write path can make an edit visible immediately
rather than waiting out the TTL.

> **"The gateway is plumbing, not a control plane" means it ships no
> *persistent* store — not that task defaults are meant to be code-only.** All
> three config stores exist precisely so an app's own control plane stays in
> charge. Deferring this to §4.4 is what makes Phase 2 read as a one-way door.

**Verification:** kill a provider key in staging and watch the chain walk in
the ledger — one row per attempt, `provider` and `model` differing per row. If
you implemented `TaskOverrideStore`, also change a model in the admin UI and
confirm the next call's ledger row names the new model.

### 4.3 Phase 3 — enforce

Flip `mode` to `"enforce"` (or drop it; enforce is the default) once the
observed breach rate is what you expect.

If you kept a pre-flight check through §4.1, this phase has a constraint the
greenfield path does not:

> **Deleting the pre-flight check and flipping `caps.mode` must be the same
> change.** Doing only the first re-opens the hole you avoided in Phase 1;
> doing only the second double-enforces, and your users hit whichever limit is
> tighter with an error from whichever layer got there first.

Ship them together, in one commit, and verify with a deliberate breach that
exactly one `SpendCapError` comes back and a `spend_cap_events` row is written
for it.

### 4.4 Phase 4 — the control plane

Implement `PromptStore` and `ModelConfigStore` over your existing settings
tables, so an admin can change prompts and pin models without a deploy. This is
the phase that needs §5.2.

(`TaskOverrideStore` is the third of the trio. If an admin already chose models
at runtime before you started, you implemented it back in §4.2 rather than
leaving the UI dead for three phases.)

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
- [ ] A spend-cap breach produces a `spend_cap_events` row — **and the call is
      refused by whichever layer owns enforcement right now.** If you enforced
      before adopting, that is your pre-flight check during Phase 1–2 and the
      gateway from Phase 3 on; a breach that returns a result means enforcement
      has lapsed (§4.1). If you did not enforce before, observe mode not
      blocking is correct and expected.
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
