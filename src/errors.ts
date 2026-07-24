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
