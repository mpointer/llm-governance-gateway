// The policy report: gateway.describePolicy(), its markdown rendering, and
// the `llm-gateway policy` command that prints it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Gateway } from "./gateway.js";
import { MemoryUsageStore } from "./adapters/memory.js";
import { renderPolicyMarkdown, runPolicyCommand, type PolicyReport } from "./policy.js";
import type { GatewayConfig, RateLimiter, UsageStore } from "./types.js";

const API_KEY = "sk-ant-SECRET-never-printed";
const ENDPOINT_URL = "https://llm.internal.example.com/v1";
// The built-in rates are dated 2026-10-28; a month later none is stale.
const NOW = new Date("2026-11-26T00:00:00Z");

/** A store and a limiter that are not the in-memory defaults. */
class PgLedger implements UsageStore {
  async logUsage() {
    return 1;
  }
  async sumSpendCents() {
    return 0;
  }
  async recordSpendCapEvent() {}
  async saveJudgeScore() {}
  async getUserDailyCapCents() {
    return undefined;
  }
}
class SharedLimiter implements RateLimiter {
  async limit() {
    return { success: true, limit: 10, remaining: 9 };
  }
}

/** A configuration with nothing for the report to flag. */
function cleanConfig(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    usage: new PgLedger(),
    rateLimiter: new SharedLimiter(),
    appId: "support-desk",
    encrypt: (t) => `enc:${t}`,
    providers: {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      apiKeys: { anthropic: API_KEY },
      endpoints: { internal: { baseURL: ENDPOINT_URL } },
      retention: { anthropic: { zdr: true, note: "ZDR addendum signed" } },
    },
    ...extra,
  };
}

const describeWith = (extra: Partial<GatewayConfig> = {}) =>
  new Gateway(cleanConfig(extra)).describePolicy({ now: NOW });

describe("describePolicy", () => {
  it("reports the effective spend limits, including the defaults nobody set", async () => {
    const r = await describeWith({ caps: { userDailyCents: 300, orgDailyCents: 5000 } });
    expect(r.spendCaps).toEqual({
      mode: "enforce",
      userDailyCents: 300,
      anonDailyCents: 100, // built-in default
      globalDailyCents: 5000, // built-in default
      orgDailyCents: 5000,
      storeOverrides: { user: true, org: false },
    });
    expect(r.app).toBe("support-desk");
    expect(r.findings).toEqual([]);
  });

  it("says which guardrail hooks exist, and whether they fail open", async () => {
    const r = await describeWith({
      guardrails: { pre: () => ({ action: "allow" }), tool: () => ({ action: "allow" }) },
    });
    expect(r.guardrails).toEqual({ pre: true, post: false, tool: true, failOpen: false });
  });

  it("resolves each task's chain with the ZDR and pricing status of every model", async () => {
    const r = await describeWith({
      tasks: {
        defaults: {
          review: ["anthropic:claude-sonnet-4-6", "openai:gpt-4.1"],
          local: "internal:llama",
        },
        labels: { review: "Contract review" },
        constraints: { review: { requireZdr: true } },
      },
    });
    expect(r.tasks).toEqual([
      {
        task: "review",
        label: "Contract review",
        requireZdr: true,
        source: "default",
        chain: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            kind: "provider",
            zdr: true,
            priced: true,
            pricingAsOf: "2026-10-28",
            pricingStale: false,
          },
          {
            provider: "openai",
            model: "gpt-4.1",
            kind: "provider",
            zdr: false,
            priced: true,
            pricingAsOf: "2026-10-28",
            pricingStale: false,
          },
        ],
      },
      {
        task: "local",
        label: "local",
        requireZdr: false,
        source: "default",
        // A custom endpoint: self-hosted, so ZDR and free by default.
        chain: [
          { provider: "internal", model: "llama", kind: "endpoint", zdr: true, priced: true },
        ],
      },
    ]);
    expect(r.routing.defaultChain).toHaveLength(1);
    expect(r.routing.defaultChain[0]).toMatchObject({ provider: "anthropic", zdr: true });
    expect(r.routing.defaultChainSource).toBe("config");
  });

  it("shows a task override from the store, and the chain a model config store supplies", async () => {
    const r = await describeWith({
      tasks: {
        defaults: { triage: "anthropic:claude-sonnet-4-6" },
        store: { getOverrides: async () => ({ triage: "openai:gpt-4.1" }) },
        overridesBeatPin: true,
      },
      modelConfig: {
        getOverride: async () => null,
        getChain: async () => [
          { provider: "openai", model: "gpt-4.1" },
          { endpoint: "internal", model: "llama" },
        ],
      },
    });
    expect(r.tasks[0]).toMatchObject({ source: "override" });
    expect(r.tasks[0]!.chain[0]).toMatchObject({ provider: "openai", model: "gpt-4.1" });
    expect(r.routing).toMatchObject({
      defaultChainSource: "model config store",
      adminPin: true,
      taskOverrideStore: true,
      overridesBeatPin: true,
    });
    expect(r.routing.defaultChain.map((m) => `${m.provider}:${m.model}`)).toEqual([
      "openai:gpt-4.1",
      "internal:llama",
    ]);
  });

  it("lists the tool policy, and omits it when tool governance is off", async () => {
    expect((await describeWith()).tools).toBeUndefined();
    const r = await describeWith({
      toolPolicy: {
        search: { costCents: 0.5, maxCalls: 20 },
        write: { maxCents: 10 },
        quote: { costCents: () => 1 },
      },
    });
    expect(r.tools).toEqual([
      { tool: "search", costCents: 0.5, maxCalls: 20 },
      { tool: "write", costCents: 0, maxCents: 10 },
      { tool: "quote", costCents: "by arguments" },
    ]);
  });

  it("names providers and endpoints, and never prints a key or a URL", async () => {
    const r = await describeWith({
      tasks: { defaults: { local: "internal:llama" } },
      toolPolicy: { search: {} },
    });
    expect(r.providers.withKeys).toContain("anthropic");
    expect(r.providers.endpoints).toEqual(["internal"]);
    expect(r.retention).toEqual([{ key: "anthropic", zdr: true, note: "ZDR addendum signed" }]);
    for (const text of [JSON.stringify(r), renderPolicyMarkdown(r)]) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain("internal.example.com");
    }
  });

  it("resolves for the org it is asked about", async () => {
    const seen: (string | null | undefined)[] = [];
    const gw = new Gateway(
      cleanConfig({
        tasks: {
          defaults: { triage: "anthropic:claude-sonnet-4-6" },
          store: {
            getOverrides: async (orgId) => {
              seen.push(orgId);
              return {};
            },
          },
        },
      }),
    );
    const r = await gw.describePolicy({ orgId: "acme", now: NOW });
    expect(r.org).toBe("acme");
    expect(seen).toEqual(["acme"]);
  });
});

describe("describePolicy: findings", () => {
  const findings = async (extra: Partial<GatewayConfig>, now = NOW) =>
    (await new Gateway(cleanConfig(extra)).describePolicy({ now })).findings;

  it("has none for a configuration with nothing to flag", async () => {
    expect(await findings({})).toEqual([]);
  });

  it.each([
    ["mock mode", { mock: true }, /Mock mode is on/],
    ["an in-memory ledger", { usage: new MemoryUsageStore() }, /usage ledger is in memory/],
    ["observe mode", { caps: { mode: "observe" as const } }, /observe mode/],
    [
      "limits turned off",
      { caps: { userDailyCents: 0, globalDailyCents: 0 } },
      /limits are off: per-user, global\./,
    ],
    ["hooks that fail open", { guardrails: { failOpen: true } }, /fail open/],
    ["plaintext snapshots", { encrypt: undefined }, /stored as plaintext/],
    ["an in-memory rate limiter", { rateLimiter: undefined }, /rate limiter is in memory/],
    [
      "a model with no pricing",
      { tasks: { defaults: { t: "openrouter:acme/new-model" } } },
      /openrouter:acme\/new-model has no pricing/,
    ],
    [
      "no default model",
      { providers: { apiKeys: { anthropic: API_KEY } } },
      /No default model is configured/,
    ],
  ])("flags %s", async (_name, extra, pattern) => {
    const found = await findings(extra as Partial<GatewayConfig>);
    expect(found.some((f) => pattern.test(f))).toBe(true);
  });

  it("flags a ZDR task whose chain is partly, or wholly, not ZDR-asserted", async () => {
    const found = await findings({
      tasks: {
        defaults: {
          partly: ["anthropic:claude-sonnet-4-6", "openai:gpt-4.1"],
          wholly: "openai:gpt-4.1",
          fine: "anthropic:claude-sonnet-4-6",
        },
        constraints: {
          partly: { requireZdr: true },
          wholly: { requireZdr: true },
          fine: { requireZdr: true },
        },
      },
    });
    expect(found).toEqual([
      'Task "partly" requires ZDR: 1 of the 2 models in its chain is not ZDR-asserted and is skipped (openai:gpt-4.1).',
      'Task "wholly" requires ZDR and no model in its chain is ZDR-asserted: every call to it is refused.',
    ]);
  });

  it("flags pricing older than the staleness window, once per model", async () => {
    const later = new Date("2027-06-01T00:00:00Z");
    const found = await findings(
      {
        tasks: { defaults: { a: "anthropic:claude-sonnet-4-6", b: "anthropic:claude-sonnet-4-6" } },
      },
      later,
    );
    expect(found).toEqual([
      "Pricing for anthropic:claude-sonnet-4-6 is dated 2026-10-28, more than 90 days old.",
    ]);
  });
});

describe("renderPolicyMarkdown", () => {
  it("renders the same report to the same text, with the sections a reviewer reads", async () => {
    const r = await describeWith({
      caps: { userDailyCents: 300, mode: "observe" },
      tasks: {
        defaults: { review: ["anthropic:claude-sonnet-4-6", "openai:gpt-4.1"] },
        labels: { review: "Contract review" },
        constraints: { review: { requireZdr: true } },
      },
      toolPolicy: { search: { costCents: 0.5, maxCalls: 20 } },
    });
    const md = renderPolicyMarkdown(r);
    expect(renderPolicyMarkdown(r)).toBe(md);
    expect(md).toContain("# LLM gateway policy: support-desk");
    expect(md).toContain("| Each signed-in user | $3.00 | yes |");
    expect(md).toContain("Mode: **observe**. A breach is recorded and the call goes ahead.");
    expect(md).toContain(
      "| `review` (Contract review) | yes | `anthropic:claude-sonnet-4-6` (ZDR; priced 2026-10-28)" +
        "<br>`openai:gpt-4.1` (not ZDR; priced 2026-10-28) | code default |",
    );
    expect(md).toContain("| `search` | 0.5¢ | 20 | no limit |");
    expect(md).toContain("encrypted before storage");
    expect(md).toContain("- Spend limits are in observe mode");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("says so when there are no findings and when tool governance is off", async () => {
    const md = renderPolicyMarkdown(await describeWith());
    expect(md).toContain("## Findings\n\nNone.");
    expect(md).toContain("Tool governance is off");
  });
});

describe("llm-gateway policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-policy-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let report: PolicyReport;
  /** Writes a module whose exports stand in for a Gateway. */
  const moduleFile = async (name: string, body: (reportJson: string) => string) => {
    report ??= await describeWith({
      tasks: { defaults: { triage: "anthropic:claude-sonnet-4-6" } },
    });
    const file = join(dir, name);
    writeFileSync(file, body(JSON.stringify(report)));
    return file;
  };
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPolicyCommand(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("prints the markdown report of the module's `gateway` export", async () => {
    const file = await moduleFile(
      "named.mjs",
      (json) => `export const gateway = { describePolicy: async () => (${json}) };`,
    );
    const res = await run([file]);
    expect(res.code).toBe(0);
    expect(res.out).toBe(renderPolicyMarkdown(report));
  });

  it("reads a default export, a function returning the gateway, and --export", async () => {
    const file = await moduleFile(
      "shapes.mjs",
      (json) => `const gw = { describePolicy: async () => (${json}) };
        export default async () => gw;
        export const billing = gw;`,
    );
    expect((await run([file])).code).toBe(0);
    expect((await run([file, "--export", "billing"])).code).toBe(0);
    const missing = await run([file, "--export", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no export named "nope"');
  });

  it("prints JSON with --json and passes --org through", async () => {
    const file = await moduleFile(
      "org.mjs",
      () => `export const gateway = { describePolicy: async (o) => ({ asked: o }) };`,
    );
    const res = await run([file, "--json", "--org", "acme"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual({ asked: { orgId: "acme" } });
  });

  it("explains itself: usage with no module, and an error for what it cannot load", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["--help"])).out).toContain("Usage: llm-gateway policy <module>");
    expect((await run(["x.mjs", "--nope"])).code).toBe(2);

    const absent = await run([join(dir, "absent.mjs")]);
    expect(absent.code).toBe(1);
    expect(absent.err).toContain("Could not load");

    const wrong = await moduleFile("wrong.mjs", () => `export const gateway = { nothing: true };`);
    const notGateway = await run([wrong]);
    expect(notGateway.code).toBe(1);
    expect(notGateway.err).toContain("is not a Gateway");

    const broken = await moduleFile(
      "broken.mjs",
      () =>
        `export const gateway = { describePolicy: async () => { throw new Error("store down"); } };`,
    );
    const failed = await run([broken]);
    expect(failed.code).toBe(1);
    expect(failed.err).toBe("Could not build the report: store down");
  });
});
