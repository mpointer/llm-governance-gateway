// Per-attempt abort composition. See docs/design/timeouts-and-deadlines.md.
//
// This deliberately does NOT use `AbortSignal.any([AbortSignal.timeout(ms),
// callerSignal])`, which is the obvious one-liner, for three reasons:
//
//   1. That composition has a reported failure mode where the timeout never
//      fires and the request runs to completion (nodejs/node#57736) — nothing
//      holds a strong reference to the timeout signal inside the composite, so
//      it is collectible. A timeout that silently no-ops is worse than no
//      timeout: the library would advertise a bound it does not enforce.
//   2. `AbortSignal.any` landed in Node 20.3.0, while engines.node is ">=20".
//   3. A composed signal reports whichever input fired, as a DOMException,
//      which loses the ability to tell an attempt timeout from a caller abort.
//
// So the controller, the timer (held in a local, strong reference, cleared in
// dispose) and the listener are all owned explicitly here.

/** Reason attached when the per-attempt clock, rather than the caller, aborts. */
export class AttemptTimeoutReason extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Provider call exceeded ${timeoutMs}ms`);
    this.name = "AttemptTimeoutReason";
  }
}

export interface AttemptSignal {
  /** Hand to the SDK / provider client. */
  readonly signal: AbortSignal;
  /** True once this attempt's own clock fired (not a caller abort). */
  timedOut(): boolean;
  /** Clears the timer and listener. Idempotent; always call from finally. */
  dispose(): void;
}

/**
 * One attempt's abort signal: fires on `timeoutMs`, or when `callerSignal`
 * aborts, whichever comes first.
 *
 * Create one PER ATTEMPT — a retry deserves a fresh window, not the remains
 * of the previous one.
 */
export function attemptSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): AttemptSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCallerAbort = () => {
    dispose();
    controller.abort(callerSignal?.reason);
  };

  function dispose(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    if (callerSignal) {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        timer = undefined;
        controller.abort(new AttemptTimeoutReason(timeoutMs));
      }, timeoutMs);
      // Never hold the process open on an attempt clock alone.
      (timer as { unref?: () => void }).unref?.();
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose,
  };
}

/**
 * Sleep that a signal can cut short. The bare
 * `new Promise(r => setTimeout(r, ms))` this replaces made a caller abort
 * wait out the full backoff delay before anyone noticed.
 *
 * Rejects with the signal's reason when aborted, so a cancelled backoff
 * unwinds the retry loop instead of resuming it.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * An attempt shorter than this is not worth opening a connection for: it is
 * guaranteed to abort mid-flight, and a half-open provider call may still
 * bill. See Rule 2 in docs/design/timeouts-and-deadlines.md.
 */
export const MIN_ATTEMPT_MS = 1_000;

/**
 * The whole-operation clock: one per governed call, shared across every chain
 * link, retry, and backoff sleep within it.
 *
 * Deliberately NOT a single long-lived AbortSignal — each attempt gets its own
 * short-lived signal derived from `min(attemptMs, remaining budget)`, so a
 * per-attempt timeout and a blown deadline stay distinguishable (Rule 5). A
 * budget with no `deadlineMs` is unbounded, which is the default and preserves
 * the library's pre-S4 behavior exactly.
 */
export class AttemptBudget {
  private readonly startedAt = Date.now();

  constructor(
    /** Whole-operation budget. undefined = unbounded. */
    readonly deadlineMs?: number,
    /** The caller's own signal, composed into every attempt. */
    readonly callerSignal?: AbortSignal,
  ) {}

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** undefined when unbounded. Never negative. */
  remainingMs(): number | undefined {
    if (this.deadlineMs === undefined) return undefined;
    return Math.max(0, this.deadlineMs - this.elapsedMs());
  }

  expired(): boolean {
    const r = this.remainingMs();
    return r !== undefined && r <= 0;
  }

  /**
   * Is there enough budget left to be worth starting another attempt?
   * Unbounded budgets always are.
   */
  canStartAttempt(minMs = MIN_ATTEMPT_MS): boolean {
    const r = this.remainingMs();
    return r === undefined || r >= minMs;
  }

  /**
   * One attempt's signal: fires at `min(attemptMs, remaining budget)`, or when
   * the caller aborts. Dispose it when the attempt settles.
   */
  attempt(attemptMs: number): AttemptSignal {
    const remaining = this.remainingMs();
    const ms = remaining === undefined ? attemptMs : Math.min(attemptMs, remaining);
    return attemptSignal(ms, this.callerSignal);
  }

  /** Clamp a backoff delay so a sleep cannot outlive the budget. */
  clampDelay(ms: number): number {
    const r = this.remainingMs();
    return r === undefined ? ms : Math.min(ms, r);
  }
}
