/**
 * R9-A87.7 — LIFECYCLE REGRESSIONS FOR F1 / F2 / F3.
 *
 * The R9-A87.6 review proved the three defects by control-flow inspection
 * because it was forbidden to add tests. This suite is that missing evidence:
 *
 *   F1  a reader failure / idle timeout / abort closes the session, removes it
 *       from the registry, never returns partial bytes, and the NEXT read opens
 *       a fresh working stream;
 *   F2  capsule-scoped teardown and the lease/release counter actually close
 *       the shared stream, and never kill another live consumer;
 *   F3  a caller abort reaches the transport (body cancelled, reader lock
 *       released, no orphan running to the 120 s ceiling) while a consumer
 *       that is only released — not aborted — leaves the shared stream alone.
 *
 * The real `readContainerWindow` / `storage.downloadRange` are driven; only
 * `fetch` is stubbed. Windows are deliberately larger than one stream chunk so
 * a mid-window failure really is mid-window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { StoragePointer } from "@/lib/storage/storageAdapter";
import {
  HEADER_SIZE,
  serializeContainerHeader,
} from "@/lib/storage/container/containerLayout";
import { storage } from "@/lib/storage/storage";
import { openVideo } from "@/lib/capsule/open/openVideo";
import type { OpenMediaRequest } from "@/lib/capsule/open/openTypes";
import { StorageRangeError } from "@/lib/storage/storageRangeFailure";
import {
  activeContainerStreams,
  disposeContainerWindowStreams,
  disposeContainerWindowStreamsFor,
  readContainerWindow,
  retainContainerWindowStream,
  WINDOW_STREAM_IDLE_MS,
  WINDOW_STREAM_IDLE_SESSION_MS,
} from "@/lib/storage/container/containerWindowStream";

const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;
/** Three chunks: a mid-window failure cannot be mistaken for a complete one. */
const LONG_WINDOW = 3 * CHUNK;

function patternAt(abs: number): number {
  return abs % 251;
}

interface BodyStats {
  pulls: number;
  cancels: number;
  errors: number;
}

type BodyKind =
  | "healthy"
  | "stall"
  | "error-after-first"
  | "one-chunk-then-stall";

/**
 * A synthetic container body with observable pull/cancel/error counters, so
 * the tests assert real transport behaviour instead of mock call counts.
 */
function makeBody(plan: {
  totalSize: number;
  headerChunkCount: number;
  sliceSize?: number;
}): { stream: ReadableStream<Uint8Array>; stats: BodyStats } {
  const stats: BodyStats = { pulls: 0, cancels: 0, errors: 0 };
  const slice = plan.sliceSize ?? CHUNK;
  let cursor = 0;
  let produced = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulls += 1;

      if (bodyKind === "stall") return;

      /**
       * A REAL one-chunk park: exactly one chunk is ever produced, so a window
       * larger than one chunk stays genuinely incomplete until it is aborted.
       */
      if (bodyKind === "one-chunk-then-stall" && produced >= 1) return;

      if (bodyKind === "error-after-first" && cursor > 0) {
        stats.errors += 1;
        controller.error(new Error("reader exploded"));
        return;
      }

      const end = Math.min(cursor + slice, plan.totalSize);
      if (cursor >= end) {
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
      produced += 1;
      controller.enqueue(out);
    },
    cancel() {
      stats.cancels += 1;
    },
  });

  return { stream, stats };
}

function makeResponse(init: {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  contentType?: string;
  contentLength?: string | null;
}): Response {
  const headers = new Map<string, string>();
  if (init.contentType !== undefined) headers.set("content-type", init.contentType);
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

function ptr(n: number): StoragePointer {
  const body = `W${String(n).padStart(23, "0")}`;
  return (body + "X".repeat(43 - body.length)) as StoragePointer;
}

/** Attaches the handler IMMEDIATELY so a rejection is never unhandled. */
function trap<T>(p: Promise<T>): Promise<T | Error> {
  return p.then(
    (value) => value,
    (cause: unknown) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  );
}

const HINT = { size: 100 * MiB, chunkCount: 12 };
const TX = "lifecycle-test-tx";

let bodyKind: BodyKind;
let lastBody: { stream: ReadableStream<Uint8Array>; stats: BodyStats } | null;
let plainCalls: number;

beforeEach(() => {
  bodyKind = "healthy";
  lastBody = null;
  plainCalls = 0;
  disposeContainerWindowStreams();
  vi.useFakeTimers();

  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;

    if (headers !== undefined) {
      // Every RANGE attempt is answered with a plain 200: this suite exists
      // for the streaming fallback, not for the 206 fast path.
      return Promise.resolve(
        makeResponse({ status: 200, contentType: "application/octet-stream" }),
      );
    }

    plainCalls += 1;
    const { stream, stats } = makeBody({
      totalSize: HINT.size,
      headerChunkCount: HINT.chunkCount,
      sliceSize: CHUNK,
    });
    lastBody = { stream, stats };

    return Promise.resolve(
      makeResponse({
        status: 200,
        body: stream,
        contentType: "application/octet-stream",
        contentLength: String(HINT.size),
      }),
    );
  }) as unknown as ReturnType<typeof vi.fn>;

  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  disposeContainerWindowStreams();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function windowRequest(offset: number, length: number, signal: AbortSignal) {
  return {
    url: `https://gateway.irys.xyz/tx/${TX}/data`,
    txId: TX,
    offset,
    length,
    hint: HINT,
    signal,
  };
}

/* ================================================================== *
 * F1 — failed session recovery
 * ================================================================== */

describe("R9-A87.7 F1 — failed session recovery", () => {
  it("1/3: an idle timeout closes the reader and removes the session", async () => {
    bodyKind = "stall";

    const pending = trap(
      readContainerWindow(windowRequest(HEADER_SIZE, LONG_WINDOW, new AbortController().signal)),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(activeContainerStreams()).toBe(1);

    await vi.advanceTimersByTimeAsync(WINDOW_STREAM_IDLE_MS);
    await expect(pending).resolves.toBeNull();

    expect(activeContainerStreams()).toBe(0);
    expect(lastBody?.stats.cancels).toBeGreaterThanOrEqual(1);
  });

  it("2/3: a reader.read() rejection closes the session and returns no bytes", async () => {
    bodyKind = "error-after-first";

    const pending = trap(
      readContainerWindow(windowRequest(HEADER_SIZE, LONG_WINDOW, new AbortController().signal)),
    );
    await expect(pending).resolves.toBeNull();

    expect(lastBody?.stats.errors).toBeGreaterThanOrEqual(1);
    expect(activeContainerStreams()).toBe(0);
  });

  it("4: the next read after a failure opens a FRESH working session", async () => {
    bodyKind = "stall";
    const first = trap(
      readContainerWindow(windowRequest(HEADER_SIZE, LONG_WINDOW, new AbortController().signal)),
    );
    await vi.advanceTimersByTimeAsync(WINDOW_STREAM_IDLE_MS);
    await expect(first).resolves.toBeNull();
    expect(plainCalls).toBe(1);

    bodyKind = "healthy";
    const second = await readContainerWindow(
      windowRequest(HEADER_SIZE, 256, new AbortController().signal),
    );
    expect(second).not.toBeNull();
    expect(second?.[0]).toBe(patternAt(HEADER_SIZE));
    expect(plainCalls).toBe(2);
    expect(activeContainerStreams()).toBe(1);
  });

  it("5: the typed StorageRangeError survives a streamed-window failure", async () => {
    bodyKind = "stall";

    const settled = trap(storage.downloadRange(ptr(5), HEADER_SIZE, 256, HINT));

    // The storage deadline for this small window is ~3 s; the idle watchdog is
    // 10 s, so the storage clock fires first — and must still be the error the
    // caller sees, not a generic sealed failure.
    await vi.advanceTimersByTimeAsync(4_000);
    const err = await settled;

    expect(err).toBeInstanceOf(StorageRangeError);
    expect((err as StorageRangeError).code).toBe("range-timeout");
  });

  it("6: a failed request never resolves to partial window bytes", async () => {
    bodyKind = "one-chunk-then-stall";

    const pending = trap(
      readContainerWindow(windowRequest(HEADER_SIZE, LONG_WINDOW, new AbortController().signal)),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(lastBody?.stats.pulls).toBeGreaterThanOrEqual(1);

    disposeContainerWindowStreamsFor(TX);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeNull();
    expect(lastBody?.stats.cancels).toBeGreaterThanOrEqual(1);
  });
});

/* ================================================================== *
 * F2 — capsule-level resource teardown
 * ================================================================== */

describe("R9-A87.7 F2 — capsule teardown and leases", () => {
  it("7/8: teardown aborts the live stream, clears the registry and the timers", async () => {
    const other = "other-container-tx";

    // A second container's stream must not be collateral damage.
    bodyKind = "healthy";
    await readContainerWindow({
      url: `https://gateway.irys.xyz/tx/${other}/data`,
      txId: other,
      offset: HEADER_SIZE,
      length: 256,
      hint: HINT,
      signal: new AbortController().signal,
    });
    expect(activeContainerStreams()).toBe(1);

    // Now open the container under test and kill it while it is live.
    bodyKind = "stall";
    const pending = trap(
      readContainerWindow(windowRequest(HEADER_SIZE, LONG_WINDOW, new AbortController().signal)),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(activeContainerStreams()).toBe(2);

    disposeContainerWindowStreamsFor(TX);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();

    expect(lastBody?.stats.cancels).toBeGreaterThanOrEqual(1);
    expect(activeContainerStreams()).toBe(1);

    // Re-touch the survivor, then let time pass: the disposed container's
    // idle timer must be GONE (nothing resurrects TX), and the survivor is
    // closed only by its OWN 30 s idle policy — never by the teardown.
    await readContainerWindow({
      url: `https://gateway.irys.xyz/tx/${other}/data`,
      txId: other,
      offset: HEADER_SIZE + 256,
      length: 256,
      hint: HINT,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(WINDOW_STREAM_IDLE_SESSION_MS - 5);
    expect(activeContainerStreams()).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(activeContainerStreams()).toBe(0);
  });

  it("9: a window in flight is dropped, never completed, when the capsule goes away", async () => {
    bodyKind = "one-chunk-then-stall";

    const pending = trap(
      readContainerWindow(windowRequest(HEADER_SIZE, LONG_WINDOW, new AbortController().signal)),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(lastBody?.stats.pulls).toBeGreaterThanOrEqual(1);

    disposeContainerWindowStreamsFor(TX);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeNull();
    expect(lastBody?.stats.cancels).toBeGreaterThanOrEqual(1);
    expect(activeContainerStreams()).toBe(0);
  });

  it("10: releasing ONE consumer does not kill another live consumer's stream", async () => {
    bodyKind = "healthy";

    const releaseA = retainContainerWindowStream(TX);
    const releaseB = retainContainerWindowStream(TX);

    const first = await readContainerWindow(
      windowRequest(HEADER_SIZE, 256, new AbortController().signal),
    );
    expect(first).not.toBeNull();
    expect(plainCalls).toBe(1);

    // Consumer A goes away. B still holds the container.
    releaseA();
    await vi.advanceTimersByTimeAsync(0);

    // B is still served by the SAME forward stream — no second GET.
    const second = await readContainerWindow(
      windowRequest(HEADER_SIZE + 1024, 256, new AbortController().signal),
    );
    expect(second).not.toBeNull();
    expect(second?.[0]).toBe(patternAt(HEADER_SIZE + 1024));
    expect(plainCalls).toBe(1);
    expect(activeContainerStreams()).toBe(1);

    releaseB();
  });

  it("11: the FINAL lease release closes the shared stream", async () => {
    bodyKind = "healthy";
    const releaseA = retainContainerWindowStream(TX);
    const releaseB = retainContainerWindowStream(TX);

    await readContainerWindow(windowRequest(HEADER_SIZE, 256, new AbortController().signal));
    expect(activeContainerStreams()).toBe(1);

    releaseA();
    await vi.advanceTimersByTimeAsync(0);
    expect(activeContainerStreams()).toBe(1);

    releaseB();
    await vi.advanceTimersByTimeAsync(0);
    expect(activeContainerStreams()).toBe(0);
  });

  it("12: reopening the capsule does not inherit a disposed session", async () => {
    bodyKind = "healthy";
    const release = retainContainerWindowStream(TX);
    await readContainerWindow(windowRequest(HEADER_SIZE, 256, new AbortController().signal));
    expect(plainCalls).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(activeContainerStreams()).toBe(0);

    // The capsule is opened again: a NEW stream, and it works.
    const release2 = retainContainerWindowStream(TX);
    const bytes = await readContainerWindow(
      windowRequest(HEADER_SIZE, 256, new AbortController().signal),
    );
    expect(bytes).not.toBeNull();
    expect(plainCalls).toBe(2);
    expect(activeContainerStreams()).toBe(1);
    release2();
  });
});

/* ================================================================== *
 * F3 — real cancellation from caller to network
 * ================================================================== */

describe("R9-A87.7 F3 — caller cancellation reaches the transport", () => {
  it("13/14: a caller abort cancels the response body and fails with a typed error", async () => {
    bodyKind = "stall";
    const controller = new AbortController();

    const settled = trap(storage.downloadRange(ptr(13), HEADER_SIZE, 256, HINT, controller.signal));
    await vi.advanceTimersByTimeAsync(1);
    expect(activeContainerStreams()).toBe(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;

    expect(err).toBeInstanceOf(StorageRangeError);
    expect((err as StorageRangeError).code).toBe("range-timeout");
    expect(lastBody?.stats.cancels).toBeGreaterThanOrEqual(1);
    expect(activeContainerStreams()).toBe(0);
  });

  it("15: the reader lock is released after a cancellation", async () => {
    bodyKind = "stall";
    const controller = new AbortController();

    const settled = trap(storage.downloadRange(ptr(15), HEADER_SIZE, 256, HINT, controller.signal));
    await vi.advanceTimersByTimeAsync(1);
    expect(lastBody?.stream.locked).toBe(true);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect(lastBody?.stream.locked).toBe(false);
  });

  it("16/17: a read after cancellation works, and no orphan runs to the ceiling", async () => {
    bodyKind = "stall";
    const controller = new AbortController();

    const settled = trap(storage.downloadRange(ptr(16), HEADER_SIZE, 256, HINT, controller.signal));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(StorageRangeError);
    expect(plainCalls).toBe(1);

    // Nothing is left running: no stream, no further pulls, ever.
    const pullsAtAbort = lastBody?.stats.pulls ?? 0;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(activeContainerStreams()).toBe(0);
    expect(lastBody?.stats.pulls).toBe(pullsAtAbort);
    expect(lastBody?.stats.errors).toBe(0);

    bodyKind = "healthy";
    const bytes = await storage.downloadRange(ptr(16), HEADER_SIZE, 256, HINT);
    expect(bytes.byteLength).toBe(256);
    expect(bytes[0]).toBe(patternAt(HEADER_SIZE));
    expect(plainCalls).toBe(2);
  });

  it("18: a released consumer leaves the shared stream for the survivor", async () => {
    bodyKind = "healthy";
    const releaseA = retainContainerWindowStream(TX);
    const releaseB = retainContainerWindowStream(TX);

    await readContainerWindow(windowRequest(HEADER_SIZE, 256, new AbortController().signal));
    expect(plainCalls).toBe(1);

    releaseA();
    await vi.advanceTimersByTimeAsync(0);

    // B — the surviving consumer — is still served by the same stream.
    const bytes = await readContainerWindow(
      windowRequest(HEADER_SIZE + 256, 256, new AbortController().signal),
    );
    expect(bytes).not.toBeNull();
    expect(bytes?.[0]).toBe(patternAt(HEADER_SIZE + 256));
    expect(plainCalls).toBe(1);
    expect(activeContainerStreams()).toBe(1);

    releaseB();
    await vi.advanceTimersByTimeAsync(0);
    expect(activeContainerStreams()).toBe(0);
  });
});

/**
 * F3 also requires the two SESSION-level properties the storage tests cannot
 * see: a caller signal reaches the read the session starts, and disposing the
 * session aborts a read that is already in flight.
 */
describe("R9-A87.7 F3 — session-owned cancellation", () => {
  it("19: disposing the media session aborts its in-flight read", async () => {
    let captured: AbortSignal | undefined;

    const runtime = {
      getBytes: vi.fn((_start: number, _end: number, signal?: AbortSignal) => {
        captured = signal;
        return new Promise<Uint8Array>(() => {});
      }),
      dispose: vi.fn(),
    };

    const session = await openVideo(runtime as never, {} as OpenMediaRequest);
    void trap(session.read(0, 16));
    await Promise.resolve();

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);

    session.dispose();

    expect(captured?.aborted).toBe(true);
  });

  it("20: the caller's own abort reaches the read the session started", async () => {
    let captured: AbortSignal | undefined;

    const runtime = {
      getBytes: vi.fn((_start: number, _end: number, signal?: AbortSignal) => {
        captured = signal;
        return new Promise<Uint8Array>(() => {});
      }),
      dispose: vi.fn(),
    };

    const session = await openVideo(runtime as never, {} as OpenMediaRequest);
    const controller = new AbortController();
    void trap(session.read(0, 16, controller.signal));
    await Promise.resolve();

    expect(captured?.aborted).toBe(false);

    controller.abort();

    expect(captured?.aborted).toBe(true);
  });
});
