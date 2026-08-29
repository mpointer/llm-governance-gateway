// Task-based model routing (LocalNewsBuddy pattern): name your call sites
// ("enrich", "summarize", "dedup_judge"), give each a code-level default
// model, and let an admin store override the model per task at runtime.
// Code defaults are the fallback; the store — when present — wins.

import { parseModelId } from "./providers.js";
import type { ProviderId, TaskRoutingConfig } from "./types.js";

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
    { overrides: Record<string, string>; expiresAt: number }
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

  private async loadOverrides(orgId?: string | null): Promise<Record<string, string>> {
    if (!this.cfg.store) return {};
    const bucket = orgId ?? "";
    const now = Date.now();
    const cached = this.overridesByOrg.get(bucket);
    if (cached && cached.expiresAt > now) return cached.overrides;
    let overrides: Record<string, string>;
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
    const overrides = await this.loadOverrides(orgId);
    const overridden = overrides[task];
    if (overridden) {
      const { provider, model } = this.parse(overridden);
      return { task, provider, model, source: "override" };
    }
    const def = this.cfg.defaults[task];
    if (!def) {
      throw new Error(
        `Unknown AI task "${task}". Known tasks: ${this.tasks().join(", ")}`,
      );
    }
    const { provider, model } = this.parse(def);
    return { task, provider, model, source: "default" };
  }
}
