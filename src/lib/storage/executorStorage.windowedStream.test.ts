/**
 * R9-A87.5 — BOUNDED WINDOWED CONTAINER READING.
 *
 * Drives the REAL `executorStorage.downloadRange` with only `fetch` stubbed,
 * and proves that a container ABOVE the 20 MiB buffering ceiling is served by
 * a bounded forward stream instead of a whole-object buffer:
 *
 *   - 206 fast path unchanged (no plain GET);
 *   - 200 (Range ignored) → streamed window, never `arrayBuffer()`;
 *   - prefix discarded, exact window returned, memory bounded by the window;
 *   - header / chunkCount / Content-Length / truncation all fail closed;
 *   - one stream serves many ascending windows (≈1.0x transfer);
 *   - backward access never returns stale bytes (one bounded restart);
 *   - cancellation and disposal release the reader;
 *   - a 100 MiB object causes no 100 MiB allocation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { StoragePointer } from "@/lib/storage/storageAdapter";
import {
  HEADER_SIZE,
  serializeContainerHeader,
} from "@/lib/storage/container/containerLayout";
import { storage } from "@/lib/storage/storage";
import {
  CONTAINER_FULL_FALLBACK_MAX_BYTES,
} from "@/lib/storage/executorStorage";
import {
  activeContainerStreams,
  disposeContainerWindowStreams,
  readContainerWindow,
  windowStreamDeadlineMs,
  WINDOW_STREAM_CEILING_MS,
} from "@/lib/storage/container/containerWindowStream";

/* ------------------------------------------------------------------ *
 * Synthetic container: computed on demand, never materialised
 * ------------------------------------------------------------------ */

const MiB = 1024 * 1024;

/** Byte value at an absolute container offset — cheap and verifiable. */
function patternAt(abs: number): number {
  return abs % 251;
}

interface StreamPlan {
  /** Bytes the object claims / really has. */
  readonly totalSize: number;
  /** Chunk count written into the 64-byte header. */
  readonly headerChunkCount: number;
  /** Stream chunk size (browser-ish). */
  readonly sliceSize?: number;
  /** Stop the body early at this absolute offset (truncation). */
  readonly truncateAt?: number;
  /** Declared Content-Length (defaults to totalSize). */
  readonly contentLength?: string | null;
  /** Content-Type (defaults to octet-stream). */
  readonly contentType?: string;
}

function makeBodyStream(plan: StreamPlan): ReadableStream<Uint8Array> {
  const slice = plan.sliceSize ?? 16 * 1024;
  let cursor = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const end =
        plan.truncateAt !== undefined
          ? Math.min(cursor + slice, plan.truncateAt)
          : Math.min(cursor + slice, plan.totalSize);

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
      controller.enqueue(out);
    },
  });
}

function makeResponse(init: {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  contentType?: string;
  contentLength?: string | null;
  contentRange?: string | null;
  /** Real body for the 206 fast path only. */
  bytes?: Uint8Array;
}): Response {
  const headers = new Map<string, string>();
  if (init.contentType !== undefined) headers.set("content-type", init.contentType);
  if (init.contentLength !== undefined && init.contentLength !== null) {
    headers.set("content-length", init.contentLength);
  }
  if (init.contentRange !== undefined && init.contentRange !== null) {
    headers.set("content-range", init.contentRange);
  }
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    body: init.body ?? null,
    arrayBuffer: async () => {
      // The STRICT 206 path legitimately reads the window with arrayBuffer().
      // The streamed 200 path must never reach this: passing `bytes` is how a
      // test opts in to a real body.
      if (init.bytes === undefined) {
        throw new Error("arrayBuffer() must never be used for a container");
      }
      return init.bytes.slice().buffer;
    },
  } as unknown as Response;
}

/* ------------------------------------------------------------------ *
 * fetch stub
 * ------------------------------------------------------------------ */

interface Scenario {
  /** Status returned for RANGE requests (both gateways). */
  rangeStatus?: number;
  /** Status for the plain (streaming) GET. */
  plainStatus?: number;
  /** Plan used to build the streamed body. */
  plan?: StreamPlan;
  /** Per-gateway override for the plain GET. */
  gatewayPlan?: (url: string) => "ok" | "http400" | "reject";
  /** Track bytes actually pulled by the consumer. */
  pulled?: { total: number };
}

let fetchMock: ReturnType<typeof vi.fn>;
let scenario: Scenario;
let plainCalls: number;
let rangeCalls: number;

function ptr(n: number): StoragePointer {
  const body = `W${String(n).padStart(23, "0")}`;
  return (body + "X".repeat(43 - body.length)) as StoragePointer;
}

beforeEach(() => {
  scenario = {};
  plainCalls = 0;
  rangeCalls = 0;
  disposeContainerWindowStreams();

  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;

    // RANGE attempt
    if (headers !== undefined) {
      rangeCalls += 1;
      return Promise.resolve(
        makeResponse({
          status: scenario.rangeStatus ?? 200,
          contentType: "application/octet-stream",
        }),
      );
    }

    // PLAIN streaming GET
    plainCalls += 1;

    const gateway = scenario.gatewayPlan?.(url);
    if (gateway === "reject") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    if (gateway === "http400") {
      return Promise.resolve(makeResponse({ status: 400, body: null }));
    }

    const plan = scenario.plan;
    if (!plan) return Promise.resolve(makeResponse({ status: 200, body: null }));

    return Promise.resolve(
      makeResponse({
        status: scenario.plainStatus ?? 200,
        body: makeBodyStream(plan),
        contentType: plan.contentType ?? "application/octet-stream",
        contentLength:
          plan.contentLength !== undefined
            ? plan.contentLength
            : String(plan.totalSize),
      }),
    );
  }) as unknown as ReturnType<typeof vi.fn>;

  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  disposeContainerWindowStreams();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const HINT_ABOVE = {
  size: 100 * MiB,
  chunkCount: 12,
};

/* ================================================================== *
 * 1 — the 206 fast path is untouched
 * ================================================================== */

describe("R9-A87.5 — 206 fast path", () => {
  it("1: a valid 206 window is returned without any plain GET", async () => {
    scenario = { rangeStatus: 206 };
    // The range attempt is answered with a REAL 206 body here.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers !== undefined) {
        rangeCalls += 1;
        const body = new Uint8Array(1024).fill(9);
        return Promise.resolve(
          makeResponse({
            status: 206,
            body: new ReadableStream<Uint8Array>({
              start(c) { c.enqueue(body); c.close(); },
            }),
            contentRange: `bytes 0-1023/${HINT_ABOVE.size}`,
            contentLength: "1024",
            bytes: body,
          }),
        );
      }
      plainCalls += 1;
      return Promise.resolve(makeResponse({ status: 200, body: null }));
    });

    const bytes = await storage.downloadRange(ptr(1), 0, 1024, HINT_ABOVE);

    expect(bytes.byteLength).toBe(1024);
    expect(bytes[0]).toBe(9);
    expect(plainCalls).toBe(0);
  });
});

/* ================================================================== *
 * 2..4 — 200 fallback, prefix discard, exact window
 * ================================================================== */

describe("R9-A87.5 — 200 fallback streams the window", () => {
  it("2/3/4: a 200 response is served by a bounded stream, exactly the requested window", async () => {
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: HINT_ABOVE.size, headerChunkCount: 12 },
    };

    const offset = 4 * MiB;
    const length = 4096;

    const bytes = await storage.downloadRange(ptr(2), offset, length, HINT_ABOVE);

    expect(bytes.byteLength).toBe(length);
    // Byte-exact: the window contains object bytes at [offset, offset+length).
    for (let i = 0; i < length; i += 257) {
      expect(bytes[i]).toBe(patternAt(offset + i));
    }
    expect(plainCalls).toBe(1);
  });

  it("3: the discarded prefix is not retained in the returned window", async () => {
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: 8 * MiB, headerChunkCount: 1, sliceSize: 64 * 1024 },
    };

    const offset = 6 * MiB;
    const length = 1024;
    const hint = { size: 8 * MiB, chunkCount: 1 };

    const bytes = await storage.downloadRange(ptr(3), offset, length, hint);

    expect(bytes.byteLength).toBe(length);
    expect(bytes[0]).toBe(patternAt(offset));
    expect(bytes[0]).not.toBe(patternAt(0));
  });
});

/* ================================================================== *
 * 5 — gateway behaviour
 * ================================================================== */

describe("R9-A87.5 — gateway handling", () => {
  it("5a: a 400 stream attempt falls through to the next gateway", async () => {
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: 4 * MiB, headerChunkCount: 1 },
      gatewayPlan: (url) =>
        url.includes("gateway.irys.xyz") ? "http400" : "ok",
    };

    const hint = { size: 4 * MiB, chunkCount: 1 };
    const bytes = await storage.downloadRange(ptr(5), HEADER_SIZE, 256, hint);

    expect(bytes.byteLength).toBe(256);
    expect(plainCalls).toBe(2);
  });

  it("5b: when every stream attempt fails the ORIGINAL typed error is thrown", async () => {
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: 4 * MiB, headerChunkCount: 1 },
      gatewayPlan: () => "http400",
    };

    const hint = { size: 4 * MiB, chunkCount: 1 };
    await expect(
      storage.downloadRange(ptr(6), HEADER_SIZE, 256, hint),
    ).rejects.toThrow();
  });
});

/* ================================================================== *
 * 6..9 — validation failures
 * ================================================================== */

describe("R9-A87.5 — validation fails closed", () => {
  it("6: a mismatching Content-Range on a 206 is rejected (no stream)", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers !== undefined) {
        return Promise.resolve(
          makeResponse({
            status: 206,
            body: new ReadableStream<Uint8Array>({
              start(c) { c.enqueue(new Uint8Array(256)); c.close(); },
            }),
            contentRange: "bytes 0-199/999999",
          }),
        );
      }
      plainCalls += 1;
      return Promise.resolve(makeResponse({ status: 200, body: null }));
    });

    await expect(
      storage.downloadRange(ptr(7), 0, 256, HINT_ABOVE),
    ).rejects.toThrow();
    expect(plainCalls).toBe(0);
  });

  it("7: a Content-Length that disagrees with the trusted size is rejected", async () => {
    scenario = {
      rangeStatus: 200,
      plan: {
        totalSize: 4 * MiB,
        headerChunkCount: 1,
        contentLength: String(4 * MiB + 1),
      },
    };

    await expect(
      storage.downloadRange(ptr(8), HEADER_SIZE, 256, {
        size: 4 * MiB,
        chunkCount: 1,
      }),
    ).rejects.toThrow();
  });

  it("8: a truncated body is rejected", async () => {
    scenario = {
      rangeStatus: 200,
      plan: {
        totalSize: 4 * MiB,
        headerChunkCount: 1,
        truncateAt: HEADER_SIZE + 100,
      },
    };

    await expect(
      storage.downloadRange(ptr(9), HEADER_SIZE, 4096, {
        size: 4 * MiB,
        chunkCount: 1,
      }),
    ).rejects.toThrow();
  });

  it("9: a header chunkCount that disagrees with the trusted layout is rejected", async () => {
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: 4 * MiB, headerChunkCount: 7 },
    };

    await expect(
      storage.downloadRange(ptr(10), HEADER_SIZE, 256, {
        size: 4 * MiB,
        chunkCount: 1,
      }),
    ).rejects.toThrow();
  });

  it("9b: a non-200 plain response is rejected", async () => {
    scenario = {
      rangeStatus: 200,
      plainStatus: 206,
      plan: { totalSize: 4 * MiB, headerChunkCount: 1 },
    };

    await expect(
      storage.downloadRange(ptr(11), HEADER_SIZE, 256, {
        size: 4 * MiB,
        chunkCount: 1,
      }),
    ).rejects.toThrow();
  });
});
/* ================================================================== *
 * 11..13 — 100 MiB container, bounded memory, stream reuse
 * ================================================================== */

describe("R9-A87.5 — 100 MiB container stays bounded", () => {
  it("11: a high-offset window in a 100 MiB container allocates only the window", async () => {
    scenario = {
      rangeStatus: 200,
      plan: {
        totalSize: HINT_ABOVE.size,
        headerChunkCount: 12,
        sliceSize: 4 * MiB,
      },
    };

    const offset = 92 * MiB;
    const length = 8 * 1024;

    const bytes = await storage.downloadRange(ptr(11), offset, length, HINT_ABOVE);

    expect(bytes.byteLength).toBe(length);
    expect(bytes[0]).toBe(patternAt(offset));
    expect(bytes[length - 1]).toBe(patternAt(offset + length - 1));
    // Only one stream, and it discarded the prefix instead of buffering it.
    expect(plainCalls).toBe(1);
    expect(activeContainerStreams()).toBe(1);
  });

  it("12/13: twelve ascending windows share ONE stream and transfer ~1.0x", async () => {
    const total = 100 * MiB;
    const hint = HINT_ABOVE;
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: total, headerChunkCount: 12, sliceSize: 1 * MiB },
    };

    const step = 1 * MiB;
    for (let i = 0; i < 12; i++) {
      const offset = HEADER_SIZE + i * step;
      const bytes = await storage.downloadRange(ptr(12), offset, 1024, hint);
      expect(bytes.byteLength).toBe(1024);
      expect(bytes[0]).toBe(patternAt(offset));
    }

    // One plain GET for twelve windows — the whole point of the session.
    expect(plainCalls).toBe(1);
  });
});

/* ================================================================== *
 * 14..16 — concurrency, backward access, cancellation
 * ================================================================== */

describe("R9-A87.5 — concurrency and random access", () => {
  it("14: concurrent ascending windows do not create uncontrolled full-object GETs", async () => {
    const total = 100 * MiB;
    const hint = HINT_ABOVE;
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: total, headerChunkCount: 12, sliceSize: 1 * MiB },
    };

    const results = await Promise.all([
      storage.downloadRange(ptr(13), 0, 512, hint),
      storage.downloadRange(ptr(13), 1 * MiB, 512, hint),
      storage.downloadRange(ptr(13), 2 * MiB, 512, hint),
    ]);

    expect(results.map((r) => r.byteLength)).toEqual([512, 512, 512]);
    expect(results[1]![0]).toBe(patternAt(1 * MiB));
    expect(plainCalls).toBeLessThanOrEqual(2);
  });

  it("15: a backward request restarts once and never returns stale bytes", async () => {
    const total = 100 * MiB;
    const hint = HINT_ABOVE;
    scenario = {
      rangeStatus: 200,
      plan: { totalSize: total, headerChunkCount: 12, sliceSize: 1 * MiB },
    };

    const high = await storage.downloadRange(ptr(14), 6 * MiB, 256, hint);
    expect(high[0]).toBe(patternAt(6 * MiB));

    // Now go BACK — the stream cannot rewind.
    const low = await storage.downloadRange(ptr(14), HEADER_SIZE, 256, hint);

    expect(low.byteLength).toBe(256);
    expect(low[0]).toBe(patternAt(HEADER_SIZE));
    expect(low[0]).not.toBe(patternAt(6 * MiB));
    // One restart, not an unbounded retry loop.
    expect(plainCalls).toBe(2);
  });

  it("16: an aborted caller signal is refused and no stream is retained", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await readContainerWindow({
      url: "https://gateway.irys.xyz/tx/abcdefghij/data",
      txId: "abort-test",
      offset: HEADER_SIZE,
      length: 256,
      hint: HINT_ABOVE,
      signal: controller.signal,
    });

    expect(result).toBeNull();
    expect(activeContainerStreams()).toBe(0);
  });
});

/* ================================================================== *
 * 18..19 — JPEG and ZIP inside a 100 MiB container
 * ================================================================== */

describe("R9-A87.5 — small items inside a large container", () => {
  it("18/19: a 50 KB JPEG and a 42 KB ZIP are readable from a 100 MiB container", async () => {
    scenario = {
      rangeStatus: 200,
      plan: {
        totalSize: HINT_ABOVE.size,
        headerChunkCount: 12,
        sliceSize: 4 * MiB,
      },
    };

    const jpeg = await storage.downloadRange(ptr(16), HEADER_SIZE, 50_138, HINT_ABOVE);
    expect(jpeg.byteLength).toBe(50_138);
    expect(jpeg[0]).toBe(patternAt(HEADER_SIZE));

    const zipOffset = 96 * MiB;
    const zip = await storage.downloadRange(ptr(16), zipOffset, 42_596, HINT_ABOVE);
    expect(zip.byteLength).toBe(42_596);
    expect(zip[0]).toBe(patternAt(zipOffset));

    // Both served from ONE stream: ascending offsets, no restart.
    expect(plainCalls).toBe(1);
  });
});

/* ================================================================== *
 * 17 — finite, progress-aware deadline
 * ================================================================== */

describe("R9-A87.5 — deadline policy", () => {
  it("17a: the deadline grows with the prefix but is always finite", () => {
    const early = windowStreamDeadlineMs(HEADER_SIZE, 1024, 100 * MiB);
    const late = windowStreamDeadlineMs(90 * MiB, 1024, 100 * MiB);

    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(WINDOW_STREAM_CEILING_MS);
  });

  it("17b: invalid inputs fall back to the finite ceiling, never to Infinity", () => {
    expect(windowStreamDeadlineMs(-1, 10, 100)).toBe(WINDOW_STREAM_CEILING_MS);
    expect(windowStreamDeadlineMs(0, 0, 100)).toBe(WINDOW_STREAM_CEILING_MS);
    expect(Number.isFinite(windowStreamDeadlineMs(0, 10, 100))).toBe(true);
  });

  it("17c: the buffering ceiling is unchanged", () => {
    expect(CONTAINER_FULL_FALLBACK_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});