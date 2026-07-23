# Examples

- **[node-basic.mjs](./node-basic.mjs)** — smallest possible governed call: memory adapters, one prompt, spend caps on. Run with `ANTHROPIC_API_KEY=... node examples/node-basic.mjs`.
- **[nextjs-server-action.ts](./nextjs-server-action.ts)** — Next.js App Router server action with per-user caps, Drizzle usage store, and cache-off for PII.
- **[worker-http.ts](./worker-http.ts)** — the HTTP gateway on Cloudflare Workers: one deployment, many apps, per-app usage attribution.

These files are illustrative and not compiled by CI — copy them into your app and adjust imports/env.
