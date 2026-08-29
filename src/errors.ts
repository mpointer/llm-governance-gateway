export class RateLimitError extends Error {
  constructor(
    public readonly limit: number,
    public readonly remaining: number,
  ) {
    super("AI rate limit exceeded");
    this.name = "RateLimitError";
  }
}

export class JudgeGateError extends Error {
  constructor(
    public readonly scores: Record<string, number>,
    public readonly overallScore: number,
    public readonly threshold: number,
    /** The generated object that failed the gate — callers may still use it. */
    public readonly object: unknown,
  ) {
    super(
      `Response failed judge gate: overall ${overallScore.toFixed(2)} < threshold ${threshold}`,
    );
    this.name = "JudgeGateError";
  }
}

export class ZdrViolationError extends Error {
  constructor(
    public readonly provider: string,
    public readonly model: string,
    context: string,
  ) {
    super(
      `ZDR required but "${provider}/${model}" is not asserted zero-data-retention (${context}). ` +
        `Add it to ProviderConfig.retention only if your account contract actually guarantees ZDR.`,
    );
    this.name = "ZdrViolationError";
  }
}

/**
 * One provider attempt exceeded its per-attempt bound.
 *
 * The chain treats this as a reason to ADVANCE to the next link but never to
 * retry the same one — a link that just timed out has demonstrated it is slow.
 * It is deliberately not `isRetryable` (see docs/design/timeouts-and-deadlines.md
 * Rule 7): widening `isRetryable` would re-enable the same-link retry that
 * Rule 4 forbids, so the chain loops test for this error explicitly instead.
 */
export class AttemptTimeoutError extends Error {
  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly attemptMs: number,
  ) {
    super(`"${provider}/${model}" did not respond within ${attemptMs}ms`);
    this.name = "AttemptTimeoutError";
  }
}

/**
 * The whole governed operation ran out of wall-clock budget. Unlike an
 * attempt timeout this is terminal: no further chain links, no retries.
 *
 * The usage rows for whatever already completed are still written — the
 * deadline bounds generation, never the ledger (Rule 1).
 */
export class DeadlineExceededError extends Error {
  constructor(
    public readonly deadlineMs: number,
    public readonly elapsedMs: number,
    /** What the budget was doing when it ran out, for diagnosis. */
    public readonly phase: "before-link" | "before-retry" | "in-flight" = "in-flight",
  ) {
    super(
      `Operation exceeded its ${deadlineMs}ms deadline after ${elapsedMs}ms (${phase})`,
    );
    this.name = "DeadlineExceededError";
  }
}

/**
 * A stream produced no first emission, or fell silent mid-stream, within its
 * configured window. See docs/design/timeouts-and-deadlines.md.
 *
 * The usage row for the aborted attempt is written BEFORE this throws: a
 * provider call that spent money must leave an audit trail even when it
 * never finished.
 */
export class StreamStallError extends Error {
  constructor(
    /** "first-chunk" = nothing ever arrived; "stall" = went silent mid-stream. */
    public readonly phase: "first-chunk" | "stall",
    public readonly waitedMs: number,
    public readonly provider: string,
    public readonly model: string,
  ) {
    super(
      phase === "first-chunk"
        ? `Stream from "${provider}/${model}" produced no output within ${waitedMs}ms`
        : `Stream from "${provider}/${model}" stalled: no output for ${waitedMs}ms`,
    );
    this.name = "StreamStallError";
  }
}

export class SpendCapError extends Error {
  constructor(
    public readonly spentCents: number,
    public readonly capCents: number,
    // "user" = the caller hit their own daily cap; "global" = the app-wide
    // circuit breaker tripped (the caller did nothing wrong — say "busy",
    // not "you're over your limit").
    public readonly scope: "user" | "global" = "user",
  ) {
    super("AI daily spend cap exceeded");
    this.name = "SpendCapError";
  }
}
