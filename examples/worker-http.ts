// Cloudflare Worker: one governed gateway, many client apps.
// wrangler secrets: ANTHROPIC_API_KEY, APP_WEB_TOKEN, APP_MOBILE_TOKEN, ADMIN_TOKEN
// D1/Turso/Hyperdrive: wire your UsageStore of choice; memory shown for brevity
// (memory resets per isolate — fine for demos, NOT for real enforcement).

import { Gateway, MemoryUsageStore } from "llm-governance-gateway";
import { createGatewayApp } from "llm-governance-gateway/http";

interface Env {
  ANTHROPIC_API_KEY: string;
  APP_WEB_TOKEN: string;
  APP_MOBILE_TOKEN: string;
  ADMIN_TOKEN: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const gateway = new Gateway({
      usage: new MemoryUsageStore(), // replace with DrizzleSqliteUsageStore(turso)
      providers: { apiKeys: { anthropic: env.ANTHROPIC_API_KEY } },
      promptDefaults: [
        { slug: "classify", body: "Classify: {{text}}", variables: ["text"] },
      ],
      caps: { userDailyCents: 100, globalDailyCents: 2000 },
    });

    const app = createGatewayApp({
      gateway,
      auth: {
        [env.APP_WEB_TOKEN]: "web",
        [env.APP_MOBILE_TOKEN]: "mobile",
        [env.ADMIN_TOKEN]: "admin",
      },
      adminTokens: [env.ADMIN_TOKEN],
    });
    return app.fetch(req, env);
  },
};

// Client (any language):
//   POST https://gateway.example.com/run
//   Authorization: Bearer <APP_WEB_TOKEN>
//   { "slug": "classify", "schema": { ...JSON Schema... },
//     "variables": { "text": "..." }, "cacheParts": ["..."], "userId": "u1" }
