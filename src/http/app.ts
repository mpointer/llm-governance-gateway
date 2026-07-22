// Hono HTTP layer — mount the governed pipeline as a service so multiple
// apps (any language) share one enforcement point. Runs anywhere Hono does:
// Cloudflare Workers, Node (@hono/node-server), Bun, Deno.
// Import via subpath: "llm-governance-gateway/http" (hono is an optional
// peer dependency).
//
// Contract (ported from a production Worker):
//   POST /run          — governed structured generation (JSON Schema on wire)
//   GET  /health       — liveness
//   GET  /models       — live provider/model discovery (?all=1 for keyless too)
//   GET  /tasks        — task registry for admin UIs
//   POST /prompt-test  — admin prompt test run (admin token when configured)
// Errors: 401 unauthorized, 400 validation, 429 rate limit, 402 spend cap.

import { Hono } from "hono";
import { jsonSchema } from "ai";
import { z } from "zod";
import type { Gateway } from "../gateway.js";
import { RateLimitError, SpendCapError } from "../errors.js";
import { listAllProviderModels } from "../discovery.js";

export interface GatewayAppOptions {
  gateway: Gateway;
  /**
   * Bearer auth: a single token, or a map of token → appId for multi-app
   * deployments (the matched appId tags every usage row).
   */
  auth: string | Record<string, string>;
  /** When set, /prompt-test requires one of these tokens. */
  adminTokens?: string[];
  /** Service name reported by /health. */
  serviceName?: string;
}

const RunBody = z.object({
  slug: z.string().min(1),
  schema: z.record(z.string(), z.unknown()),
  // Server-side rendering: variables substituted into the stored prompt.
  variables: z.record(z.string(), z.string()).optional(),
  // Client-side rendering: send the full body instead (skips prompt store).
  promptBody: z.string().optional(),
  cacheParts: z.array(z.string()).optional(),
  cache: z.boolean().optional(),
  tier: z.enum(["fast", "power"]).optional(),
  task: z.string().optional(),
  userId: z.string().optional(),
  anonKey: z.string().optional(),
  route: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const PromptTestBody = z.object({
  slug: z.string().optional(),
  body: z.string().min(1),
  variables: z.record(z.string(), z.string()),
  model: z.string().optional(),
  task: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  userId: z.string().optional(),
});

type Vars = { appId: string; token: string };

export function createGatewayApp(opts: GatewayAppOptions): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  const tokenMap: Record<string, string> =
    typeof opts.auth === "string" ? { [opts.auth]: "default" } : opts.auth;

  app.use("*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
    const token = auth.slice(7);
    const appId = tokenMap[token];
    if (!appId) return c.json({ error: "Unauthorized" }, 401);
    c.set("appId", appId);
    c.set("token", token);
    await next();
  });

  app.get("/health", (c) =>
    c.json({ ok: true, service: opts.serviceName ?? "llm-governance-gateway" }),
  );

  app.post("/run", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = RunBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    try {
      const result = await opts.gateway.runStructured({
        slug: body.slug,
        schema: jsonSchema<unknown>(body.schema),
        input: null,
        variables: () => body.variables ?? {},
        ...(body.promptBody !== undefined ? { promptBody: body.promptBody } : {}),
        ...(body.cacheParts !== undefined ? { cacheParts: body.cacheParts } : {}),
        ...(body.cache !== undefined ? { cache: body.cache } : {}),
        ...(body.tier !== undefined ? { tier: body.tier } : {}),
        ...(body.task !== undefined ? { task: body.task } : {}),
        ...(body.userId !== undefined ? { userId: body.userId } : {}),
        ...(body.anonKey !== undefined ? { anonKey: body.anonKey } : {}),
        ...(body.route !== undefined ? { route: body.route } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        app: c.get("appId"),
      });
      return c.json({
        object: result.object,
        traceId: result.traceId,
        cacheHit: result.cacheHit,
        usageLogId: result.usageLogId,
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/models", async (c) => {
    const includeUnconfigured = c.req.query("all") === "1";
    const models = await listAllProviderModels(opts.gateway.registry, {
      includeUnconfigured,
    });
    return c.json({ providers: models });
  });

  app.get("/tasks", (c) => {
    const router = opts.gateway.tasks;
    if (!router) return c.json({ tasks: [] });
    return c.json({
      tasks: router.tasks().map((t) => ({ task: t, label: router.label(t) })),
    });
  });

  app.post("/prompt-test", async (c) => {
    if (opts.adminTokens && !opts.adminTokens.includes(c.get("token"))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = PromptTestBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await opts.gateway.runPromptTest(parsed.data);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorResponse(c: any, err: unknown) {
  if (err instanceof RateLimitError) {
    return c.json(
      { error: "Rate limit exceeded", limit: err.limit, remaining: err.remaining },
      429,
    );
  }
  if (err instanceof SpendCapError) {
    // "global" = the app-wide breaker tripped; tell the caller "busy",
    // not "you're over your limit".
    return c.json(
      {
        error:
          err.scope === "global"
            ? "Service is at capacity, try again later"
            : "Daily AI spend cap exceeded",
        scope: err.scope,
        capCents: err.capCents,
        spentCents: err.spentCents,
      },
      402,
    );
  }
  const message = err instanceof Error ? err.message : "Internal error";
  // Caller errors from the pipeline (missing cacheParts, unknown slug/task)
  // are 400s, not 500s.
  if (/cacheParts is required|not found|Unknown AI task|no responder/i.test(message)) {
    return c.json({ error: message }, 400);
  }
  console.error("[llm-gateway/http] /run failed:", message);
  return c.json({ error: "Generation failed" }, 500);
}
