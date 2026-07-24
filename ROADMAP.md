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

- [x] **Judge-in-the-request-path with budget-aware sampling** — shipped: sampled model-graded scoring, cap-aware self-skip, observe/gate modes, audit-first gating
- [x] Native Anthropic path — shipped: BYO @anthropic-ai/sdk client, adaptive/budgeted thinking, cache_control, server-side web search, cache-token cost accounting, cross-path failover
- [ ] **Governed batch processing** — Anthropic Message Batches (50% cost) with two-phase spend accounting (reserve at submit, reconcile per item), DB-tracked jobs, streamed JSONL results, idempotent crash recovery. Design: [docs/design/batch-processing.md](./docs/design/batch-processing.md). Ships with/after the native Anthropic path (needs the native SDK).
- [x] Cache-aware cost model — shipped with the native path (cacheWrite/cacheRead rates, web-search per-call pricing)
- [ ] Streaming (`streamObject`/`streamText`) inside the same governance pipeline

## v0.4+

- [ ] OTel / Langfuse export hooks (integrate with observability, don't compete with it)
- [ ] Provider expansion — Together.ai + Hugging Face (#1), Bedrock/Azure/Vertex/watsonx (#2), local serving via custom OpenAI-compatible endpoints: Ollama, vLLM, LM Studio (#3)
- [ ] ZDR-aware routing — zero-data-retention metadata + task-level `requireZdr` constraints (#4); candidate fourth headline differentiator
- [x] OpenRouter pricing auto-sync — shipped: discovery registers vendor pricing into the registry
- [ ] Pluggable guardrail hooks (pre/post) — TypeScript-native, no Python sidecar
- [ ] Admin UI reference (prompt library, task routing, spend dashboards)

## Non-goals

- Observability breadth (traces, dashboards, analytics) — export to Langfuse/OTel instead.
- Being a universal proxy for 100+ providers — LiteLLM exists; this is a governance library first.
- Hosted control plane — self-host is the point. (A managed offering may come later; the library stays complete without it.)
