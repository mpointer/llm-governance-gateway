// Task-based model routing (LocalNewsBuddy pattern): name your call sites
// ("enrich", "summarize", "dedup_judge"), give each a code-level default
// model, and let an admin store override the model per task at runtime.
// Code defaults are the fallback; the store — when present — wins.

import { parseModelId } from "./providers.js";
import type { ProviderId, TaskModelSpec, TaskRoutingConfig } from "./types.js";

const DEFAULT_OVERRIDE_TTL_MS = 30_000;

export interface ResolvedTaskModel {
  task: string;
  /** Built-in ProviderId or custom endpoint name. */
  provider: string;
  model: string;
  /** "override" = admin store, "default" = code registry. */
  source: "override" | "default";
}

type ModelParser = (id: string) => { provider: string; model: string };

export class TaskRouter {
  private readonly cfg: TaskRoutingConfig;
  private readonly parse: ModelParser;
  /**
   * Overrides cached PER TENANT. A single shared map would serve one org's
   * task routing to another for the length of the TTL — a cross-tenant config
   * leak, not merely a stale read. Unscoped callers use the "" bucket and
   * behave exactly as before.
   */
  private readonly overridesByOrg = new Map<
    string,
    { overrides: Record<string, TaskModelSpec>; expiresAt: number }
  >();

  constructor(cfg: TaskRoutingConfig, parse?: ModelParser) {
    this.cfg = cfg;
    this.parse = parse ?? parseModelId;
  }

  tasks(): string[] {
    return Object.keys(this.cfg.defaults);
  }

  label(task: string): string {
    return this.cfg.labels?.[task] ?? task;
  }

  /** Task-level governance constraint: must this task run ZDR-only? */
  requiresZdr(task: string): boolean {
    return this.cfg.constraints?.[task]?.requireZdr === true;
  }

  /**
   * Test seam / admin write path: force override refresh on next resolve.
   * Omit `orgId` to invalidate every tenant's cache.
   */
  invalidateOverrides(orgId?: string | null): void {
    if (orgId === undefined) this.overridesByOrg.clear();
    else this.overridesByOrg.delete(orgId ?? "");
  }

  private async loadOverrides(orgId?: string | null): Promise<Record<string, TaskModelSpec>> {
    if (!this.cfg.store) return {};
    const bucket = orgId ?? "";
    const now = Date.now();
    const cached = this.overridesByOrg.get(bucket);
    if (cached && cached.expiresAt > now) return cached.overrides;
    let overrides: Record<string, TaskModelSpec>;
    try {
      overrides = await this.cfg.store.getOverrides(orgId);
    } catch (err) {
      // Store unreachable — routing must degrade to code defaults, never fail.
      console.warn(
        "[llm-gateway] task override store unreachable, using code defaults:",
        err instanceof Error ? err.message : err,
      );
      overrides = {};
    }
    this.overridesByOrg.set(bucket, {
      overrides,
      expiresAt: now + (this.cfg.overrideTtlMs ?? DEFAULT_OVERRIDE_TTL_MS),
    });
    return overrides;
  }

  /**
   * Resolve a task to its model: store override → code default. Throws on an
   * unknown task — a typo'd task name must fail loudly, not silently route to
   * some global default.
   */
  async modelForTask(task: string, orgId?: string | null): Promise<ResolvedTaskModel> {
    // The head of the task's chain. Kept as the single-model accessor so
    // callers that only want "which model would this task use?" — including
    // adopters comparing the gateway's resolution against their own — are
    // unaffected by chains existing.
    const chain = await this.chainForTask(task, orgId);
    return chain[0]!;
  }

  /**
   * Resolve a task to its ordered failover chain: store override → code
   * default. A single-id configuration yields a one-link chain, which is
   * exactly the pre-chain behavior.
   *
   * Throws on an unknown task — a typo'd task name must fail loudly, not
   * silently route to some global default — and on a task configured with an
   * empty chain, which is a config error rather than an empty result.
   */
  async chainForTask(task: string, orgId?: string | null): Promise<ResolvedTaskModel[]> {
    const overrides = await this.loadOverrides(orgId);
    const overridden = overrides[task];
    const spec = overridden ?? this.cfg.defaults[task];
    const source: ResolvedTaskModel["source"] = overridden ? "override" : "default";
    if (spec === undefined) {
      throw new Error(
        `Unknown AI task "${task}". Known tasks: ${this.tasks().join(", ")}`,
      );
    }
    const ids = (Array.isArray(spec) ? spec : [spec]).filter((id) => !!id);
    if (ids.length === 0) {
      throw new Error(
        `AI task "${task}" resolves to an empty model chain (${source}). ` +
          `Configure at least one model id.`,
      );
    }
    return ids.map((id) => {
      const { provider, model } = this.parse(id);
      return { task, provider, model, source };
    });
  }
}
