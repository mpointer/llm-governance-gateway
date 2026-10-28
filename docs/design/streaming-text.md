# Design: governed `streamText` with tool calling

Status: shipped in Unreleased (`Gateway.streamText`). Answers the Scout half of #14.
NewsHound's half (native Anthropic streaming via `.messages.stream()`, which
also lifts the SDK's 10-minute non-streaming ceiling) is deferred and stays
open on #14.

## Problem

Two adopters have each had to keep a streaming path off the gateway with a
named call site. The harder one is CareerPointers' Scout chat
(`apps/web/lib/scout-cp/gateway.ts`, `cpGateway.streamText`), which implements
the `Gateway` port that the `@pointer/scout` chat engine consumes. A chat turn
is one streaming call with tools and `stopWhen: stepCountIs(4)`. The engine
reads text deltas as they arrive and reads `toolCalls`/`toolResults` afterward.

The gateway has `streamStructured` (objects) and `runText` (non-streaming), but
nothing that streams text with tools. While that is true, CP must keep its old
resolution layer (`getActiveChain`/`getSdkModel`/`getModelOverride`) alive for
this one file, and FMA cannot move Scout onto the gateway at all.

`streamStructured`'s failure behavior does not transfer. It restarts on the
next link mid-stream, which is fine for objects because every partial is a
full snapshot. For text, a restart repeats words the user has already read.
CP ships the opposite contract today, and a silent restart would be a
regression they could not adopt.

## Decision

### Shape

```ts
gateway.streamText(opts: StreamTextOptions): StreamTextResult

interface StreamTextOptions {
  slug: string;                 // names the call: routing, ledger, guardrails, ZDR
  system?: string;              // caller-assembled; the gateway does not render it
  messages: ModelMessage[];     // AI SDK message type
  tools?: ToolSet;              // passed through; the AI SDK executes them
  stopWhen?: StopCondition | StopCondition[];  // passed through
  tier?: "fast" | "power";
  task?: string;
  orgId?: string;
  userId?: string;              // identity and cap scope: same four fields
  anonKey?: string;             // and semantics as RunTextOptions
  route?: string;
  app?: string;
  temperature?: number;
  requireZdr?: boolean;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  degradedNotice?: string;      // overrides the gateway default
}

interface StreamTextResult {
  traceId: string;
  textStream: AsyncIterable<string>;   // deltas; never throws after first token
  result: Promise<{
    text: string;                      // everything the user saw, notice included
    toolCalls: unknown[];
    toolResults: unknown[];
    usage: { inputTokens: number; outputTokens: number };
    provider: string;
    model: string;
    degraded: boolean;
    failovers: StreamFailover[];       // existing type
  }>;                                  // resolves AFTER the ledger row is written
}
```

The caller builds the system prompt, as Scout does today. The slug is
required because it is what the ledger, guardrails and ZDR key on, and what
#49's slug pin will route on.

### Governance

Same front door as `runText` (`Gateway.frontDoor`): rate limit, spend cap,
guardrail pre-hook, then the usage ledger. Differences:

- **No cache.** Chat turns and tool side effects must not be replayed.
- **No judge.**
- **Guardrail pre-hook** gets `prompt` = the last user message and
  `system` = the system text, as separate fields. A `transform` replaces the
  last user message only; the system text is never rewritten. `frontDoor`
  renders stored prompts by slug, so `streamText` needs its own pre-hook
  branch or a `frontDoor` variant that takes caller-built input; that choice
  is the builder's. **Post-hook** runs on the final `text` before the ledger
  write. A `block` from the post-hook cannot un-send streamed text; it marks
  the row and rejects `result`. A `transform` is returned on `result.text`
  only.
- **Spend cap and rate limit** are checked before the stream opens, as for
  `runText`, with the same `userId`/`anonKey`/`route` scoping. CP's route
  checks today by user and route (`checkSpendCap(db, user.id, "scout-chat")`
  and a `scout-chat:${user.id}` rate-limit key), so CP passes
  `route: "scout-chat"` and its user id, and its route-level checks can go.

### Model resolution

Today's order, identical to `streamStructured`: admin pin
(`getOverride(orgId, tier)`), then task chain, then config chain, then default.
#57's `tasks.overridesBeatPin` applies. ZDR filters links exactly as in
`streamStructured`. The #49 slug pin (`docs/design/model-naming.md`) lands in
a separate PR immediately after. That is not a regression for CP, whose stream
already ignores the slug's model today.

### Failure contract

- **The point of no return** is the first text delta **or** the first executed
  tool call, whichever comes first. After either, the turn never fails over,
  because a new link would start from the original `messages` and run tools a
  second time. A failure after a tool call but before any text degrades: the
  stream carries only the notice.
- **Before the point of no return:** a stall (first-chunk clock) or a
  retryable error fails over to the next link. Each abandoned link leaves a zero-token ledger
  row, as in `streamStructured`, and appears in `failovers`.
- **After the point of no return:** never restart. On a stall, a retryable or
  non-retryable error, the gateway appends the notice to `textStream` (as a
  final delta, preceded by a blank line), ends the stream normally, and
  resolves `result` with `degraded: true`. The ledger row carries the partial
  output and an estimated cost from the tokens seen so far.
- **Default notice:** `"Sorry, I lost my connection partway through that
  answer. Please try again."` Overridable per call with `degradedNotice`.
- **Caller abort** is terminal with no notice: the stream ends, `result`
  rejects with the caller's reason, and the ledger records what was used.
- **Chain exhausted before the point of no return:** `textStream` throws and
  `result` rejects with the last link's error, as in `streamStructured`.

Stall clocks use the existing streaming `timeouts` config, with two changes
from `streamStructured`:

- **The clocks pause while a tool executes** (from a tool call until the next
  step's first part) and resume after. A slow tool must not trip a stall.
  Tool runtime is bounded only by the call's whole-operation deadline
  (`deadlineMs`), if one is set.
- **No conflation.** `guardStream` keeps only the newest value, which is right
  for object snapshots and wrong for text deltas. Text needs a queue that
  delivers every delta: either an option on `guardStream` or a sibling.

Cost for a degraded or aborted turn: the AI SDK's reported usage for any
completed steps, plus a character-based estimate for the cut-off step
(characters / 4 for input and partial output, the same estimate the mock path
uses). No tokenizer dependency. This differs from abandoned pre-first-token
links, which keep their existing zero-token rows.

### Ledger

One row per turn, totalled across every tool step (the AI SDK's total usage,
not the last step's). `degraded: true` turns are marked so cost analysis can
separate them; the field is optional on `UsageEntry`, so existing
`UsageStore` implementations keep compiling. Tool calls are not ledgered
individually; their count goes in the row's metadata.

## Non-goals

- Native Anthropic streaming (`.messages.stream()`), adaptive thinking, web
  search and prompt caching on this path. That is NewsHound's half of #14.
- A restart-on-failure option. Add it only if an adopter asks.
- The gateway executing tools itself, or validating tool schemas. The AI SDK
  does both.
- Exposing resolved model handles (settled by #49).

## Anti-goals

- Any word the user already saw is repeated or rewritten after a failure.
- A degraded or aborted turn leaves no ledger row, or a row with zero cost.
- A ZDR-required call streams on a non-eligible model.

## Left to the builder

- **AI SDK field names.** The repo is on `ai` 7.x. Check `streamText`'s
  current option and result names (`stopWhen`, `totalUsage`, `toolCalls`,
  `toolResults`, `fullStream` part types) against the installed version's
  docs before coding; do not assume v5 names.
- Whether `textStream` is built from `fullStream` (likely, to see errors and
  tool steps) or from the SDK's own `textStream`.
- How the point of no return is detected in the AI SDK's part stream (the first
  text delta or first tool call part).
- Mock-mode behavior, matching `runText`'s mock responder.
- Updating Scout's port docs and the adoption playbook §4.2 note that an
  unmigratable streaming call site keeps the old resolution layer alive.

## Calls made in writing this (not discussed)

- The guardrail pre-hook gets the last user message as `prompt` and the system text separately; a transform replaces only the last user message.
- A post-hook `block` rejects `result` but cannot recall streamed text.
- The default notice wording above.
- The notice is appended as a final delta after a blank line.
- A caller abort gets no notice.
- Tool calls are counted in row metadata, not ledgered one by one.
- Stall clocks pause while a tool executes; tool runtime is bounded only by
  `deadlineMs`.
- A degraded turn's cut-off step is costed at characters / 4.
- `streamText` takes `userId`/`anonKey`/`route`/`app` exactly as `runText` does.

Decided with the owner after review: the first executed tool call is a point of
no return, like the first text delta (no failover, so no tool rerun).
