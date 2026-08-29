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
};

export function buildEmbeddingModel(
  registry: ProviderRegistry,
  provider: string,
  model: string,
): EmbeddingModel | null {
  // v1: OpenAI only — the one provider our adopters embed with today.
  // Voyage (LocalNewsBuddy harvest) and custom endpoints via the
  // `embeddingModel` BYO seam until they earn first-class support.
  if (provider === "openai") {
    const key = registry.apiKey("openai");
    if (!key) return null;
    return createOpenAI({ apiKey: key }).embedding(model);
  }
  return null;
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
