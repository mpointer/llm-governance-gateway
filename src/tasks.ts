// Task-based model routing (LocalNewsBuddy pattern): name your call sites
// ("enrich", "summarize", "dedup_judge"), give each a code-level default
// model, and let an admin store override the model per task at runtime.
// Code defaults are the fallback; the store — when present — wins.

import { parseModelId } from "./providers.js";
import type { ProviderId, TaskRoutingConfig } from "./types.js";

const DEFAULT_OVERRIDE_TTL_MS = 30_000;

export interface ResolvedTaskModel {
  task: string;
  provider: ProviderId;
  model: string;
  /** "override" = admin store, "default" = code registry. */
  source: "override" | "default";
}

export class TaskRouter {
  private readonly cfg: TaskRoutingConfig;
  private overrides: Record<string, string> = {};
  private overridesExpireAt = 0;

  constructor(cfg: TaskRoutingConfig) {
    this.cfg = cfg;
  }

  tasks(): string[] {
    return Object.keys(this.cfg.defaults);
  }

  label(task: string): string {
    return this.cfg.labels?.[task] ?? task;
  }

  /** Test seam / admin write path: force override refresh on next resolve. */
  invalidateOverrides(): void {
    this.overridesExpireAt = 0;
  }

  private async loadOverrides(): Promise<Record<string, string>> {
    if (!this.cfg.store) return {};
    const now = Date.now();
    if (this.overridesExpireAt > now) return this.overrides;
    try {
      this.overrides = await this.cfg.store.getOverrides();
    } catch (err) {
      // Store unreachable — routing must degrade to code defaults, never fail.
      console.warn(
        "[llm-gateway] task override store unreachable, using code defaults:",
        err instanceof Error ? err.message : err,
      );
      this.overrides = {};
    }
    this.overridesExpireAt =
      now + (this.cfg.overrideTtlMs ?? DEFAULT_OVERRIDE_TTL_MS);
    return this.overrides;
  }

  /**
   * Resolve a task to its model: store override → code default. Throws on an
   * unknown task — a typo'd task name must fail loudly, not silently route to
   * some global default.
   */
  async modelForTask(task: string): Promise<ResolvedTaskModel> {
    const overrides = await this.loadOverrides();
    const overridden = overrides[task];
    if (overridden) {
      const { provider, model } = parseModelId(overridden);
      return { task, provider, model, source: "override" };
    }
    const def = this.cfg.defaults[task];
    if (!def) {
      throw new Error(
        `Unknown AI task "${task}". Known tasks: ${this.tasks().join(", ")}`,
      );
    }
    const { provider, model } = parseModelId(def);
    return { task, provider, model, source: "default" };
  }
}
