/**
 * =========================================================
 * Sequential two-chunk read — budget interaction
 * =========================================================
 *
 * The reported capsule is ONE container DataItem holding TWO chunks
 * (10 MiB + 2.98 MiB). `ByteRuntime.getBytes(0, size)` reads them
 * SEQUENTIALLY, so a whole-file read issues two `downloadRange` calls
 * whose deadlines ADD UP, while the caller bounds the whole read with
 * a single 30 s `MEDIA_READ_TIMEOUT_MS`.
 *
 * This suite drives the REAL layers —
 *
 *   sessionToBoundedBlobUrl (30 s outer bound)
 *     → ByteRuntime.getBytes
 *       → chunkLoader.loadChunk
 *         → storage.downloadRange
 *           → executorStorage.downloadRange  (per-chunk deadline)
 *
 * — with only `fetch` and `decryptChunk` stubbed. No network, no real
 * crypto, no capability secret.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Keep the heavy openRuntime graph out of the import (VaultRenderer
// only needs the MediaSession contract here).
vi.mock("@/lib/capsule/open/openRuntime", () => ({
  openImage: vi.fn(),
  openVideo: vi.fn(),
  openAudio: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("@/lib/crypto/decryptChunk", () => ({
  decryptChunk: vi.fn(),
}));

import type { PublishedChunkMetadata } from "@/types/vault";
import type { StoragePointer } from "@/lib/storage/storageAdapter";

import { createByteRuntime } from "@/lib/capsule/runtime/byteRuntime";
import { sessionToBoundedBlobUrl } from "@/pages/capsule/VaultRenderer";
import { rangeDownloadDeadlineMs } from "@/lib/storage/executorStorage";
import { decryptChunk } from "@/lib/crypto/decryptChunk";

/** Public-shape synthetic pointer (never a real capability). */
const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

const CAPSULE_ID = "6a2f7dcbe568378609755cb2b081552f7999442e15f3a54a6c47d0bfe202dd9a";
const CRYPTO_KEY = {} as CryptoKey;

/** Confirmed Container V1 layout of the reported capsule. */
const MEDIA_BYTES = 13_613_666;
const AES_GCM_OVERHEAD = 28;
const HEADER_BYTES = 64;

const CHUNK0_PLAIN = 10_485_760; // MAX_CHUNK_SIZE
const CHUNK0_CIPHER = CHUNK0_PLAIN + AES_GCM_OVERHEAD; // 10_485_788
const CHUNK1_PLAIN = MEDIA_BYTES - CHUNK0_PLAIN; // 3_127_906
const CHUNK1_CIPHER = CHUNK1_PLAIN + AES_GCM_OVERHEAD; // 3_127_934

const CHUNK0_OFFSET = HEADER_BYTES; // 64
const CHUNK1_OFFSET = HEADER_BYTES + CHUNK0_CIPHER; // 10,485,852

const CONTAINER_BYTES = HEADER_BYTES + CHUNK0_CIPHER + CHUNK1_CIPHER;

const MEDIA_READ_TIMEOUT_MS = 30_000;

const CHUNKS: readonly PublishedChunkMetadata[] = [
  {
    chunkId: "chunk-0",
    mediaId: "media-0",
    index: 0,
    size: CHUNK0_CIPHER,
    pointer: POINTER,
    container: {
      containerTxId: POINTER,
      globalIndex: 0,
      offset: CHUNK0_OFFSET,
      length: CHUNK0_CIPHER,
    },
  },
  {
    chunkId: "chunk-1",
    mediaId: "media-0",
    index: 1,
    size: CHUNK1_CIPHER,
    pointer: POINTER,
    container: {
      containerTxId: POINTER,
      globalIndex: 1,
      offset: CHUNK1_OFFSET,
      length: CHUNK1_CIPHER,
    },
  },
] as unknown as readonly PublishedChunkMetadata[];

/** Per-window artificial latency, keyed by the Range start offset. */
let delays: Map<number, number>;
let fetchMock: ReturnType<typeof vi.fn>;
let requestedWindows: Array<{ start: number; end: number; length: number }>;

function installFetch(): void {
  fetchMock = vi.fn();

  fetchMock.mockImplementation((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal | undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers["Range"] ?? "");

    if (!match) {
      return Promise.reject(new Error(`unexpected Range: ${headers["Range"]}`));
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;

    requestedWindows.push({ start, end, length });

    const delay = delays.get(start) ?? 0;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;

      signal?.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );

      setTimeout(() => {
        if (settled) return;
        settled = true;

        // The window is served as a 206 with EXACTLY the requested
        // length — the same contract the real CDN honours.
        resolve({
          status: 206,
          ok: true,
          headers: {
            get: (name: string) => {
              const key = name.toLowerCase();
              if (key === "content-type") return "application/octet-stream";
              // Production reads Content-Range as null (not exposed
              // through CORS) — modelled faithfully.
              return null;
            },
          },
          arrayBuffer: async () => new Uint8Array(length).buffer,
        } as unknown as Response);
      }, delay);
    });
  });

  vi.stubGlobal("fetch", fetchMock);
}

function makeSession() {
  const runtime = createByteRuntime(
    CAPSULE_ID,
    CRYPTO_KEY,
    CHUNKS,
    MEDIA_BYTES
  );

  return {
    read: (start: number, end: number) => runtime.getBytes(start, end),
    dispose: () => runtime.dispose(),
  };
}

/** Advances fake time in steps until `p` settles; returns ms elapsed. */
async function advanceUntilSettled(
  p: Promise<unknown>,
  step = 100,
  max = 40_000
): Promise<number> {
  let settled = false;
  void p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  let elapsed = 0;
  while (!settled && elapsed < max) {
    await vi.advanceTimersByTimeAsync(step);
    elapsed += step;
  }

  return elapsed;
}

beforeEach(() => {
  delays = new Map();
  requestedWindows = [];

  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: () => {},
  });

  vi.mocked(decryptChunk).mockImplementation(async (cipher: Uint8Array) =>
    new Uint8Array(cipher.byteLength - AES_GCM_OVERHEAD)
  );

  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sequential two-chunk read", () => {
  it("reads BOTH chunks with the correct container windows, in order", async () => {
    vi.useFakeTimers();
    delays.set(CHUNK0_OFFSET, 1_000);
    delays.set(CHUNK1_OFFSET, 1_000);

    const p = sessionToBoundedBlobUrl(makeSession(), MEDIA_BYTES, "video/webm");

    await advanceUntilSettled(p);

    await expect(p).resolves.toMatch(/^blob:/);

    expect(requestedWindows).toEqual([
      { start: CHUNK0_OFFSET, end: CHUNK0_OFFSET + CHUNK0_CIPHER - 1, length: CHUNK0_CIPHER },
      { start: CHUNK1_OFFSET, end: CHUNK1_OFFSET + CHUNK1_CIPHER - 1, length: CHUNK1_CIPHER },
    ]);

    // The two windows tile the container after its 64-byte header.
    expect(CHUNK1_OFFSET).toBe(CHUNK0_OFFSET + CHUNK0_CIPHER);
    expect(CONTAINER_BYTES).toBe(
      HEADER_BYTES + CHUNK0_CIPHER + CHUNK1_CIPHER
    );
  });

  it("SUCCEEDS for a slow-but-healthy read that the old 8 s cap would have aborted", async () => {
    vi.useFakeTimers();
    delays.set(CHUNK0_OFFSET, 19_500);
    delays.set(CHUNK1_OFFSET, 5_500);

    const p = sessionToBoundedBlobUrl(makeSession(), MEDIA_BYTES, "video/webm");

    const elapsed = await advanceUntilSettled(p);

    await expect(p).resolves.toMatch(/^blob:/);

    // ~25 s of transfer — far past the old 8 s budget, still inside
    // the caller's 30 s bound.
    expect(elapsed).toBeGreaterThanOrEqual(25_000);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });

  it("the plan's TOTAL inner budget is strictly below the outer bound", () => {
    // This is the invariant the floor change exists to protect: the
    // two sequential per-chunk budgets must not be able to outlast
    // the caller's single 30 s deadline.
    const total =
      rangeDownloadDeadlineMs(CHUNK0_CIPHER) +
      rangeDownloadDeadlineMs(CHUNK1_CIPHER);

    expect(total).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
    // ...and it is exactly the whole-file time at the 512 KiB/s floor.
    expect(total).toBe(25_968);
  });

  it("succeeds even when both chunks consume nearly their whole inner budget", async () => {
    vi.useFakeTimers();
    delays.set(CHUNK0_OFFSET, 19_800); // inner budget 20,001
    delays.set(CHUNK1_OFFSET, 5_800); // inner budget  5,967

    const p = sessionToBoundedBlobUrl(makeSession(), MEDIA_BYTES, "video/webm");

    const elapsed = await advanceUntilSettled(p);

    await expect(p).resolves.toMatch(/^blob:/);
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });

  it("fails terminally when a chunk stalls past its own deadline — no hang, no outer pre-emption", async () => {
    vi.useFakeTimers();
    delays.set(CHUNK0_OFFSET, 19_000);
    // chunk1 never answers within its own deadline.
    delays.set(CHUNK1_OFFSET, 60_000);

    const p = sessionToBoundedBlobUrl(makeSession(), MEDIA_BYTES, "video/webm");

    const elapsed = await advanceUntilSettled(p);

    await expect(p).rejects.toBeDefined();

    // The INNER deadline (19,000 + 5,967 ≈ 24.97 s) fires STRICTLY
    // before the caller's 30 s bound — the whole point of the fix.
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });

  it("still terminates if BOTH chunks stall (bounded, never pending)", async () => {
    vi.useFakeTimers();
    delays.set(CHUNK0_OFFSET, 60_000);
    delays.set(CHUNK1_OFFSET, 60_000);

    const p = sessionToBoundedBlobUrl(makeSession(), MEDIA_BYTES, "video/webm");

    const elapsed = await advanceUntilSettled(p, 100, 60_000);

    await expect(p).rejects.toBeDefined();
    expect(elapsed).toBeLessThan(60_000);
  });
});
