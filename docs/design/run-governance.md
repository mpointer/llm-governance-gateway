# Design: governed runs

Status: **step 1 shipped** (run lineage, run budget, step ceiling: `src/run.ts`,
`Gateway.startRun()`). Steps 2 and 3 below are designed, not built. This is the
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
  SDK takes inside it. Its single ledger row already totals usage across
  those steps, so the run's spend is right; what is missing is a stop inside
  the loop and a row per inner step. That is step 2.
- **Concurrent calls in one run can overshoot together.** Two calls admitted
  at the same moment both see the same spent total. The run is a guard for a
  loop, not a distributed lock.
- **No `explainRun()` yet.** The rows are in the ledger with their lineage and
  an index on `(run_id, step_index)`; reading them back as a tree is a query
  today and a helper later.

## Step 2: budgets and tools inside the loop (not built)

`streamText` already passes `tools` and `stopWhen` to the AI SDK loop. When
the call carries a run, the loop itself should be governed. The spike the
roadmap called for is answered, against the pinned `ai@7.0.83`, for both
`streamText` and `generateText`:

| Need | AI SDK surface |
| --- | --- |
| Usage per inner step | `onStepEnd`, whose `StepResult` carries `usage` |
| Stop before the next inner step | `stopWhen` (array-composable) and `prepareStep` |
| See a tool call before it runs | `onToolExecutionStart` |
| See its result and duration | `onToolExecutionEnd` |
| Hold a tool call for a human | `toolApproval` |

So the loop does not need to be driven by hand. The plan:

1. A budget stop condition composed into `stopWhen`, fed by `onStepEnd`
   usage priced through the registry: the loop stops when the run is out of
   budget, instead of at the next governed call.
2. One ledger row per inner step, sharing the call's `stepIndex` with a
   sub-index, in place of the single totalled row. This changes the row count
   of a `streamText` turn, so it is opt-in by the presence of a run.
3. A cost-velocity breaker over the last N inner steps, off by default.
4. A non-streaming sibling on `generateText` for agent loops that do not
   stream.

This replaces the separate `runAgent()` method first planned: it would have
been a second door onto the loop `streamText` already runs.

## Step 3: governed tool calls (not built)

A `ToolPolicy` per tool name (`costCents`, `maxCallsPerRun`,
`maxCentsPerRun`, `requiresApproval`), enforced from the tool execution hooks,
with a `guardrails.tool` hook before execution and a ledger row per tool call
(`provider: "tool"`). Unknown tool pricing warns once and ledgers zero, the
posture local endpoints already have. Section 6.3 of the strategy doc has the
detail.

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
