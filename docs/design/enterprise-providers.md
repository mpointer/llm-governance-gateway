# Design: Enterprise Providers (Bedrock, Azure, Vertex, watsonx)

Status: DRAFT — issue #2. Decision requested on the core approach below.

## The problem

The four enterprise clouds don't fit the `apiKey`-from-env model that every
current provider uses:

| Provider | Auth | Addressing quirk |
|---|---|---|
| AWS Bedrock | SigV4 (access key/secret/session, profiles, IMDS roles) | region-scoped model ids (`us.anthropic.claude...`) |
| Azure OpenAI / AI Foundry | api-key header OR Entra ID tokens | **deployment names**, not model ids; per-resource endpoint + api-version |
| Google Vertex AI | ADC / service-account JSON / workload identity | project + location; distinct from AI Studio (`google`) |
| IBM watsonx.ai | IAM apikey → bearer token exchange (expiring) | region base URL + project/space id |

Wiring these as first-class `ProviderId`s means four more `@ai-sdk/*`
dependencies, async credential flows inside the (currently synchronous)
model-build path, and a config surface we'd forever chase across four clouds.

## Decision: provider factories, not first-class ProviderIds

Extend the pattern that already works three times in this codebase
(`RedisLike`, BYO Anthropic client, BYO `languageModel` chain links):

```ts
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"; // user's dep, not ours
import { createAzure } from "@ai-sdk/azure";

const bedrock = createAmazonBedrock({ region: "us-east-1" }); // SigV4 via AWS SDK chain
const azure = createAzure({ resourceName: "my-res", apiKey: env.AZURE_KEY });

const gw = new Gateway({
  usage,
  providers: {
    factories: {
      bedrock: { model: (id) => bedrock(id) },
      azure: {
        model: (alias) => azure(DEPLOYMENTS[alias]), // alias → deployment mapping is user code
        listModels: async () => Object.keys(DEPLOYMENTS), // optional: doctor/discovery hook
      },
    },
    pricing: { "anthropic.claude-sonnet-4-6-v1:0": { in: 0.3, out: 1.5 } }, // region-priced: user-supplied
    retention: { bedrock: { zdr: true, note: "in-region, no retention per AWS terms" } },
  },
});

// Everywhere model ids go: "bedrock:anthropic.claude-sonnet-4-6-v1:0", "azure:gpt4-prod"
// tasks: { defaults: { extract: "bedrock:..." } }
// chains: [{ factory: "bedrock", model: "..." }, { provider: "anthropic", model: "..." }]
```

Factory names join the same namespace machinery endpoints already use:
`parseAny` resolves them, chains/tasks route to them, ZDR asserts over them,
`estimateForLink` prices them (user-supplied pricing; **no silent $0** — unlike
local endpoints these cost real money, so unknown pricing warns and uses the
conservative fallback).

### Why this wins

1. **Supply-chain posture is preserved** — zero new dependencies; the user
   imports exactly the cloud SDK they already have. This is a selling point,
   not a cop-out.
2. **Credential complexity stays where it belongs.** SigV4 profiles, Entra
   token refresh, ADC — each cloud's own SDK already solves its own auth.
   We'd re-solve it badly.
3. **Sync build path unchanged.** Factories return constructed models;
   credential acquisition happens inside the user's factory/SDK, which is
   built for it.
4. **Four recipes instead of four integrations.** The deliverable becomes
   documentation + examples + tests over a small generic mechanism (S-M),
   instead of four bespoke integrations (L each, forever maintained).

### What we give up (stated honestly)

- No zero-config `AZURE_API_KEY`-style onboarding; each cloud costs the user
  ~3-5 lines of factory code. Acceptable: anyone running Bedrock/Vertex has
  already made peace with cloud SDK setup.
- No automatic pricing/tier tables (region-dependent anyway) — user supplies
  `pricing` entries; `doctor` flags factory models generating at fallback
  pricing so the gap is visible.
- Discovery is opt-in via `listModels` — there is no uniform "list models"
  across these clouds worth faking.

## Scope

**Phase 1 (implementation issue, S-M):**
- `ProviderConfig.factories: Record<string, { model(id): LanguageModel; listModels?(): Promise<string[]> }>`
- `parseAny`/`buildAny`/chain `factory:` field/task routing integration
  (mirrors the endpoint registry — much of the machinery exists)
- `estimateForLink`: factories use normal pricing lookup WITH the fallback
  warning (real money, never silent $0)
- ZDR: factories are NOT ZDR by default (cloud ≠ self-hosted); assert via
  `retention`
- `doctor`: reports configured factories; runs `listModels` when provided
- Tests: fake factories; README recipes for all four clouds (copy-paste-able)

**Phase 2 (only if demanded):** sugar subpath exports (`./bedrock` etc.)
wrapping the recipes with the SDK as optional peer.

**Out of scope, recorded:**
- Native Anthropic features (thinking/cache_control) through Bedrock-hosted
  Claude — the native path is direct-API only; Bedrock's parameter passthrough
  differs and needs its own investigation.
- Bedrock/Vertex batch APIs — the batch design is Anthropic Message Batches;
  cloud batch is a separate design if ever.
- Endpoints vs factories: endpoints stay for OpenAI-compatible URLs (simpler
  config, $0 pricing); factories are for everything else. Endpoints could be
  reimplemented atop factories someday; not worth the churn now.

## Open questions

1. Chain config field name: `factory: "bedrock"` (parallel to `endpoint:`) vs
   overloading `provider:` with factory names. Leaning `factory:` — explicit
   beats clever, and the union type stays honest.
2. Should `watsonx`'s IAM token refresh get a documented helper (tokens expire
   hourly; naive factories will 401 mid-day)? Leaning yes: a 20-line
   `refreshingTokenFactory()` utility in the recipe, not in the library.
