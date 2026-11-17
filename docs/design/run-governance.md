# Design: governed runs

Status: **step 1 shipped in 0.18.0** (run lineage, run budget, step ceiling: `src/run.ts`,
`Gateway.startRun()`). **Step 2 is half built**: the budget stop inside a
`streamText` tool loop and the per-tool-step ledger rows are in; the
cost-velocity breaker and the non-streaming loop are not. **Step 3 is built**
(`src/tools.ts`): tool policy, the tool guardrail hook and a ledger row per
tool call. The human approval gate is not. This is the
first item of the plan in
[docs/strategy/roadmap-2026-2027.md](../strategy/roadmap-2026-2027.md).

## Problem

The ledger knows about calls. It does not know that calls belong together. An
agent turn that makes six model calls and embeds twice is eight unrelated rows,
joined only by whatever the caller remembered to put in `metadata`. So the
questions an operator of an agent actually asks have no answer inside the
gateway:

- What did this run cost, end to end?
- Stop this run when it has spent a dollar, wherever it is in its loop.
- Stop this run after twenty calls, because a loop that long is a bug.

The daily caps do not help. They bound a user or a tenant per day, and a
runaway loop can spend a day's budget in a minute.

A proxy cannot answer these either. It sees HTTP requests, not which loop
made them. This library runs inside the loop's process, which is why the run
is the right unit to own here.

## What shipped: lineage, budget, ceiling

```ts
const run = gateway.startRun({ budgetCents: 100, maxSteps: 20 });

await gateway.runStructured({ ...opts, run });
await gateway.streamText({ slug, messages, tools, run });
await gateway.embed(texts, { run });

run.spentCents;        // counted from the ledger rows the gateway wrote
run.remainingCents();  // tightest budget in the chain, or undefined
```

Each governed call that carries a run is one **step**. `run` is accepted by
`runStructured`, `runText`, `streamStructured`, `streamText` and `embed`.

### Ledger

`UsageEntry` gains three optional fields, and the Drizzle adapters three
nullable columns: `runId` / `run_id`, `stepIndex` / `step_index`,
`parentRunId` / `parent_run_id`. Every row a step writes carries them: the
final row, a cache-hit row, a guardrail block, a failed or timed-out link, the
judge row. Rows written outside a run do not carry the keys at all, so they are
shaped exactly as before.

Lineage is stamped in one place, `logUsage`, from a `lineage` key that every
internal ledger write is required by its type to pass (it may be `undefined`).
A new ledger write therefore cannot forget to say which run it belongs to: it
does not compile. That is the same lesson as the shared front door, applied to
the write side.

The roadmap proposed a `parent_trace_id` column. As built it is
`parent_run_id`: a child run's link is to a run, not to one call's trace, and
shadow calls (the other proposed use of a trace link) get their own `shadowOf`
column when they are built.

### Budget

Checked in the shared front door, after the rate limit and the daily caps and
before the cache and any provider. A call is refused when the run has spent
`budgetCents` (`spent >= budget`, the same rule as the daily caps), with
`RunLimitError` (`limit: "budget"`).

- **Spend is counted from the ledger.** The run's total moves only when the
  gateway writes a usage row, by that row's `estimatedCostCents`. There is no
  second estimate to drift from the ledger. Judge spend counts, because the
  judge row carries the judged call's lineage. Cache hits cost nothing.
- **The check is before the call, not during it.** A run with 5¢ left is
  allowed one more call, whatever that call turns out to cost. The overshoot
  is at most one step. Step 2 below tightens this inside a tool loop.
- **A refusal is a spend-cap event** with the new `runId` field and a `run:`
  route prefix, so it sits with every other cap breach. Under
  `caps.mode: "observe"` it is recorded and the call proceeds, like every
  other cap.

### Step ceiling

`maxSteps` bounds the number of governed calls. The call past the ceiling is
refused with `RunLimitError` (`limit: "steps"`) and leaves a zero-token usage
row (`provider: "run"`, `model: "step-limit"`) carrying the run's lineage: a
refusal the ledger cannot see is not auditable.

It is **always enforced**, observe mode included. A step ceiling is a loop
guard, not a threshold on trial. An adopter who is only measuring leaves
`maxSteps` unset.

### Nesting

`gateway.startRun({ parent })` makes a child run with its own id, budget and
step count. Its spend also counts against every ancestor, and a call is
refused when the child or any ancestor is out of budget; the error and the cap
event name the run that actually ran out. This is the control for fan-out: a
sub-agent cannot spend what its parent has not got. A child's steps are its
own and do not count toward the parent's ceiling.

### Runs that span processes

`run.snapshot()` returns the counters as JSON; `gateway.resumeRun(snapshot)`
rebuilds the run. Where the snapshot is stored is the adopter's business, as
with every other store. A child's snapshot keeps its `parentRunId`; pass
`{ parent }` to `resumeRun` to re-link a live parent so its budget applies.

### What it does not do

- **Batch and `runPromptTest` take no run.** A batch is not a step of an
  interactive loop, and the admin test bench bypasses governance by design.
- **One `streamText` call is one step**, however many tool-loop steps the AI
  SDK takes inside it. Step 1 left that loop ungoverned; step 2 below stops
  it on the budget and ledgers its tool steps.
- **Concurrent calls in one run can overshoot together.** Two calls admitted
  at the same moment both see the same spent total. The run is a guard for a
  loop, not a distributed lock.
- **No `explainRun()` yet.** The rows are in the ledger with their lineage and
  an index on `(run_id, step_index)`; reading them back as a tree is a query
  today and a helper later.

## Step 2: budgets inside the loop

`streamText` passes `tools` and `stopWhen` to the AI SDK loop. The front door
checks the run's budget once, before the call. A loop can spend many times
that inside the call, so when the call carries a run the loop itself is
governed.

The spike the roadmap called for, against the pinned `ai@7.0.83`, for both
`streamText` and `generateText`:

| Need | AI SDK surface |
| --- | --- |
| Usage per inner step | `finish-step` parts and `onStepEnd`, whose `StepResult` carries `usage` |
| Stop before the next inner step | `stopWhen` (array-composable) and `prepareStep` |
| See a tool call before it runs | `onToolExecutionStart` |
| See its result and duration | `onToolExecutionEnd` |
| Hold a tool call for a human | `toolApproval` |

So the loop does not need to be driven by hand.

### Built: the budget stop

When the call carries a run whose chain has a budget, and the caller passed
`stopWhen`, a budget condition is appended to the caller's conditions. After
each inner step it:

1. prices every step of the turn so far from the SDK's own step results,
   with the same registry function that prices ledger rows;
2. subtracts what the run has already been charged for this turn (see the
   next section: tool steps are ledgered as they finish);
3. asks the run whether that pending spend puts it, or an ancestor, at its
   budget (`GovernedRun.exhausted(pendingCents)`), and stops the loop if so.

Step 2 matters because the SDK evaluates stop conditions in its own pipeline,
which may run before or after the gateway's consumer has written the row for
the step that just finished. The condition must be right either way. So
`logUsage` adds each row's cost to a per-turn counter in the same synchronous
tick it adds it to the run, and the condition uses
`turn cost so far − turn cost already ledgered` as the pending amount. There
is no window in which a step is counted twice or not at all.

When the loop is cut:

- `result` resolves, it does not reject. The text and tool results produced
  so far were already streamed and are valid. `result.runStopped` is
  `{ limit: "budget", runId }`, naming the run that ran out (the call's own,
  or an ancestor).
- A spend-cap event is recorded with the run id, after the closing row so its
  `spentCents` is the ledger's.
- The run's next call is refused by the front door.

`runStopped` is set only when the loop was actually cut, that is, when the
last step asked for tools and the model was not called again. Under
`caps.mode: "observe"` the breach is recorded and the loop runs on.

With no `stopWhen` from the caller the SDK runs one step (`isStepCount(1)`),
so there is no loop and nothing is added. Appending a condition there would
replace the SDK's default and turn a single call into an unbounded loop.

### Built: a row per tool step

With a run, a completed tool step is ledgered as soon as its `finish-step`
arrives, tagged `metadata.innerStep` with its index. The turn's closing row
(the one that carries the final text and the post-guardrail verdict) then
carries only what is left: the last step's tokens, or zero if the loop was
cut right after a tool step. It is tagged `metadata.innerSteps` with the
count.

- **Each quantity is ledgered once.** Tokens, cost and tool-call counts on
  the turn's rows sum to `result.usage` and the total tool calls. Text is the
  exception: a step row holds that step's text, the closing row the whole
  turn's.
- **Why ledger early.** It is the library's oldest rule applied to the loop:
  a row is written when the money is known to be spent, so a turn killed
  mid-loop keeps the audit trail of what it had already spent. It also lets
  a sibling call in the same run see this turn's spend while it is running.
- **Why only tool steps.** The last step of a turn is not known to be the
  last until the stream ends, and it is ledgered milliseconds later on the
  closing row anyway. A tool step is the one after which the loop goes back
  to the provider, which is the gap worth covering.
- **Why only with a run.** It changes the number of rows a turn writes.
  Callers without a run keep one row per turn.
- **No schema change.** `innerStep` and `innerSteps` sit in `metadata`, next
  to the `toolCalls` count `streamText` already put there.

The aborted and degraded closing rows follow the same rule: they carry the
cut-off estimate minus what was already ledgered.

### Not built

- **Cost-velocity breaker.** A stop when the cost per inner step keeps
  growing. Deliberately held: the rule ("how much growth over how many
  steps") should come from a real loop's ledger, which now exists to be
  read, not from a guess.
- **A non-streaming loop** on `generateText`, for agents that do not stream.
  The same condition and the same row scheme apply; it is a new public method
  and wants its own change.
- **Inner steps are not counted against `maxSteps`.** A run's steps are
  governed calls. The caller's `stopWhen` bounds the inner loop.

This replaces the separate `runAgent()` method first planned: it would have
been a second door onto the loop `streamText` already runs.

## Step 3: governed tool calls

A proxy governs MCP traffic, because that is what crosses its wire. A tool an
in-process agent calls is a function, and nothing on the network sees it. Yet
tools are where an agent's money and risk concentrate: a search API bills per
call, a database write is irreversible.

```ts
const gw = new Gateway({
  usage,
  toolPolicy: {
    web_search: { costCents: 1, maxCalls: 10 },
    run_sql: { maxCalls: 3 },
    lookup: {},                       // free and uncapped, but declared
  },
  guardrails: {
    tool: ({ tool, input }) =>
      tool === "run_sql" && /\b(drop|delete|update)\b/i.test(String((input as { sql: string }).sql))
        ? { action: "block", reason: "read-only agent" }
        : { action: "allow" },
  },
});
```

Tool governance is on when `toolPolicy` is set (even to `{}`) or
`guardrails.tool` is set. Unset, tools run exactly as before and write no
rows of their own: an existing `streamText` adopter sees no change.

When it is on, `streamText` wraps the `execute` of every tool the call
passed. Tools with no `execute` (client-side tools) pass through. For each
tool call the loop is about to run, in this order:

1. **Policy caps**, counted per run, or per call when the call carries no
   run: `maxCalls`, then `maxCents`. Then, for a priced tool on a run with a
   budget, whether the run can afford it. A priced tool's cost is known
   before it runs, so unlike a model call it is not allowed to overshoot.
   The check and the reservation happen with no `await` between them,
   because the AI SDK runs a step's tool calls concurrently and two calls
   must not both pass a limit with room for one.
2. **`guardrails.tool`**: `allow`, `transform` (the new `input` field on the
   verdict replaces the arguments, and must still satisfy the tool's schema),
   or `block`. A hook that throws denies the call unless `failOpen` is set,
   the same policy as the pre and post hooks. A block releases the
   reservation from step 1.
3. **The tool runs**, and a ledger row is written before its result goes
   back to the loop.

### The row

`provider: "tool"`, `model: <tool name>`, zero tokens, `estimatedCostCents`
from the policy, the arguments in `inputText` and the result in `outputText`
(through the same truncate and encrypt path as prompts), the hook's verdict
in `guardrails`, and in `metadata`: `toolCallId`, `innerStep`, and one of
`toolDenied`, `toolWouldDeny` or `toolError` when they apply.

Because the price is on a ledger row, it needs no second accounting: it
counts against the run's budget, against the in-loop budget stop, and against
the daily caps, the same way a model call's cost does. The row carries the
call's plain lineage rather than the turn-counted one, so the in-loop budget
check does not mistake a tool's cost for a model step it has already
subtracted.

A tool that throws is still ledgered and still charged. Whether a failed call
was billed by the provider is unknowable from here, and a cap that
undercounts is worse than one that overcounts.

### A denial does not fail the turn

A denied call throws `ToolDeniedError` from the tool's `execute`. The AI SDK
hands that back to the model as the tool's error and the loop goes on: the
model learns the tool was not run and can answer without it. The error's
message is written for the model to read. The denial is ledgered (zero cost,
`metadata.toolDenied`) and listed in `result.toolDenials`.

Under `caps.mode: "observe"` a cap that would deny is recorded
(`metadata.toolWouldDeny`) and the tool runs. A `guardrails.tool` block is
policy, not a threshold on trial, and is enforced in observe mode too.

### Unpriced tools

A tool with no policy entry, when a policy is configured, runs uncapped at
0¢ and warns once, the posture unknown model pricing already has.
`gateway.preflightTools(tools)` throws at startup instead. An empty entry,
`{}`, declares a free uncapped tool on purpose.

### Not built

- **Human approval gate** (`requiresApproval`): a tool call that waits on a
  person. It needs somewhere to persist the pending request, which is the
  control plane's review queue. The AI SDK's `toolApproval` is the surface it
  will use.
- **Per-tool ZDR.**
- **Counting a child run's tool calls against its parent's caps.** Caps are
  counted on the call's own run. Spend already nests; call counts do not.
- **A plain function that returns an async iterable** has its final value
  kept and its preliminary results not streamed. A tool written as
  `async function*` is detected and stays a generator.

## Calls made in building step 1

- The breach of a run budget is a `RunLimitError`, not a `SpendCapError`.
  `SpendCapError` means a daily cap and its message says so; the HTTP layer
  maps its scopes to "busy" or "over your limit". A run budget is neither.
- `budgetCents` must be positive and `maxSteps` an integer of at least 1.
  Zero is rejected rather than read as "no limit", because for a run "omit
  it" already means that and a silent zero is how limits get turned off by
  accident.
- A cache hit is a step. It is a governed call the loop made.
- Embedding calls can belong to a run. Retrieval is part of most agent loops
  and its spend is real.
- `GovernedRun` is exported and constructible without a gateway.
  `gateway.startRun()` is the documented way in; the class has no dependency
  on the gateway, which keeps it testable and lets a host create a run before
  it has decided which gateway instance will serve it.
