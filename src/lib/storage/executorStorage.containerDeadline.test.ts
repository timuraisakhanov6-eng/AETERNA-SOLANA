/**
 * =========================================================
 * Phase F3.3.1 / F3.3.2 — CONTAINER-AWARE FALLBACK DEADLINE
 * =========================================================
 *
 * The F3.3 fallback downloads the WHOLE container, but it originally
 * shared a deadline derived from the REPLACED CHUNK WINDOW. On the real
 * plan (512 KiB/s floor):
 *
 *   d(chunk1 window 3,127,934 B) =  5,967 ms
 *   full container 13,613,786 B  = 25,967 ms to transfer
 *
 * F3.3.1 fixed the SIZE mismatch (window → container). F3.3.2 fixes the
 * remaining CEILING mismatch: `rangeDownloadDeadlineMs` clamps at 24,000
 * ms, which still truncated the real container ~2 s early.
 *
 * These tests drive the REAL `executorStorage.downloadRange` (through
 * the real `storage` façade) with `fetch` stubbed and fake timers, and
 * pin down the corrected contract:
 *
 *   • the ONE operation deadline becomes container-aware when — and
 *     only when — a valid in-ceiling container hint is supplied, sized
 *     to the CONTAINER's true need (25,967 ms transfer + 1,000 ms
 *     Range-phase reserve + 1,000 ms completion reserve = 27,967 ms)
 *     and NOT clamped to the 24 s range ceiling;
 *   • the container path may exceed 24,000 ms but never the absolute
 *     30,000 ms operation budget;
 *   • elapsed Range time is SUBTRACTED from the fallback's budget
 *     (the timer is never reset at the fallback transition);
 *   • the whole operation never exceeds the outer 30 s bound;
 *   • parallel consumers of one container share ONE plain GET, and
 *     independent cancellation never breaks a live consumer;
 *   • a timeout/cancel leaves no pending request, no cache entry and no
 *     retained buffer;
 *   • the body is still bounded DURING streaming (no arrayBuffer());
 *   • every integrity gate (length / header / chunkCount) still applies.
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
  CONTAINER_FULL_FALLBACK_MAX_BYTES,
  rangeDownloadDeadlineMs,
  containerRangeDeadlineMs,
} from "@/lib/storage/executorStorage";

/* ------------------------------------------------------------------ *
 * Fixtures — the REAL published plan
 * ------------------------------------------------------------------ */

const CHUNK0_CIPHER = 10_485_788;
const CHUNK1_CIPHER = 3_127_934;
const CONTAINER_SIZE = 64 + CHUNK0_CIPHER + CHUNK1_CIPHER; // 13,613,786

/** The caller's hard media-read bound. */
const MEDIA_READ_TIMEOUT_MS = 30_000;

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
 * fetch stub — a CONTROLLABLE-DELAY full GET
 *
 * The plain GET resolves only after `fullDelayMs` of FAKE time, so a
 * test can prove whether the operation's own deadline or a delayed body
 * decides the outcome.
 * ------------------------------------------------------------------ */

interface StubOptions {
  /** Status returned for every RANGE attempt. */
  rangeStatus?: number;
  /** Delay, in fake ms, before EACH range attempt resolves. */
  rangeDelayMs?: number;
  /** Delay, in fake ms, before the plain GET resolves. */
  fullDelayMs?: number;
  /** Body chunks for the plain GET (streamed one by one). */
  fullChunks?: readonly Uint8Array[];
  /** Delay, in fake ms, between body chunks once streaming starts. */
  streamDelayMs?: number;
  /** Never resolve the plain GET (for cancellation tests). */
  holdFull?: boolean;
  /** Reject the plain GET at the transport layer. */
  fullRejects?: boolean;
  /** `content-length` for the plain GET (early-reject path). */
  fullContentLength?: string | null | undefined;
}

/** A permissive mock type — this vitest's `vi.fn` is generic-invariant. */
type FetchMock = {
  mock: { calls: unknown[][] };
  (...args: [string, RequestInit?]): Promise<Response>;
};

let fetchMock: FetchMock;
let options: StubOptions;
let activeSignals: AbortSignal[];
let fullCallSignals: AbortSignal[];

function fullCallCount(): number {
  return fetchMock.mock.calls.filter(
    (c) => (c[1] as RequestInit | undefined)?.headers === undefined
  ).length;
}

/** Sleep in FAKE time, aborting early if the signal fires. */
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
  signal: AbortSignal,
  gapMs: number
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        if (gapMs > 0) await sleepMs(gapMs, signal);
        if (signal.aborted) {
          controller.error(new DOMException("Aborted", "AbortError"));
          return;
        }
        controller.enqueue(chunks[i]);
        i += 1;
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function makeResponse(init: {
  status: number;
  body?: ReadableStream<Uint8Array> | null | undefined;
  contentType?: string | undefined;
  contentLength?: string | null | undefined;
}): Response {
  const headers = new Map<string, string>();
  if (init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
  }
  if (init.contentLength !== undefined && init.contentLength !== null) {
    headers.set("content-length", init.contentLength);
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
  activeSignals = [];
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
    activeSignals.push(signal);

    if (options.fullRejects) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }

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
        body: streamOf(
          options.fullChunks ?? [],
          signal,
          options.streamDelayMs ?? 0
        ),
        contentType: "application/octet-stream",
        contentLength: options.fullContentLength,
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
  // Drain microtasks so `.then` handlers run.
  await vi.runOnlyPendingTimersAsync().catch(() => undefined);
  await Promise.resolve();
  return { elapsed, status: settled ?? "rejected" };
}

/* ================================================================== *
 * PURE MAPPING
 * ================================================================== */

describe("containerRangeDeadlineMs — the size→budget mapping", () => {
  it("never SHORTENS a window budget", () => {
    expect(
      containerRangeDeadlineMs(CHUNK0_CIPHER, CONTAINER_SIZE)
    ).toBeGreaterThanOrEqual(rangeDownloadDeadlineMs(CHUNK0_CIPHER));
    // A large window whose own need dominates is preserved.
    expect(containerRangeDeadlineMs(24_000_000, 1_000)).toBe(24_000);
  });

  it("sizes the budget for the CONTAINER, NOT clamped to the 24 s range ceiling", () => {
    // The F3.3.1 defect: a small chunk window got 5,967 ms.
    expect(rangeDownloadDeadlineMs(CHUNK1_CIPHER)).toBe(5_967);
    // The F3.3.2 defect: the container allowance was clamped to the 24 s
    // RANGE ceiling. F3.3.3 further requires a real completion reserve:
    // transfer (25,967) + range reserve (1,000) + completion (1,000)
    // = 27,967 ms.
    expect(containerRangeDeadlineMs(CHUNK1_CIPHER, CONTAINER_SIZE)).toBe(27_967);
    expect(containerRangeDeadlineMs(CHUNK1_CIPHER, CONTAINER_SIZE)).toBeGreaterThan(
      rangeDownloadDeadlineMs(CONTAINER_SIZE) // 24,000 — the old clamp
    );
  });

  it("leaves REAL headroom over the true operation need", () => {
    // True need = Range phase (1,000) + honest transfer (25,967) =
    // 26,967 ms. The allowance MUST exceed it, not equal it.
    const allowance = containerRangeDeadlineMs(CHUNK1_CIPHER, CONTAINER_SIZE);
    expect(allowance).toBe(27_967);
    // Strictly greater — an EQUAL value would leave zero headroom and
    // reproduce the F3.3.2 defect.
    expect(allowance).toBeGreaterThan(26_967);
  });

  it("stays strictly inside the caller's 30 s bound", () => {
    const d = containerRangeDeadlineMs(CHUNK1_CIPHER, CONTAINER_SIZE);
    expect(d).toBe(27_967);
    expect(d).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });

  it("caps the maximal fallback size (20 MiB) just below the budget", () => {
    // 20 MiB + reserve at the 512 KiB/s floor is ~41,000 ms — more than
    // any single operation may take. It is clamped to budget-1 s
    // (29,000 ms), still strictly inside the 30 s absolute lifetime.
    expect(containerRangeDeadlineMs(1, CONTAINER_FULL_FALLBACK_MAX_BYTES)).toBe(29_000);
    expect(containerRangeDeadlineMs(1, CONTAINER_FULL_FALLBACK_MAX_BYTES)).toBeLessThan(
      MEDIA_READ_TIMEOUT_MS
    );
  });

  it("keeps the small-window floor for a tiny container", () => {
    expect(containerRangeDeadlineMs(1, 64)).toBe(5_000);
  });
});

/* ================================================================== *
 * THE CORE REGRESSION
 * ================================================================== */

describe("F3.3.1 — the fallback is no longer truncated by a chunk-sized budget", () => {
  it("REPRODUCES the defect: a plain range read keeps the small window budget", async () => {
    // No hint → the pre-existing (correct-for-range) behaviour: a range
    // read whose gateway never answers aborts on the ~5.97 s window
    // budget and never reaches a container-sized allowance.
    const pointer = freshPointer();
    vi.useFakeTimers();
    options = { rangeStatus: 200, holdFull: true };

    const p = storage.downloadRange(pointer, HEADER_SIZE + CHUNK0_CIPHER, CHUNK1_CIPHER);
    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");
    // A range-only read is still governed by its own small budget.
    expect(elapsed).toBeLessThan(10_000);

    // Drain.
    vi.clearAllTimers();
  });

  it("a hint-sized container read outlives the CHUNK budget (the fix)", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    // The plain GET takes 12 s — well past the ~5.97 s CHUNK budget, but
    // comfortably inside the container-sized budget. It must SUCCEED.
    options = {
      rangeStatus: 200,
      fullDelayMs: 12_000,
      fullChunks: [container],
    };

    const p = storage.downloadRange(pointer, HEADER_SIZE + CHUNK0_CIPHER, CHUNK1_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { elapsed, status } = await advanceUntilSettled(p);

    await expect(p).resolves.toBeInstanceOf(Uint8Array);
    expect(status).toBe("fulfilled");
    expect(elapsed).toBeGreaterThanOrEqual(12_000);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
    expect(fullCallCount()).toBe(1);
  });
});

/* ================================================================== *
 * ELAPSED RANGE TIME IS SUBTRACTED
 * ================================================================== */

describe("F3.3.1 — already-spent Range time is subtracted from the budget", () => {
  it("DECISIVELY proves the timer is not reset: budget is a single absolute lifetime", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    // The container budget is 27,967 ms (F3.3.3). Spend 1,500 ms per
    // gateway attempt in the RANGE phase (3,000 ms total), then the
    // fallback body needs 26,000 ms more: 3 + 26 = 29 s total — PAST the
    // single 27.967 s lifetime but still inside the caller's 30 s. If the
    // fallback were granted a FRESH budget it would succeed; because the
    // deadline is ONE absolute lifetime that is never reset, it must
    // ABORT at ~27.967 s, i.e. BEFORE the body's 29 s completion.
    options = {
      rangeStatus: 200,
      rangeDelayMs: 1_500,
      fullDelayMs: 26_000,
      fullChunks: [container],
    };

    const p = storage.downloadRange(pointer, HEADER_SIZE + CHUNK0_CIPHER, CHUNK1_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");
    // Aborted at the SINGLE absolute deadline (27,967 ms) — NOT at
    // 3,000 + 27,967 = 30,967 ms, and strictly inside 30 s.
    expect(elapsed).toBeGreaterThanOrEqual(27_967);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });

  it("a body that fits INSIDE the single budget still succeeds", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    options = {
      rangeStatus: 200,
      fullDelayMs: 15_000,
      fullChunks: [container],
    };

    const p = storage.downloadRange(pointer, HEADER_SIZE + CHUNK0_CIPHER, CHUNK1_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { elapsed, status } = await advanceUntilSettled(p);

    await expect(p).resolves.toBeInstanceOf(Uint8Array);
    expect(status).toBe("fulfilled");
    expect(elapsed).toBeLessThan(27_967);
  });

  it("aborts a fallback whose body would overrun the container budget", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    // The body would only finish at ~40 s — the container budget
    // (27,967 ms) must abort it, and the abort must land strictly before
    // the outer 30 s media bound.
    options = {
      rangeStatus: 200,
      fullDelayMs: 40_000,
      fullChunks: [container],
    };

    const p = storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");
    // Aborted by the operation deadline, still before the outer bound.
    expect(elapsed).toBeGreaterThanOrEqual(27_967);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });
});

/* ================================================================== *
 * SHARED FETCH + INDEPENDENT CANCELLATION
 * ================================================================== */

describe("F3.3.1 — parallel consumers share one GET and cancel independently", () => {
  it("two parallel chunk reads of one container use ONE plain GET", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };

    const [a, b] = await Promise.all([
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
        size: container.byteLength,
        chunkCount: 2,
      }),
      storage.downloadRange(pointer, HEADER_SIZE + CHUNK0_CIPHER, CHUNK1_CIPHER, {
        size: container.byteLength,
        chunkCount: 2,
      }),
    ]);

    expect(a.byteLength).toBe(CHUNK0_CIPHER);
    expect(b.byteLength).toBe(CHUNK1_CIPHER);
    expect(fullCallCount()).toBe(1);
  });

  it("the deadline abort reaches the shared full GET: no pending request survives", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    // The plain GET never resolves on its own; it must be torn down by
    // the operation deadline.
    options = { rangeStatus: 200, holdFull: true };

    const p = storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });

    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");
    // The held request must have been observed and then aborted by the
    // operation deadline — never left dangling.
    expect(fullCallSignals.length).toBeGreaterThan(0);
    expect(fullCallSignals.every((s) => s.aborted)).toBe(true);
    // Aborted by the container budget (27,967 ms), strictly inside 30 s.
    expect(elapsed).toBeGreaterThanOrEqual(27_967);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });
});

/* ================================================================== *
 * STREAMING + INTEGRITY ARE UNCHANGED
 * ================================================================== */

describe("F3.3.1 — streaming bound and integrity gates still hold", () => {
  it("still streams: a body exceeding the ceiling is cancelled, not buffered", async () => {
    const pointer = freshPointer();
    // A header-declared size over the ceiling is rejected with the
    // ORIGINAL error and produces no successful read.
    options = {
      rangeStatus: 200,
      fullContentLength: String(CONTAINER_FULL_FALLBACK_MAX_BYTES + 1),
      fullChunks: [new Uint8Array(1024)],
    };

    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
        size: CONTAINER_FULL_FALLBACK_MAX_BYTES + 1,
        chunkCount: 2,
      })
    ).rejects.toBeDefined();
  });

  it("still rejects a body whose length disagrees with the trusted hint", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    // Advertise a longer container than the body provides.
    options = { rangeStatus: 200, fullChunks: [container] };

    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
        size: container.byteLength + 1,
        chunkCount: 2,
      })
    ).rejects.toBeDefined();
  });

  it("still rejects a header chunkCount that disagrees with the hint", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };

    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
        size: container.byteLength,
        chunkCount: 3,
      })
    ).rejects.toBeDefined();
  });

  it("still never accepts a 200 range response as the window", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    // full GET also returns a 200 with NO body → fallback fails closed.
    options = { rangeStatus: 200, fullChunks: [] };

    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
        size: container.byteLength,
        chunkCount: 2,
      })
    ).rejects.toBeDefined();
  });
});

/* ================================================================== *
 * F3.3.2 — THE MANDATED CONTROLLED SCENARIO
 *
 * Container V1: 13,613,786 B. Floor speed 512 KiB/s → ~25,967 ms of
 * body transfer. Initial Range attempts consume 1,000 ms in total.
 * Absolute operation budget: 30,000 ms.
 *
 * The former 24,000 ms clamp truncated this healthy read ~2 s early.
 * ================================================================== */

/**
 * ==================================================================
 * F3.3.2 / F3.3.3 — THE MANDATED CONTROLLED SCENARIO
 *
 * Container V1: 13,613,786 B. Floor speed exactly 512 KiB/s =
 * 524,288 B/s. The EXACT transfer time is 13,613,786 / 524,288 * 1000 =
 * 25,966.24 ms, so the honest (ceil) transfer budget is 25,967 ms.
 * The initial Range phase consumes 1,000 ms in total.
 *
 * The FORMER tests modelled a 25,467 ms body — 500 ms FASTER than the
 * real transfer — which hid the fact that the F3.3.2 allowance
 * (26,967 ms) had ZERO headroom over the true need (26,967 ms).
 * F3.3.3 adds a completion reserve so the allowance (27,967 ms) leaves
 * genuine room for HTTP setup / redirects / final validation.
 * ================================================================== */

describe("F3.3.3 — the real container completes at its TRUE transfer time", () => {
  it("POSITIVE: the honest 25,967 ms transfer + 1,000 ms Range SUCCEEDS with real headroom", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    expect(container.byteLength).toBe(13_613_786);
    vi.useFakeTimers();

    // 1,000 ms of Range attempts (two gateways, 500 ms each) + a body
    // that streams for the HONEST 25,967 ms — NOT an artificially
    // faster body. Total ≈ 26,967 ms against the 27,967 ms allowance.
    options = {
      rangeStatus: 200,
      rangeDelayMs: 500,
      fullDelayMs: 25_967,
      fullChunks: [container],
    };

    const p = storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { elapsed, status } = await advanceUntilSettled(p);

    await expect(p).resolves.toBeInstanceOf(Uint8Array);
    expect(status).toBe("fulfilled");
    // ~26,967 ms — PAST the OLD 24,000 ms clamp, with genuine headroom
    // under the 27,967 ms allowance and the 30 s absolute budget.
    expect(elapsed).toBeGreaterThan(24_000);
    // The body alone accounts for 25,967 ms of the elapsed time.
    expect(elapsed).toBeGreaterThan(25_967);
    expect(elapsed).toBeLessThan(27_967);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
    expect(fullCallCount()).toBe(1);
  });

  it("NEGATIVE: a body that would exhaust the budget fails, cancels the ACTIVE fetch and caches nothing", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    // 1,000 ms of Range attempts + a body that needs 40,000 ms → the
    // single 27,967 ms container allowance must abort it, and the abort
    // must land strictly before the caller's 30,000 ms bound.
    options = {
      rangeStatus: 200,
      rangeDelayMs: 500,
      fullDelayMs: 40_000,
      fullChunks: [container],
    };

    const p = storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");
    expect(elapsed).toBeGreaterThanOrEqual(27_967);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);

    // The network was cancelled: every observed plain-GET signal aborted.
    expect(fullCallSignals.length).toBeGreaterThan(0);
    expect(fullCallSignals.every((s) => s.aborted)).toBe(true);

    // Nothing incomplete was cached: a subsequent GOOD read must issue a
    // FRESH plain GET and succeed.
    options = { rangeStatus: 200, fullChunks: [container] };
    const ok = await storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    expect(ok.byteLength).toBe(CHUNK0_CIPHER);
  });

  it("a LATE body resolution after the deadline never fills the cache", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    vi.useFakeTimers();

    options = {
      rangeStatus: 200,
      fullDelayMs: 40_000, // resolves long AFTER the deadline
      fullChunks: [container],
    };

    const p = storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    const { status } = await advanceUntilSettled(p);
    expect(status).toBe("rejected");

    // Advance far past the late resolution to let it "arrive".
    await vi.advanceTimersByTimeAsync(20_000);

    // A fresh read must NOT be served from a poisoned cache — it issues
    // its own GET and returns correct bytes.
    const before = fullCallCount();
    options = { rangeStatus: 200, fullChunks: [container] };
    const ok = await storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
      size: container.byteLength,
      chunkCount: 2,
    });
    expect(ok.byteLength).toBe(CHUNK0_CIPHER);
    expect(Array.from(ok)).toEqual(
      Array.from(container.subarray(HEADER_SIZE, HEADER_SIZE + CHUNK0_CIPHER))
    );
    expect(fullCallCount()).toBeGreaterThan(before);
  });

  it("keeps the shared single-flight contract for the real container", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };

    const [a, b] = await Promise.all([
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK0_CIPHER, {
        size: container.byteLength,
        chunkCount: 2,
      }),
      storage.downloadRange(pointer, HEADER_SIZE + CHUNK0_CIPHER, CHUNK1_CIPHER, {
        size: container.byteLength,
        chunkCount: 2,
      }),
    ]);

    expect(a.byteLength).toBe(CHUNK0_CIPHER);
    expect(b.byteLength).toBe(CHUNK1_CIPHER);
    expect(fullCallCount()).toBe(1);
  });

  it("a range-only read (no hint) keeps the pre-existing window budget", async () => {
    const pointer = freshPointer();
    vi.useFakeTimers();
    options = { rangeStatus: 200, holdFull: true };

    // No hint → the container allowance does NOT apply; the small window
    // budget governs and aborts early (unchanged legacy behaviour).
    const p = storage.downloadRange(pointer, HEADER_SIZE + CHUNK0_CIPHER, CHUNK1_CIPHER);
    const { elapsed, status } = await advanceUntilSettled(p);

    expect(status).toBe("rejected");
    expect(elapsed).toBeLessThan(10_000);
    vi.clearAllTimers();
  });
});
