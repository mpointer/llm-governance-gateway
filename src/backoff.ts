// Retry classification + backoff timing for outbound AI provider calls.
// Kept separate so the policy is unit-testable in isolation.

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 8_000;

// Retry only on 429 (rate limited) and 5xx (server) — never on other 4xx,
// which are caller errors that won't succeed on retry. Reads both
// `statusCode` (AI SDK) and `status` (@anthropic-ai/sdk).
export function isRetryable(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const s =
    (err as { statusCode?: number }).statusCode ??
    (err as { status?: number }).status;
  if (typeof s !== "number") return false;
  return s === 429 || (s >= 500 && s < 600);
}

/**
 * Schema-validation failures from generateObject (model returned output that
 * doesn't satisfy the schema, or unparseable JSON). These are NOT transient
 * network errors — but they ARE model-specific: a different provider/model in
 * the chain may well produce valid output. Detected by AI SDK error name so
 * we don't couple to error-class identity across SDK versions; walks the
 * cause chain because NoObjectGeneratedError wraps the underlying failure.
 */
export function isSchemaValidationError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (
      cur instanceof Error &&
      /^AI_(NoObjectGenerated|TypeValidation|JSONParse)Error$/.test(cur.name)
    ) {
      return true;
    }
    cur = cur instanceof Error ? cur.cause : null;
  }
  return false;
}

// Honor a provider Retry-After header (seconds or HTTP-date) when present,
// clamped to [0, MAX_DELAY_MS]. Returns null when no usable header is found.
export function retryAfterMs(err: unknown): number | null {
  if (err == null || typeof err !== "object") return null;
  const headers =
    (err as { responseHeaders?: Record<string, string> }).responseHeaders ??
    (err as { headers?: Record<string, string> }).headers;
  const ra = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!ra) return null;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1000), MAX_DELAY_MS);
  const at = Date.parse(ra);
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), MAX_DELAY_MS);
  return null;
}

// Exponential backoff with equal jitter (half fixed + half random) so that
// concurrent retries after a provider 429 spike don't fire in lockstep
// (thundering herd). A provider-supplied Retry-After takes precedence.
export function backoffMs(retry: number, err: unknown): number {
  const server = retryAfterMs(err);
  if (server != null) return server;
  const ceil = Math.min(BASE_DELAY_MS * 2 ** retry, MAX_DELAY_MS);
  return ceil / 2 + Math.random() * (ceil / 2);
}
