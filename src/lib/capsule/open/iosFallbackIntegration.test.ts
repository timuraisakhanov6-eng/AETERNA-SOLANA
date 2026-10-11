// @vitest-environment jsdom
/**
 * =========================================================
 * iOS media fallback — full-chain integration
 * =========================================================
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The reported iPhone 13 / iOS 26.5 defect is a capsule that OPENS
 * (text decrypts fine) but whose 13,613,666-byte WebM video shows
 * `00:00 / 00:00` and the terminal card
 * `Failed to load preview` / `Media preview unavailable`.
 *
 * Four facts have to be true AT ONCE for that combination, and no
 * existing suite exercises them together:
 *
 *   1. the stored MIME is CODEC-QUALIFIED: `video/webm;codecs=vp8,opus`
 *      (so `resolveStreamableMimeType` trusts MSE directly and does
 *       NOT run the bare-container probe);
 *   2. `MediaSource.isTypeSupported` returns FALSE (the real iOS /
 *      WKWebView capability answer for VP8+Opus in MSE);
 *   3. the media is a genuine TWO-chunk container (10 MiB + 2.98 MiB),
 *      not a small single-chunk fixture;
 *   4. the recovery path performs a REAL whole-file read 0 → size
 *      across the 10 MiB plaintext seam, with the real offset
 *      arithmetic and real sequential plaintext assembly.
 *
 * The existing suites each cover a SUBSET and therefore cannot see a
 * seam-crossing truncation:
 *
 *   - mediaSourceAttachment.test.ts  → (1)+(2)+(4) with size 16;
 *   - sessionMediaSource.test.ts     → (1)+(2)+(4) with size 64;
 *   - sequentialChunkBudget.test.ts  → (3)+(4) but calls
 *                                      `sessionToBoundedBlobUrl`
 *                                      DIRECTLY, bypassing the
 *                                      capability decision.
 *
 * This suite drives the REAL decision entry point instead:
 *
 *   openStreamableOrFallback
 *     → sessionToMediaSource        (throws MediaNotStreamableError)
 *     → sessionToBoundedBlobUrl     (the permitted recovery)
 *       → withTimeout(session.read(0, size), 30 s)
 *         → createByteRuntime.getBytes
 *           → chunkLoader.loadChunk
 *             → storage façade → executorStorage.downloadRange
 *               → fetch (stubbed, 206, EXACT window length)
 *
 * Only the network (`fetch`) and the AES-GCM primitive
 * (`decryptChunk`) are stubbed. Every offset, boundary, exact-length
 * gate, container position and plaintext-assembly step is the REAL
 * production code — which is the only way a truncation at the
 * 10,485,760-byte seam could be caught.
 *
 * The AES primitive is stubbed with a deterministic, recoverable
 * encoding so the assembled plaintext can be verified BYTE FOR BYTE
 * (a "returns something 13.6 MB long" assertion would not detect a
 * seam-crossing hole):
 *
 *   ciphertext chunk = [12-byte IV][plaintext XOR pad][16-byte tag]
 *   recovered bytes  = ciphertext.subarray(12, len - 16) XOR pad
 *
 * No real media bytes, no network, no capability secret.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Keep the heavy openRuntime graph out of the import — this suite
// only needs the MediaSession contract. (VaultRenderer itself imports
// openRuntime for the unrelated image/file paths.)
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
import type { MediaSession } from "@/lib/capsule/open/openTypes";

import { createByteRuntime } from "@/lib/capsule/runtime/byteRuntime";
import { openStreamableOrFallback } from "@/pages/capsule/VaultRenderer";
import {
  MediaNotStreamableError,
  isMediaNotStreamableError,
  resolveStreamableMimeType,
} from "@/lib/capsule/open/mediaCompatibility";
import { decryptChunk } from "@/lib/crypto/decryptChunk";

/* ───────────────────────── scenario constants ───────────────────────── */

/** The exact MIME stored on the reported capsule. */
const STORED_MIME = "video/webm;codecs=vp8,opus";

/** The reported media size. */
const MEDIA_BYTES = 13_613_666;

/** Per-chunk AES-GCM overhead: 12-byte IV + 16-byte tag. */
const AES_GCM_OVERHEAD = 28;
const IV_LENGTH = 12;

/** Container V1 header. */
const HEADER_BYTES = 64;

const CHUNK0_PLAIN = 10_485_760; // MAX_CHUNK_SIZE (10 MiB)
const CHUNK0_CIPHER = CHUNK0_PLAIN + AES_GCM_OVERHEAD; // 10_485_788
const CHUNK1_PLAIN = MEDIA_BYTES - CHUNK0_PLAIN; // 3_127_906
const CHUNK1_CIPHER = CHUNK1_PLAIN + AES_GCM_OVERHEAD; // 3_127_934

const CHUNK0_OFFSET = HEADER_BYTES; // 64
const CHUNK1_OFFSET = HEADER_BYTES + CHUNK0_CIPHER; // 10_485_852

const CONTAINER_BYTES = HEADER_BYTES + CHUNK0_CIPHER + CHUNK1_CIPHER;

/** The MSE loop's window inside `sessionToMediaSource`. */
const MSE_WINDOW = 256 * 1024;

const MEDIA_READ_TIMEOUT_MS = 30_000;

/** Public-shape synthetic pointer (always 43/44 base64url chars). */
const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

const CAPSULE_ID = "6a2f7dcbe568378609755cb2b081552f7999442e15f3a54a6c47d0bfe202dd9a";
const CRYPTO_KEY = {} as CryptoKey;

/** Deterministic per-chunk XOR pad — stands in for the AES keystream. */
const PAD_BY_INDEX: Record<number, number> = { 0: 0x5a, 1: 0xa5 };

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

/* ───────────────────── deterministic plaintext + ciphertext ───────────────────── */

/**
 * The real plaintext of the reported file, as a function of the
 * plaintext offset. A non-trivial pattern (not a constant) so any
 * misplaced, dropped or duplicated segment is detectable.
 */
function plaintextByte(offset: number): number {
  return (offset * 7 + 11) & 0xff;
}

const PLAINTEXT = (() => {
  const out = new Uint8Array(MEDIA_BYTES);
  for (let i = 0; i < MEDIA_BYTES; i++) out[i] = plaintextByte(i);
  return out;
})();

/** Builds the ciphertext buffer for one chunk (IV + XOR payload + tag). */
function ciphertextFor(
  plainStart: number,
  cipherLength: number,
  index: number
): Uint8Array {
  const plainLength = cipherLength - AES_GCM_OVERHEAD;
  const pad = PAD_BY_INDEX[index] ?? 0;
  const out = new Uint8Array(cipherLength);

  // 12-byte IV — opaque, never inspected by the read path.
  for (let i = 0; i < IV_LENGTH; i++) out[i] = (index + i) & 0xff;

  // Payload = plaintext XOR pad.
  for (let i = 0; i < plainLength; i++) {
    out[IV_LENGTH + i] = plaintextByte(plainStart + i) ^ pad;
  }

  // 16-byte tag — opaque.
  for (let i = 0; i < AES_GCM_OVERHEAD - IV_LENGTH; i++) {
    out[IV_LENGTH + plainLength + i] = (0x3c + index + i) & 0xff;
  }

  return out;
}

/** The full container DataItem (header + chunk0 + chunk1). */
const CONTAINER = (() => {
  const out = new Uint8Array(CONTAINER_BYTES);
  out.set(ciphertextFor(0, CHUNK0_CIPHER, 0), CHUNK0_OFFSET);
  out.set(ciphertextFor(CHUNK0_PLAIN, CHUNK1_CIPHER, 1), CHUNK1_OFFSET);
  return out;
})();

/* ───────────────────────── fetch stub (real Range contract) ───────────────────────── */

let requestedWindows: Array<{ start: number; end: number; length: number }>;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(): void {
  fetchMock = vi.fn();

  fetchMock.mockImplementation((url: string, init: RequestInit) => {
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

    return Promise.resolve({
      status: 206,
      ok: true,
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase();
          if (key === "content-type") return "application/octet-stream";
          // Production reads Content-Range as null (not exposed via
          // CORS) — modelled faithfully: null is NOT a gate.
          return null;
        },
      },
      // Serves EXACTLY the requested window out of the real container.
      arrayBuffer: async () =>
        CONTAINER.slice(start, start + length).buffer,
    } as unknown as Response);
  });

  vi.stubGlobal("fetch", fetchMock);
}

/* ───────────────────────── MSE capability stub ───────────────────────── */

/**
 * Models the REAL iPhone answer: VP8+Opus in MSE is not supported.
 * `resolveStreamableMimeType` therefore returns null for the stored
 * codec-qualified MIME WITHOUT running the bare-container probe.
 */
class UnsupportedMediaSource extends EventTarget {
  static isTypeSupported(_mime: string): boolean {
    return false;
  }
  readyState: "closed" | "open" | "ended" = "closed";
  addSourceBuffer(): never {
    throw new Error("addSourceBuffer must never be reached");
  }
  endOfStream(): void {}
}

/* ───────────────────────── object URLs ───────────────────────── */

let mseObjectUrls: string[];
let blobObjectUrls: string[];
let revokeCount: number;
let urlSeq = 0;

function installUrls(): void {
  vi.stubGlobal("URL", {
    createObjectURL: (obj: unknown) => {
      // A MediaSource is minted before the capability check throws;
      // anything else here is the Blob produced by the fallback.
      const url = `blob:${obj instanceof UnsupportedMediaSource ? "mse" : "blob"}-${++urlSeq}`;
      if (obj instanceof UnsupportedMediaSource) mseObjectUrls.push(url);
      else blobObjectUrls.push(url);
      return url;
    },
    revokeObjectURL: () => {
      revokeCount++;
    },
  });
}

/* ───────────────────────── session under test ───────────────────────── */

function makeSession(): MediaSession {
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
  step = 200,
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

/** O(n) comparison — avoids chai's per-element diffing on 13.6 MB. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

beforeEach(() => {
  requestedWindows = [];
  mseObjectUrls = [];
  blobObjectUrls = [];
  revokeCount = 0;
  urlSeq = 0;

  vi.stubGlobal("MediaSource", UnsupportedMediaSource);
  installUrls();
  installFetch();

  // Deterministic, recoverable AES stand-in (see the file header).
  vi.mocked(decryptChunk).mockImplementation(
    async (cipher: Uint8Array, _key: unknown, index: number) => {
      const pad = PAD_BY_INDEX[index] ?? 0;
      const plainLength = cipher.byteLength - AES_GCM_OVERHEAD;
      const out = new Uint8Array(plainLength);
      for (let i = 0; i < plainLength; i++) {
        out[i] = cipher[IV_LENGTH + i] ^ pad;
      }
      return out;
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ───────────────────────── the scenario ───────────────────────── */

describe("iOS media fallback — codec-qualified WebM + MSE unsupported", () => {
  it("classifies the stored MIME as non-streamable (null), without the bare-container probe", () => {
    // The codec-qualified branch trusts MSE directly — it must NOT
    // expand through WEBM_VIDEO_CODEC_CANDIDATES.
    expect(resolveStreamableMimeType(STORED_MIME)).toBeNull();

    // And the fixture really is the two-chunk layout under test.
    expect(CHUNK0_PLAIN + CHUNK1_PLAIN).toBe(MEDIA_BYTES);
    expect(CHUNK1_OFFSET).toBe(CHUNK0_OFFSET + CHUNK0_CIPHER);
    expect(CONTAINER_BYTES).toBe(MEDIA_BYTES + 2 * AES_GCM_OVERHEAD + HEADER_BYTES);
  });

  it("falls back to a bounded Blob and reads the WHOLE file 0 → size across the 10 MiB seam", async () => {
    vi.useFakeTimers();

    const session = makeSession();
    const signal = new AbortController().signal;

    // Drive the REAL decision entry point — not the fallback helper.
    const p = openStreamableOrFallback(
      session,
      { mimeType: STORED_MIME, size: MEDIA_BYTES } as never,
      signal
    );

    const elapsed = await advanceUntilSettled(p);
    const url = await p;

    /* ── outcome ───────────────────────────────────────────────── */

    // The Blob URL (minted by the fallback) — NOT a MediaSource URL.
    expect(url).toMatch(/^blob:blob-/);
    expect(blobObjectUrls).toHaveLength(1);

    /**
     * The capability check fails BEFORE `new MediaSource()` — the
     * codec-qualified MIME resolves to null and `sessionToMediaSource`
     * throws immediately. So no MediaSource object URL is ever minted
     * and nothing has to be revoked. This is the important ordering
     * fact: the failure is a pure capability answer, not a partial
     * MediaSource handshake.
     */
    expect(mseObjectUrls).toHaveLength(0);
    expect(revokeCount).toBe(0);

    // The MSE 256 KiB window was never read: the only reads are the
    // two container windows below.
    expect(requestedWindows).not.toContainEqual({
      start: 0,
      end: MSE_WINDOW - 1,
      length: MSE_WINDOW,
    });

    /* ── the reads ─────────────────────────────────────────────── */

    // EXACTLY TWO reads, each the container position of one chunk,
    // each of the exact ciphertext length. This is the boundary proof:
    // chunk 1 starts at 10,485,852 — i.e. one byte past
    // chunk0.offset + chunk0.length.
    expect(requestedWindows).toEqual([
      {
        start: CHUNK0_OFFSET,
        end: CHUNK0_OFFSET + CHUNK0_CIPHER - 1,
        length: CHUNK0_CIPHER,
      },
      {
        start: CHUNK1_OFFSET,
        end: CHUNK1_OFFSET + CHUNK1_CIPHER - 1,
        length: CHUNK1_CIPHER,
      },
    ]);

    // The 256 KiB MSE reader never ran: the fallback is a single
    // whole-file read, so the window list has exactly two entries.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    /* ── the assembled plaintext ───────────────────────────────── */

    // `sessionToBoundedBlobUrl` builds a Blob from ONE
    // `session.read(0, size)`; we verify that read directly against
    // the real ByteRuntime so the seam-crossing bytes are checked
    // byte-for-byte (the Blob URL alone cannot be inspected).
    const assembled = await session.read(0, MEDIA_BYTES);

    expect(assembled.byteLength).toBe(MEDIA_BYTES);
    expect(bytesEqual(assembled, PLAINTEXT)).toBe(true);

    // Spot-check the seam itself: the last byte of chunk 0 and the
    // first byte of chunk 1 must be exactly the expected plaintext —
    // a truncation or off-by-one at the boundary would surface here.
    expect(assembled[CHUNK0_PLAIN - 1]).toBe(plaintextByte(CHUNK0_PLAIN - 1));
    expect(assembled[CHUNK0_PLAIN]).toBe(plaintextByte(CHUNK0_PLAIN));
    expect(assembled[CHUNK0_PLAIN + 1]).toBe(plaintextByte(CHUNK0_PLAIN + 1));
    expect(assembled[MEDIA_BYTES - 1]).toBe(plaintextByte(MEDIA_BYTES - 1));

    /* ── the timing budget ─────────────────────────────────────── */

    // One bounded read under the caller's single 30 s deadline.
    expect(elapsed).toBeLessThan(MEDIA_READ_TIMEOUT_MS);

    // The second read is served from the ByteRuntime cache (the
    // fallback already loaded both chunks), so it cannot have
    // triggered further network traffic.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a REAL read failure unchanged — the codec answer alone does not force a fallback", async () => {
    vi.useFakeTimers();

    // Serve a 500 (not 206) from every gateway: the range read
    // exhausts and fails closed BEFORE the capability decision.
    fetchMock.mockImplementation((_url: string, _init: RequestInit) =>
      Promise.resolve({
        status: 500,
        ok: false,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response)
    );

    const session = makeSession();
    const p = openStreamableOrFallback(
      session,
      { mimeType: STORED_MIME, size: MEDIA_BYTES } as never,
      new AbortController().signal
    );

    await advanceUntilSettled(p);

    /**
     * The failure must be a READ failure, NOT a silent Blob and NOT
     * a `MediaNotStreamableError`. The `storage.ts` façade wraps every
     * adapter failure in its canonical fail-closed message
     * (`[AETERNA] Storage failure`), so that is the observable error
     * here — the important part is that it is NOT the capability
     * error, which is what would authorise a fallback.
     */
    await expect(p).rejects.toThrow(/Storage failure/);

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }

    // Fail-closed on the read path means the error must NOT be a
    // MediaNotStreamableError (that is the ONLY fallback trigger).
    expect(isMediaNotStreamableError(caught)).toBe(false);

    // No Blob URL was ever minted.
    expect(blobObjectUrls).toHaveLength(0);
  });
});

describe("guard: the capability error is the ONLY fallback trigger", () => {
  it("MediaNotStreamableError is what the codec-qualified MIME produces", async () => {
    // Directly assert the classification contract this suite relies on.
    const err = new MediaNotStreamableError(STORED_MIME);
    expect(err.mimeType).toBe(STORED_MIME);
    expect(err.message).toContain("Progressive playback unavailable");

    // A codec-qualified MIME resolves to null on the iOS capability
    // answer, which is exactly what raises this error inside
    // `sessionToMediaSource`.
    expect(resolveStreamableMimeType(STORED_MIME)).toBeNull();
  });
});
