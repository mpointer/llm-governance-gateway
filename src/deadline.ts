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
