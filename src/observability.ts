// Observability export helpers. The gateway takes NO dependency on any
// OTel or Langfuse package — hooks receive plain objects and these helpers
// shape them for common backends. See ObservabilityHooks in types.ts.

import type { UsageEntry } from "./types.js";

/**
 * Map a usage entry onto OpenTelemetry GenAI semantic-convention attribute
 * names (gen_ai.*) plus llm_gateway.* extensions for the governance fields
 * the conventions don't cover. Attach to a span however your OTel setup
 * likes: `span.setAttributes(toOtelAttributes(entry))`.
 */
export function toOtelAttributes(
  entry: UsageEntry & { id?: string | number },
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "gen_ai.system": entry.provider,
    "gen_ai.response.model": entry.model,
    "gen_ai.usage.input_tokens": entry.inputTokens,
    "gen_ai.usage.output_tokens": entry.outputTokens,
    "llm_gateway.estimated_cost_cents": entry.estimatedCostCents,
    "llm_gateway.cache_hit": entry.cacheHit,
    "llm_gateway.trace_id": entry.traceId,
  };
  if (entry.app != null) attrs["llm_gateway.app"] = entry.app;
  if (entry.route != null) attrs["llm_gateway.route"] = entry.route;
  if (entry.userId != null) attrs["enduser.id"] = entry.userId;
  if (entry.promptSlug != null) attrs["llm_gateway.prompt_slug"] = entry.promptSlug;
  if (entry.durationMs != null) attrs["llm_gateway.duration_ms"] = entry.durationMs;
  if (entry.cacheCreateTokens != null)
    attrs["llm_gateway.cache_create_tokens"] = entry.cacheCreateTokens;
  if (entry.cacheReadTokens != null)
    attrs["llm_gateway.cache_read_tokens"] = entry.cacheReadTokens;
  if (entry.webSearches != null) attrs["llm_gateway.web_searches"] = entry.webSearches;
  if (entry.zdrEnforced != null) attrs["llm_gateway.zdr_enforced"] = entry.zdrEnforced;
  return attrs;
}
