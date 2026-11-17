// Pluggable guardrail hooks: policy enforced on EVERY governed call, in the
// request path, with the verdict written to the ledger.
//
// Two seams, both TypeScript functions supplied by the adopter:
//   pre  — after the prompt is rendered, before any provider spend. A block
//          here costs no tokens. A transform rewrites the prompt that goes out.
//   post — after generation and schema validation, before the cache write and
//          before the judge. A transform rewrites the object the caller gets
//          (and what gets cached, and what the judge scores). A block throws
//          GuardrailError AFTER the usage row is written: the tokens were
//          spent, and an audit that cannot see blocked calls is not an audit.
//
// Policy on hook failure is DECLARED, not inferred. Default is fail closed: a
// throwing hook blocks the call. `failOpen: true` lets the call through and
// ledgers that it did, so the choice is visible later. The judge is not a
// guardrail: it samples for quality on its own budget; these run on every
// call and are allowed to say no.

import { GuardrailError } from "./errors.js";

export type GuardrailVerdict =
  /** Proceed. `reason` and `detail` are optional audit breadcrumbs. */
  | { action: "allow"; reason?: string; detail?: Record<string, unknown> }
  /**
   * Scrub and continue: a pre hook may replace `prompt`, a post hook `output`,
   * a tool hook the tool call's `input`.
   */
  | { action: "transform"; prompt?: string; output?: unknown; input?: unknown; reason?: string }
  /** Stop the call. `detail` is ledgered as-is; keep it small and JSON-safe. */
  | { action: "block"; reason: string; detail?: Record<string, unknown> };

export interface PreGuardrailContext {
  slug: string;
  /** The rendered prompt about to be sent. */
  prompt: string;
  system?: string;
  /** The caller's input object, before templating. */
  input: unknown;
  traceId: string;
  userId?: string | null;
  orgId?: string | null;
  route?: string | null;
  task?: string;
}

export interface PostGuardrailContext {
  slug: string;
  prompt: string;
  system?: string;
  input: unknown;
  /** The schema-valid object the provider returned. */
  output: unknown;
  provider: string;
  model: string;
  traceId: string;
  userId?: string | null;
  orgId?: string | null;
  route?: string | null;
  task?: string;
}

/** What a tool hook sees: one tool call the model asked for, before it runs. */
export interface ToolGuardrailContext {
  /** The governed call's slug. */
  slug: string;
  /** The tool's name, as keyed in the call's `tools`. */
  tool: string;
  toolCallId: string;
  /** The arguments the model produced, already validated by the tool's schema. */
  input: unknown;
  traceId: string;
  userId?: string | null;
  orgId?: string | null;
  route?: string | null;
  task?: string;
  /** The governed run the call belongs to, when it carries one. */
  runId?: string;
}

export type GuardrailHook<Ctx> = (ctx: Ctx) => GuardrailVerdict | Promise<GuardrailVerdict>;

export interface GuardrailConfig {
  pre?: GuardrailHook<PreGuardrailContext>;
  post?: GuardrailHook<PostGuardrailContext>;
  /**
   * Runs before each tool call a `streamText` loop is about to execute.
   * `allow` runs the tool, `transform` runs it with `input` replaced, `block`
   * does not run it: the model is told the tool was denied and the loop goes
   * on. The verdict is ledgered on the tool call's row. See
   * docs/design/run-governance.md.
   */
  tool?: GuardrailHook<ToolGuardrailContext>;
  /**
   * What a THROWING hook means. Default false: the call is blocked (fail
   * closed). true: the call proceeds as if the hook had allowed it, and the
   * ledger row records the error and that the gate was open at the time.
   */
  failOpen?: boolean;
}

/** One ledgered verdict. The usage row carries one per hook that ran. */
export interface GuardrailRecord {
  hook: "pre" | "post" | "tool";
  action: GuardrailVerdict["action"];
  reason?: string;
  detail?: Record<string, unknown>;
  /** The hook threw. `action` then says what the failure policy decided. */
  error?: string;
  failOpen: boolean;
  durationMs: number;
}

export interface GuardrailOutcome {
  verdict: GuardrailVerdict;
  record: GuardrailRecord;
}

/**
 * Run one hook and turn whatever happens into a verdict plus a ledger record.
 * Never throws: a hook error becomes a block (fail closed) or an allow with
 * the error recorded (fail open). The caller throws GuardrailError on block.
 */
export async function runGuardrail<Ctx>(
  hook: GuardrailHook<Ctx>,
  which: "pre" | "post" | "tool",
  ctx: Ctx,
  failOpen: boolean,
): Promise<GuardrailOutcome> {
  const start = Date.now();
  try {
    const verdict = normalize(await hook(ctx), which);
    const record: GuardrailRecord = {
      hook: which,
      action: verdict.action,
      failOpen,
      durationMs: Date.now() - start,
    };
    if (verdict.action !== "transform" && verdict.reason) record.reason = verdict.reason;
    if (verdict.action === "transform" && verdict.reason) record.reason = verdict.reason;
    if (verdict.action !== "transform" && verdict.detail) record.detail = verdict.detail;
    return { verdict, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;
    if (failOpen) {
      return {
        verdict: { action: "allow" },
        record: { hook: which, action: "allow", error: message, failOpen, durationMs },
      };
    }
    const reason = `${which} guardrail threw: ${message}`;
    return {
      verdict: { action: "block", reason },
      record: { hook: which, action: "block", reason, error: message, failOpen, durationMs },
    };
  }
}

function normalize(v: GuardrailVerdict, which: "pre" | "post" | "tool"): GuardrailVerdict {
  if (!v || typeof v !== "object" || typeof (v as { action?: unknown }).action !== "string") {
    throw new Error(`${which} guardrail returned an invalid verdict`);
  }
  if (v.action === "block" && typeof v.reason !== "string") {
    throw new Error(`${which} guardrail blocked without a reason`);
  }
  return v;
}

export function guardrailError(record: GuardrailRecord, output?: unknown): GuardrailError {
  // Only pre and post records reach here: a tool hook's block is a
  // ToolDeniedError handed back to the model, never a GuardrailError.
  return new GuardrailError(
    record.hook as "pre" | "post",
    record.reason ?? "blocked",
    record.detail,
    output,
  );
}
