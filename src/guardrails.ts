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
  /** Scrub and continue: a pre hook may replace `prompt`, a post hook `output`. */
  | { action: "transform"; prompt?: string; output?: unknown; reason?: string }
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

export type GuardrailHook<Ctx> = (ctx: Ctx) => GuardrailVerdict | Promise<GuardrailVerdict>;

export interface GuardrailConfig {
  pre?: GuardrailHook<PreGuardrailContext>;
  post?: GuardrailHook<PostGuardrailContext>;
  /**
   * What a THROWING hook means. Default false: the call is blocked (fail
   * closed). true: the call proceeds as if the hook had allowed it, and the
   * ledger row records the error and that the gate was open at the time.
   */
  failOpen?: boolean;
}

/** One ledgered verdict. The usage row carries one per hook that ran. */
export interface GuardrailRecord {
  hook: "pre" | "post";
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
  which: "pre" | "post",
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

function normalize(v: GuardrailVerdict, which: "pre" | "post"): GuardrailVerdict {
  if (!v || typeof v !== "object" || typeof (v as { action?: unknown }).action !== "string") {
    throw new Error(`${which} guardrail returned an invalid verdict`);
  }
  if (v.action === "block" && typeof v.reason !== "string") {
    throw new Error(`${which} guardrail blocked without a reason`);
  }
  return v;
}

export function guardrailError(record: GuardrailRecord, output?: unknown): GuardrailError {
  return new GuardrailError(record.hook, record.reason ?? "blocked", record.detail, output);
}
