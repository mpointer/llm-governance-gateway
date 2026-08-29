// Governed embeddings (harvested from the ProjectFlowAI adoption): embedding
// spend is real money at document-pipeline volume and must flow through the
// same ledger/caps as generation.

import crypto from "node:crypto";
import type { EmbeddingModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderRegistry } from "./providers.js";

export interface EmbedOptions {
  /** Prefixed model id. Default "openai:text-embedding-3-small". */
  model?: string;
  /** Output dimensions where the provider supports it. Default 1536. */
  dimensions?: number;
  /** BYO AI SDK embedding model (tests, Voyage, custom endpoints). When set,
   *  `model` is used for attribution/pricing only. */
  embeddingModel?: EmbeddingModel;
  /** Aborts the embedding request (caller cancellation, request teardown). */
  signal?: AbortSignal;
  /** Bound on the embedding call. Overrides GatewayConfig.timeouts. */
  attemptMs?: number;
  /** Whole-call bound. embed() is single-shot, so this rarely differs from
   *  attemptMs; accepted for symmetry with the generation paths. */
  deadlineMs?: number;
  /** Tenant this call belongs to. Falls back to GatewayConfig.orgId. */
  orgId?: string;
  /** Caller-defined attribution logged on every usage row this call writes
   *  (including cache hits and the judge). The gateway never reads it — it is
   *  not part of the cache key and never affects routing. */
  metadata?: Record<string, unknown>;
  requireZdr?: boolean;
  userId?: string;
  anonKey?: string;
  route?: string;
  app?: string;
}

export interface EmbedResult {
  embeddings: number[][];
  provider: string;
  model: string;
  inputTokens: number;
  traceId: string;
  usageLogId?: string | number;
}

export const DEFAULT_EMBEDDING_MODEL = "openai:text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** Embedding pricing, cents per 1K tokens (no output tokens). */
export const EMBEDDING_PRICING: Record<string, { in: number; out: number }> = {
  "text-embedding-3-small": { in: 0.002, out: 0 },
  "text-embedding-3-large": { in: 0.013, out: 0 },
  // Voyage list pricing, cents per 1K tokens.
  "voyage-3-lite": { in: 0.002, out: 0 },
  "voyage-3": { in: 0.006, out: 0 },
  "voyage-3-large": { in: 0.018, out: 0 },
  "voyage-code-3": { in: 0.006, out: 0 },
};

/**
 * Embedding providers with first-class support. Voyage speaks the same
 * OpenAI-compatible embeddings shape, so it needs a base URL rather than a
 * new dependency — the pattern the registry already uses for its aggregator
 * chat providers (openrouter/venice/together/huggingface).
 */
const EMBEDDING_PROVIDERS: Record<
  string,
  { baseURL?: string; envVar: string }
> = {
  openai: { envVar: "OPENAI_API_KEY" },
  voyage: { baseURL: "https://api.voyageai.com/v1", envVar: "VOYAGE_API_KEY" },
};

/** Embedding provider ids the gateway can build without a BYO model. */
export const EMBEDDING_PROVIDER_IDS = Object.keys(EMBEDDING_PROVIDERS);

/**
 * Parse an embedding model id.
 *
 * Embedding-only providers are NOT in the registry's chat PROVIDER_IDS, so
 * `parseAny` would treat "voyage:voyage-3" as a bare Anthropic model id and
 * silently mis-attribute the call. Recognise them here first, then defer to
 * the registry for chat providers, endpoints and factories.
 */
export function parseEmbeddingModelId(
  id: string,
  fallback: (id: string) => { provider: string; model: string },
): { provider: string; model: string } {
  const idx = id.indexOf(":");
  if (idx > 0) {
    const prefix = id.slice(0, idx);
    if (prefix in EMBEDDING_PROVIDERS) {
      return { provider: prefix, model: id.slice(idx + 1) };
    }
  }
  return fallback(id);
}

export function buildEmbeddingModel(
  registry: ProviderRegistry,
  provider: string,
  model: string,
): EmbeddingModel | null {
  // First-class: OpenAI and Voyage. Anything else — a self-hosted encoder, a
  // provider we do not model — still goes through the `embeddingModel` BYO
  // seam, which stays the escape hatch rather than the only option.
  const cfg = EMBEDDING_PROVIDERS[provider];
  if (!cfg) return null;
  const key = registry.namedApiKey(provider, cfg.envVar);
  if (!key) return null;
  return createOpenAI({
    apiKey: key,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  }).embedding(model);
}

/**
 * Deterministic pseudo-embedding for mock mode: stable per input,
 * unit-normalized, identical input → identical vector. Ported from a
 * production implementation (ProjectFlowAI) so adopters' mock vectors are
 * drop-in compatible.
 */
export function mockEmbedding(text: string, dimensions = DEFAULT_EMBEDDING_DIMENSIONS): number[] {
  const seed = crypto.createHash("sha256").update(text).digest();
  const values: number[] = [];
  let counter = 0;
  while (values.length < dimensions) {
    const block = crypto.createHash("sha256").update(seed).update(String(counter++)).digest();
    for (let i = 0; i + 1 < block.length && values.length < dimensions; i += 2) {
      values.push(block.readInt16BE(i) / 32768);
    }
  }
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}
