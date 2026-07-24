# Enterprise provider recipes (Bedrock, Azure, Vertex, watsonx)

Design rationale: [docs/design/enterprise-providers.md](../docs/design/enterprise-providers.md).
You install the cloud SDK; the gateway takes a factory. Zero new dependencies here.

Common to all four: model ids are `"<factory>:<model-or-alias>"`, pricing is
yours to supply (region-dependent — unknown models warn and use the
conservative fallback, never silent $0), and factories are **NOT ZDR** until
you assert your contract terms in `retention`.

## AWS Bedrock

```ts
// npm i @ai-sdk/amazon-bedrock   (credentials via the standard AWS chain:
// env, profile, SSO, IMDS role — the AWS SDK handles all of it)
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";

const bedrock = createAmazonBedrock({ region: "us-east-1" });

const gw = new Gateway({
  usage,
  providers: {
    factories: { bedrock: { model: (id) => bedrock(id) } },
    pricing: { "anthropic.claude-sonnet-4-6-v1:0": { in: 0.3, out: 1.5 } }, // us-east-1 rates
    retention: { bedrock: { zdr: true, note: "AWS: prompts not stored/used for training, in-region" } },
  },
});
// "bedrock:anthropic.claude-sonnet-4-6-v1:0" in tasks/chains
```

## Azure OpenAI / AI Foundry

```ts
// npm i @ai-sdk/azure — Azure routes by DEPLOYMENT name, not model id.
// Keep the alias→deployment map in your code; route by alias everywhere else.
import { createAzure } from "@ai-sdk/azure";

const azure = createAzure({
  resourceName: "my-resource",           // or baseURL for AI Foundry
  apiKey: process.env.AZURE_OPENAI_KEY,  // or Entra ID via azure-identity
});
const DEPLOYMENTS: Record<string, string> = { gpt4: "gpt-4o-prod-eastus2" };

factories: {
  azure: {
    model: (alias) => azure(DEPLOYMENTS[alias] ?? alias),
    listModels: async () => Object.keys(DEPLOYMENTS), // doctor/admin hook
  },
}
// "azure:gpt4"
```

## Google Vertex AI (Model Garden)

```ts
// npm i @ai-sdk/google-vertex — auth via ADC (gcloud auth application-default
// login locally, workload identity in prod). Distinct from the built-in
// "google" provider, which is the AI Studio consumer API.
import { createVertex } from "@ai-sdk/google-vertex";

const vertex = createVertex({ project: "my-project", location: "us-central1" });

factories: { vertex: { model: (id) => vertex(id) } }
// "vertex:gemini-2.5-pro"
```

## IBM watsonx.ai

IBM IAM tokens expire after ~1 hour — a naive factory 401s mid-day. This
refresh helper exchanges the API key when less than 5 minutes remain:

```ts
// Works with any watsonx client/community provider that accepts a
// headers/fetch override. Exchange endpoint: iam.cloud.ibm.com.
function iamTokenProvider(apikey: string) {
  let token = "";
  let expiresAt = 0;
  return async (): Promise<string> => {
    if (Date.now() < expiresAt - 5 * 60_000) return token;
    const res = await fetch("https://iam.cloud.ibm.com/identity/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ibm:params:oauth:grant-type:apikey",
        apikey,
      }),
    });
    if (!res.ok) throw new Error(`IAM token exchange failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = j.access_token;
    expiresAt = Date.now() + j.expires_in * 1000;
    return token;
  };
}

const getToken = iamTokenProvider(process.env.WATSONX_APIKEY!);

// Example with an OpenAI-compatible watsonx gateway/proxy, or a community
// provider that accepts a custom fetch:
import { createOpenAI } from "@ai-sdk/openai";
const watsonxFetch: typeof fetch = async (url, init) => {
  const t = await getToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${t}`);
  return fetch(url, { ...init, headers });
};

factories: {
  watsonx: {
    model: (id) =>
      createOpenAI({
        apiKey: "unused-iam-bearer",
        baseURL: `https://us-south.ml.cloud.ibm.com/ml/v1/openai/v1`, // adjust region/path to your deployment
        fetch: watsonxFetch,
      }).chat(id),
  },
}
// "watsonx:granite-13b-chat" — verify the exact OpenAI-compat path for your
// watsonx.ai instance/version; some deployments require project_id as a
// query parameter or header.
```
