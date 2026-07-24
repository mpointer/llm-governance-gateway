// Live smoke test — hits real provider APIs with your keys. Run locally:
//   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npm run smoke
//
// For every provider with a key configured:
//   1. model discovery via the vendor's models API
//   2. one tiny governed runStructured() call (caps disabled, cache off)
// Providers without keys are skipped. Exits 1 if any keyed provider fails.
//
// Override the generation model per provider if a default has aged out:
//   SMOKE_MODEL_OPENROUTER="openai/gpt-4o-mini" npm run smoke

import { z } from "zod";
import {
  Gateway,
  MemoryUsageStore,
  ProviderRegistry,
  listProviderModels,
  loadEnvFiles,
} from "../dist/index.js";

loadEnvFiles(); // .env.local / .env in cwd; shell env wins

const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  google: "gemini-2.0-flash",
  openai: "gpt-4.1-mini",
  openrouter: "openai/gpt-4o-mini",
  venice: "mistral-31-24b",
  together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  huggingface: "meta-llama/Llama-3.3-70B-Instruct",
};

const registry = new ProviderRegistry({});
const configured = registry.configuredProviders();

if (configured.length === 0) {
  console.error("No provider API keys found in env. Nothing to smoke-test.");
  process.exit(1);
}

console.log(`Keyed providers: ${configured.join(", ")}\n`);
let failures = 0;

for (const provider of configured) {
  const model =
    process.env[`SMOKE_MODEL_${provider.toUpperCase()}`] ?? DEFAULT_MODELS[provider];

  // Gateway first so discovery syncs vendor pricing (OpenRouter) into the
  // SAME registry the generation step uses for cost estimation.
  const gw = new Gateway({
    usage: new MemoryUsageStore(),
    promptDefaults: [
      { slug: "smoke", body: "Reply with the single word: {{word}}", variables: ["word"] },
    ],
    modelConfig: {
      getOverride: async () => null,
      getChain: async () => [{ provider, model }],
    },
    caps: { userDailyCents: 0, anonDailyCents: 0, globalDailyCents: 0 },
  });

  // 1. Discovery (+ pricing sync)
  try {
    const d = await listProviderModels(gw.registry, provider);
    const note = d.error ? ` (error: ${d.error})` : "";
    const priced = provider === "openrouter" && gw.registry.hasPricing(model) ? ", pricing synced" : "";
    console.log(`[${provider}] discovery: ${d.models.length} models, source=${d.source}${note}${priced}`);
    if (d.source !== "api") failures++;
  } catch (e) {
    console.error(`[${provider}] discovery FAILED: ${e.message}`);
    failures++;
  }

  // 2. Governed generation
  try {
    const t0 = Date.now();
    const res = await gw.runStructured({
      slug: "smoke",
      schema: z.object({ word: z.string() }),
      input: { word: "pong" },
      variables: (i) => ({ word: i.word }),
      cache: false,
      anonKey: "smoke",
    });
    console.log(
      `[${provider}] generate ok via ${model}: ${JSON.stringify(res.object)} (${Date.now() - t0}ms, trace ${res.traceId.slice(0, 8)})\n`,
    );
  } catch (e) {
    console.error(`[${provider}] generate FAILED via ${model}: ${e.message}\n`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`Smoke test finished with ${failures} failure(s).`);
  process.exit(1);
}
console.log("All keyed providers passed.");
