# Design: the slug names the model

Status: decided 2026-10-28, not implemented. Answers #49, and through it #10,
#11, #13, #33 and the composition question in #57. Implementation is gated on
the first adopter that needs it: Scout (the `@pointer/scout` chat engine) moving
onto the gateway in CareerPointers, then in Future Me Answered once FMA's
#4402 (one ZDR path for all AI traffic) is decided. Scout also needs a
tool-calling `streamText` (#14), so this and #14 land together or this lands
first.

## Problem

Adopters keep rebuilding model resolution outside the gateway, then trying to
keep the two in agreement:

- NewsHound wrote a guard that re-resolves via `task` and only hands off when
  both resolvers agree (#10), kept a local `resolveModel()` for calls with a
  second axis (#13), and left Venice off the gateway entirely (#11).
- CareerPointers' Scout adapter (`apps/web/lib/scout-cp/gateway.ts`) resolves
  a model from the slug's `modelHint`, then `streamText` ignores that handle
  and re-resolves with no slug model at all. The chat streams on the admin pin
  or chain, never on the slug's model.
- The Scout seam itself has drifted between hosts. FMA's in-tree copy added
  `promptSlug` to `resolveModel` so its ZDR lock can see the slug. CP vendors
  the older `pointer-ai` copy, which lacks it.
- `ModelConfigStore.getOverride` has gained `orgId` then `tier` for the same
  reason: resolution needed one more fact about the call.

Both apps already work the same way underneath. Each prompt row carries the
prompt and its model together (CP: `prompts.modelHint`; FMA:
`prompts.modelOverride` plus `providerOverride` and `temperature`). That is the
owner's design principle for these apps, and the gateway should adopt it.

## Decision

**The slug always names the model.** Code never names a model on a call. An
admin changes a call's model by editing the slug's row in the prompt library.

### What a slug can pin

`StoredPrompt` (and `PromptDefault` for code defaults) gains three optional
fields next to the existing `modelHint` and `providerOverride`:

```ts
interface StoredPrompt {
  slug: string;
  body: string;
  modelHint?: string | null;          // existing: the slug's model
  providerOverride?: string | null;   // existing
  temperature?: number | null;        // existing
  tierModels?: { fast: string; power: string } | null;  // new, rare
  fallbackModels?: string[] | null;   // new, optional
}
```

- **Normal case:** one model in `modelHint`. The call's `tier` is ignored.
- **Rare case:** `tierModels` pins a fast and a power model, and the call's
  `tier` picks one. Use it only where a user-facing fast/power toggle matters,
  like Scout chat. Most slugs should not set it. Both models or neither.
- **Fallbacks:** `fallbackModels` is walked in order after the slug's model.
  When it is absent, a failed slug model falls back to the configured chain.

Model ids use the existing format (bare = Anthropic, `openai:` etc. prefixed),
validated by the existing `validatedModelHint`.

### Precedence

Opt-in via a new `GatewayConfig.slugPinWins?: boolean` (default false). With it
off, resolution is byte-for-byte what ships today. With it on:

1. **ZDR constraint.** Not a preference: it filters every layer below. A
   ZDR-required call only runs on ZDR-eligible models. On a slug-pinned
   ZDR call, if the slug's model and every fallback are ineligible (or there
   are no fallbacks), the call throws `ZdrViolationError` rather than walking
   the chain. A wrong pin on a locked slug fails loudly, matching FMA's
   existing fail-closed lock.
2. **The slug's pin:** `tierModels[tier]` if set and a tier was passed, else
   `modelHint`, then `fallbackModels`, then the chain. Once a slug is pinned,
   its failures go straight to the chain: the admin pin and the task are
   skipped. `routedBy` is `"slug"`, `"slug-fallback"` or `"chain"` on such a
   call, never `"admin-pin"`.
3. **The admin global pin** (`ModelConfigStore.getOverride`). Unchanged: a
   hard pin with no failover.
4. **The task**, with #57's `tasks.overridesBeatPin` deciding whether a task
   store entry beats the admin pin.
5. **The chain**, then the env/config default.

`providerOverride` qualifies every id on the row (`modelHint`, both
`tierModels` and each `fallbackModels` entry), exactly as it qualifies
`modelHint` today. A prefixed id overrides it for that one entry.

When a stored row leaves a new field null or absent, the code default's
value (`PromptDefault`) for that field applies. Merge is per field; a non-null
row field always wins. Without this, adopters' existing rows (which have no
`tierModels` column) would silently cancel a code default's tier pins.

### Which methods

The slug pin applies to `runStructured`, `runText`, `streamStructured` and the
future `streamText` (#14), identically. Out of scope, unchanged:

- `submitBatch` keeps its existing `opts.model` (removing it breaks callers).
  With `slugPinWins` on, the slug pin applies when `opts.model` is absent.
  `opts.model` is marked deprecated in its doc comment.
- `runJudge` keeps its own admin-pinned judge model (`getJudgeModel`).
- `runPromptTest` keeps its explicit `model`: it is the admin's test bench and
  deliberately bypasses governance.

`zdr.slugs` applies to every method that takes a slug, batch and judge
included.

Today `modelHint` is honored only on `runStructured`, and only in two narrow
cases (inside an admin pin's provider, or with no chain). That narrowness is a
bug under this decision.

### ZDR per slug

The gateway learns which slugs are ZDR-locked from code config, not from the
prompt row: `GatewayConfig.zdr?.slugs?: string[]`, equivalent to FMA's
`ZDR_LOCKED_SLUGS`. A lock is a security decision and should not be editable in
an admin UI. The existing per-call `requireZdr` and per-task
`constraints.requireZdr` stay; any of the three makes the call ZDR-required.

`zdr.slugs` works whether or not `slugPinWins` is on, and can ship as its own
change first. Setting it is itself the opt-in, so default resolution is still
unchanged. FMA can adopt it without adopting slug routing.

### Scout: no handle

The gateway does not expose resolved model handles. Scout's
"resolve once, reuse" need disappears because the streaming call takes the
slug and resolves the model itself, using the same precedence. A host's
`resolveModel` in the Scout seam becomes an availability check only, and the
host passes `promptSlug` through to the gateway call. No handle shape enters
the public contract, so nothing about it needs freezing at 1.0.

### Ledger

`UsageEntry` gains an optional `routedBy` field recording which layer decided:
`"slug" | "slug-fallback" | "admin-pin" | "task-override" | "task-default" |
"chain" | "default"`. Optional, so existing `UsageStore` implementations keep
compiling, and absent on rows written with `slugPinWins` off.

## Answers to #49's questions

1. **Per-call model override (#10): declined.** The slug names the model. A
   call site that needs a different model gets a different slug.
2. **Second task axis (#13): no new axis.** Each variant is its own slug with
   its own prompt and model (`summarize-rural`, `summarize-urban`).
   `TaskRouter` and `modelForTask` are unchanged.
3. **Per-link `extraBody` (#11): independent.** It is provider construction,
   not resolution. It goes on `ChainLinkConfig`/`ProviderConfig` as
   `providerOptions` and can ship on its own whenever Venice needs it.
4. **Parameter accretion: stopped, without a context object.** Resolution
   needs the slug, the org and the tier. The slug carries the ZDR rule, so
   `getOverride` gains nothing further and no migration is needed.

Also settled:

- **#57 (pin shadows task store):** the shipped opt-in `tasks.overridesBeatPin`
  stands. Under this design both sit below the slug pin.
- **#33 (content-based routing):** a content router, if one is ever built,
  picks a slug, never a model.

## Non-goals

- Jev (TypeSafe) and speech-to-text routing. Jev uses its own SDK, returns
  typed judgments rather than text, and pins its own model
  (FMA `src/lib/typesafe.ts`). Speech-to-text goes through Vercel AI Gateway
  for its team ZDR. Both stay off this resolution path. They should still
  write ledger rows under their own slugs so cost analysis sees them.
- A per-call `model` parameter on any run method.
- Admin-editable ZDR locks.
- Merging tasks into slugs. Tasks stay as code-side defaults for slugs with
  no pin.

## Anti-goals

These would make the change a failure even if it technically worked:

- Any existing adopter's routing changes without opting in.
- A ZDR-locked slug ever runs on a non-eligible model, through a fallback or
  any other path.
- The ledger cannot tell a slug-pinned call from a chain-routed one.
- Scout's fast/power toggle silently does nothing on a slug that pinned
  `tierModels`.

## Left to the builder

- Exact field names, if `tierModels`/`fallbackModels`/`routedBy` clash with
  anything in the adopters' stores.
- How the slug's chain (model, fallbacks, then chain) reuses `callWithChain`
  and the streaming failover in `stream-guard.ts`.
- Cache-key impact: `tierModels` and `fallbackModels` must join `modelHint` in
  the prompt fingerprint (`gateway.ts` around line 503) when
  `invalidateCacheOnPromptChange` is on.
- The Scout seam change itself lives in `pointer-ai`, which CP vendors and FMA
  has diverged from. Reconciling the two copies is a prerequisite there, not
  here.

## Calls made in writing this (not discussed)

- A slug that pins `tierModels` but receives no tier uses the power model.
- ZDR locks come from code config (`zdr.slugs`), not the prompt row.
- The opt-in is a single gateway-level flag, `slugPinWins`.
- `routedBy` vocabulary as listed above.
- A slug-pinned call that exhausts its slug models goes straight to the chain,
  skipping the admin pin and the task (from "fallback to the chain").
- A slug-pinned ZDR call with no eligible slug model throws instead of
  walking the ZDR-filtered chain.
- `zdr.slugs` is independent of `slugPinWins`.
- Row fields merge per field over code defaults.
- `submitBatch`'s `opts.model` stays (deprecated), `runJudge` and
  `runPromptTest` are unchanged.
- `providerOverride` qualifies every id on the row.
