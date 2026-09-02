# The shared admin control plane

Status: **design only**. Specifies a **sibling package**, not a change to this
repository. Nothing here is built. Revised once after adversarial review — see
"Revision history".

Supersedes [admin-ui-reference.md](./admin-ui-reference.md), which sketched an
admin *UI* sequenced "after the Show HN wave". That framing put the least
valuable layer first. This document inverts it.

Related: finding §3.5 in [critique-beyond-pr18.md](./critique-beyond-pr18.md) —
"No control plane — the admin surface is a thin HTTP skeleton" — which correctly
identifies this as **a boundary to hold, not a gap to fill**. This package is how
you hold it: by giving the control plane somewhere to live that is not inside the
gateway.

## Problem

The extraction eliminated divergence in **inference**. It left divergence in
**configuration** completely intact.

Count the reference implementations this repository ships, per store interface:

| SPI | Reference adapters | Who writes it today |
|---|---|---|
| `UsageStore` | 3 (memory, Drizzle SQLite, Drizzle PG) | shipped |
| `PromptStore` | 1 (memory — dev only) | **every adopter, by hand** |
| `ModelConfigStore` | **0** | **every adopter, by hand** |
| `TaskOverrideStore` | **0** | **every adopter, by hand** |

Three apps — FMA, CareerPointers, NewsHound — each hand-write the same three
interfaces over their own schema, with their own bugs, their own migration story
and their own admin surface. FMA has a real control plane. CareerPointers has
"a single 13-line route listing provider models" (§3.5). NewsHound has whatever
it has. That is precisely the divergence the gateway was extracted to remove,
sitting one layer up and unaddressed.

The second symptom is operational: **nobody can change a prompt without a
deploy** unless they have already built the write side themselves. The gateway
supports store-as-override — it is designed for runtime prompt edits and even
falls back to the code default when a stored edit is malformed — but it ships no
way to *make* that edit.

## The seam nobody has named

Every control-plane interface in the gateway is **read-only from the gateway's
side**:

| Interface | Methods the gateway calls | Direction |
|---|---|---|
| `PromptStore` | `getPrompt`, `seedPrompt?` | read (+ one seed) |
| `ModelConfigStore` | `getOverride`, `getChain`, `getJudgeModel?` | read |
| `TaskOverrideStore` | `getOverrides` | read |
| `UsageStore` | `logUsage`, `recordSpendCapEvent`, `saveJudgeScore` | append |
| `UsageStore` | `sumSpendCents`, `get*DailyCapCents?` | read |

The gateway never writes a **chain**, a **task override**, or a **cap**, and the
write side of each is entirely unspecified. That is not an oversight — it is the
boundary §3.5 says to hold, and it is where this package lives: **the gateway
reads, the control plane writes, and they meet at a shared schema.**

**One exception, and it is load-bearing.** `loadPrompt` calls `seedPrompt` on a
store miss, *on the request path* (`gateway.ts:1819`), writing a code default
into whatever table the adapter backs. It is fire-and-forget and failure-tolerant
(a `.catch` that warns), but it is a write, it carries no author, and it happens
during inference.

That forces a choice the adapter cannot dodge:

- **Implement `seedPrompt`** and it writes a `prompt_versions` row with no
  `author` — violating Rule 4 from inside the gateway. It must also land as
  `published`, or the gateway re-seeds on every subsequent call.
- **Omit it** (it is optional) and the library never sees slugs nobody has
  edited, so the admin UI shows an empty list on a working system.

Recommended: **implement it**, writing a row attributed to a reserved
`system:seed` author with `published = true`, and treat that as the documented
one exception to Rule 4 rather than pretending the rule is absolute.

## What this package is not

Stated first, because every one of these is a way the project could fail:

- **Not part of the gateway.** The dependency is one-way — the gateway never
  imports this package, and if it needs to know this package exists the design is
  wrong. But the dependency is **on a live `Gateway` instance, not merely on
  types**: the package needs `gateway.tasks.invalidateOverrides()` after a task
  write, `gateway.runPromptTest()` for "test this draft", and
  `gateway.registry` to validate a chain and populate model pickers. So
  `ControlPlaneOptions` takes a `gateway`, and this is an in-process sibling, not
  a detached service. The separate repository buys a *code* boundary, not a
  deployment one.
- **Not a hosted service.** Same self-host posture as the gateway.
- **Not an auth system.** It authorizes against an identity the host app
  supplies. It never authenticates anyone.
- **Not a database owner.** It takes the app's existing connection, like the
  Drizzle adapters do. No new datastore, no sidecar.
- **Not a proxy.** Inference keeps going through the gateway in the app's own
  process. The control plane never sits in the request path.

## Shape: four layers, built bottom-up

```
L4  React admin UI            ← highest chance of rejection
L3  HTTP handlers (mountable)
L2  Headless admin operations ← where the pain actually is
L1  Store adapters + schema   ← lowest risk; the foundation L2 needs
```

Most admin-surface projects begin at L4 and die there, because the UI is the
layer most likely to collide with an adopting app's design system, routing, and
auth. **This one ships L1 first and may never ship L4.**

An earlier draft claimed L1 was the *highest-value* layer. That does not survive
scrutiny: the read-side stores are one to three methods each — `MemoryPromptStore`
is about 30 lines — so the cost of hand-writing them is real but small. L1 alone
gives an adopter a table they can still only write with hand-rolled SQL, which is
the status quo `admin-ui-reference.md` was complaining about.

The honest case for building L1 first is **risk and dependency, not value**: it is
the schema L2 needs, and it is independently useful. The value is concentrated in
**L2** — versioned publish and rollback with attribution, and confidence that a
publish actually took effect. Which brings us to the thing that nearly sank this
design.

## The prerequisite: publishing a prompt does not currently take effect

Found in adversarial review of this document's first draft, and verified against
source. It is the most important thing here.

The response cache key is `cacheKey(slug, parts, orgId)` (`gateway.ts:421`) —
**the prompt body is not in it** — and the cache lookup happens *before*
`loadPrompt`:

| Path | cache read | prompt load |
|---|---|---|
| `runText` | `gateway.ts:708` | `gateway.ts:743` |
| `runStructured` | `gateway.ts:1057` | `gateway.ts:1088` |
| `streamStructured` | `gateway.ts:1963` | `gateway.ts:1989` |

So for any input already in cache, **publishing a new prompt version changes
nothing for up to the 24-hour default TTL.** An admin edits a prompt, the UI
confirms it, production keeps serving output generated by the previous version,
and nothing anywhere reports a problem. That is the worst possible failure shape
for an admin tool: silent, delayed, and it makes the operator distrust the whole
surface.

The doc's first draft called the gateway's read path "unchanged and unaware".
It is unaware, and that is exactly the bug.

Three ways out, in preference order:

1. **Put a prompt version or body hash in the cache key** — a gateway change, so
   a gateway PR justified on its own merits (Rule 1), and the cleanest fix: a
   publish makes prior entries unreachable rather than stale. `StoredPrompt` would
   gain a `version` the key incorporates. Non-breaking: absent version, the key
   keeps its current shape.
2. **Invalidate on publish from the control plane** — needs `CacheStore` key
   enumeration by prefix. Workable on Redis (`SCAN`), awkward on the memory store,
   and racy across instances.
3. **Accept the TTL lag and surface it** — the UI states "live within N hours for
   cached inputs". Honest, and bad.

**A1 should not ship without (1).** A prompt library whose publishes do not take
effect is worse than no prompt library, because it invites the operator to
believe a change landed when it has not.

> **Resolved in gateway 0.13.0** via option (1), as
> `invalidateCacheOnPromptChange`. It fingerprints the resolved prompt instead
> of adding `StoredPrompt.version` — see the Sequencing note on A0 for why. The
> control plane must set the flag; it is off by default so existing caches
> survive the upgrade.

The task-override path has the same shape but a smaller blast radius and an
existing escape hatch: `TaskRouter` caches `getOverrides` per org for 30 s
(`tasks.ts:63-85`) and already exposes `invalidateOverrides()`, labelled "admin
write path" (`tasks.ts:55`). `setTaskOverride` must call it — which is one more
reason the package needs a live `Gateway`, and a reason multi-instance
deployments need the 30 s TTL understood as the real propagation delay.

The opposite problem exists on the uncached reads: `getPrompt`, `getOverride` and
`getChain` are hit on **every** call and are not cached at all. A Drizzle PG
adapter therefore adds two to three round-trips to every inference. If L1 caches
to fix that, it inherits the invalidation problem above — so caching belongs in
the adapter only alongside fix (1), never before it.

### L1 — Store adapters and the reference schema

The whole of the table in "Problem", closed:

```ts
import { DrizzlePgPromptStore, DrizzlePgModelConfigStore,
         DrizzlePgTaskOverrideStore } from "@shared/ai-control-plane/drizzle-pg";

const gw = new Gateway({
  usage:       new DrizzlePgUsageStore(db),        // already exists
  prompts:     new DrizzlePgPromptStore(db),       // new
  modelConfig: new DrizzlePgModelConfigStore(db),  // new
  tasks:       { defaults, store: new DrizzlePgTaskOverrideStore(db) },
});
```

An adopter whose only goal is "stop hand-writing three stores" can take L1 and
nothing else. That alone justifies the package.

### L2 — Headless admin operations (the write side)

Framework-agnostic functions over the same schema. This is the half the gateway
deliberately lacks:

```ts
savePromptVersion({ slug, body, orgId, author, note })  // validated, versioned
publishPromptVersion({ slug, versionId, orgId, author })
rollbackPrompt({ slug, toVersionId, orgId, author })
diffPromptVersions(a, b)
setChain({ orgId, links, author })   // see "A chain is not directly storable"
setTaskOverride({ task, spec, orgId, author })
spendRollup({ orgId, since, groupBy: "model" | "route" | "day" })
judgeReview({ orgId, since, belowScore })
```

Two rules make these safe, both drawn from behaviour the gateway already has:

- **Validate before save, not after.** The gateway falls back to the code default
  when a stored prompt is missing a required `{{placeholder}}` — a good safety
  net, but it means a broken edit degrades silently in production. The control
  plane validates at save time and refuses the write.

  Two limits on that net, both of which the package must cover itself.
  `missingPlaceholders` (`template.ts:28`) only checks that required names are
  *present*; it does not catch an **unknown** placeholder, and `renderTemplate`
  ships `{{typo}}` to the model verbatim. And the fallback only exists when a
  `PromptDefault` is registered for the slug (`gateway.ts:1829`) — a prompt
  created in the library with no code default has **no gateway-side validation and
  no safety net at all**. For those, `prompt_versions.variables[]` is the only
  contract, it is owned by this package, and it is unenforced at read time. So L2
  validates in both directions: required-present *and* no-unknowns.
- **Every mutation is versioned and attributed**, with the `seedPrompt` exception
  named above.

### L3 — HTTP handlers

Hono handlers mirroring L2, mountable in the app's own router — the same
transport choice the gateway's `/http` subpath already makes, so an adopter runs
one framework, not two. Optional; L2 is directly callable from a Next.js server
action or an Express route.

### L4 — React UI

Prompt library, model/task routing, spend dashboards, judge review. **Last, and
optional.** Ships headless-first (hooks + unstyled primitives) so an app with its
own design system can use the logic without the look.

## The schema the gateway deliberately does not own

`StoredPrompt` is `{ slug, body, modelHint?, providerOverride?, temperature? }`.
No version, no author, no timestamp, no history. That is correct for the gateway
— it reads the *current* prompt on a hot path and has no business carrying an
audit trail.

A prompt **library** needs exactly what the gateway omits:

```
prompt_versions
  id, slug, org_id, body, variables[], model_hint, provider_override,
  temperature, author, note, created_at, parent_version_id, published
```

`StoredPrompt` becomes the **projection** of the published row for a slug and
org. The gateway's read path is unchanged and unaware.

This is the clearest illustration of the boundary: the same data, two shapes,
one for a hot read and one for governance, and the package owns the difference.

## Identity, without owning auth

```ts
export interface AdminIdentity { id: string; email?: string; roles?: string[]; }

/** What is being acted on — NOT just what action. See below. */
export interface AdminResource {
  kind: "prompt" | "chain" | "task" | "usage" | "judge";
  orgId?: string | null;   // null = the global row
  slug?: string;
}

export interface ControlPlaneOptions {
  db: Db;
  /** In-process gateway: cache invalidation, prompt test, model discovery. */
  gateway: Gateway;
  /** The host app resolves its own session. This package never authenticates. */
  identify: (req: Request) => Promise<AdminIdentity | null>;
  /** Optional; default denies EVERYTHING, reads included. */
  authorize?: (
    id: AdminIdentity,
    action: AdminAction,
    resource: AdminResource,
  ) => boolean | Promise<boolean>;
}
```

**`authorize` must receive the resource, not just the action.** An earlier draft
passed only `(identity, action)`, which cannot express per-tenant authorization
at all: an org admin permitted to `publishPrompt` could publish for every other
org *and* for the global row. With Rule 6 that is not a nit, it is a cross-tenant
write vulnerability designed in at the type level.

The gateway's HTTP skeleton uses bearer tokens mapped to app ids — right for
service-to-service, wrong for humans: no identity, no roles, and no way to record
*who* changed a prompt. That is why `author` is non-optional on every L2 mutation.

**Default-deny on everything, reads included.** An earlier draft defaulted to
permitting reads. That is wrong: reads here include prompt bodies (IP), per-user
spend (PII), and `inputText`/`outputText` snapshots (user text). "Any identified
user may read" is not a safe default for that set.

And the sensitive asset is not only the prompt body. `modelHint`,
`providerOverride`, `setChain` and `getOverride` decide **which provider sees
your users' data and which account is billed** — routing a call to a non-ZDR
provider is a data-residency incident, not a quality regression. Write access to
routing config deserves the same gate as write access to prompts, and the
security framing should say so rather than treating prompt injection as the whole
threat.

## Analytics needs no new store

The ledger already carries what a dashboard needs: `provider`, `model`,
`estimated_cost_cents`, `cache_hit`, `duration_ms`, `route`, `prompt_slug`,
`org_id`, `metadata`, plus `spend_cap_events` (with `enforced` since 0.11.0) and
`ai_judge_scores`. Spend dashboards, cap-breach review and judge review are
**queries over existing tables**, not a new persistence layer.

Three consequences, the first of which is a genuine scope limit rather than a
note.

**A3 binds to the reference tables, not to the `UsageStore` SPI.** `UsageStore`
has no list or query method — only `logUsage`, `sumSpendCents`,
`recordSpendCapEvent`, `saveJudgeScore` and the optional cap getters. So
"queries over existing tables" means literally the Drizzle tables this package
ships. **An adopter with a hand-written `UsageStore` over a different schema gets
no dashboards**, which contradicts a flat reading of "adopters keep their
hand-written stores indefinitely": they keep them, and they forgo A3. The
alternative is a gateway PR adding a read side to `UsageStore` — a real option,
listed under "candidate gateway changes" below, and not a prerequisite for A1–A2.

**Snapshots are encrypted, and reviewing them means decrypting user data.**
`inputText`/`outputText` pass through the app's `encrypt` hook before reaching the
ledger (`gateway.ts:1924`), so judge review over raw rows shows ciphertext unless
the package is handed `decrypt`. `admin-ui-reference.md` had a rule for this —
ciphertext by default, decryption an explicit opt-in with its own authorization —
and dropping it was an oversight. **Reinstated:** snapshot decryption is a
separate `AdminAction`, denied by default even for users who may read
aggregates. The same care applies to `metadata`, which is caller-defined and may
carry anything.

**Dashboards need a read replica or an explicit rate limit**, because an
unbounded `GROUP BY` over a busy `ai_usage_log` is a self-inflicted outage.

## A chain is not directly storable

`setChain` looks like the simplest operation in L2 and is the most under-specified.
`ChainLinkConfig` (`types.ts:160-185`) is a *runtime* shape, not a record:

- **`languageModel?: LanguageModel`** is a live object. A BYO Bedrock, Azure or
  Vertex link cannot round-trip through a database row at all.
- **`apiKey?: string`** is a secret. A control plane that stores and renders chain
  configs would be storing provider credentials in an admin-readable table.
- **`getOverride` returns `provider: ProviderId`**, a closed union of the seven
  built-ins — so a custom `endpoint` or `factory` link **cannot be expressed as a
  hard pin** through that method even though `getChain` supports both.

So the package stores a deliberately narrower record:

```ts
/** The storable subset. Secrets by reference, never by value. */
interface StoredChainLink {
  provider?: ProviderId; endpoint?: string; factory?: string;
  model: string;
  temperature?: number | null;
  apiKeyRef?: string;        // env var NAME or secret-manager id — never the key
}
```

`languageModel` links stay in code, where they already are. The schema stores what
an admin can safely edit; anything requiring a live object is out of scope for
runtime configuration, and the doc should say so rather than implying every chain
is editable.

Validating a chain at save time needs the app's `ProviderConfig` — which endpoint
and factory names exist, which keys are set, which tiers resolve. That lives on
the `Gateway` instance, which is a third reason the package takes one.

## What a day-one implementer hits

Collected from adversarial review; none of these are exotic.

- **Concurrent edits.** Two admins publish the same slug. Needs optimistic locking
  on `parent_version_id` and a partial unique index on `(slug, org_id) WHERE
  published`.
- **Org fallback semantics.** `MemoryPromptStore` falls back org → global
  (`memory.ts:71`). Does the published projection inherit that? May an org admin
  see, or edit, the global row? Unspecified, and it is a cross-tenant question.
- **Drift between code defaults and published overrides.** Add a required variable
  to a `PromptDefault` in code, and every already-published body is now missing a
  placeholder — so production silently reverts to the code default. The package
  should detect this at deploy or import time; nothing else will.
- **Deleting a library-only prompt is a production 500.** With no `PromptDefault`,
  `getPrompt` returning undefined makes the gateway throw "not found"
  (`gateway.ts:1813`) — *before* any usage row is written. An admin action can
  therefore create a failure path that writes no ledger row, which brushes against
  the ledger-first principle. Unpublish must be blocked, or gated behind an
  explicit confirmation, when no code default exists.
- **No SPI conformance suite exists.** The gateway tests `UsageStore` against
  Drizzle SQLite only. This package needs contract tests for three stores across
  PG and SQLite, plus an integration test that the gateway consumes the published
  projection correctly — which makes the gateway a devDependency.
- **`temperature: null` means two different things.** On `StoredPrompt` it is
  "unset"; on `ChainLinkConfig` it is "never send temperature on this link"
  (`types.ts:122` vs `:179`). The schema must say which one it encodes.
- **Rollups drift.** `estimated_cost_cents` is the estimate at write time under
  the pricing table configured then, so historical spend restated under new
  pricing will not match. Also `groupBy: "day"` needs a stated timezone.

## Rules

1. **The package never widens the gateway's SPI to suit itself.** If a control
   plane feature needs something the gateway doesn't expose, that is a gateway PR
   justified on its own merits, not a dependency of this one. Three such
   candidates are already visible, and naming them is better than discovering them
   mid-build:
   - **a prompt version or hash on `StoredPrompt`, incorporated into the cache
     key** — a prerequisite for A1, per the section above;
   - **`variables[]` on `StoredPrompt`**, so library-only prompts get read-time
     validation instead of relying on a `PromptDefault` that does not exist;
   - **a read side on `UsageStore`**, without which A3 only works for adopters on
     the reference tables.
2. **The gateway never imports this package.** One-way dependency, always.
3. **Never owns auth, never owns a connection.** Both are the host app's.
4. **Every mutation is attributed and versioned.** No silent edits to a prompt
   that steers production models.
5. **Validate at write time.** Never rely on the gateway's fallback as the
   primary defence against a bad edit.
6. **Org-aware from day one.** `orgId` is already threaded through every SPI
   method. Building single-tenant and retrofitting would repeat finding 3.1's
   mistake at a layer where the retrofit is harder, because the UI shape changes
   too.
7. **The read path stays the gateway's.** The control plane configures; it never
   serves inference.

## Sequencing

- **A0 — the cache-key gateway PR. DONE** (gateway 0.13.0). Shipped as
  `GatewayConfig.invalidateCacheOnPromptChange`, opt-in and default-off.
  Implemented by fingerprinting the resolved prompt rather than versioning
  `StoredPrompt` as sketched below: a version field is only correct while every
  writer remembers to bump it, and one that forgets reintroduces this bug
  silently, whereas a hash cannot go stale and needs no SPI change. The
  fingerprint covers `modelHint`/`providerOverride`/`temperature` as well as the
  body, so repointing a prompt at another model invalidates too. **A1 is
  unblocked.**
- **A1 — L1 adapters.** `PromptStore`, `ModelConfigStore`, `TaskOverrideStore`
  over Drizzle (PG + SQLite), plus the reference schema and its migration path.
  Closes the table in "Problem" and is independently useful. Note `ensureTables`
  has precedent for SQLite only (`drizzle-sqlite.ts:198`); PG uses drizzle-kit.
- **A2 — L2 write side.** Prompt versioning, publish/rollback, chain and task
  mutation, attribution. The half nobody has.
- **A3 — spend and judge queries.** Rollups over the existing ledger.
- **A4 — L3 handlers.**
- **A5 — L4 UI.** Only if two apps want the same screens. If FMA keeps its own
  admin and CareerPointers builds a different one, A1–A3 still paid for
  themselves and A5 should not be built.

**Gate: A1 starts when a second app needs a store the first one already wrote.**
That condition is arguably met today — the requirement is to confirm what FMA and
CareerPointers actually implement before writing a third version, since the
adapters must fit the schemas already in production, not a greenfield ideal.

**Half of that confirmation is now in** ([#44](https://github.com/mpointer/llm-governance-gateway/issues/44),
2026-09-01). CareerPointers was verified against its current `main`; see Open
question 1 below for what it changes. **FMA remains unconfirmed, and it is the
half that matters more** — it is the app with a real control plane, so it is the
one whose schema an adapter would have to fit.

## Which repository

A new one. Not this repo — the gateway must not carry a dependency on an admin
package, even optionally, and §3.5's boundary is easier to hold across a
repository line than across a directory. Not inside an app, for the obvious
reason.

The design doc lives here because this is where the SPI it implements is defined
and where the boundary is documented.

## Backward compatibility

Nothing in this package changes the gateway, and no adopter is obliged to take it.

The first draft tried to have this both ways — a "reference schema" that also
"must fit the schemas already in production". Those are different projects.
Fitting three existing schemas means three adapters, which is what those apps
already have and would deliver no convergence at all. **So: a reference schema.**

The consequence, stated plainly rather than dodged: FMA and CareerPointers each
have production tables that will not match it, so adopting L1 is a **migration**
for them, not a drop-in. The package should ship that migration path (a documented
mapping and a backfill script) rather than pretending the question does not arise.

That reframes who benefits first. The clean win is for **new** adopters and for
any app that has not yet built its config store; for the two that have, the
package is a convergence target with a real switching cost, and the decision is
theirs. Confirming what FMA and CareerPointers actually run remains the first task
of A1 — not to fit it, but to size the migration.

## Explicitly out of scope

- **Anything in the inference path.** No routing decisions, no request handling.
- **Authentication.** Identity resolution is a callback.
- **A hosted or multi-app-shared deployment.** Each app mounts its own.
- **Prompt A/B testing and evaluation runs.** Adjacent and tempting; belongs
  with the shadow-call work in
  [hedging-and-shadow-calls.md](./hedging-and-shadow-calls.md), not here.
- **Migrating the gateway's own `/prompt-test` skeleton.** It stays as the thin
  SPI proof it is.

## Open questions (answer before building)

1. **What do FMA and CareerPointers actually implement today?** The single
   highest-value unknown. The adapters must fit real schemas. Neither repository
   is in scope for the session that wrote this document.

   **CareerPointers: answered** ([#44](https://github.com/mpointer/llm-governance-gateway/issues/44),
   verified against CP `main` on 2026-09-01; full report with file:line citations
   in `futuremeanswered/CareerPointers` PR #635). Two things for A1's scoping:

   - **The prior art to fit is `aiModelConfig` (admin override) plus the admin
     prompt editor, both over `@pointers/db`.** That is what an L1 adapter would
     have to map onto.
   - **Not `apps/ai-gateway`.** CP carries an unactivated Cloudflare Worker of
     that name which duplicates `packages/ai`'s chain-walking, tiers, pricing and
     admin override so that CP and FMA could share one governed backend over HTTP
     — the same problem this package and the gateway already solve. It is not a
     gateway defect and it is not prior art for the stores; the honest read is
     that adopting the gateway retires it rather than running alongside it.
     Recorded here because a scoping pass that mistook it for CP's control plane
     would size the migration against the wrong code.

   **FMA: still unanswered**, and it is the more consequential half — FMA is the
   app with the real org-scoped control plane.
2. **One package or two?** Splitting adapters (L1) from admin logic (L2+) lets an
   adopter take the stores without the write side. Leaning: one package, subpath
   exports, mirroring how the gateway ships `/drizzle-pg` and `/http`.
3. **Does prompt versioning need branches, or is linear history with rollback
   enough?** Leaning: linear. Branches invite a merge UI.
4. **Should `PromptStore.seedPrompt` be the seam for importing code defaults into
   the library**, or should the control plane read `promptDefaults` directly?
   The former is already in the SPI and unused by any shipped adapter.
5. **Read replica for dashboards** — package concern or deployment note?

## Decisions

| Decision | Answer | Why |
|---|---|---|
| Inside the gateway? | No — sibling package | §3.5: the boundary is the point |
| Which layer first? | L1 store adapters | Lowest risk and the schema L2 needs — *not* highest value; see the layering section |
| Owns auth? | No — `identify` callback | Every app already has a session |
| Owns a database? | No — takes the app's connection | Same posture as the Drizzle adapters |
| New analytics store? | No | The ledger already has the columns |
| Prompt history in the gateway? | No — here | `StoredPrompt` is the hot-read projection |
| Default authorization | Deny writes | An editable prompt library steers every model |
| UI first? | No — possibly never | It is the layer most likely to be rejected |
| Prompt version in the cache key? | **Prerequisite for A1** | Without it a publish silently does nothing for up to 24h |
| Fit existing app schemas, or ship a reference one? | Reference schema | Fitting three schemas is three adapters, i.e. no convergence |
| Does `authorize` see the resource? | Yes — action *and* resource | Action alone cannot express per-tenant authorization |
| Default for reads | Deny | Reads include prompt bodies, per-user spend and user-text snapshots |
| Store `languageModel` / `apiKey` in a chain row? | Never | One is unserialisable, the other is a secret |
| Implement `seedPrompt`? | Yes, as `system:seed` | The documented exception to "every mutation is attributed" |

## Revision history

**2026-09-01 — revised after adversarial review of the first draft.** Changes
worth knowing about if you read the original:

- The cache-invalidation prerequisite is **new**, and it is the reason A1 now has
  a gateway PR in front of it. The first draft asserted the gateway's read path
  was "unchanged and unaware"; unaware was the bug.
- "The gateway never writes a prompt — not once" was **false**. `seedPrompt` runs
  on the request path.
- L1 was claimed as the *highest-value* layer. Corrected: it is the lowest-risk
  layer and the foundation L2 needs. The value is in L2.
- `authorize` took no resource, which could not express per-tenant permission —
  a cross-tenant write hole at the type level.
- Default-allow on reads, corrected to default-deny.
- The decrypt/PII rule inherited from `admin-ui-reference.md` had been dropped;
  reinstated as its own `AdminAction`.
- Reference-schema versus fit-existing-schemas was an unresolved contradiction;
  resolved in favour of a reference schema, with the migration cost stated.
- Chain storability, the day-one implementer list, and the candidate gateway
  changes under Rule 1 are all new.
