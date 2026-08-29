// Native Anthropic path (opt-in): adaptive extended thinking, prompt-caching
// cache_control, and server-side web search — features the AI SDK path can't
// express. BYO client: pass a `new Anthropic({...})` instance (or anything
// structurally compatible — the package takes NO dependency on
// @anthropic-ai/sdk, mirroring the RedisLike pattern).
//
// Structured output strategy:
//   - Without thinking: forced tool_use (tool_choice: {type:"tool"}) — the
//     model must emit arguments matching the JSON schema.
//   - With thinking: forced tool_choice is not allowed, so we use
//     tool_choice:"auto" plus a hard instruction; a response with no tool_use
//     block becomes a schema-validation error, which flows into the standard
//     repair-retry → chain-failover machinery.

import type { z } from "zod";
import { toJSONSchema } from "zod";

/**
 * Per-request options, structurally matching @anthropic-ai/sdk's second
 * argument. Only `signal` is used; the SDK's own `timeout` is deliberately
 * NOT set here — two competing clocks would make it ambiguous which one
 * aborted a call. See docs/design/timeouts-and-deadlines.md.
 */
export interface AnthropicRequestOptions {
  signal?: AbortSignal;
}

/**
 * Structural subset of @anthropic-ai/sdk's Messages API.
 *
 * The `options` parameter is optional, so a BYO client written against the
 * older one-argument shape still satisfies this interface (a function of
 * fewer parameters is assignable to a type declaring more). Such a client
 * simply ignores the signal and keeps whatever timeout it was constructed
 * with.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: AnthropicRequestOptions,
    ): Promise<AnthropicMessage>;
  };
}

export interface AnthropicMessage {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: unknown }
    | { type: string; [k: string]: unknown }
  >;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
  stop_reason?: string | null;
}

export interface NativeCallOptions {
  /** true = adaptive thinking; object = explicit token budget. */
  thinking?: boolean | { budgetTokens: number };
  /** true = default max_uses (4); object to set it explicitly. */
  webSearch?: boolean | { maxUses: number };
  /** Attach ephemeral cache_control to the system prompt block. */
  cacheSystem?: boolean;
}

export interface NativeAnthropicConfig {
  client: AnthropicMessagesClient;
  /** Gate for thinking support; sending `thinking` to a non-supporting model
   *  400s. Default: opus/sonnet/fable prefixes. */
  supportsThinking?: (model: string) => boolean;
  maxTokens?: number;
}

export interface NativeResult {
  object: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  webSearches: number;
}

/** Thrown with an AI-SDK-compatible error name ON PURPOSE so the existing
 *  isSchemaValidationError → repair → failover machinery treats native
 *  schema failures identically to AI SDK ones. */
export class NativeSchemaError extends Error {
  override name = "AI_TypeValidationError";
}

export const EMIT_TOOL = "emit_result";

/** Extract the emit-tool input from a message, or throw NativeSchemaError. */
export function extractEmitToolInput(msg: AnthropicMessage): unknown {
  const toolUse = msg.content.find(
    (b): b is { type: "tool_use"; name: string; input: unknown } =>
      b.type === "tool_use" && (b as { name?: string }).name === EMIT_TOOL,
  );
  if (!toolUse) {
    throw new NativeSchemaError(
      `Anthropic response contained no ${EMIT_TOOL} tool call`,
    );
  }
  return toolUse.input;
}

function defaultSupportsThinking(model: string): boolean {
  return (
    model.startsWith("claude-opus") ||
    model.startsWith("claude-sonnet") ||
    model.startsWith("claude-fable")
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function schemaToJson(schema: z.ZodType<any> | { jsonSchema?: unknown }): Record<string, unknown> {
  if ("jsonSchema" in schema && schema.jsonSchema) {
    return schema.jsonSchema as Record<string, unknown>;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return toJSONSchema(schema as z.ZodType<any>, { reused: "inline" }) as Record<string, unknown>;
}

export async function callNativeAnthropic(
  cfg: NativeAnthropicConfig,
  args: {
    model: string;
    prompt: string;
    system?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: z.ZodType<any> | { jsonSchema?: unknown };
    temperature?: number;
    native: NativeCallOptions;
    /** Aborts the request. The gateway always supplies one. */
    signal?: AbortSignal;
  },
): Promise<NativeResult> {
  const supports = cfg.supportsThinking ?? defaultSupportsThinking;
  const wantsThinking = !!args.native.thinking && supports(args.model);
  const jsonSchema = schemaToJson(args.schema);

  const thinking =
    wantsThinking && typeof args.native.thinking === "object"
      ? { type: "enabled", budget_tokens: args.native.thinking.budgetTokens }
      : wantsThinking
        ? { type: "adaptive" }
        : undefined;

  const tools: Record<string, unknown>[] = [
    {
      name: EMIT_TOOL,
      description: "Emit the final structured result. Call exactly once.",
      input_schema: jsonSchema,
    },
  ];
  if (args.native.webSearch) {
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses:
        typeof args.native.webSearch === "object" ? args.native.webSearch.maxUses : 4,
    });
  }

  // Forced tool_choice is incompatible with thinking and with server tools in
  // the loop; fall back to auto + instruction in those modes.
  const forceTool = !wantsThinking && !args.native.webSearch;
  const prompt = forceTool
    ? args.prompt
    : `${args.prompt}\n\nWhen you have the final answer, call the ${EMIT_TOOL} tool with it. You MUST call ${EMIT_TOOL} exactly once.`;

  const system = args.system
    ? [
        {
          type: "text",
          text: args.system,
          ...(args.native.cacheSystem ? { cache_control: { type: "ephemeral" } } : {}),
        },
      ]
    : undefined;

  const msg = await cfg.client.messages.create({
    model: args.model,
    max_tokens: cfg.maxTokens ?? 8192,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: prompt }],
    tools,
    tool_choice: forceTool ? { type: "tool", name: EMIT_TOOL } : { type: "auto" },
    ...(thinking ? { thinking } : {}),
    ...(args.temperature !== undefined && !wantsThinking
      ? { temperature: args.temperature } // thinking requires temperature 1
      : {}),
  }, { signal: args.signal });

  const toolUse = msg.content.find(
    (b): b is { type: "tool_use"; name: string; input: unknown } =>
      b.type === "tool_use" && (b as { name?: string }).name === EMIT_TOOL,
  );
  if (!toolUse) {
    throw new NativeSchemaError(
      `Native Anthropic response contained no ${EMIT_TOOL} tool call`,
    );
  }

  const u = msg.usage ?? {};
  return {
    object: toolUse.input,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
  };
}

export interface NativeTextResult {
  text: string;
  /** AI-SDK-vocabulary finishReason ("stop", "length", ...) mapped from
   *  Anthropic's stop_reason, so runText callers see one vocabulary. */
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  webSearches: number;
}

function toFinishReason(stopReason: string | null | undefined): string | undefined {
  if (stopReason == null) return undefined;
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "max_tokens") return "length";
  return stopReason;
}

/** Native Anthropic TEXT call: the runText counterpart of
 *  callNativeAnthropic. No emit tool and no schema — the answer is the
 *  concatenated text blocks — which is exactly what makes server-side web
 *  search usable for grounded text: the search results and the prose answer
 *  interleave freely instead of being forced through a tool call. */
export async function callNativeAnthropicText(
  cfg: NativeAnthropicConfig,
  args: {
    model: string;
    prompt: string;
    system?: string;
    temperature?: number;
    maxTokens?: number;
    native: NativeCallOptions;
    /** Aborts the request. The gateway always supplies one. */
    signal?: AbortSignal;
  },
): Promise<NativeTextResult> {
  const supports = cfg.supportsThinking ?? defaultSupportsThinking;
  const wantsThinking = !!args.native.thinking && supports(args.model);

  const thinking =
    wantsThinking && typeof args.native.thinking === "object"
      ? { type: "enabled", budget_tokens: args.native.thinking.budgetTokens }
      : wantsThinking
        ? { type: "adaptive" }
        : undefined;

  const tools: Record<string, unknown>[] = [];
  if (args.native.webSearch) {
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses:
        typeof args.native.webSearch === "object" ? args.native.webSearch.maxUses : 4,
    });
  }

  const system = args.system
    ? [
        {
          type: "text",
          text: args.system,
          ...(args.native.cacheSystem ? { cache_control: { type: "ephemeral" } } : {}),
        },
      ]
    : undefined;

  const msg = await cfg.client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens ?? cfg.maxTokens ?? 8192,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: args.prompt }],
    ...(tools.length > 0 ? { tools } : {}),
    ...(thinking ? { thinking } : {}),
    ...(args.temperature !== undefined && !wantsThinking
      ? { temperature: args.temperature } // thinking requires temperature 1
      : {}),
  }, { signal: args.signal });

  const text = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const u = msg.usage ?? {};
  return {
    text,
    finishReason: toFinishReason(msg.stop_reason),
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
  };
}
