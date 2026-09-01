# The shared admin control plane

Status: **design only**. Specifies a **sibling package**, not a change to this
repository. Nothing here is built.

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

The gateway **never writes a prompt, a chain, a task override, or a cap**. Not
once. The write side of every one of these is entirely unspecified.

That is not an oversight — it is the boundary §3.5 says to hold. And it is
exactly where this package lives: **the gateway reads, the control plane
writes, and they meet at a shared schema.**

## What this package is not

Stated first, because every one of these is a way the project could fail:

- **Not part of the gateway.** It depends on the gateway for types; the gateway
  never depends on it. If the gateway needs to know this package exists, the
  design is wrong.
- **Not a hosted service.** Same self-host posture as the gateway.
- **Not an auth system.** It authorizes against an identity the host app
  supplies. It never authenticates anyone.
- **Not a database owner.** It takes the app's existing connection, like the
  Drizzle adapters do. No new datastore, no sidecar.
- **Not a proxy.** Inference keeps going through the gateway in the app's own
  process. The control plane never sits in the request path.

## Shape: four layers, value inverted against the obvious order

```
L4  React admin UI            ← lowest value, highest chance of rejection
L3  HTTP handlers (mountable)
L2  Headless admin operations
L1  Store adapters + schema   ← highest value, lowest risk
```

Most admin-surface projects begin at L4 and die there, because the UI is the
layer most likely to collide with an adopting app's design system, routing,
and auth. **This one ships L1 first and may never ship L4.**

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
setChain({ orgId, links, author })
setTaskOverride({ task, spec, orgId, author })
spendRollup({ orgId, since, groupBy: "model" | "route" | "day" })
judgeReview({ orgId, since, belowScore })
```

Two rules make these safe, both drawn from behaviour the gateway already has:

- **Validate before save, not after.** The gateway falls back to the code default
  when a stored prompt is missing a required `{{placeholder}}` — a good safety
  net, but it means a broken edit degrades silently in production. The control
  plane validates placeholders against `PromptDefault.variables` at save time and
  refuses the write. The net stays; nobody should be relying on it.
- **Every mutation is versioned and attributed.** See the schema note below.

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
export interface ControlPlaneOptions {
  db: Db;
  /** The host app resolves its own session. This package never authenticates. */
  identify: (req: Request) => Promise<AdminIdentity | null>;
  /** Optional; default denies everything but reads. */
  authorize?: (id: AdminIdentity, action: AdminAction) => boolean | Promise<boolean>;
}
```

The gateway's HTTP skeleton uses bearer tokens mapped to app ids — right for
service-to-service, wrong for humans: no identity, no roles, and no way to record
*who* changed a prompt. That is why `author` is non-optional on every L2 mutation.

**Default-deny on writes.** An unconfigured `authorize` permits reads and refuses
every mutation. Getting this backwards ships a remote prompt-injection surface —
an editable prompt library is arguably the most security-sensitive thing in the
stack, since whoever edits a prompt controls what every downstream model is told.

## Analytics needs no new store

The ledger already carries what a dashboard needs: `provider`, `model`,
`estimated_cost_cents`, `cache_hit`, `duration_ms`, `route`, `prompt_slug`,
`org_id`, `metadata`, plus `spend_cap_events` (with `enforced` since 0.11.0) and
`ai_judge_scores`. Spend dashboards, cap-breach review and judge review are
**queries over existing tables**, not a new persistence layer.

Two consequences worth stating: the control plane needs **read** access to the
usage schema, which is the first thing that has ever needed it; and dashboards
should be read replicas or explicitly rate-limited, because an unbounded
`GROUP BY` over a busy `ai_usage_log` is a self-inflicted outage.

## Rules

1. **The package never widens the gateway's SPI to suit itself.** If a control
   plane feature needs something the gateway doesn't expose, that is a gateway PR
   justified on its own merits, not a dependency of this one.
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

- **A1 — L1 adapters.** `PromptStore`, `ModelConfigStore`, `TaskOverrideStore`
  over Drizzle (PG + SQLite), plus the reference schema and `ensureTables`.
  Closes the table in "Problem" and is independently useful.
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

## Which repository

A new one. Not this repo — the gateway must not carry a dependency on an admin
package, even optionally, and §3.5's boundary is easier to hold across a
repository line than across a directory. Not inside an app, for the obvious
reason.

The design doc lives here because this is where the SPI it implements is defined
and where the boundary is documented.

## Backward compatibility

Nothing in this package changes the gateway. Adopters keep their hand-written
stores indefinitely; the adapters are an alternative, not a migration. The one
thing that would force change is a schema mismatch between an app's existing
tables and the reference schema — which is why A1 must be designed against what
FMA and CareerPointers already have, not against a clean sheet.

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
   is in scope for the session that wrote this document, so this is unverified.
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
| Which layer first? | L1 store adapters | Highest value, lowest risk, independently useful |
| Owns auth? | No — `identify` callback | Every app already has a session |
| Owns a database? | No — takes the app's connection | Same posture as the Drizzle adapters |
| New analytics store? | No | The ledger already has the columns |
| Prompt history in the gateway? | No — here | `StoredPrompt` is the hot-read projection |
| Default authorization | Deny writes | An editable prompt library steers every model |
| UI first? | No — possibly never | It is the layer most likely to be rejected |
