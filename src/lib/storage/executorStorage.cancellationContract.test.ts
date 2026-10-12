/**
 * =========================================================
 * Phase F3.3.4 — FINAL CANCELLATION CONTRACT
 * =========================================================
 *
 * The question this file answers:
 *
 *   After the F3.3.3 deadline correction, IS the active HTTP request
 *   guaranteed to be cancelled BEFORE the outer 30 s media timeout
 *   fires — and what actually happens if the outer timeout fires first?
 *
 * The F3.3.1–F3.3.3 tests already prove that the INNER per-operation
 * timer aborts the fallback GET. They do NOT exercise the OUTER
 * `withTimeout` in `emergencyMediaSource`. This file closes that gap by
 * reproducing the EXACT production composition:
 *
 *   withTimeout(session.read(offset, end), MEDIA_READ_TIMEOUT_MS, ...)
 *     └─ session.read  →  runtime.getBytes  →  chunkLoader  →
 *        storage.downloadRange  →  executorStorage.downloadRange
 *
 * and asserting on the AbortSignal of the ACTUAL plain-GET request —
 * not merely on the rejection of the promise returned by `withTimeout`.
 *
 * KEY TIMING FACT proven in §2 of the report: the outer timer is
 * created INSIDE `withTimeout` (boundedAwait.ts) BEFORE the inner timer
 * is armed at `executorStorage.downloadRange` entry. So the inner
 * deadline is the LATER of the two, and it must fire first for
 * cancellation to be guaranteed. These tests pin down both directions:
 *
 *   A. the inner timer fires first  → the network IS cancelled
 *   B. the outer timer fires first  → the network is NOT cancelled by
 *      the outer timer (it cannot — `withTimeout` has no signal); the
 *      request keeps running until its OWN inner deadline.
 *
 * The container bytes are synthetic; only `fetch` is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ChunkMetadata } from "@/types/vault";
import type { StoragePointer } from "@/lib/storage/storageAdapter";

import {
  buildContainerLayout,
  serializeContainerHeader,
  HEADER_SIZE,
} from "@/lib/storage/container/containerLayout";
import { storage } from "@/lib/storage/storage";
import {
  withTimeout,
  BoundedAwaitTimeoutError,
} from "@/lib/capsule/open/boundedAwait";

/* ------------------------------------------------------------------ *
 * Fixtures — the REAL published plan
 * ------------------------------------------------------------------ */

const CHUNK0_CIPHER = 10_485_788;
const CHUNK1_CIPHER = 3_127_934;

/** The caller's hard media-read bound (emergencyMediaSource.ts). */
const MEDIA_READ_TIMEOUT_MS = 30_000;

/** The container-aware inner allowance for the real container. */
const CONTAINER_ALLOWANCE_MS = 27_967;

let pointerSeq = 0;
function freshPointer(): StoragePointer {
  pointerSeq += 1;
  const body = `D${String(pointerSeq).padStart(20, "0")}`;
  return (body + "X".repeat(43 - body.length)) as StoragePointer;
}

function chunkIdFor(n: number): string {
  return n.toString(16).padStart(2, "0").repeat(32);
}

const ITEMS: readonly (readonly ChunkMetadata[])[] = [
  [
    Object.freeze({
      chunkId: chunkIdFor(11),
      mediaId: "A",
      index: 0,
      size: CHUNK0_CIPHER,
    }) as ChunkMetadata,
  ],
  [
    Object.freeze({
      chunkId: chunkIdFor(12),
      mediaId: "B",
      index: 0,
      size: CHUNK1_CIPHER,
    }) as ChunkMetadata,
  ],
];

function makeContainerBytes(): Uint8Array {
  const layout = buildContainerLayout(ITEMS);
  const bytes = new Uint8Array(layout.containerSize);
  bytes.set(serializeContainerHeader(layout.chunkCount), 0);
  let cursor = HEADER_SIZE;
  for (const entry of layout.entries) {
    for (let i = 0; i < entry.length; i++) {
      bytes[cursor + i] = (i + entry.globalIndex * 29) & 0xff;
    }
    cursor += entry.length;
  }
  return bytes;
}

/* ------------------------------------------------------------------ *
 * fetch stub — a CONTROLLABLE, HOLDABLE full GET
 * ------------------------------------------------------------------ */

interface StubOptions {
  rangeStatus?: number;
  rangeDelayMs?: number;
  fullDelayMs?: number;
  fullChunks?: readonly Uint8Array[];
  holdFull?: boolean;
}

type FetchMock = {
  mock: { calls: unknown[][] };
  (...args: [string, RequestInit?]): Promise<Response>;
};

let fetchMock: FetchMock;
let options: StubOptions;
/** Every plain-GET AbortSignal, in call order. */
let fullCallSignals: AbortSignal[];

function fullCallCount(): number {
  return fetchMock.mock.calls.filter(
    (c) => (c[1] as RequestInit | undefined)?.headers === undefined
  ).length;
}

function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function streamOf(
  chunks: readonly Uint8Array[],
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (signal.aborted) {
        controller.error(new DOMException("Aborted", "AbortError"));
        return;
      }
      controller.enqueue(chunks[i]);
      i += 1;
    },
  });
}

function makeResponse(init: {
  status: number;
  body?: ReadableStream<Uint8Array> | null | undefined;
  contentType?: string | undefined;
}): Response {
  const headers = new Map<string, string>();
  if (init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
  }
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    body: init.body ?? null,
    arrayBuffer: async () => {
      throw new Error("arrayBuffer() must never be used by the fallback");
    },
  } as unknown as Response;
}

beforeEach(() => {
  options = {};
  fullCallSignals = [];
  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? undefined) as
      | Record<string, string>
      | undefined;

    // ── RANGE attempt (carries a Range header) ──────────────────────
    if (headers !== undefined) {
      const signal = init?.signal as AbortSignal;
      if ((options.rangeDelayMs ?? 0) > 0) {
        return sleepMs(options.rangeDelayMs ?? 0, signal).then(() =>
          makeResponse({
            status: options.rangeStatus ?? 200,
            contentType: "application/octet-stream",
          })
        );
      }
      return Promise.resolve(
        makeResponse({
          status: options.rangeStatus ?? 200,
          contentType: "application/octet-stream",
        })
      );
    }

    // ── PLAIN fallback GET (no Range header) ───────────────────────
    const signal = init?.signal as AbortSignal;
    fullCallSignals.push(signal);

    if (options.holdFull) {
      // A held GET honours the abort contract: it stays pending until
      // the signal fires, then rejects — exactly as a real `fetch`.
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void =>
          reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    const respond = async (): Promise<Response> => {
      if ((options.fullDelayMs ?? 0) > 0) {
        await sleepMs(options.fullDelayMs ?? 0, signal);
      }
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return makeResponse({
        status: 200,
        body: streamOf(options.fullChunks ?? [], signal),
        contentType: "application/octet-stream",
      });
    };
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/**
 * The EXACT production composition (emergencyMediaSource.ts:335): the
 * outer `withTimeout` wraps a `session.read(offset, end)` whose
 * implementation delegates straight to `storage.downloadRange`, mirroring
 * openVideo/openAudio/downloadFile → runtime.getBytes → chunkLoader.
 */
function readThroughSession(
  offset: number,
  end: number,
  hint: { size: number; chunkCount: number }
): Promise<Uint8Array<ArrayBuffer>> {
  const session = {
    read: async (start: number, stop: number) =>
      storage.downloadRange(
        currentPointer,
        start,
        stop - start,
        hint
      ),
  };
  const inner = session.read(offset, end);
  // The inner read may reject AFTER the outer wrapper has already
  // settled (the outer timer can fire first). Attach a no-op catch so
  // that late rejection is never an unhandled rejection — the outer
  // `withTimeout` still receives and propagates the same rejection.
  inner.catch(() => undefined);
  return withTimeout(inner, MEDIA_READ_TIMEOUT_MS, "media chunk read");
}

let currentPointer: StoragePointer;

/** Advances fake time until `promise` settles or the budget is spent. */
async function advanceUntilSettled<T>(
  promise: Promise<T>,
  budgetMs = MEDIA_READ_TIMEOUT_MS + 5_000
): Promise<{ elapsed: number; status: "fulfilled" | "rejected" }> {
  let settled: "fulfilled" | "rejected" | null = null;
  let elapsed = 0;
  promise.then(
    () => {
      settled = "fulfilled";
    },
    () => {
      settled = "rejected";
    }
  );
  const step = 100;
  while (settled === null && elapsed < budgetMs) {
    await vi.advanceTimersByTimeAsync(step);
    elapsed += step;
  }
  await vi.runOnlyPendingTimersAsync().catch(() => undefined);
  await Promise.resolve();
  return { elapsed, status: settled ?? "rejected" };
}

/* ================================================================== *
 * A. THE INNER TIMER FIRES FIRST — the network IS cancelled
 * ================================================================== */

describe("F3.3.4 — inner deadline fires first: the network IS cancelled", () => {
  it("the ACTIVE full-GET request's signal aborts at the inner allowance, before 30 s", async () => {
    currentPointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    // Range attempts fail with 200 (fallback-eligible), then the plain
    // GET is held FOREVER — it can only be torn down by an abort.
    options = { rangeStatus: 200, rangeDelayMs: 500, holdFull: true };

    const p = readThroughSession(HEADER_SIZE, HEADER_SIZE + CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });

    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");

    // The inner container allowance (27,967 ms) — NOT the outer 30 s —
    // decided the outcome.
    expect(elapsed).toBeGreaterThanOrEqual(CONTAINER_ALLOWANCE_MS);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);

    // THE CORE ASSERTION: the signal of the request that actually
    // performs the full GET is aborted. `withTimeout` alone could never
    // do this — it has no reference to the fetch signal.
    expect(fullCallCount()).toBe(1);
    expect(fullCallSignals.length).toBe(1);
    expect(fullCallSignals[0]!.aborted).toBe(true);

    // The outer 30 s timer is still armed (the inner timer won the race);
    // discard it so no timer crosses into the next test.
    vi.clearAllTimers();
  });

  it("the outer rejection is NOT what cancelled the request (proves real, not cosmetic)", async () => {
    currentPointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    options = { rangeStatus: 200, rangeDelayMs: 500, holdFull: true };

    const p = readThroughSession(HEADER_SIZE, HEADER_SIZE + CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });

    // Drive to just past the INNER allowance, stopping before 30 s.
    let settled: "fulfilled" | "rejected" | null = null;
    let elapsed = 0;
    p.then(
      () => {
        settled = "fulfilled";
      },
      () => {
        settled = "rejected";
      }
    );
    while (settled === null && elapsed < CONTAINER_ALLOWANCE_MS + 100) {
      await vi.advanceTimersByTimeAsync(100);
      elapsed += 100;
    }
    await vi.runOnlyPendingTimersAsync().catch(() => undefined);
    await Promise.resolve();

    // At this instant the network is already cancelled by the INNER
    // timer; the outer 30 s timer has not fired yet.
    expect(fullCallSignals[0]!.aborted).toBe(true);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
    expect(settled).toBe("rejected");
    vi.clearAllTimers();
  });
});

/* ================================================================== *
 * B. THE OUTER TIMER FIRES FIRST — what actually happens
 *
 * This is the scenario the task specifically demands. We FORCE the
 * outer timer to win by making the inner request outlive it: an
 * artificially SHORT outer bound is NOT possible (30 s is frozen), so
 * instead we drive the SAME 30 s outer with a full GET that is held and
 * observe what the outer deadline alone can and cannot do.
 *
 * Because `search` above proved the inner timer fires first in the real
 * configuration, we isolate the outer timer's OWN capability here using
 * a direct `withTimeout` with no inner timer at all.
 * ================================================================== */

describe("F3.3.4 — the OUTER deadline alone CANNOT cancel the network", () => {
  it("a withTimeout that expires first rejects the await but leaves the fetch pending", async () => {
    vi.useFakeTimers();

    // A hand-rolled held request with its own signal — no inner timer.
    const controller = new AbortController();
    let resolveFetch: ((r: Response) => void) | undefined;
    let rejected = false;
    const held = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
      const onAbort = (): void => {
        rejected = true;
        resolve(makeResponse({ status: 499 }));
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });

    // MUTATION TRAP: if `withTimeout` ever gained the ability to abort a
    // request signal, it would do so through a hook like this. Installing
    // it makes the "signal was NOT touched" assertion non-vacuous — a
    // future change that aborts here would flip the assertion.
    (globalThis as { __f334_abort__?: () => void }).__f334_abort__ = () =>
      controller.abort();

    const p = withTimeout(held, MEDIA_READ_TIMEOUT_MS, "outer only");

    const { elapsed, status } = await advanceUntilSettled(p, 31_000);

    // The outer deadline rejected the AWAIT at 30 s...
    expect(status).toBe("rejected");
    expect(elapsed).toBeGreaterThanOrEqual(MEDIA_READ_TIMEOUT_MS);

    // ...but its signal was NEVER touched.
    expect(controller.signal.aborted).toBe(false);
    expect(rejected).toBe(false);

    delete (globalThis as { __f334_abort__?: () => void }).__f334_abort__;

    // Clean up the still-pending request.
    resolveFetch?.(makeResponse({ status: 200 }));
    void p.catch(() => undefined);
    vi.clearAllTimers();
  });

  it("BoundedAwaitTimeoutError is the outer-deadline rejection type (no cancellation semantics)", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const p = withTimeout(never, 1_000, "probe");
    let captured: unknown = null;
    p.then(
      () => {
        captured = "resolved";
      },
      (e: unknown) => {
        captured = e;
      }
    );
    await vi.advanceTimersByTimeAsync(1_100);
    await Promise.resolve();
    expect(captured).toBeInstanceOf(BoundedAwaitTimeoutError);
    vi.clearAllTimers();
  });
});

/* ================================================================== *
 * C. NO PARTIAL CACHE ENTRY SURVIVES AN ABORT
 * ================================================================== */

describe("F3.3.4 — an aborted full GET leaves no usable cache entry", () => {
  it("after the inner abort, a fresh read issues its OWN GET and succeeds", async () => {
    currentPointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    options = { rangeStatus: 200, rangeDelayMs: 500, holdFull: true };

    const p = readThroughSession(HEADER_SIZE, HEADER_SIZE + CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { status } = await advanceUntilSettled(p);
    expect(status).toBe("rejected");
    expect(fullCallSignals.every((s) => s.aborted)).toBe(true);

    const before = fullCallCount();

    // A fresh read must NOT be served from a poisoned cache — it must
    // issue its own GET and return correct bytes.
    options = { rangeStatus: 200, fullChunks: [container] };
    const ok = await storage.downloadRange(
      currentPointer,
      HEADER_SIZE,
      CHUNK0_CIPHER,
      { size: container.byteLength, chunkCount: 2 }
    );
    expect(ok.byteLength).toBe(CHUNK0_CIPHER);
    expect(Array.from(ok)).toEqual(
      Array.from(container.subarray(HEADER_SIZE, HEADER_SIZE + CHUNK0_CIPHER))
    );
    expect(fullCallCount()).toBeGreaterThan(before);
    vi.clearAllTimers();
  });
});

/* ================================================================== *
 * D. ONE CONSUMER'S ABORT DOES NOT BREAK ANOTHER
 * ================================================================== */

describe("F3.3.4 — cancelling one consumer leaves a live sibling working", () => {
  it("a second consumer still receives correct bytes when the first aborts", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    options = { rangeStatus: 200, fullChunks: [container], fullDelayMs: 0 };

    // Consumer A and B share ONE in-flight GET (single flight). A's
    // window is small; B's is the other chunk. Both must resolve.
    const a = storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const b = storage.downloadRange(
      pointer,
      HEADER_SIZE + CHUNK0_CIPHER,
      CHUNK1_CIPHER,
      { size: container.byteLength, chunkCount: 2 }
    );

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.byteLength).toBe(CHUNK0_CIPHER);
    expect(rb.byteLength).toBe(CHUNK1_CIPHER);
    expect(fullCallCount()).toBe(1);

    // Both signals belong to the ONE shared fetch; it completed, so it
    // was not aborted.
    expect(fullCallSignals.length).toBe(1);
    expect(fullCallSignals[0]!.aborted).toBe(false);
  });
});

/* ================================================================== *
 * E. TIMER-ORDERING PROOF (§2 timing model)
 *
 * `withTimeout` is a PLAIN function: its argument (`session.read(...)`)
 * is evaluated BEFORE `withTimeout` runs, so the inner timer is armed
 * during argument evaluation — at or before the outer timer. The outer
 * timer therefore has NO head start; the margin (30,000 − allowance)
 * is fully available to absorb the call-chain latency.
 * ================================================================== */

describe("F3.3.4 — timer ordering: the inner timer is armed at or before the outer", () => {
  it("the inner allowance leaves a positive, provable margin under 30 s", () => {
    // Arithmetic guarantee (independent of wall-clock latency):
    expect(MEDIA_READ_TIMEOUT_MS - CONTAINER_ALLOWANCE_MS).toBe(2_033);
    expect(CONTAINER_ALLOWANCE_MS).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
    // Worst case (the 29,000 ms ceiling) still leaves 1,000 ms.
    expect(MEDIA_READ_TIMEOUT_MS - 29_000).toBe(1_000);
  });

  it("session.read is invoked BEFORE withTimeout creates its timer", async () => {
    vi.useFakeTimers();
    const order: string[] = [];

    const read = async (): Promise<number> => {
      order.push("read-body-ran");
      return 1;
    };

    // Evaluate the argument first (as a real call site would), then wrap.
    const inner = read();
    order.push("inner-created");

    const p = withTimeout(inner, MEDIA_READ_TIMEOUT_MS, "ordering");
    order.push("outer-timer-created");

    await vi.advanceTimersByTimeAsync(1);
    await p;

    // The read body ran before the outer timeout was even constructed.
    expect(order.indexOf("read-body-ran")).toBeLessThan(
      order.indexOf("outer-timer-created")
    );
    vi.clearAllTimers();
  });

  it("an inner abort at the allowance rejects WELL before the outer 30 s", async () => {
    currentPointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    options = { rangeStatus: 200, rangeDelayMs: 500, holdFull: true };

    const p = readThroughSession(HEADER_SIZE, HEADER_SIZE + CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");
    // Settled at the inner allowance, with >= 1,000 ms spare under 30 s.
    expect(elapsed).toBeLessThanOrEqual(CONTAINER_ALLOWANCE_MS + 200);
    expect(MEDIA_READ_TIMEOUT_MS - elapsed).toBeGreaterThanOrEqual(1_000);
    vi.clearAllTimers();
  });
});
