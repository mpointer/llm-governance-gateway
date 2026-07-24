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

/** Structural subset of @anthropic-ai/sdk's Messages API. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessage>;
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
  });

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
