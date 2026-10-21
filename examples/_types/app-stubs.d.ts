// Type stubs for the app-side modules the examples import. They stand in for
// YOUR app's modules so the examples typecheck in this repo's CI
// (`npm run typecheck:examples`). Copy an example into your app and these
// imports resolve to your real modules instead.

declare module "@/db" {
  import type { DrizzleSqliteUsageStore } from "llm-governance-gateway/drizzle-sqlite";
  /** Your drizzle database handle. */
  export const db: ConstructorParameters<typeof DrizzleSqliteUsageStore>[0];
}

declare module "@/auth" {
  /** Your auth helper (next-auth, Clerk, Lucia, ...). */
  export function auth(): Promise<{ user?: { id: string } } | null>;
}
