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
  /**
   * runText only: use the streaming transport (messages.create with
   * stream: true) and return the joined text. Needed for completions the SDK
   * refuses to send non-streaming (its 10-minute ceiling, e.g. a 64k
   * max_tokens). streamText always streams.
   */
  stream?: boolean;
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
    throw new NativeSchemaError(`Anthropic response contained no ${EMIT_TOOL} tool call`);
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
      max_uses: typeof args.native.webSearch === "object" ? args.native.webSearch.maxUses : 4,
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

  const msg = await cfg.client.messages.create(
    {
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
    },
    { signal: args.signal },
  );

  const toolUse = msg.content.find(
    (b): b is { type: "tool_use"; name: string; input: unknown } =>
      b.type === "tool_use" && (b as { name?: string }).name === EMIT_TOOL,
  );
  if (!toolUse) {
    throw new NativeSchemaError(`Native Anthropic response contained no ${EMIT_TOOL} tool call`);
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

/** Request params for a native text call (shared by the unary and streaming paths). */
function nativeTextParams(
  cfg: NativeAnthropicConfig,
  args: {
    model: string;
    messages: { role: "user" | "assistant"; content: string }[];
    system?: string;
    temperature?: number;
    maxTokens?: number;
    native: NativeCallOptions;
  },
): Record<string, unknown> {
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
      max_uses: typeof args.native.webSearch === "object" ? args.native.webSearch.maxUses : 4,
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

  return {
    model: args.model,
    max_tokens: args.maxTokens ?? cfg.maxTokens ?? 8192,
    ...(system ? { system } : {}),
    messages: args.messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(thinking ? { thinking } : {}),
    ...(args.temperature !== undefined && !wantsThinking
      ? { temperature: args.temperature } // thinking requires temperature 1
      : {}),
  };
}

/** A streamed native part, shaped like the AI SDK's fullStream parts the
 *  gateway's stream loop already reads. */
export type NativeStreamPart =
  | { type: "text-delta"; text: string }
  | {
      type: "finish";
      finishReason?: string;
      totalUsage: { inputTokens: number; outputTokens: number };
      extras: { cacheCreateTokens: number; cacheReadTokens: number; webSearches: number };
    };

/**
 * Native text over the streaming transport: messages.create({ stream: true })
 * yields raw SSE events, mapped to text deltas and one final usage part.
 * Same join rule as the unary path (#16): a text block that follows a
 * non-text block (a web search) starts on a new line.
 */
export async function* streamNativeAnthropicText(
  cfg: NativeAnthropicConfig,
  args: Parameters<typeof nativeTextParams>[1] & { signal?: AbortSignal },
): AsyncGenerator<NativeStreamPart> {
  const create = cfg.client.messages.create as unknown as (
    p: Record<string, unknown>,
    o?: AnthropicRequestOptions,
  ) => Promise<AsyncIterable<Record<string, any>>>;
  const events = await create(
    { ...nativeTextParams(cfg, args), stream: true },
    { signal: args.signal },
  );
  const usage = { in: 0, out: 0, cacheCreate: 0, cacheRead: 0, searches: 0 };
  let stopReason: string | null | undefined;
  let emitted = false;
  let afterText = true;
  for await (const e of events) {
    if (e.type === "message_start") {
      const u = e.message?.usage ?? {};
      usage.in = u.input_tokens ?? 0;
      usage.out = u.output_tokens ?? 0;
      usage.cacheCreate = u.cache_creation_input_tokens ?? 0;
      usage.cacheRead = u.cache_read_input_tokens ?? 0;
    } else if (e.type === "content_block_start") {
      if (e.content_block?.type !== "text") afterText = false;
      else {
        if (!afterText && emitted) yield { type: "text-delta", text: "\n" };
        afterText = true;
      }
    } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      emitted = true;
      yield { type: "text-delta", text: e.delta.text };
    } else if (e.type === "message_delta") {
      stopReason = e.delta?.stop_reason ?? stopReason;
      if (e.usage?.output_tokens !== undefined) usage.out = e.usage.output_tokens;
      usage.searches = e.usage?.server_tool_use?.web_search_requests ?? usage.searches;
    } else if (e.type === "error") {
      throw Object.assign(new Error(e.error?.message ?? "Anthropic stream error"), {
        status: e.error?.type === "overloaded_error" ? 529 : undefined,
      });
    }
  }
  yield {
    type: "finish",
    finishReason: toFinishReason(stopReason),
    totalUsage: { inputTokens: usage.in, outputTokens: usage.out },
    extras: {
      cacheCreateTokens: usage.cacheCreate,
      cacheReadTokens: usage.cacheRead,
      webSearches: usage.searches,
    },
  };
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
  const textArgs = {
    ...args,
    messages: [{ role: "user" as const, content: args.prompt }],
  };
  if (args.native.stream) {
    // Streaming transport, joined: same result shape as the unary call.
    let text = "";
    for await (const part of streamNativeAnthropicText(cfg, textArgs)) {
      if (part.type === "text-delta") text += part.text;
      else
        return {
          text,
          finishReason: part.finishReason,
          inputTokens: part.totalUsage.inputTokens,
          outputTokens: part.totalUsage.outputTokens,
          ...part.extras,
        };
    }
    throw new Error("Anthropic stream ended without a final message");
  }

  const msg = await cfg.client.messages.create(nativeTextParams(cfg, textArgs), {
    signal: args.signal,
  });

  // Adjacent text blocks are one run (citations split mid-sentence), so they
  // join bare. A non-text block between them (a web search) is a break (#16).
  let text = "";
  let afterText = true;
  for (const b of msg.content) {
    if (b.type !== "text") {
      afterText = false;
      continue;
    }
    if (!afterText && text) text += "\n";
    text += (b as { text: string }).text;
    afterText = true;
  }

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
