# Design: admin UI reference implementation

Status: proposed. Explicitly a REFERENCE app, not a hosted product; the
non-goals section of the roadmap still holds (no control plane).

## Problem

Every adopter re-answers the same three admin questions with SQL and env
edits: what are we spending (by app, route, user, model, day), which
prompts and model chains are live, and what did the judge think. The
stores already exist (UsageStore, PromptStore, ModelConfigStore,
TaskOverrideStore); only the screen is missing.

## Shape

A small Next.js app in `examples/admin/` (or a separate
`llm-gateway-admin` repo if it grows), which talks ONLY through the
existing store interfaces, and takes the same BYO-database posture as the
library: point it at your Drizzle store, get screens.

Four screens, nothing more in v1:

1. **Spend** — daily cost by app/route/model, cap events timeline,
   cache-hit ratio, web-search counts. Powered entirely by UsageStore
   queries that already exist (sumSpendCents + entries).
2. **Prompts** — list store prompts vs code defaults, edit a stored
   prompt (store-as-override is already the resolution rule), show the
   placeholder validation the loader enforces.
3. **Routing** — the chain per task, admin override toggle
   (ModelConfigStore.getOverride is already read on every call), per-link
   temperature display.
4. **Judge** — score distribution per slug, low scorers with their
   (decrypted, permission-gated) snapshots.

## Rules

1. The UI writes through the same interfaces apps use, so nothing the UI
   does is impossible for an app to do in code. No private endpoints.
2. Decrypting inputText/outputText requires the decrypt hook and an
   explicit env opt-in; the default build shows ciphertext presence, not
   content.
3. Auth is the host app's problem (it's a reference implementation);
   ship it locked to localhost by default with a warning banner
   otherwise.

## Sequencing

After the Show HN wave, not before: the announcement's caveats promise
OTel export (shipped) and position the library as governance-first. The
admin UI earns its slot once external adopters exist and ask the same
three questions the internal apps did, and their issues will say which
screens matter. PFA's spend dashboard need is the first real signal;
CareerPointers' llmSettings admin page is prior art to steal from.
