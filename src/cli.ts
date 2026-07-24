#!/usr/bin/env node
// llm-gateway CLI — provider key setup and health checks.
//
//   npx llm-gateway init     guided key entry → .env.local (chmod 600)
//   npx llm-gateway doctor   validate every configured key against the
//                            provider's live models API (default command)
//
// Deliberately NOT a secrets manager: keys live in your .env.local / shell /
// deploy platform. This is entry + validation UX only.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadEnvFiles, parseEnvFile } from "./envfile.js";
import { ProviderRegistry, PROVIDER_IDS } from "./providers.js";
import { listProviderModels } from "./discovery.js";
import type { ProviderId } from "./types.js";

const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  venice: "VENICE_API_KEY",
  together: "TOGETHER_API_KEY",
  huggingface: "HF_TOKEN",
};

const KEY_HINTS: Record<ProviderId, string> = {
  anthropic: "console.anthropic.com → API keys (sk-ant-...)",
  google: "aistudio.google.com/apikey",
  openai: "platform.openai.com/api-keys (sk-...)",
  openrouter: "openrouter.ai/keys (sk-or-...)",
  venice: "venice.ai/settings/api (optional)",
  together: "api.together.ai/settings/api-keys",
  huggingface: "huggingface.co/settings/tokens (hf_..., inference permission)",
};

function mask(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 6)}...${key.slice(-4)}`;
}

async function doctor(): Promise<number> {
  const loaded = loadEnvFiles();
  if (loaded.length > 0) console.log(`Loaded ${loaded.length} value(s) from env file(s).\n`);
  const registry = new ProviderRegistry({});
  let configured = 0;
  let broken = 0;

  for (const provider of PROVIDER_IDS) {
    const key = registry.apiKey(provider);
    if (!key) {
      console.log(`  ○ ${provider.padEnd(10)} no key (${ENV_KEYS[provider]})`);
      continue;
    }
    configured++;
    const res = await listProviderModels(registry, provider);
    if (res.source === "api") {
      console.log(
        `  ✓ ${provider.padEnd(10)} ${mask(key)} — key valid, ${res.models.length} models`,
      );
    } else {
      broken++;
      console.log(
        `  ✗ ${provider.padEnd(10)} ${mask(key)} — key present but models API failed${res.error ? `: ${res.error}` : ""}`,
      );
    }
  }

  console.log(
    `\n${configured} provider(s) configured, ${broken} failing.` +
      (configured === 0 ? " Run: npx llm-gateway init" : ""),
  );
  return broken > 0 ? 1 : 0;
}

async function init(): Promise<number> {
  console.log("Provider key setup — writes .env.local (never committed; .gitignore covers it).");
  console.log("Press Enter to skip a provider. Existing values are kept unless you re-enter them.\n");

  const existing: Record<string, string> = existsSync(".env.local")
    ? parseEnvFile(readFileSync(".env.local", "utf8"))
    : {};

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const values: Record<string, string> = { ...existing };

  for (const provider of PROVIDER_IDS) {
    const envKey = ENV_KEYS[provider];
    const current = existing[envKey];
    const label = current ? ` [current: ${mask(current)}]` : "";
    const answer = (
      await rl.question(`${provider} — ${KEY_HINTS[provider]}${label}\n  ${envKey}= `)
    ).trim();
    if (answer) values[envKey] = answer;
  }
  rl.close();

  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  writeFileSync(".env.local", lines.join("\n") + "\n", "utf8");
  try {
    chmodSync(".env.local", 0o600);
  } catch {
    // Windows: chmod is a no-op; NTFS ACLs apply instead.
  }
  console.log(`\nWrote .env.local (${lines.length} entr${lines.length === 1 ? "y" : "ies"}, mode 600). Validating...\n`);
  return doctor();
}

const cmd = process.argv[2] ?? "doctor";
let code: number;
if (cmd === "init") code = await init();
else if (cmd === "doctor") code = await doctor();
else {
  console.error(`Unknown command "${cmd}". Usage: llm-gateway [init|doctor]`);
  code = 2;
}
process.exit(code);
