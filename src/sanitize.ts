// Identity-field sanitizer. Email addresses, phone numbers, and URLs are
// replaced with neutral placeholders before user-authored text reaches an LLM
// provider. Names and companies deliberately STAY — they are often
// load-bearing for output quality; scope removal to identity fields.
//
// One-way redaction by design: no substitution map, no un-substitute.
// Placeholders preserve grammar ("[email]" reads as a noun).

export const SANITIZER_VERSION = 2; // v2: one-way identity-field redaction

const URL_RE = /https?:\/\/[^\s)]+/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Phone: NANP-ish shapes with separators, plus bare 10-digit runs. The
// separator requirement keeps ordinary numbers ("$2,000,000", "2019") safe.
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{10}\b/g;

export interface SanitizeCounts {
  email: number;
  phone: number;
  url: number;
}

/** Replace identity fields in user-authored text with neutral placeholders.
 *  Order matters: URLs first (their paths can contain @ and digit runs),
 *  then emails (local parts contain dots/digits), then phones. */
export function sanitizeIdentity(text: string): { text: string; counts: SanitizeCounts } {
  const counts: SanitizeCounts = { email: 0, phone: 0, url: 0 };
  let out = text.replace(URL_RE, () => {
    counts.url += 1;
    return "[link]";
  });
  out = out.replace(EMAIL_RE, () => {
    counts.email += 1;
    return "[email]";
  });
  out = out.replace(PHONE_RE, () => {
    counts.phone += 1;
    return "[phone]";
  });
  return { text: out, counts };
}

/** Convenience: sanitize, drop the counts. Null/undefined pass through. */
export function sanitized(text: string): string;
export function sanitized(text: string | null | undefined): string | null | undefined;
export function sanitized(text: string | null | undefined): string | null | undefined {
  if (text == null) return text;
  return sanitizeIdentity(text).text;
}
