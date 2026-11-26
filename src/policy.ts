// The policy report: what a gateway is configured to enforce, as plain data
// and as markdown. `gateway.describePolicy()` builds it; `llm-gateway policy`
// prints it. It answers the questions a security or compliance reviewer asks
// first: what are the spend limits, which calls are guarded, where does the
// data go, and which model serves which task.
//
// It is a read of configuration, plus the two stores that decide routing
// (task overrides and the chain). It makes no provider call. It prints no
// API key and no endpoint URL: names only, so the output can be handed to a
// customer or committed to a repository.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export interface PolicyModel {
  /** Built-in provider id, custom endpoint name, or factory name. */
  provider: string;
  model: string;
  kind: "provider" | "endpoint" | "factory";
  /** ZDR-asserted in `providers.retention` (custom endpoints default to true). */
  zdr: boolean;
  /** Has a rate in the pricing table. Custom endpoints are free and read true. */
  priced: boolean;
  /** The `asOf` date of its rate, when it has one. */
  pricingAsOf?: string;
  /** `pricingAsOf` is older than the staleness window at report time. */
  pricingStale?: boolean;
}

export interface PolicyTask {
  task: string;
  label: string;
  requireZdr: boolean;
  /** Where the chain came from: code defaults, or the override store. */
  source: "default" | "override";
  /** In failover order. */
  chain: PolicyModel[];
}

export interface PolicyTool {
  tool: string;
  /** Cents per call; "by arguments" when the price is a function. */
  costCents: number | "by arguments";
  maxCalls?: number;
  maxCents?: number;
}

export interface PolicyReport {
  app: string | null;
  /** The org the report was resolved for, when one was given or configured. */
  org: string | null;
  mock: boolean;
  spendCaps: {
    mode: "enforce" | "observe";
    /** Cents per UTC day. 0 means that cap is off. */
    userDailyCents: number;
    anonDailyCents: number;
    globalDailyCents: number;
    /** Undefined when no org cap is configured. */
    orgDailyCents?: number;
    /** The usage store can override the per-user or per-org cap at call time. */
    storeOverrides: { user: boolean; org: boolean };
  };
  guardrails: { pre: boolean; post: boolean; tool: boolean; failOpen: boolean };
  /** Gateway-level judge defaults. A judge runs only where a call asks for one. */
  judge: { model?: string; sampleRate?: number };
  ledger: {
    store: string;
    /** Prompt and output snapshots pass through an encrypt hook before storage. */
    snapshotsEncrypted: boolean;
    snapshotLimitChars: number;
  };
  cache: { store: string; ttlSeconds: number; invalidatedOnPromptChange: boolean };
  rateLimiter: string;
  timeouts: {
    attemptMs: number;
    /** Undefined: a call has no whole-operation bound. */
    deadlineMs?: number;
    streamFirstChunkMs: number;
    streamStallMs: number;
  };
  routing: {
    /** The chain a call with no task uses, in failover order. */
    defaultChain: PolicyModel[];
    /**
     * Where that chain came from. "config" and "environment" are
     * `ProviderConfig.defaultProvider`/`defaultModel` and
     * `AI_DEFAULT_PROVIDER`/`AI_DEFAULT_MODEL`.
     */
    defaultChainSource: "model config store" | "config" | "environment" | "library fallback";
    /** A ModelConfigStore is configured: an admin pin can replace any chain at call time. */
    adminPin: boolean;
    /** A task override store is configured. */
    taskOverrideStore: boolean;
    overridesBeatPin: boolean;
  };
  tasks: PolicyTask[];
  /** Undefined when tool governance is off (no `toolPolicy`, no tool hook). */
  tools?: PolicyTool[];
  /** `providers.retention`, as asserted by the deployer. */
  retention: { key: string; zdr: boolean; note?: string }[];
  providers: {
    /** Built-in providers with an API key present. Names only. */
    withKeys: string[];
    /** Custom endpoint names. URLs are not reported. */
    endpoints: string[];
    factories: string[];
    nativeAnthropic: boolean;
    batch: boolean;
  };
  pricingStaleAfterDays: number;
  observability: string[];
  /** Things a reviewer should look at. Statements of fact, not advice. */
  findings: string[];
}

const cents = (c: number) => (c === 0 ? "off" : `$${(c / 100).toFixed(2)}`);
const yesNo = (b: boolean) => (b ? "yes" : "no");

function modelCell(m: PolicyModel): string {
  const notes = [m.zdr ? "ZDR" : "not ZDR"];
  if (m.kind === "endpoint") notes.push("self-hosted, no charge");
  else if (!m.priced) notes.push("no pricing");
  else if (m.pricingAsOf) notes.push(`priced ${m.pricingAsOf}${m.pricingStale ? ", stale" : ""}`);
  else notes.push("priced, undated");
  return `\`${m.provider}:${m.model}\` (${notes.join("; ")})`;
}

/** The report as markdown. The same report always renders the same text. */
export function renderPolicyMarkdown(r: PolicyReport): string {
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const table = (head: string[], rows: string[][]) => {
    line(`| ${head.join(" | ")} |`);
    line(`| ${head.map(() => "---").join(" | ")} |`);
    for (const row of rows) line(`| ${row.join(" | ")} |`);
    line();
  };

  line(`# LLM gateway policy${r.app ? `: ${r.app}` : ""}`);
  line();
  line(
    "Generated by `llm-gateway policy` from the gateway's configuration. It reports what " +
      "is configured, not what has happened: the usage ledger is the record of that.",
  );
  line();
  if (r.org) {
    line(`Resolved for org \`${r.org}\`.`);
    line();
  }

  line("## Findings");
  line();
  if (r.findings.length === 0) line("None.");
  else for (const f of r.findings) line(`- ${f}`);
  line();

  line("## Spend limits");
  line();
  const caps = r.spendCaps;
  table(
    ["Limit", "Per UTC day", "Set at call time by the usage store"],
    [
      ["Each signed-in user", cents(caps.userDailyCents), yesNo(caps.storeOverrides.user)],
      ["Each anonymous caller", cents(caps.anonDailyCents), "no"],
      [
        "Each org",
        caps.orgDailyCents === undefined ? "not set" : cents(caps.orgDailyCents),
        yesNo(caps.storeOverrides.org),
      ],
      ["All calls together (circuit breaker)", cents(caps.globalDailyCents), "no"],
    ],
  );
  line(
    caps.mode === "enforce"
      ? "Mode: **enforce**. A call that would breach a limit is refused before the model is called."
      : "Mode: **observe**. A breach is recorded and the call goes ahead.",
  );
  line();

  line("## Guardrails");
  line();
  table(
    ["Hook", "Configured"],
    [
      ["Before the model sees the prompt (`pre`)", yesNo(r.guardrails.pre)],
      ["On the model's output (`post`)", yesNo(r.guardrails.post)],
      ["Before each tool call (`tool`)", yesNo(r.guardrails.tool)],
    ],
  );
  line(
    r.guardrails.failOpen
      ? "A hook that throws **lets the call through** (`failOpen`), and the ledger row records it."
      : "A hook that throws blocks the call (fail closed).",
  );
  line();

  line("## Models by task");
  line();
  line(
    "Each chain is in failover order. ZDR is the deployer's assertion in " +
      "`providers.retention`; an unlisted model counts as not ZDR.",
  );
  line();
  const chainCell = (chain: PolicyModel[]) => chain.map(modelCell).join("<br>");
  table(
    ["Task", "Requires ZDR", "Chain", "From"],
    [
      [
        "*(a call with no task)*",
        "per call",
        chainCell(r.routing.defaultChain),
        r.routing.defaultChainSource,
      ],
      ...r.tasks.map((t) => [
        t.label === t.task ? `\`${t.task}\`` : `\`${t.task}\` (${t.label})`,
        yesNo(t.requireZdr),
        chainCell(t.chain),
        t.source === "override" ? "override store" : "code default",
      ]),
    ],
  );
  const routingNotes: string[] = [
    "A call that passes `tier` swaps a built-in provider's model in the no-task chain for " +
      "that provider's fast or power model.",
  ];
  if (r.routing.adminPin) {
    routingNotes.push(
      "A model config store is configured: an admin pin in it replaces a chain at call time" +
        (r.routing.overridesBeatPin ? ", except where a task override exists." : "."),
    );
  }
  if (r.routing.taskOverrideStore) {
    routingNotes.push(
      "A task override store is configured: the chains above are as resolved when this report ran.",
    );
  }
  for (const n of routingNotes) line(`- ${n}`);
  if (routingNotes.length > 0) line();

  line("## Tools");
  line();
  if (!r.tools) {
    line("Tool governance is off: tool calls are not priced, capped or ledgered.");
    line();
  } else if (r.tools.length === 0) {
    line("A tool hook is configured and no tool has a policy: tool calls are ledgered at no cost.");
    line();
  } else {
    table(
      ["Tool", "Cost per call", "Most calls per run", "Most spend per run"],
      r.tools.map((t) => [
        `\`${t.tool}\``,
        t.costCents === "by arguments" ? "by arguments" : `${t.costCents}¢`,
        t.maxCalls === undefined ? "no limit" : String(t.maxCalls),
        t.maxCents === undefined ? "no limit" : cents(t.maxCents),
      ]),
    );
  }

  line("## Data handling");
  line();
  table(
    ["", ""],
    [
      ["Usage ledger", `\`${r.ledger.store}\``],
      [
        "Prompt and output snapshots",
        `first ${r.ledger.snapshotLimitChars.toLocaleString("en-US")} characters, ` +
          (r.ledger.snapshotsEncrypted ? "encrypted before storage" : "stored as plaintext"),
      ],
      [
        "Response cache",
        `\`${r.cache.store}\`, kept ${r.cache.ttlSeconds.toLocaleString("en-US")} s, ` +
          (r.cache.invalidatedOnPromptChange
            ? "invalidated when a prompt changes"
            : "not invalidated when a prompt changes"),
      ],
      ["Rate limiter", `\`${r.rateLimiter}\``],
      ["Providers with a key", r.providers.withKeys.join(", ") || "none"],
      ["Custom endpoints", r.providers.endpoints.join(", ") || "none"],
      ["Provider factories", r.providers.factories.join(", ") || "none"],
      ["Mock mode", r.mock ? "on: no provider is called" : "off"],
    ],
  );
  if (r.retention.length > 0) {
    line("Retention, as asserted in `providers.retention`:");
    line();
    table(
      ["Provider or model", "ZDR", "Note"],
      r.retention.map((e) => [`\`${e.key}\``, yesNo(e.zdr), e.note ?? ""]),
    );
  }

  line("## Timeouts and judging");
  line();
  table(
    ["", ""],
    [
      ["One provider attempt", `${r.timeouts.attemptMs.toLocaleString("en-US")} ms`],
      [
        "A whole call",
        r.timeouts.deadlineMs === undefined
          ? "no bound"
          : `${r.timeouts.deadlineMs.toLocaleString("en-US")} ms`,
      ],
      ["First part of a stream", `${r.timeouts.streamFirstChunkMs.toLocaleString("en-US")} ms`],
      ["Between parts of a stream", `${r.timeouts.streamStallMs.toLocaleString("en-US")} ms`],
      [
        "Judge model, where a call asks for a judge",
        r.judge.model ? `\`${r.judge.model}\`` : "the default provider's judge tier",
      ],
      [
        "Judge sample rate",
        r.judge.sampleRate === undefined
          ? "1, unless the call sets one"
          : String(r.judge.sampleRate),
      ],
      ["Observability hooks", r.observability.join(", ") || "none"],
    ],
  );

  return `${out.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// `llm-gateway policy <module>`

interface Describable {
  describePolicy(opts?: { orgId?: string }): Promise<PolicyReport>;
}
const isDescribable = (v: unknown): v is Describable =>
  typeof (v as Describable | null)?.describePolicy === "function";

export const POLICY_USAGE = `Usage: llm-gateway policy <module> [--json] [--org <id>] [--export <name>]

  <module>          A JavaScript module that exports your Gateway: as "gateway",
                    as the default export, or under --export. The export may be
                    the Gateway or a function that returns one.
  --json            Print the report as JSON instead of markdown.
  --org <id>        Resolve chains and overrides for this org.
  --export <name>   The export to read.

A TypeScript module needs a loader, for example:
  node --import tsx node_modules/llm-governance-gateway/dist/cli.js policy ./src/gateway.ts`;

/** Runs the command. Returns the process exit code. */
export async function runPolicyCommand(
  args: string[],
  io: { out: (text: string) => void; err: (text: string) => void },
): Promise<number> {
  let file: string | undefined;
  let json = false;
  let orgId: string | undefined;
  let exportName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--org") orgId = args[++i];
    else if (a === "--export") exportName = args[++i];
    else if (a === "--help" || a === "-h") {
      io.out(POLICY_USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      io.err(`Unknown option "${a}".\n\n${POLICY_USAGE}`);
      return 2;
    } else file ??= a;
  }
  if (!file) {
    io.err(POLICY_USAGE);
    return 2;
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolve(file)).href)) as Record<string, unknown>;
  } catch (e) {
    io.err(`Could not load "${file}": ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const names = exportName ? [exportName] : ["gateway", "default"];
  const found = names.find((n) => mod[n] !== undefined);
  if (!found) {
    io.err(
      `"${file}" has no export named ${names.map((n) => `"${n}"`).join(" or ")}. ` +
        `Its exports: ${Object.keys(mod).join(", ") || "none"}.`,
    );
    return 1;
  }
  let value = mod[found];
  if (typeof value === "function" && !isDescribable(value)) {
    value = await (value as () => unknown)();
  }
  if (!isDescribable(value)) {
    io.err(`The "${found}" export of "${file}" is not a Gateway, nor a function returning one.`);
    return 1;
  }
  let report: PolicyReport;
  try {
    report = await value.describePolicy(orgId ? { orgId } : {});
  } catch (e) {
    // A routing store that cannot be read: no report is better than a wrong one.
    io.err(`Could not build the report: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  io.out(json ? JSON.stringify(report, null, 2) : renderPolicyMarkdown(report));
  return 0;
}
