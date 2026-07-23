// Smallest governed call. Run: ANTHROPIC_API_KEY=... node examples/node-basic.mjs
import { z } from "zod";
import { Gateway, MemoryUsageStore, loadEnvFiles } from "llm-governance-gateway";

loadEnvFiles(); // picks up .env.local / .env

const gw = new Gateway({
  usage: new MemoryUsageStore(),
  promptDefaults: [
    {
      slug: "haiku",
      body: "Write a haiku about {{topic}}. Return JSON.",
      variables: ["topic"],
    },
  ],
  caps: { anonDailyCents: 50, globalDailyCents: 500 },
});

const { object, traceId, cacheHit } = await gw.runStructured({
  slug: "haiku",
  schema: z.object({ haiku: z.string() }),
  input: { topic: "rate limits" },
  variables: (i) => ({ topic: i.topic }),
  cacheParts: ["rate limits"],
  anonKey: "example",
});

console.log(object.haiku);
console.log({ traceId, cacheHit });
