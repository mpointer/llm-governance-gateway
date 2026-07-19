import { describe, expect, it } from "vitest";
import { renderTemplate, missingPlaceholders } from "./template.js";
import { isRetryable, retryAfterMs, backoffMs, MAX_DELAY_MS } from "./backoff.js";
import { sanitizeIdentity, sanitized } from "./sanitize.js";

describe("template", () => {
  it("substitutes known placeholders and leaves unknown verbatim", () => {
    expect(renderTemplate("Hi {{name}}, {{unknown}}", { name: "Jo" })).toBe(
      "Hi Jo, {{unknown}}",
    );
  });
  it("reports missing required placeholders", () => {
    expect(missingPlaceholders("Hi {{name}}", ["name", "role"])).toEqual(["role"]);
  });
});

describe("backoff", () => {
  it("retries only 429 and 5xx", () => {
    expect(isRetryable({ statusCode: 429 })).toBe(true);
    expect(isRetryable({ statusCode: 503 })).toBe(true);
    expect(isRetryable({ statusCode: 400 })).toBe(false);
    expect(isRetryable(new Error("nope"))).toBe(false);
  });
  it("honors Retry-After seconds, clamped", () => {
    expect(retryAfterMs({ responseHeaders: { "retry-after": "2" } })).toBe(2000);
    expect(retryAfterMs({ responseHeaders: { "retry-after": "9999" } })).toBe(MAX_DELAY_MS);
    expect(retryAfterMs({})).toBeNull();
  });
  it("backoff stays within the exponential ceiling", () => {
    for (let r = 0; r < 6; r++) {
      const ms = backoffMs(r, {});
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
  });
});

describe("sanitize", () => {
  it("redacts urls, emails, phones; preserves money and years", () => {
    const { text, counts } = sanitizeIdentity(
      "Mail a@b.com or call 555-123-4567, see https://x.co/p?u=a@b.com. Raised $2,000,000 in 2019.",
    );
    expect(text).toContain("[email]");
    expect(text).toContain("[phone]");
    expect(text).toContain("[link]");
    expect(text).toContain("$2,000,000");
    expect(text).toContain("2019");
    expect(counts).toEqual({ email: 1, phone: 1, url: 1 });
  });
  it("passes null/undefined through", () => {
    expect(sanitized(null)).toBeNull();
    expect(sanitized(undefined)).toBeUndefined();
  });
});
