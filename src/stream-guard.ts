// Chunk-relative stall detection for streamed generations.
// See docs/design/timeouts-and-deadlines.md ("Streaming — a different clock").
//
// Why not a total-duration cap: a long stream that is actively producing
// tokens is healthy, and killing it at N seconds would be a regression.
// Silence is what is never healthy. So there are two clocks — time to the
// first emission, and time since the last one.
//
// What the clocks actually measure: emissions from the stream handed to
// `guardStream` — for streamStructured that is `partialObjectStream`, which
// emits only when the PARSED PARTIAL OBJECT changes, not on every provider
// chunk. A model that emits `{"ans` and then `wer"` produces no partial at
// all yet. So "time to first emission" is time to the first parseable
// partial, and the default window is sized (60s) with that slack in mind.
// This is the right measure for a structured stream: it tracks useful
// progress rather than mere bytes.
//
// Why this module owns the iteration: streamObject drives the model eagerly
// (its constructor starts the request), but a consumer that only awaits
// `.object` never iterates `partialObjectStream` and therefore produces no
// observable per-chunk activity. Driving the stall clock from the consumer's
// iteration would make a healthy long stream trip the clock for that consumer.
// So the guard pumps the source itself and the consumer drains a conflated
// cell — the clock then ticks on real provider progress, whatever the
// consumer does.

export type StallPhase = "first-chunk" | "stall";

export interface StreamGuard<T> {
  /** Consumer-facing stream. Throws the onTrip error once the clock trips. */
  readonly stream: AsyncIterable<T>;
  /**
   * Resolves (never rejects) with the error to surface when the clock trips
   * or the caller aborts. Race a completion promise against this.
   */
  readonly tripped: Promise<Error>;
  /** Clears timers and listeners. Idempotent; call from a finally block. */
  dispose(): void;
}

export interface StreamGuardOptions {
  /**
   * Aborts the underlying request when a clock trips. The caller creates it
   * so the same signal can be handed to streamObject before the source
   * stream exists.
   */
  controller: AbortController;
  /** Time allowed to the first emission. 0 disables. */
  firstChunkMs: number;
  /** Time allowed since the last emission. 0 disables. */
  stallMs: number;
  /** The caller's own signal (request teardown, client disconnect). */
  callerSignal?: AbortSignal;
  /** Builds the error surfaced to the consumer. */
  onTrip: (phase: StallPhase, waitedMs: number) => Error;
  /** Builds the error surfaced when the CALLER aborts, not a clock. */
  onCallerAbort: (reason: unknown) => Error;
}

/**
 * A single-slot channel: the writer overwrites the pending value rather than
 * queueing, so a consumer slower than the producer sees the NEWEST value and
 * memory stays O(1). Safe for partial-object streams specifically because
 * every partial is a complete snapshot of the object so far — a dropped
 * intermediate loses a frame, never information.
 */
export interface ConflatedCell<T> {
  publish(value: T): void;
  close(): void;
  /** First failure wins; later ones (e.g. the abort that a stall causes) are
   *  ignored so the consumer sees the root cause. */
  fail(err: Error): void;
  isClosed(): boolean;
  readonly stream: AsyncIterable<T>;
}

export function createConflatedCell<T>(): ConflatedCell<T> {
  let latest: { value: T } | null = null;
  let closed = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;

  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  async function* consume(): AsyncGenerator<T> {
    for (;;) {
      if (latest) {
        const { value } = latest;
        latest = null;
        yield value;
        continue;
      }
      if (failure) throw failure;
      if (closed) return;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  }

  return {
    publish(value) {
      latest = { value };
      nudge();
    },
    close() {
      closed = true;
      nudge();
    },
    fail(err) {
      if (!failure) failure = err;
      closed = true;
      nudge();
    },
    isClosed: () => closed,
    stream: { [Symbol.asyncIterator]: () => consume() },
  };
}

/**
 * Wraps `source` with first-chunk and inter-chunk stall clocks.
 *
 * Emissions are conflated: if the consumer is slower than the provider, it
 * receives the newest partial rather than a backlog. Each partial from
 * streamObject is a complete snapshot of the object so far, so a slow
 * consumer still sees monotonically newer state and always the final value —
 * and memory stays O(1) instead of growing with a stream it isn't reading.
 */
export function guardStream<T>(
  source: AsyncIterable<T>,
  opts: StreamGuardOptions,
): StreamGuard<T> {
  const { controller, firstChunkMs, stallMs, callerSignal, onTrip, onCallerAbort } = opts;

  const cell = createConflatedCell<T>();
  const { publish, close, fail } = cell;

  // --- clocks ---------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedAt = Date.now();
  let disposed = false;
  let resolveTripped!: (err: Error) => void;
  const tripped = new Promise<Error>((r) => {
    resolveTripped = r;
  });

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = (phase: StallPhase, ms: number) => {
    clearTimer();
    if (disposed || cell.isClosed() || ms <= 0) return;
    armedAt = Date.now();
    timer = setTimeout(() => {
      const waited = Date.now() - armedAt;
      const err = onTrip(phase, waited);
      resolveTripped(err);
      fail(err);
      // Abort last: this makes the source throw, and `fail` above has already
      // recorded the error the consumer should actually see.
      controller.abort(err);
    }, ms);
    // Never hold the process open on the stall clock alone.
    (timer as { unref?: () => void }).unref?.();
  };

  const onCallerAbortEvent = () => {
    const err = onCallerAbort(callerSignal?.reason);
    resolveTripped(err);
    fail(err);
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbortEvent();
    else callerSignal.addEventListener("abort", onCallerAbortEvent, { once: true });
  }

  arm("first-chunk", firstChunkMs);

  // --- pump -----------------------------------------------------------------
  void (async () => {
    try {
      for await (const value of source) {
        arm("stall", stallMs);
        publish(value);
      }
      close();
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimer();
    }
  })();

  return {
    stream: cell.stream,
    tripped,
    dispose() {
      disposed = true;
      clearTimer();
      callerSignal?.removeEventListener("abort", onCallerAbortEvent);
    },
  };
}
