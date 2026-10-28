# Governed `streamText` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gateway.streamText()`: a governed, tool-calling text stream with a "fail over before the point of no return, degrade after it" contract, so Scout's chat turn can move onto the gateway.

**Architecture:** `streamText` reuses `frontDoor` (rate limit, cap, pre-guardrail) and `streamStructured`'s link resolution, then drives the AI SDK's `streamText` over `fullStream`. A queue-mode variant of `guardStream` delivers every text delta and lets the driver pause the stall clock while a tool runs. A small per-turn state machine decides failover vs degrade and writes exactly one ledger row for the turn.

**Tech Stack:** TypeScript (strict), `ai` 7.0.97, vitest, zod.

**Spec:** `docs/design/streaming-text.md` (read it before Task 1).

## Global Constraints

- No new dependencies.
- Backward compatible: no existing method, option or default changes behavior. New `UsageEntry` fields are optional.
- Model resolution is exactly `streamStructured`'s on `main`: admin pin (`getOverride(orgId, tier)`) > task chain > config chain > default. No slug pin in this work. (#57's `overridesBeatPin` is on an unmerged branch; whichever lands second wires it into the shared `resolveStreamLinks`.)
- `streamText` returns `Promise<StreamTextResult>`, like `streamStructured`. The spec's synchronous signature is shorthand.
- No cache and no judge on this path.
- Default notice, exact text: `Sorry, I lost my connection partway through that answer. Please try again.` Appended as a final delta preceded by `"\n\n"`.
- Point of no return = the first `text-delta` part **or** the first `tool-call` part, whichever comes first.
- Use v7 part names verified in `node_modules/ai/dist/index.d.ts`: `text-delta` (field `text`), `tool-call`, `tool-result`, `start-step`, `finish-step` (field `usage`), `finish` (field `totalUsage`), `error` (field `error`), `abort`.
- Degraded/aborted cost: completed steps' reported usage + `Math.ceil(chars / 4)` for the cut-off step's input and partial output.
- Run `npx tsc --noEmit` and `npx vitest run` before every commit.

## Review Focus

1. **Empty or absent last user message** (e.g. a turn that is only a tool result, or `messages: []`). `frontDoor` treats an empty `promptBody` as "read the store". Expect: `streamText` throws `Error("streamText: messages must end with a user message")` before any spend. Test in Task 3.
2. **User text containing `{{name}}`.** `renderTemplate` leaves unknown placeholders verbatim; expect the model and ledger to see the text unchanged. Test in Task 3.
3. **Consumer never iterates `textStream`, only awaits `result`.** The guard pumps the source itself; expect `result` to resolve with full text. Test in Task 3.
4. **Slow tool after text has started** (tool takes longer than `streamStallMs`). Expect no degrade; clocks are paused during tool execution. Test in Task 5.
5. **Abort arriving while a tool is executing.** Expect no notice, `result` rejects with the caller's reason, one ledger row. Test in Task 6.

---

### Task 1: Queue mode and pausable clocks in `guardStream`

**Files:**
- Modify: `src/stream-guard.ts`
- Create: `src/stream-guard.test.ts`

**Interfaces:**
- Produces: `createQueuedCell<T>(): ConflatedCell<T>` (same interface, FIFO, never drops). `StreamGuardOptions.mode?: "conflate" | "queue"` (default `"conflate"`, so `streamStructured` is unchanged). `StreamGuard.pauseClock(): void` and `StreamGuard.resumeClock(): void`.

- [ ] **Step 1: Write the failing tests** in `src/stream-guard.test.ts`:
  - `queue mode delivers every value in order to a slow consumer`: source yields `"a","b","c"` synchronously; consumer collects after the pump finishes; expect `["a","b","c"]`.
  - `conflate mode still drops intermediates` (regression): same source, expect last value `"c"` and length < 3.
  - `pauseClock stops a stall trip; resumeClock re-arms it` (fake timers): `stallMs: 100`; emit one value, `pauseClock()`, advance 500ms, expect `tripped` unresolved; `resumeClock()`, advance 101ms, expect `tripped` resolved with phase `"stall"`.
- [ ] **Step 2: Run** `npx vitest run src/stream-guard.test.ts`. Expected: queue and pause tests FAIL.
- [ ] **Step 3: Implement** `createQueuedCell` (array queue, same `fail`/`close` semantics as the conflated cell: first failure wins), the `mode` option, and `pauseClock`/`resumeClock` (pause clears the timer and sets a flag that `arm` respects; resume arms `"stall"` if at least one value was published, else `"first-chunk"`).
- [ ] **Step 4: Run** `npx vitest run src/stream-guard.test.ts src/stream.test.ts src/stream-failover.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(stream-guard): queue mode and pausable clocks for text streams (#14)`.

### Task 2: Types, exports, shared link resolution

**Files:**
- Modify: `src/gateway.ts` (types near `StreamStructuredResult` ~line 357; `frontDoor` kind union ~line 2179; extract from `streamStructured` ~line 1200)
- Modify: `src/types.ts` (`UsageEntry`)
- Modify: `src/index.ts`

**Interfaces:**
- Produces, exported from `src/index.ts`:
  - `StreamTextOptions` and `StreamTextResult` exactly as in the spec's "Shape" section, with `messages: ModelMessage[]`, `tools?: ToolSet`, `stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[]` (types imported from `ai`).
  - `StreamTextOutcome` = the resolved type of `StreamTextResult["result"]`.
  - `DEFAULT_DEGRADED_NOTICE` (the exact string in Global Constraints).
- `UsageEntry.degraded?: boolean | null` with a doc comment: true when a streamed turn ended with the degraded notice.
- `frontDoor` `kind` union gains `"streamText"`.
- Private `resolveStreamLinks(orgId: string | undefined, opts: { tier?: "fast" | "power"; task?: string }, requireZdr: boolean): Promise<ChainLink[]>`, extracted from `streamStructured`'s resolution + ZDR filter block, which now calls it.

- [ ] **Step 1: Extract** `resolveStreamLinks` from `streamStructured` without behavior change.
- [ ] **Step 2: Run** `npx vitest run src/stream.test.ts src/stream-failover.test.ts src/task-chain.test.ts src/zdr.test.ts`. Expected: all PASS (pure refactor).
- [ ] **Step 3: Add** the types, `UsageEntry.degraded`, the constant and exports. `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit** `refactor(gateway): share stream link resolution; add streamText types (#14)`.

### Task 3: `streamText` happy path

**Files:**
- Modify: `src/gateway.ts` (new public method after `streamStructured`)
- Create: `src/stream-text.test.ts`

**Interfaces:**
- Consumes: `resolveStreamLinks`, `guardStream({ mode: "queue" })`, `frontDoor`.
- Produces: `streamText(opts: StreamTextOptions): Promise<StreamTextResult>` (async because `frontDoor` is; the returned `textStream`/`result` behave as in the spec).
- Test helper in `src/stream-text.test.ts`: `scriptedModel(steps: Array<{ parts: unknown[] } | "hang" | Error>, id?: string): { model: LanguageModel; calls: number }`. Each `doStream` call consumes the next step; `"hang"` never emits and rejects on abort; an `Error` throws from `doStream`. Base it on `streamLm` in `src/model-config-tier.test.ts`; a tool step emits `{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(args) }` and finishes with `finishReason: "tool-calls"`.

- [ ] **Step 1: Write failing tests:**
  - `streams deltas and resolves result after the ledger row`: model emits `"Hel"`,`"lo"`; collect `textStream` → `["Hel","lo"]`; `result.text === "Hello"`, `degraded === false`, `failovers` empty; usage store has exactly 1 row with `promptSlug`, `outputTokens > 0`, `cacheHit: false`, `degraded` falsy, and the row exists when `result` resolves.
  - `runs a tool step and totals usage across steps`: step 1 calls tool `lookup` (execute returns `{ ok: true }`), step 2 emits `"done"`; `stopWhen: stepCountIs(4)`; `result.toolCalls.length === 1`, `result.toolResults.length === 1`, tool executed once, row `inputTokens`/`outputTokens` equal the sum of both steps, row `metadata.toolCalls === 1`.
  - `never caches`: two identical calls hit the model twice.
  - `rate limit and spend cap run before the stream opens`: rate limiter that denies → rejects `RateLimitError`, model `calls === 0`.
  - Review Focus 1: `messages: []` and a last message with `role: "assistant"` both reject with `messages must end with a user message`; `calls === 0`.
  - Review Focus 2: last user message `"hi {{name}}"` reaches the model unchanged.
  - Review Focus 3: consumer awaits only `result`; `result.text` is the full text.
  - `mock mode`: with `mock: true` and a responder registered for the slug, `textStream` yields the responder's text once and `result.text` matches.
- [ ] **Step 2: Run** `npx vitest run src/stream-text.test.ts`. Expected: FAIL (`streamText` is not a function).
- [ ] **Step 3: Implement.** Call `frontDoor("streamText", { slug, input: undefined, variables: () => ({}), promptBody: lastUserText, cache: false, system, userId, anonKey, route, app, orgId, metadata, task, requireZdr, temperature }, (v) => v)`; put the returned (possibly transformed) `prompt` back as the last user message's text. Resolve links with `resolveStreamLinks`. Drive AI SDK `streamText({ model, system, messages, tools, stopWhen, temperature, abortSignal })` over `fullStream`, publishing `text-delta` text into a queue-mode guard. Write the ledger row (encrypt hook applies to `inputText`/`outputText`), then resolve `result`. Mirror `runText`'s mock-responder branch.
- [ ] **Step 4: Run** `npx vitest run src/stream-text.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): streamText with tool calling, happy path (#14)`.

### Task 4: Failover before the point of no return

**Files:**
- Modify: `src/gateway.ts`, `src/stream-text.test.ts`

**Interfaces:**
- Consumes: `StreamFailover` (existing; `hadPartialOutput` is always `false` here).

- [ ] **Step 1: Write failing tests:**
  - `fails over on a first-chunk stall`: link A `"hang"`, link B emits `"ok"`; `streamFirstChunkMs: 50`; `result.text === "ok"`, `failovers` = `[{ provider: A, reason: "stall", hadPartialOutput: false }]`; 2 ledger rows, A's with 0 tokens.
  - `fails over on a retryable error before any part`: A throws a 503 error; B succeeds; `failovers[0].reason === "retryable"`.
  - `a non-retryable error before the point of no return does not fail over`: A throws 400; `result` rejects, `textStream` throws, B never called.
  - `chain exhausted rejects with the last link's error`.
  - `ZDR filters links`: `requireZdr: true`, A not ZDR, B ZDR → only B called.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement** the per-link loop using the existing retryable classifier and `logAbortedAttempt` for zero-token rows. **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat(gateway): streamText failover before the point of no return (#14)`.

### Task 5: Degrade after the point of no return

**Files:**
- Modify: `src/gateway.ts`, `src/stream-text.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `stall after text degrades with the default notice`: A emits `"Part"` then hangs; `streamStallMs: 50`; deltas = `["Part", "\n\n" + DEFAULT_DEGRADED_NOTICE]`; `textStream` ends without throwing; `result.degraded === true`, `result.text === "Part\n\n" + DEFAULT_DEGRADED_NOTICE`; B never called; one row with `degraded: true` and `estimatedCostCents > 0`.
  - `error after text degrades` (retryable and non-retryable both): same shape, no failover.
  - `degradedNotice overrides the default`: notice text is the caller's.
  - `failure after a tool call but before text degrades to notice-only`: step 1 tool call executes, step 2 throws 503; deltas = `[DEFAULT_DEGRADED_NOTICE]` (no `"\n\n"` prefix when no text was emitted); tool executed exactly once; B never called.
  - Review Focus 4: text, then a tool whose `execute` awaits 200ms with `streamStallMs: 50`, then more text; `result.degraded === false`.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement**: track `pastPointOfNoReturn`; on `tool-call` call `guard.pauseClock()`, on the next `start-step` call `resumeClock()`; on failure past the point of no return publish the notice (prefix `"\n\n"` only if text was emitted), close the stream, cost the cut-off step per Global Constraints, write the row with `degraded: true`. **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat(gateway): streamText degrades in place after the point of no return (#14)`.

### Task 6: Caller abort

**Files:**
- Modify: `src/gateway.ts`, `src/stream-text.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `abort after text: no notice, result rejects with the caller's reason, one row with estimated cost`.
  - `abort before any part: result rejects, one zero-token row, no failover`.
  - Review Focus 5: abort while a tool's `execute` is pending; no notice, rejects with the reason, one row.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement** using `guardStream`'s `callerSignal`/`onCallerAbort` (the caller's reason surfaces unwrapped, as in `anthropic-native.test.ts`'s abort test). **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat(gateway): streamText caller abort (#14)`.

### Task 7: Guardrails

**Files:**
- Modify: `src/gateway.ts`, `src/stream-text.test.ts`

**Interfaces:**
- Consumes: `applyPostGuardrail` (existing).

- [ ] **Step 1: Write failing tests:**
  - `pre-hook sees the last user message as prompt and system separately`.
  - `pre transform replaces only the last user message`; system text reaches the model unchanged.
  - `pre block rejects before the stream opens`; model never called; block row written.
  - `post block rejects result after streaming`; deltas were still delivered; row records the block.
  - `post transform changes result.text only`; streamed deltas are the original.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement.** **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat(gateway): streamText guardrails (#14)`.

### Task 8: Docs and release notes

**Files:**
- Modify: `README.md` (add `streamText` next to `streamStructured`)
- Modify: `CHANGELOG.md` (Unreleased → Added)
- Modify: `docs/integration/adopting-the-gateway.md` §4.2 (one paragraph: an unmigratable streaming or tool-calling call site keeps the app's old resolution layer alive; `streamText` removes that for AI SDK paths; native Anthropic streaming is still open on #14)
- Modify: `docs/design/streaming-text.md` (Status line → "shipped in Unreleased")

- [ ] **Step 1: Write** the docs. README example uses Scout's shape: `system`, `messages`, `tools`, `stopWhen: stepCountIs(4)`, `route: "scout-chat"`.
- [ ] **Step 2: Run** `npx tsc --noEmit && npx vitest run`. Expected: all PASS.
- [ ] **Step 3: Commit** `docs: streamText in README, changelog and adoption guide (#14)`.
