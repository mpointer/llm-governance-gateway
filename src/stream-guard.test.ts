// guardStream modes: conflate (object snapshots) vs queue (text deltas), and
// the pausable clock streamText uses while a tool executes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { guardStream, type StreamGuardOptions } from "./stream-guard.js";

async function* source<T>(...values: T[]): AsyncGenerator<T> {
  for (const v of values) yield v;
}

function opts(extra: Partial<StreamGuardOptions> = {}): StreamGuardOptions {
  return {
    controller: new AbortController(),
    firstChunkMs: 0,
    stallMs: 0,
    onTrip: (phase) => new Error(phase),
    onCallerAbort: () => new Error("aborted"),
    ...extra,
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("guardStream modes", () => {
  it("queue mode delivers every value in order to a slow consumer", async () => {
    const g = guardStream(source("a", "b", "c"), opts({ mode: "queue" }));
    await tick(); // let the pump finish before the consumer reads anything
    expect(await collect(g.stream)).toEqual(["a", "b", "c"]);
    g.dispose();
  });

  it("conflate mode still drops intermediates", async () => {
    const g = guardStream(source("a", "b", "c"), opts());
    await tick();
    const got = await collect(g.stream);
    expect(got.at(-1)).toBe("c");
    expect(got.length).toBeLessThan(3);
    g.dispose();
  });
});

describe("guardStream pauseClock / resumeClock", () => {
  afterEach(() => vi.useRealTimers());

  it("pauseClock stops a stall trip; resumeClock re-arms it", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* one(): AsyncGenerator<string> {
      yield "x";
      await gate; // then hang until released
      await new Promise(() => {});
    }
    const g = guardStream(one(), opts({ stallMs: 100, mode: "queue" }));
    let tripped: Error | undefined;
    void g.tripped.then((e) => (tripped = e));
    await vi.advanceTimersByTimeAsync(0); // pump publishes "x", arms stall
    g.pauseClock();
    await vi.advanceTimersByTimeAsync(500);
    expect(tripped).toBeUndefined();
    g.resumeClock();
    await vi.advanceTimersByTimeAsync(101);
    expect(tripped?.message).toBe("stall");
    release();
    g.dispose();
  });
});
