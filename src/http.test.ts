// HTTP layer tests via app.request() — no server, no network.

import { beforeEach, describe, expect, it } from "vitest";
import { Gateway } from "./gateway.js";
import { createGatewayApp } from "./http/app.js";
import { MemoryRateLimiter, MemoryUsageStore } from "./adapters/memory.js";

const SCHEMA = { type: "object", properties: { answer: { type: "string" } } };

function make(over: { caps?: object; rateMax?: number } = {}) {
  const usage = new MemoryUsageStore();
  const gw = new Gateway({
    usage,
    rateLimiter: new MemoryRateLimiter(over.rateMax ?? 100),
    promptDefaults: [{ slug: "greet", body: "Hello {{name}}.", variables: ["name"] }],
    tasks: { defaults: { enrich: "claude-haiku-4-5" } },
    mock: true,
    caps: over.caps,
  });
  gw.registerMockResponder("greet", () => ({ answer: "hi" }));
  const app = createGatewayApp({
    gateway: gw,
    auth: { "token-a": "app-a", "token-b": "app-b" },
    adminTokens: ["token-a"],
  });
  return { app, usage, gw };
}

function post(app: ReturnType<typeof make>["app"], path: string, body: unknown, token = "token-a") {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const runBody = {
  slug: "greet",
  schema: SCHEMA,
  variables: { name: "Mike" },
  cacheParts: ["Mike"],
  userId: "u1",
};

describe("gateway HTTP app", () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => {
    ctx = make();
  });

  it("rejects missing/wrong bearer tokens", async () => {
    expect((await ctx.app.request("/health")).status).toBe(401);
    const bad = await ctx.app.request("/health", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
  });

  it("health responds when authed", async () => {
    const res = await ctx.app.request("/health", {
      headers: { Authorization: "Bearer token-a" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("POST /run generates and tags usage with the token's appId", async () => {
    const res = await post(ctx.app, "/run", runBody, "token-b");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: { answer: string }; cacheHit: boolean };
    expect(json.object).toEqual({ answer: "hi" });
    expect(json.cacheHit).toBe(false);
    expect(ctx.usage.entries[0]!.app).toBe("app-b");
  });

  it("second identical call is a cache hit", async () => {
    await post(ctx.app, "/run", runBody);
    const res = await post(ctx.app, "/run", runBody);
    expect(((await res.json()) as { cacheHit: boolean }).cacheHit).toBe(true);
  });

  it("promptBody skips the prompt store", async () => {
    ctx.gw.registerMockResponder("inline", () => ({ answer: "inline" }));
    const res = await post(ctx.app, "/run", {
      slug: "inline",
      schema: SCHEMA,
      promptBody: "Say {{word}}.",
      variables: { word: "hi" },
      cache: false,
    });
    expect(res.status).toBe(200);
    expect(ctx.usage.entries[0]!.promptSlug).toBe("inline");
  });

  it("400 on validation errors and pipeline caller errors", async () => {
    expect((await post(ctx.app, "/run", { schema: SCHEMA })).status).toBe(400); // no slug
    const noCacheParts = await post(ctx.app, "/run", {
      slug: "greet",
      schema: SCHEMA,
      variables: { name: "x" },
    });
    expect(noCacheParts.status).toBe(400); // cacheParts required
    const unknownSlug = await post(ctx.app, "/run", {
      slug: "nope",
      schema: SCHEMA,
      cache: false,
    });
    expect(unknownSlug.status).toBe(400);
  });

  it("429 when rate limited", async () => {
    const limited = make({ rateMax: 1 });
    await post(limited.app, "/run", runBody);
    const res = await post(limited.app, "/run", { ...runBody, cacheParts: ["other"] });
    expect(res.status).toBe(429);
  });

  it("402 with global scope masks the spend detail appropriately", async () => {
    const capped = make({ caps: { globalDailyCents: 1 } });
    await capped.usage.logUsage({
      userId: "someone",
      provider: "x",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostCents: 10,
      cacheHit: false,
      traceId: "t",
      createdAt: new Date(),
    });
    const res = await post(capped.app, "/run", runBody);
    expect(res.status).toBe(402);
    const json = (await res.json()) as { scope: string; error: string };
    expect(json.scope).toBe("global");
    expect(json.error).toMatch(/capacity/i);
  });

  it("GET /tasks lists the registry", async () => {
    const res = await ctx.app.request("/tasks", {
      headers: { Authorization: "Bearer token-a" },
    });
    expect((await res.json()) as object).toEqual({
      tasks: [{ task: "enrich", label: "enrich" }],
    });
  });

  it("POST /prompt-test is admin-gated and returns a result", async () => {
    const forbidden = await post(
      ctx.app,
      "/prompt-test",
      { body: "Hi {{n}}.", variables: { n: "x" } },
      "token-b",
    );
    expect(forbidden.status).toBe(403);
    const ok = await post(ctx.app, "/prompt-test", {
      body: "Hi {{n}}.",
      variables: { n: "x" },
      userId: "admin",
    });
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { prompt: string; provider: string };
    expect(json.prompt).toBe("Hi x.");
    expect(json.provider).toBe("mock");
  });
});
