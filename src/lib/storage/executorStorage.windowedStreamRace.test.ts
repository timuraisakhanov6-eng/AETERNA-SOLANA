/**
 * R9-A87.9 — R1 / R2 / R3 LIFECYCLE REPAIRS.
 *
 * The R9-A87.8 audit found three residual lifecycle defects:
 *
 *   R1  `sweepIdle` closed a session whose window was still in flight, because
 *       it looked only at `lastUsed` (refreshed when a read STARTS and when it
 *       COMPLETES) and ignored the `busy` counter. The sweep runs before the
 *       per-key queue, so even a request that merely queued could kill a live
 *       read after 30 s.
 *   R2  `run` closed `sessions.get(key)` instead of the session it held, and
 *       the global disposal cleared the per-key `chains`, breaking the
 *       serialisation the module promises.
 *   R3  settled `chains` entries were never removed.
 *
 * These tests use a GATED response body (each `pull` parks until the test
 * releases it, and `freeRun()` lets the rest of the object flow) plus an
 * explicit clock through the reader's `now` seam, so the 30 s sweep window can
 * be crossed deterministically without sleeping and without relying on fake
 * `Date`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  HEADER_SIZE,
  serializeContainerHeader,
} from "@/lib/storage/container/containerLayout";
import {
  activeContainerChains,
  activeContainerStreams,
  disposeContainerWindowStreams,
  disposeContainerWindowStreamsFor,
  readContainerWindow,
  WINDOW_STREAM_IDLE_SESSION_MS,
} from "@/lib/storage/container/containerWindowStream";

const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;

function patternAt(abs: number): number {
  return abs % 251;
}

interface GatedBody {
  stream: ReadableStream<Uint8Array>;
  stats: { pulls: number; cancels: number };
  /** Releases exactly one parked pull (false when none is parked). */
  openOne: () => boolean;
  /** Stops gating: every current and future pull delivers immediately. */
  freeRun: () => void;
  /** Pulls currently parked. */
  parked: () => number;
}

function makeGatedBody(plan: {
  totalSize: number;
  headerChunkCount: number;
  sliceSize?: number;
}): GatedBody {
  const stats = { pulls: 0, cancels: 0 };
  const slice = plan.sliceSize ?? CHUNK;
  const waiters: Array<() => void> = [];
  let cursor = 0;
  let finished = false;
  let free = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulls += 1;

      const produce = (): void => {
        if (finished) return;

        const end = Math.min(cursor + slice, plan.totalSize);
        if (cursor >= end) {
          finished = true;
          controller.close();
          return;
        }

        const out = new Uint8Array(end - cursor);
        if (cursor < HEADER_SIZE) {
          const header = serializeContainerHeader(plan.headerChunkCount);
          const take = Math.min(HEADER_SIZE - cursor, out.byteLength);
          out.set(header.subarray(cursor, cursor + take), 0);
          for (let i = take; i < out.byteLength; i++) {
            out[i] = patternAt(cursor + i);
          }
        } else {
          for (let i = 0; i < out.byteLength; i++) {
            out[i] = patternAt(cursor + i);
          }
        }

        cursor = end;
        controller.enqueue(out);
      };

      if (free) {
        produce();
        return;
      }

      return new Promise<void>((resolve) => {
        waiters.push(() => {
          produce();
          resolve();
        });
      });
    },
    cancel() {
      stats.cancels += 1;
      finished = true;
      // A parked pull must never outlive the stream.
      for (const release of waiters.splice(0)) release();
    },
  });

  return {
    stream,
    stats,
    openOne: () => {
      const release = waiters.shift();
      if (!release) return false;
      release();
      return true;
    },
    freeRun: () => {
      free = true;
      for (const release of waiters.splice(0)) release();
    },
    parked: () => waiters.length,
  };
}

function makeResponse(init: {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  contentLength?: string | null;
}): Response {
  const headers = new Map<string, string>();
  headers.set("content-type", "application/octet-stream");
  if (init.contentLength !== undefined && init.contentLength !== null) {
    headers.set("content-length", init.contentLength);
  }
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    body: init.body ?? null,
    arrayBuffer: async () => {
      throw new Error("arrayBuffer() must never be used for a container");
    },
  } as unknown as Response;
}

const HINT = { size: 4 * MiB, chunkCount: 1 };

let bodies: GatedBody[];
let plainCalls: number;

beforeEach(() => {
  bodies = [];
  plainCalls = 0;
  disposeContainerWindowStreams();
  vi.useFakeTimers();

  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;

    if (headers !== undefined) {
      // Every RANGE attempt is a plain 200: this suite exists for the
      // streaming fallback.
      return Promise.resolve(makeResponse({ status: 200 }));
    }

    plainCalls += 1;
    const body = makeGatedBody({
      totalSize: HINT.size,
      headerChunkCount: HINT.chunkCount,
      sliceSize: CHUNK,
    });
    bodies.push(body);

    return Promise.resolve(
      makeResponse({
        status: 200,
        body: body.stream,
        contentLength: String(HINT.size),
      }),
    );
  }) as unknown as ReturnType<typeof vi.fn>;

  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  for (const body of bodies) body.freeRun();
  disposeContainerWindowStreams();
  await vi.advanceTimersByTimeAsync(0);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function windowRequest(
  txId: string,
  offset: number,
  length: number,
  now: () => number,
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    url: `https://gateway.irys.xyz/tx/${txId}/data`,
    txId,
    offset,
    length,
    hint: HINT,
    signal,
    now,
  };
}

/** Bounds-checked accessor: the test's bodies are created on demand. */
function bodyAt(index: number): GatedBody {
  const body = bodies[index];
  if (!body) throw new Error(`expected response body #${index} to exist`);
  return body;
}

function trap<T>(p: Promise<T>): Promise<T | Error> {
  return p.then(
    (value) => value,
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Lets every body flow and settles the microtask queue. */
async function drainBodies(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    for (const body of bodies) body.freeRun();
    await flush();
  }
}

/* ================================================================== *
 * R1 — the sweep must not close a busy session
 * ================================================================== */

describe("R9-A87.9 R1 — sweepIdle respects busy sessions", () => {
  it("R1.1: a second request 31 s into a read does NOT close the busy session", async () => {
    let clock = 1_000_000;
    const now = () => clock;

    const first = trap(
      readContainerWindow(windowRequest("r1-tx", HEADER_SIZE, 256, now)),
    );
    await flush();

    expect(bodies.length).toBe(1);
    expect(bodyAt(0).stats.pulls).toBe(1);
    expect(bodyAt(0).parked()).toBe(1);
    expect(activeContainerStreams()).toBe(1);

    // 31 s pass while the first window is genuinely in flight. `lastUsed`
    // still points at the start of that read.
    clock += WINDOW_STREAM_IDLE_SESSION_MS + 1_000;

    // The second request sweeps BEFORE queueing — this is the defect path.
    const second = trap(
      readContainerWindow(windowRequest("r1-tx", HEADER_SIZE + 256, 256, now)),
    );
    await flush();

    // R1 regression: the busy session is untouched by the sweep.
    expect(activeContainerStreams()).toBe(1);
    expect(bodyAt(0).stats.cancels).toBe(0);
    expect(activeContainerChains()).toBe(1);

    // Let the first window finish; the queued second one is served from the
    // SAME stream (no second GET).
    bodyAt(0).freeRun();
    const firstBytes = await first;
    expect(firstBytes).toBeInstanceOf(Uint8Array);
    expect((firstBytes as Uint8Array)[0]).toBe(patternAt(HEADER_SIZE));

    const secondBytes = await second;
    expect(secondBytes).toBeInstanceOf(Uint8Array);
    expect((secondBytes as Uint8Array)[0]).toBe(patternAt(HEADER_SIZE + 256));

    expect(plainCalls).toBe(1);
    expect(bodyAt(0).stats.cancels).toBe(0);

    await flush();
    disposeContainerWindowStreamsFor("r1-tx");
    expect(activeContainerStreams()).toBe(0);
  });

  it("R1.2: a genuinely IDLE session is still swept", async () => {
    let clock = 2_000_000;
    const now = () => clock;

    // Container A: one completed read leaves an idle session (busy === 0).
    const aRead = trap(
      readContainerWindow(windowRequest("idle-a", HEADER_SIZE, 256, now)),
    );
    await flush();
    bodyAt(0).freeRun();
    await aRead;
    expect(activeContainerStreams()).toBe(1);
    expect(bodyAt(0).stats.cancels).toBe(0);

    clock += WINDOW_STREAM_IDLE_SESSION_MS + 1_000;

    // Container B: starting a request sweeps. A is idle, so it must go.
    const bRead = trap(
      readContainerWindow(windowRequest("idle-b", HEADER_SIZE, 256, now)),
    );
    await flush();

    expect(activeContainerStreams()).toBe(1);
    expect(bodyAt(0).stats.cancels).toBe(1);

    bodyAt(1).freeRun();
    const bBytes = await bRead;
    expect(bBytes).toBeInstanceOf(Uint8Array);

    disposeContainerWindowStreams();
  });
});

/* ================================================================== *
 * R2 — session identity and global disposal
 * ================================================================== */

describe("R9-A87.9 R2 — identity and serialisation", () => {
  it("R2.1: global disposal does not let two requests for one key open two sessions", async () => {
    const now = () => 3_000_000;

    const first = trap(readContainerWindow(windowRequest("r2-tx", HEADER_SIZE, 256, now)));
    await flush();
    expect(activeContainerStreams()).toBe(1);

    // Global disposal closes the live session while its read is unwinding.
    disposeContainerWindowStreams();
    expect(activeContainerStreams()).toBe(0);

    // Two new requests for the SAME key, issued immediately.
    const second = trap(readContainerWindow(windowRequest("r2-tx", HEADER_SIZE, 256, now)));
    const third = trap(readContainerWindow(windowRequest("r2-tx", HEADER_SIZE + 256, 256, now)));
    await flush();

    // Serialisation preserved: at most one live session for the key.
    expect(activeContainerStreams()).toBeLessThanOrEqual(1);

    // THE DISCRIMINATING ASSERTION: with the per-key chain intact, the second
    // request opens ONE new stream and the third reuses it (GET 1 = the
    // disposed read, GET 2 = the new stream). If `chains.clear()` were still
    // there, each request would open its own stream: three GETs, and one of
    // the two would be orphaned by the registry overwrite.
    await flush();
    expect(plainCalls).toBeLessThanOrEqual(2);

    await drainBodies();
    expect(plainCalls).toBe(2);
    // Exactly two response bodies were ever created (the disposed read and
    // the one replacement stream). A broken queue produces a third body.
    expect(bodies.length).toBe(2);
    await first;
    await second;
    await third;

    await drainBodies();
    disposeContainerWindowStreamsFor("r2-tx");
    expect(activeContainerStreams()).toBe(0);
    await flush();
    expect(activeContainerChains()).toBe(0);
  });

  it("R2.2: a failing read never closes another container's live session", async () => {
    const now = () => 4_000_000;

    // A healthy, completed session on container A.
    const aRead = trap(readContainerWindow(windowRequest("keep-a", HEADER_SIZE, 256, now)));
    await flush();
    bodyAt(0).freeRun();
    await aRead;
    expect(activeContainerStreams()).toBe(1);

    // Container B fails: its body is cancelled mid-window by its own abort.
    const controller = new AbortController();
    const failing = trap(
      readContainerWindow(
        windowRequest("fail-b", HEADER_SIZE, 256, now, controller.signal),
      ),
    );
    await flush();
    expect(activeContainerStreams()).toBe(2);

    controller.abort();
    await flush();
    await failing;

    // B is gone, A is untouched.
    expect(bodyAt(0).stats.cancels).toBe(0);
    await flush();
    expect(activeContainerStreams()).toBe(1);

    disposeContainerWindowStreams();
  });
});

/* ================================================================== *
 * R3 — keyed chain cleanup
 * ================================================================== */

describe("R9-A87.9 R3 — keyed chain cleanup", () => {
  it("R3.1: a completed chain is removed", async () => {
    const now = () => 5_000_000;

    const pending = trap(readContainerWindow(windowRequest("clean-tx", HEADER_SIZE, 256, now)));
    await flush();
    expect(activeContainerChains()).toBe(1);

    bodyAt(0).freeRun();
    await pending;
    await flush();

    expect(activeContainerChains()).toBe(0);
    disposeContainerWindowStreams();
  });

  it("R3.2: a NEWER chain survives completion of an older one", async () => {
    const now = () => 6_000_000;

    const first = trap(readContainerWindow(windowRequest("order-tx", HEADER_SIZE, 256, now)));
    await flush();

    // Two chunks long, so it cannot be satisfied by the remainder of the
    // first chunk and therefore stays pending after the first read finishes.
    const second = trap(
      readContainerWindow(windowRequest("order-tx", HEADER_SIZE + 256, 2 * CHUNK, now)),
    );
    await flush();

    // One entry per key: the newest registered chain.
    expect(activeContainerChains()).toBe(1);

    // Release exactly ONE chunk: enough for the first window, not for the
    // 2-chunk second window, which therefore stays genuinely pending.
    bodyAt(0).openOne();
    await first;
    await flush();

    // The older chain's cleanup must NOT delete the newer one.
    expect(activeContainerChains()).toBe(1);

    await drainBodies();
    const secondBytes = await second;
    expect(secondBytes).toBeInstanceOf(Uint8Array);
    await flush();

    expect(activeContainerChains()).toBe(0);
    disposeContainerWindowStreams();
  });

  it("R3.3: different containers keep independent chains", async () => {
    const now = () => 7_000_000;

    const a = trap(readContainerWindow(windowRequest("ind-a", HEADER_SIZE, 256, now)));
    const b = trap(readContainerWindow(windowRequest("ind-b", HEADER_SIZE, 256, now)));
    await flush();

    expect(activeContainerStreams()).toBe(2);
    expect(activeContainerChains()).toBe(2);

    await drainBodies();
    await a;
    await b;
    await flush();

    expect(activeContainerChains()).toBe(0);
    disposeContainerWindowStreams();
  });

  it("R3.4: cleanup also happens after cancellation and after failure", async () => {
    const now = () => 8_000_000;

    // Cancellation.
    const controller = new AbortController();
    const cancelled = trap(
      readContainerWindow(
        windowRequest("cancel-tx", HEADER_SIZE, 256, now, controller.signal),
      ),
    );
    await flush();
    expect(activeContainerChains()).toBe(1);

    controller.abort();
    await flush();
    await cancelled;
    await flush();
    expect(activeContainerChains()).toBe(0);

    // Failure: the body never delivers a full window and is torn down.
    const failing = trap(
      readContainerWindow(windowRequest("fail-tx", HEADER_SIZE, 4096, now)),
    );
    await flush();
    expect(activeContainerChains()).toBe(1);

    disposeContainerWindowStreamsFor("fail-tx");
    await flush();
    await failing;
    await flush();
    expect(activeContainerChains()).toBe(0);

    disposeContainerWindowStreams();
  });
});
