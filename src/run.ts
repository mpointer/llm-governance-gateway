// Governed runs: the unit that groups governed calls into one agent run.
//
// A run gives the calls made under it a shared id in the ledger (`runId`,
// `stepIndex`, `parentRunId` on every usage row), a dollar budget across all
// of them, and a ceiling on how many there may be. Each governed call that
// carries a run is one step. The checks run inside the gateway's shared front
// door, so every path gets them.
//
// Spend is counted from the ledger rows the gateway writes, never from an
// estimate made beforehand: the run's view of what it spent IS the ledger's.
//
// Runs nest. A child run has its own id, budget and step count; its spend
// also counts against every ancestor, and a call is refused when the child or
// any ancestor has no budget left. That is the control for fan-out: a
// sub-agent cannot spend what its parent has not got.
//
// Design and scope: docs/design/run-governance.md.

import { randomUUID } from "node:crypto";

export interface StartRunOptions {
  /** Your own id for the run. Default: a random UUID. */
  id?: string;
  /**
   * Hard budget for the whole run, in cents. A call is refused once the run
   * (or an ancestor) has spent this much. Omit for no budget: the run then
   * only groups rows and counts steps.
   */
  budgetCents?: number;
  /** Most governed calls the run may make. Omit for no ceiling. */
  maxSteps?: number;
  /** Make this a child run. Its spend also counts against the parent. */
  parent?: GovernedRun;
}

/** A run's counters as plain JSON, for a run that spans processes. */
export interface RunSnapshot {
  runId: string;
  parentRunId?: string;
  budgetCents?: number;
  maxSteps?: number;
  spentCents: number;
  steps: number;
}

export class GovernedRun {
  readonly id: string;
  readonly budgetCents: number | undefined;
  readonly maxSteps: number | undefined;
  readonly parent: GovernedRun | undefined;
  /** The parent's id. Survives a snapshot even when `parent` itself does not. */
  readonly parentRunId: string | undefined;
  private spent = 0;
  private stepCount = 0;

  constructor(opts: StartRunOptions = {}, restored?: RunSnapshot) {
    if (opts.budgetCents !== undefined && !(opts.budgetCents > 0)) {
      throw new Error(
        "GovernedRun: budgetCents must be a positive number (omit it for no budget).",
      );
    }
    if (opts.maxSteps !== undefined && !(Number.isInteger(opts.maxSteps) && opts.maxSteps >= 1)) {
      throw new Error(
        "GovernedRun: maxSteps must be an integer of at least 1 (omit it for no ceiling).",
      );
    }
    this.id = opts.id ?? randomUUID();
    this.budgetCents = opts.budgetCents;
    this.maxSteps = opts.maxSteps;
    this.parent = opts.parent;
    this.parentRunId = opts.parent?.id ?? restored?.parentRunId;
    if (restored) {
      this.spent = restored.spentCents;
      this.stepCount = restored.steps;
    }
  }

  /** Rebuild a run from `snapshot()`. Pass `parent` again to re-link a child. */
  static fromSnapshot(snapshot: RunSnapshot, opts: { parent?: GovernedRun } = {}): GovernedRun {
    return new GovernedRun(
      {
        id: snapshot.runId,
        ...(snapshot.budgetCents !== undefined ? { budgetCents: snapshot.budgetCents } : {}),
        ...(snapshot.maxSteps !== undefined ? { maxSteps: snapshot.maxSteps } : {}),
        ...(opts.parent ? { parent: opts.parent } : {}),
      },
      snapshot,
    );
  }

  /** Cents spent so far, including every child run's spend. */
  get spentCents(): number {
    return this.spent;
  }

  /** Governed calls admitted so far. Child runs count their own. */
  get steps(): number {
    return this.stepCount;
  }

  /**
   * Cents left before a call is refused: the tightest of this run's budget
   * and every ancestor's. undefined when nothing in the chain has a budget.
   */
  remainingCents(): number | undefined {
    let left: number | undefined;
    for (let r: GovernedRun | undefined = this; r; r = r.parent) {
      if (r.budgetCents === undefined) continue;
      const mine = r.budgetCents - r.spent;
      left = left === undefined ? mine : Math.min(left, mine);
    }
    return left;
  }

  /**
   * The nearest run in the chain (this one first) whose budget is spent, or
   * undefined. Same rule as the daily caps: refused at `spent >= budget`.
   */
  exhausted(): GovernedRun | undefined {
    for (let r: GovernedRun | undefined = this; r; r = r.parent) {
      if (r.budgetCents !== undefined && r.spent >= r.budgetCents) return r;
    }
    return undefined;
  }

  /** True when one more call would pass the step ceiling. */
  atStepCeiling(): boolean {
    return this.maxSteps !== undefined && this.stepCount >= this.maxSteps;
  }

  /** @internal The gateway admits a call: returns its 0-based step index. */
  beginStep(): number {
    return this.stepCount++;
  }

  /** @internal The gateway wrote a ledger row for this run. */
  record(cents: number): void {
    for (let r: GovernedRun | undefined = this; r; r = r.parent) r.spent += cents;
  }

  /** The counters as JSON. Store it, then `gateway.resumeRun()` elsewhere. */
  snapshot(): RunSnapshot {
    return {
      runId: this.id,
      ...(this.parentRunId !== undefined ? { parentRunId: this.parentRunId } : {}),
      ...(this.budgetCents !== undefined ? { budgetCents: this.budgetCents } : {}),
      ...(this.maxSteps !== undefined ? { maxSteps: this.maxSteps } : {}),
      spentCents: this.spent,
      steps: this.stepCount,
    };
  }
}
