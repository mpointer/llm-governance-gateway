// Governed tool calls.
//
// A proxy governs MCP traffic, because that is what crosses its wire. A tool
// an in-process agent calls is a function: nothing on the network sees it.
// Yet tools are where an agent's money and risk concentrate. A search API
// bills per call, a database write is irreversible. This module wraps the
// tools of a governed `streamText` call so that each tool call:
//
//   1. is checked against its `ToolPolicy` (calls and spend, per run), and
//      against what the run has left when the tool has a price;
//   2. passes through the `guardrails.tool` hook, which may allow it, rewrite
//      its arguments, or block it;
//   3. leaves a ledger row of its own (`provider: "tool"`), priced by policy,
//      whether it ran, failed or was denied.
//
// A denied tool call does not fail the turn. The wrapper throws
// `ToolDeniedError` from the tool's `execute`; the AI SDK hands that back to
// the model as the tool's error, and the loop goes on. The model learns the
// tool was not run and can answer without it.
//
// Design: docs/design/run-governance.md, step 3.

import type { ToolSet } from "ai";
import {
  type GuardrailHook,
  type GuardrailRecord,
  type ToolGuardrailContext,
  runGuardrail,
} from "./guardrails.js";
import type { GovernedRun } from "./run.js";

/** Price and limits for one tool, keyed by the tool's name in `GatewayConfig.toolPolicy`. */
export interface ToolPolicy {
  /**
   * What one call costs, in cents: a fixed price, or a function of the call's
   * arguments. Ledgered on the tool call's row, so it counts against the
   * run's budget and the daily caps like any other spend. Omit for a free
   * tool. A call that throws is still charged: whether a failed call was
   * billed is unknowable from here, and a cap that undercounts is worse than
   * one that overcounts.
   */
  costCents?: number | ((input: unknown) => number);
  /** Most calls in one run (or in one call, when the call carries no run). */
  maxCalls?: number;
  /** Most spend on this tool in one run (or one call), in cents. */
  maxCents?: number;
}

/** Why a tool call was not run. */
export type ToolDenialReason = "max-calls" | "max-cents" | "run-budget" | "guardrail";

export interface ToolDenial {
  tool: string;
  toolCallId: string;
  reason: ToolDenialReason;
  /** The guardrail's reason, for a `"guardrail"` denial. */
  detail?: string;
}

/**
 * Thrown from a governed tool's `execute` when the call is denied. The AI SDK
 * reports it to the model as the tool's error; it does not fail the turn.
 * The message is written for the model to read.
 */
export class ToolDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly reason: ToolDenialReason,
    public readonly detail?: string,
  ) {
    super(
      `Tool "${tool}" was not run: ${
        reason === "max-calls"
          ? "it has reached its call limit for this run"
          : reason === "max-cents"
            ? "it has reached its spend limit for this run"
            : reason === "run-budget"
              ? "the run does not have the budget left for it"
              : `blocked by policy${detail ? ` (${detail})` : ""}`
      }. Do not call it again; answer with what you have.`,
    );
    this.name = "ToolDeniedError";
  }
}

/** What the wrapper asks the gateway to ledger for one tool call. */
export interface ToolLedgerEntry {
  tool: string;
  toolCallId: string;
  costCents: number;
  durationMs: number;
  input: unknown;
  /** undefined when the tool did not run or threw. */
  output?: unknown;
  /** The tool threw; its message. */
  error?: string;
  /** The call was not run. */
  denied?: ToolDenialReason;
  /** Observe mode: a cap would have denied it, and it ran. */
  wouldDeny?: ToolDenialReason;
  guardrail?: GuardrailRecord;
}

export interface GovernToolsDeps {
  policy: Record<string, ToolPolicy>;
  hook?: GuardrailHook<ToolGuardrailContext>;
  failOpen: boolean;
  /** false under `caps.mode: "observe"`: caps are recorded, not enforced. */
  enforced: boolean;
  run?: GovernedRun;
  /** The live counter for a tool: the run's, or the call's when there is no run. */
  use: (tool: string) => { calls: number; cents: number };
  hookCtx: Omit<ToolGuardrailContext, "tool" | "toolCallId" | "input">;
  ledger: (entry: ToolLedgerEntry) => Promise<void>;
  /** Called for a tool with no policy entry (the gateway warns once per tool). */
  onUnpriced: (tool: string) => void;
  onDenial: (denial: ToolDenial) => void;
}

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === "object" && v !== null && Symbol.asyncIterator in v;

type AnyExecute = (input: unknown, options: { toolCallId: string }) => unknown;

/**
 * Return `tools` with every executable tool wrapped in governance. Tools with
 * no `execute` (client-side tools the caller runs itself) pass through: there
 * is nothing here to gate or to price.
 */
export function governTools(tools: ToolSet, deps: GovernToolsDeps): ToolSet {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const original = (t as { execute?: AnyExecute }).execute;
    out[name] =
      typeof original === "function" ? { ...t, execute: wrap(name, t, original, deps) } : t;
  }
  return out as ToolSet;
}

function wrap(
  name: string,
  tool: unknown,
  original: AnyExecute,
  deps: GovernToolsDeps,
): AnyExecute {
  /** Caps, reservation, hook. Resolves to what to run, or throws the denial. */
  const before = async (input: unknown, toolCallId: string) => {
    const policy = deps.policy[name];
    if (!policy) deps.onUnpriced(name);
    const cost =
      policy?.costCents === undefined
        ? 0
        : typeof policy.costCents === "function"
          ? policy.costCents(input)
          : policy.costCents;
    const use = deps.use(name);

    // Caps. Checked and reserved with no await in between: the AI SDK runs a
    // step's tool calls concurrently, and two calls must not both pass a
    // limit that has room for one.
    let over: ToolDenialReason | undefined;
    if (policy?.maxCalls !== undefined && use.calls >= policy.maxCalls) over = "max-calls";
    else if (policy?.maxCents !== undefined && use.cents + cost > policy.maxCents) {
      over = "max-cents";
    } else if (cost > 0 && deps.run) {
      // A priced tool is known to cost `cost` before it runs, so unlike a
      // model call it need not be allowed to overshoot the run's budget.
      const left = deps.run.remainingCents();
      if (left !== undefined && cost > left) over = "run-budget";
    }
    if (over && deps.enforced) {
      await deps.ledger({
        tool: name,
        toolCallId,
        costCents: 0,
        durationMs: 0,
        input,
        denied: over,
      });
      deps.onDenial({ tool: name, toolCallId, reason: over });
      throw new ToolDeniedError(name, over);
    }
    use.calls++;
    use.cents += cost;

    let record: GuardrailRecord | undefined;
    if (deps.hook) {
      const started = Date.now();
      const res = await runGuardrail(
        deps.hook,
        "tool",
        { ...deps.hookCtx, tool: name, toolCallId, input },
        deps.failOpen,
      );
      record = res.record;
      let blocked = res.verdict.action === "block";
      if (res.verdict.action === "transform" && "input" in res.verdict) {
        // A rewritten input must still satisfy the tool's schema: the SDK
        // validated what the model sent, not what the hook returned.
        const schema = (tool as { inputSchema?: { safeParse?: (v: unknown) => unknown } })
          .inputSchema;
        const parsed =
          typeof schema?.safeParse === "function"
            ? (schema.safeParse(res.verdict.input) as { success: boolean; data?: unknown })
            : { success: true, data: res.verdict.input };
        if (parsed.success) input = parsed.data;
        else {
          record.error = "transform produced input the tool's schema rejects";
          if (deps.failOpen) record.action = "allow";
          else {
            record.action = "block";
            record.reason = record.error;
            blocked = true;
          }
        }
      }
      if (blocked) {
        use.calls--;
        use.cents -= cost;
        await deps.ledger({
          tool: name,
          toolCallId,
          costCents: 0,
          durationMs: Date.now() - started,
          input,
          denied: "guardrail",
          guardrail: record,
        });
        deps.onDenial({
          tool: name,
          toolCallId,
          reason: "guardrail",
          ...(record.reason ? { detail: record.reason } : {}),
        });
        throw new ToolDeniedError(name, "guardrail", record.reason);
      }
    }
    return { input, cost, wouldDeny: over, record, toolCallId, started: Date.now() };
  };

  type Ready = Awaited<ReturnType<typeof before>>;
  const after = (ready: Ready, output: unknown, err?: unknown) =>
    deps.ledger({
      tool: name,
      toolCallId: ready.toolCallId,
      costCents: ready.cost,
      durationMs: Date.now() - ready.started,
      input: ready.input,
      ...(err === undefined
        ? { output }
        : { error: err instanceof Error ? err.message : String(err) }),
      ...(ready.wouldDeny ? { wouldDeny: ready.wouldDeny } : {}),
      ...(ready.record ? { guardrail: ready.record } : {}),
    });

  // A tool written as an async generator streams preliminary results; keep it
  // one, so the SDK still sees an iterable.
  if (original.constructor?.name === "AsyncGeneratorFunction") {
    return async function* (input: unknown, options: { toolCallId: string }) {
      const ready = await before(input, options.toolCallId);
      let last: unknown;
      try {
        for await (const v of original(ready.input, options) as AsyncIterable<unknown>) {
          last = v;
          yield v;
        }
      } catch (err) {
        await after(ready, undefined, err);
        throw err;
      }
      await after(ready, last);
    };
  }

  return async (input: unknown, options: { toolCallId: string }) => {
    const ready = await before(input, options.toolCallId);
    let output: unknown;
    try {
      output = await original(ready.input, options);
      // A plain function that returns an iterable cannot be told apart up
      // front. Its final value is kept; its preliminary results are not
      // streamed. Write such a tool as `async function*` to keep them.
      if (isAsyncIterable(output)) {
        let last: unknown;
        for await (const v of output) last = v;
        output = last;
      }
    } catch (err) {
      await after(ready, undefined, err);
      throw err;
    }
    await after(ready, output);
    return output;
  };
}
