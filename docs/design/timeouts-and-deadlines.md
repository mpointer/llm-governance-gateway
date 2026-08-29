# Design: timeouts and deadlines

Status: proposed — target v0.10. Derived from a review of the shipped
failover machinery (v0.9.0), not from an outage: the failover design is
sound, but the clock around it is incomplete, and the gaps are all in the
paths a serverless adopter actually runs.

## Problem

The library has one hardcoded timeout (60s, `AbortSignal.timeout`) applied
to three of the seven outbound call sites. Everything else inherits
whatever the caller's client does, or hangs.

| Path | Site | Timeout today |
|---|---|---|
| `generateObject` (`attemptGenerate`) | `src/gateway.ts:97` | 60s |
| `generateText` (`runText` → `attemptText`) | `src/gateway.ts:553` | 60s |
| `generateText` (prompt test) | `src/gateway.ts:1817` | 60s |
| judge | via `attemptGenerate` | 60s |
| **native Anthropic** (`messages.create`) | `src/anthropic-native.ts:163`, `:262` | **none** |
| **`streamObject`** | `src/gateway.ts:814` | **none** |
| **`embedMany`** | `src/gateway.ts:417` | **none** |
| batch submit/poll/results | caller's `BatchClient` | caller's |

Four concrete failures follow from that table:

1. **A stalled stream hangs forever.** `streamStructured` has no signal,
   so `await stream.object` (`src/gateway.ts:823`) can never settle — and
   because `finalize()` runs after it, **the usage row is never written**.
   A hung stream is un-ledgered spend, which is a governance bug, not a
   latency bug.
2. **The native path's timeout is the consumer's problem.** A BYO client
   built as a bare `new Anthropic()` gets the SDK's 10-minute default. The
   library advertises governance and then silently inherits whatever the
   caller configured.
3. **The 60s is not configurable.** `src/types.ts` has no timeout field
   anywhere: no `timeoutMs` on `GatewayConfig`, no per-call override, and
   no way to pass a caller `AbortSignal` in. You get 60s or you fork.
4. **No wall-clock budget.** A 3-link chain is 3 links × (1 attempt + 2
   transient retries + 1 schema repair) × 60s, plus backoff. Worst case is
   **north of 9 minutes** before the chain gives up. On a platform with a
   function deadline (the first adopter is on Vercel), the platform kills
   the invocation first — and the cache write and usage log, which happen
   *after* generation returns, never run. Same un-ledgered-spend failure
   as (1), reached a different way.

Note that (1) and (4) are the same class of bug: **the ledger is written
after generation, so anything that kills the process mid-generation loses
the audit trail for money already spent.** That framing drives Rule 1.

## Shape: two clocks and a caller signal

Three independent things, deliberately not conflated:

```ts
// GatewayConfig — defaults for every call
timeouts?: {
  /** Per provider attempt. Default 60_000 (today's hardcoded value). */
  attemptMs?: number;
  /** Whole governed operation: all links, retries, and backoff sleeps.
   *  Default undefined = unbounded (today's behavior). */
  deadlineMs?: number;
  /** Streaming only — see "Streaming" below. */
  streamFirstChunkMs?: number;   // default 60_000
  streamStallMs?: number;        // default 60_000
};

// Per call — on RunStructuredOptions, RunTextOptions,
// StreamStructuredOptions, and EmbedOptions
{
  attemptMs?: number;
  deadlineMs?: number;
  /** The caller's own signal (request aborted, client disconnected). */
  signal?: AbortSignal;
}
```

Precedence, matching every other knob in the library: **per call > config
> built-in default.**

The three compose into one signal per attempt. Conceptually:

```
attemptSignal  fires on whichever comes first:
                 · attemptMs elapsed
                 · remaining deadline budget exhausted
                 · caller signal aborted
```

The next section is about why that composition must be written by hand
rather than with the platform primitives that appear to do exactly this.

### Do not build that composite with `AbortSignal.any` + `AbortSignal.timeout`

The obvious implementation — `AbortSignal.any([AbortSignal.timeout(ms),
callerSignal])` — is the one to avoid, for three independent reasons:

1. **It can silently not fire.** `AbortSignal.any()` composed with
   `AbortSignal.timeout()` has a reported failure mode where the timeout
   never aborts and the request runs to completion
   ([nodejs/node#57736](https://github.com/nodejs/node/issues/57736); fix
   PR #57867). Nothing holds a strong reference to the timeout signal
   inside the composite, so it is collectible. **A timeout that silently
   no-ops is worse than no timeout**: the library would advertise a bound
   it does not enforce, which is exactly the failure this whole document
   exists to remove.
2. **Availability.** `AbortSignal.any()` landed in Node 20.3.0 (and
   18.17.0), while `engines.node` is `>=20` — so 20.0–20.2 lack it
   entirely.
3. **Reason attribution.** A composed signal reports whichever input
   fired, as a `DOMException`. Rule 5 needs to know *which* clock won, and
   sniffing `.name` cannot tell an attempt timeout from a deadline.

So `src/deadline.ts` owns the composition explicitly: one
`AbortController` per attempt, a `setTimeout` whose handle is held in a
local (strong reference) and cleared in a `finally`, a listener on the
caller signal, and `controller.abort(reason)` called with our own tagged
reason object. No `AbortSignal.any`, no `AbortSignal.timeout`, on any
path. This is more code than the one-liner and is the entire justification
for `deadline.ts` existing as a module with its own tests.

### Why an `AbortSignal` and not a `timeout` number

Not a free choice: in `ai@7`, `CallSettings = LanguageModelCallOptions &
Omit<RequestOptions, 'timeout'>`. The AI SDK **deliberately removes**
`timeout` from `generateObject`/`streamObject`/`embedMany` and leaves
`abortSignal` as the only lever. So the signal is the sanctioned
mechanism, and using it uniformly (including on the native path, where the
Anthropic SDK *does* offer `timeout`) keeps one composition story instead
of two.

## Rules

1. **The deadline covers generation, never the ledger.** Cache write,
   `logUsage`, observability hooks, and the judge's own persistence run
   *outside* the deadline, with an un-aborted context. If generation
   completes 1ms before the deadline, the usage row is still written. An
   un-ledgered provider call is the one outcome this library exists to
   prevent; a timeout feature that introduces it is a net loss.
2. **Never start an attempt the budget cannot finish.** Before each chain
   link, and before each retry, check remaining budget against a floor
   (`MIN_ATTEMPT_MS`, 1000). Below the floor, stop and throw rather than
   opening a connection that is guaranteed to abort mid-flight — a
   half-open provider call may still bill.
3. **Backoff sleeps are inside the budget and are abortable.** Today's
   sleeps (`src/gateway.ts:119`, `:537`, `:558`, `:1152`) are bare
   `setTimeout` in a Promise: a caller abort waits out the full sleep.
   Replace with an abortable `sleep(ms, signal)`, and clamp the delay to
   the remaining budget.
4. **Per-attempt timeout fails over; deadline and caller abort do not.**
   Two new error classes in `src/errors.ts`, joining the existing four:
   - `AttemptTimeoutError(provider, model, attemptMs)` → this link is
     slow; **advance to the next chain link**, and do *not* retry the same
     link (it just demonstrated it is slow). Treated like a retryable
     error for failover purposes only — see Rule 7.
   - `DeadlineExceededError(deadlineMs, elapsedMs)` → abandon everything
     and throw; no further links, no retries.
   - Caller signal aborted → abandon everything, rethrow the caller's
     abort reason unwrapped, preserving standard `AbortSignal` semantics.
     A caller who aborts should see their own reason, not ours.
5. **Distinguish the three by construction, not by sniffing.** Do not
   depend on `DOMException.name` being `TimeoutError` vs `AbortError` —
   once signals are composed, the reason belongs to whichever fired. Each
   attempt gets its own `AbortController` aborted with an explicit reason
   object (`{ kind: "attempt" | "deadline" | "caller" }`), owned by an
   `AttemptBudget` class in `src/deadline.ts`. See "Do not build that
   composite" above: this is a correctness requirement, not a style
   preference.
6. **Every timer is cleared on the path that did not fire it.** A
   `setTimeout` left pending holds the event loop open; in a serverless
   invocation that is a billed hang, and in a test it is an open handle.
   Every attempt clears its timer in `finally`, and `deadline.ts` is
   responsible for leaving zero live timers once an operation settles —
   asserted in tests, not assumed.
7. **Neither new error is `isRetryable`.** Both carry no status code, so
   `isRetryable` (`src/backoff.ts:10`) already returns false, and neither
   is a schema error — this rule is about keeping it that way. Note the
   asymmetry this creates and keep it deliberate: `AttemptTimeoutError`
   advances the chain **without** being retryable, so the chain loops must
   test it explicitly rather than folding it into `isRetryable`. Widening
   `isRetryable` instead would also re-enable same-link retries, which
   Rule 4 forbids.
8. **Mock mode ignores the clock.** No provider call, no timeout. CI must
   stay deterministic; a timeout test uses an explicit slow fake model,
   not wall-clock luck.

## Per-path specification

### Unary (`runStructured`, `runText`, judge, prompt test)

Thread the composed signal through `attemptGenerate`
(`src/gateway.ts:79`), `attemptText` (`:543`), and the judge's
`attemptGenerate` call (`:1718`), replacing the literal
`AbortSignal.timeout(60_000)`. `callWithChain` (`:1286`) and `runText`'s
chain loop (`:615`) own the budget and apply Rule 2 between links.

### Native Anthropic

`AnthropicMessagesClient` (`src/anthropic-native.ts:19`) declares a
one-argument `create`. Widen it:

```ts
export interface AnthropicRequestOptions {
  signal?: AbortSignal;
}

export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: AnthropicRequestOptions,
    ): Promise<AnthropicMessage>;
  };
}
```

**This is not a breaking change for implementers.** A function of fewer
parameters is assignable to a type declaring more, so every existing BYO
client — including the `as unknown as AnthropicMessagesClient` cast the
first adopter uses — still satisfies the interface. The real
`@anthropic-ai/sdk` already accepts `(body, options)`, so a real client
gains the behavior for free; a hand-rolled fake that ignores the second
argument keeps working, timeout-less, exactly as today.

Pass `{ signal }` only. Do **not** also pass the Anthropic SDK's own
`timeout` — two competing clocks produce whichever error won the race,
which defeats Rule 5.

`callNativeAnthropic` (`:107`) and `callNativeAnthropicText` (`:221`) take
the signal in their `args` object and forward it at `:163` and `:262`.

### Streaming — a different clock

A total-duration cap is the **wrong** primitive for a stream: a long
generation that is actively producing tokens is healthy, and killing it at
60s would be a regression. What is never healthy is silence. So streaming
gets two chunk-relative clocks instead:

- **`streamFirstChunkMs`** — time to first emission. Covers connect,
  queueing, and a provider that accepts and never responds.
- **`streamStallMs`** — time since the last emission. Covers a mid-stream
  hang.

Implement by wrapping `partialObjectStream` in a generator that races each
`next()` against a timer, and by racing `stream.object` (`:823`) against
the same stall clock so **`finalize()` still runs** on a stalled stream
(Rule 1: the ledger row must survive). `deadlineMs`/`signal`, when the
caller supplies them, are passed to `streamObject` as `abortSignal` on top
of this; total duration stays opt-in.

### Embeddings

Add `abortSignal` to `embedMany` (`src/gateway.ts:417`). Leave the AI
SDK's own `maxRetries` at its default of 2 — `embed()` has no
gateway-level retry loop, so the SDK's is the only one, and removing it
would be a reliability regression disguised as a timeout fix.

### Batch

Out of scope for the clock: batch is hours-long by construction, and
submit/poll/results run against a caller-supplied `BatchClient`. The
`signal` is still threaded to `submitBatch` so a caller can abandon a
submit, and that is all.

## Testing

Timeout features are where deterministic CI goes to die, and "mock the
provider, keep the governance" is one of this project's three positioning
claims — so the test strategy is part of the spec, not an afterthought.

The suite is real-clock today (no `vi.useFakeTimers()` anywhere). Timing
tests must not change that globally; they opt in per file.

1. **Fake timers, not real sleeps.** `vi.useFakeTimers()` plus
   `vi.advanceTimersByTimeAsync()`. A 9-minute worst-case chain must be
   provable in milliseconds, or nobody will run the test.
2. **A controllable slow model, not a slow provider.** Extend the existing
   `fakeModel` pattern (`src/failover.test.ts:16`) with a `doGenerate`
   that returns a promise resolving on an explicit external trigger, and
   that rejects when `options.abortSignal` fires. That last part is what
   actually proves the signal reached the SDK — asserting elapsed time
   proves nothing about wiring.
3. **Assert the ledger, not just the throw.** Every timeout test asserts
   the usage row that Rule 1 promises. The regression this whole document
   is about is a *missing row*, so a test that only checks
   `rejects.toThrow(DeadlineExceededError)` would pass on the bug.
4. **Assert zero live timers** after each operation settles (Rule 6),
   via `vi.getTimerCount()`.
5. **One real-clock integration test**, marked slow, with a genuinely
   short budget (~50ms) against a model that never resolves — cheap
   insurance that the whole thing works without fake timers, since the
   `AbortSignal.any` hazard above is precisely the class of bug fake
   timers would hide.

## Sequencing

Four changes, deliberately ordered so each ships independently:

| # | Change | Size | Value |
|---|---|---|---|
| S1 | `abortSignal` on `streamObject` + `embedMany`; stream first-chunk/stall clocks | S | Closes the two indefinite-hang cases, including the un-ledgered stream |
| S2 | Widen `AnthropicMessagesClient`, thread signal through both native calls | S | Gateway's guarantee stops depending on how the consumer built their client |
| S3 | `src/deadline.ts` (`AttemptBudget`, abortable `sleep`); `timeouts.attemptMs` config + per-call override; `AttemptTimeoutError` | M | Makes the existing 60s configurable; no behavior change at defaults |
| S4 | `deadlineMs` enforced across chain links, retries, and backoff; `DeadlineExceededError` | M | The one that actually protects a serverless caller |

S1+S2 are one PR. S3 is the prerequisite for S4; S4 is where Rules 1–4
earn their keep.

## Backward compatibility

Defaults reproduce today's behavior exactly: `attemptMs` 60_000,
`deadlineMs` undefined (unbounded). Two new error classes and a set of new
*optional* fields; the one existing type that changes is
`AnthropicMessagesClient`, widened by an optional second parameter, which
is assignment-compatible in both directions (verified against the repo's
own `tsc --strict`) and so breaks no implementer.

**One intentional default-behavior change**, in S1: the stream stall
clock defaults to *on* at 60s. Silence for 60 seconds mid-stream is never
legitimate, and hanging forever with no ledger row is strictly worse than
a clear error. Ships in a minor with a release note; a caller who
disagrees sets `streamStallMs: 0` to disable.

## Related: the `runText` failover asymmetry

S4 rewrites `runText`'s chain loop, so decide this at the same time.
`src/gateway.ts:651` reads:

```ts
if (!isRetryable(err) && links.length === 1) throw err;
```

With more than one link, a **non-retryable** error (a 400 caller error)
still falls through and burns a call on the next link. `callWithChain`
(`:1313`) does not do this — it advances only on retryable or
schema-invalid errors. The asymmetry is defensible (text has no schema
concept, so there is no second reason to advance) but is more likely an
oversight than a decision.

Recommendation: align `runText` to `callWithChain` — advance on retryable
only. It is a behavior change for anyone relying on a 400 failing over, so
it ships in the same minor, called out in the release notes.

## Explicitly out of scope

**Task-routed and admin-override calls remain single-link** (`:1434`,
`:1466`) and therefore have no chain failover at all — a deadline does not
change that. This matters more than it looks: the first adopter routes
every call through `task`, so it currently gets **zero** chain failover
from the library and relies on its own wrapper for resilience. Whether
task routing should support a fallback chain is a real design question
with its own tradeoffs (which model? configured where? does the admin
override still mean "hard pin"?) and deserves its own doc rather than a
paragraph here.

## Open questions (answer before building)

- Should `deadlineMs` have a non-undefined default? Unbounded is today's
  behavior and safest for compatibility, but it means the serverless
  footgun stays loaded unless an adopter reads this doc. A generous
  default (120s?) would protect by default at the cost of a behavior
  change in a library whose whole pitch is predictability.
- Does the judge get its own budget, or share the main call's? Sharing
  means a slow main call can starve the judge into a timeout; a separate
  budget means the total operation can exceed `deadlineMs`. Leaning
  separate-and-small, since the judge already self-skips under budget
  pressure and skipping is its established failure mode.
- Should `RunTextResult` / `RunStructuredResult` surface which link
  timed out, for adopters tuning `attemptMs` per provider? The ledger's
  `durationMs` gets close but does not record aborted attempts at all —
  arguably those should be ledgered as zero-token rows so a chronically
  slow provider is visible in the data rather than only in logs.
