// Minimal .env file support — no dotenv dependency. Loads KEY=VALUE lines,
// ignores comments/blanks, strips surrounding quotes. Existing process.env
// values always win (shell > file), matching dotenv semantics.

import { existsSync, readFileSync } from "node:fs";

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load .env.local then .env from cwd (first file wins per key; shell env wins
 * over both). Returns the keys that were newly applied.
 */
export function loadEnvFiles(files: string[] = [".env.local", ".env"]): string[] {
  const applied: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        applied.push(k);
      }
    }
  }
  return applied;
}
