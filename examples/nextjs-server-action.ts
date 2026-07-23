// Next.js App Router server action with per-user governance.
// app/actions/summarize.ts
"use server";

import { z } from "zod";
import { Gateway } from "llm-governance-gateway";
import { DrizzleSqliteUsageStore } from "llm-governance-gateway/drizzle-sqlite";
import { db } from "@/db"; // your drizzle instance (re-export the store's tables in your schema)
import { auth } from "@/auth"; // your auth helper

// Module-scope singleton is fine here: the Gateway holds no request state.
// (On Vercel, avoid instantiating DB clients at module load — pass a lazy db.)
const gateway = new Gateway({
  usage: new DrizzleSqliteUsageStore(db),
  promptDefaults: [
    {
      slug: "summarize-note",
      body: "Summarize this note in two sentences:\n\n{{note}}",
      variables: ["note"],
    },
  ],
  caps: { userDailyCents: 200, globalDailyCents: 5000 },
  tasks: { defaults: { summarize: "claude-haiku-4-5-20251001" } },
});

const Summary = z.object({ summary: z.string(), tags: z.array(z.string()).max(5) });

export async function summarizeNote(note: string) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const { object } = await gateway.runStructured({
    slug: "summarize-note",
    schema: Summary,
    input: { note },
    variables: (i) => ({ note: i.note }),
    cache: false, // user-authored text = PII; skip cache read AND write
    task: "summarize",
    userId: session.user.id,
    route: "actions/summarize",
  });
  return object;
}
