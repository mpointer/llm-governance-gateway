# Roadmap

Positioning: **the governance layer LLM proxies promised, as a TypeScript library you can read.** In-process — no sidecar proxy to deploy, no new attack surface, minimal dependency tree. Type-safe from Zod schema to failover chain to spend cap.

Three things no popular tool combines today, all shipped here:

1. **Spend caps that actually block** — per-user daily caps plus a global circuit breaker, enforced in-process against your own database (not observed after the fact, not gated behind a hosted control plane).
2. **Schema-validated failover** — provider chains for `generateObject`, an [open](https://github.com/vercel/ai/issues/9950) [pain point](https://github.com/vercel/ai/issues/9002) in the AI SDK.
3. **Deterministic CI for the whole pipeline** — mock the provider, keep the governance: caps, cache, failover, and judge all run in tests with zero keys.

## v0.2 (announcement-ready)

- [x] CI (typecheck + tests on PR), npm publish workflow with provenance
- [x] Live smoke script (validated on anthropic, openai, openrouter)
- [x] Schema-validation-aware failover: shipped in 0.1.0 (repair retry + chain fall-through)
- [x] `examples/` — Node, Next.js server action, Worker HTTP
- [x] README positioning rewrite around governance + supply-chain posture

## v0.3

- [ ] **Judge-in-the-request-path with budget-aware sampling** — inline rubric/model-graded scoring that can flag or gate responses, sampled (e.g. 5% of calls) so eval spend stays bounded. Existing eval platforms score offline/async only.
- [ ] Native Anthropic path (opt-in): adaptive extended thinking, prompt-caching `cache_control`, server-side web search — AI SDK path remains the default
- [ ] Cache-aware cost model (cache-write/cache-read token rates)
- [ ] Streaming (`streamObject`/`streamText`) inside the same governance pipeline

## v0.4+

- [ ] OTel / Langfuse export hooks (integrate with observability, don't compete with it)
- [ ] Provider expansion: Azure OpenAI, Bedrock, Ollama, watsonx
- [ ] OpenRouter pricing auto-sync (their models API returns prices — kill pricing-table drift)
- [ ] Pluggable guardrail hooks (pre/post) — TypeScript-native, no Python sidecar
- [ ] Admin UI reference (prompt library, task routing, spend dashboards)

## Non-goals

- Observability breadth (traces, dashboards, analytics) — export to Langfuse/OTel instead.
- Being a universal proxy for 100+ providers — LiteLLM exists; this is a governance library first.
- Hosted control plane — self-host is the point. (A managed offering may come later; the library stays complete without it.)
