/**
 * =========================================================
 * ByteRuntime — ByteMap / range math unit tests
 * =========================================================
 *
 * Scope: buildByteMap() and resolveRange(), exercised only
 * through the public createByteRuntime()/getBytes() surface
 * (both helpers are module-private by design — see the
 * "Canonical Execution Layer" header in byteRuntime.ts).
 *
 * These tests deliberately know nothing about Storage,
 * Executor, or real AES-GCM: chunkLoader.loadChunk() is
 * mocked out, so what's under test is exactly the offset
 * arithmetic that produced the original ByteMap defect
 * (ciphertext-coordinate/plaintext-coordinate confusion),
 * and nothing else.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";

import type { PublishedChunkMetadata } from "@/types/vault";
import type { StoragePointer } from "@/lib/storage/storageAdapter";
import {
  MAX_CHUNK_SIZE,
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
} from "@/lib/crypto/constants";

// Mock must come before importing the module under test — Vitest
// hoists vi.mock() calls to the top of the file automatically.
vi.mock("@/lib/capsule/runtime/chunkLoader", () => ({
  loadChunk: vi.fn(),
}));

import { loadChunk } from "@/lib/capsule/runtime/chunkLoader";
import { createByteRuntime } from "@/lib/capsule/runtime/byteRuntime";

const mockLoadChunk =
  loadChunk as unknown as ReturnType<typeof vi.fn>;

const FAKE_CRYPTO_KEY = {} as CryptoKey;
const CAPSULE_ID = "test-capsule";

/**
 * Same overhead byteRuntime.ts computes internally
 * (12-byte IV + 16-byte GCM tag), derived from the same
 * canonical constants — never hardcoded, so this stays in
 * sync with constants.ts automatically.
 */
const CHUNK_CIPHERTEXT_OVERHEAD =
  AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH / 8;

/**
 * Builds a deterministic plaintext buffer and slices it
 * exactly the way prepareMediaChunks.ts does:
 *
 *   while (offset < size) { end = min(offset + MAX, size) }
 *
 * Returns the chunk metadata (as it would appear after
 * publish — chunk.size is the *ciphertext* length, matching
 * ChunkMetadata/PublishedChunkMetadata) plus a lookup table
 * so the mocked loadChunk() can return the right plaintext
 * slice for each chunk index.
 */
function buildTestMedia(
  plaintextSize: number,
  maxChunkSize: number = MAX_CHUNK_SIZE,
  seed = 0,
) {
  const fullPlaintext = new Uint8Array(plaintextSize);
  for (let i = 0; i < plaintextSize; i++) {
    fullPlaintext[i] = (seed + i) & 0xff;
  }

  const chunks: PublishedChunkMetadata[] = [];
  const plaintextByIndex = new Map<number, Uint8Array>();

  let offset = 0;
  let index = 0;

  while (offset < plaintextSize) {
    const end = Math.min(offset + maxChunkSize, plaintextSize);
    const slice = fullPlaintext.slice(offset, end);

    plaintextByIndex.set(index, slice);

    chunks.push(
      Object.freeze({
        chunkId: `chunk-${index}`,
        mediaId: "test-media",
        index,
        size: slice.byteLength + CHUNK_CIPHERTEXT_OVERHEAD,
        pointer: `stub-pointer-${index}` as unknown as StoragePointer,
      }),
    );

    offset = end;
    index++;
  }

  return { fullPlaintext, chunks, plaintextByIndex };
}

beforeEach(() => {
  mockLoadChunk.mockReset();
});

/**
 * Plain O(n) comparison for potentially multi-megabyte typed
 * arrays. Chai's `toEqual` deep-equality walks large typed
 * arrays through generic object-diffing machinery, which
 * allocates per-element wrapper structures and can exhaust the
 * worker's heap well before the array itself would (observed
 * OOM around a ~20MB comparison). This is functionally
 * identical to toEqual for two Uint8Arrays, just without the
 * diffing overhead.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Wires the mock to return whatever plaintext each chunk
 * index maps to — the mock never sees real ciphertext.
 */
function wireLoader(plaintextByIndex: Map<number, Uint8Array>) {
  mockLoadChunk.mockImplementation(
    async (_capsuleId: string, chunk: PublishedChunkMetadata) => {
      const bytes = plaintextByIndex.get(chunk.index);
      if (!bytes) {
        throw new Error(`No test plaintext for chunk ${chunk.index}`);
      }
      return bytes;
    },
  );
}

describe("byteRuntime — single chunk", () => {
  it("byte map covers exactly the file size", async () => {
    const plaintextSize = 5_000;
    const { fullPlaintext, chunks, plaintextByIndex } =
      buildTestMedia(plaintextSize);

    expect(chunks).toHaveLength(1);
    wireLoader(plaintextByIndex);

    const runtime = createByteRuntime(
      CAPSULE_ID,
      FAKE_CRYPTO_KEY,
      chunks,
      plaintextSize,
    );

    const bytes = await runtime.getBytes(0, plaintextSize);

    expect(bytes).toHaveLength(plaintextSize);
    expect(bytesEqual(bytes, fullPlaintext)).toBe(true);
  });
});

describe("byteRuntime — two chunks", () => {
  it("second chunk starts exactly where the first plaintext chunk ends", async () => {
    // First chunk fills MAX_CHUNK_SIZE exactly; second chunk holds
    // the remainder. This is the real boundary that produced the
    // original defect (a large image/video just over one chunk).
    const plaintextSize = MAX_CHUNK_SIZE + 777;
    const { fullPlaintext, chunks, plaintextByIndex } =
      buildTestMedia(plaintextSize);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.size).toBe(MAX_CHUNK_SIZE + CHUNK_CIPHERTEXT_OVERHEAD);
    expect(chunks[1]!.size).toBe(777 + CHUNK_CIPHERTEXT_OVERHEAD);
    wireLoader(plaintextByIndex);

    const runtime = createByteRuntime(
      CAPSULE_ID,
      FAKE_CRYPTO_KEY,
      chunks,
      plaintextSize,
    );

    // Read exactly the second chunk's plaintext region and confirm
    // it starts at file offset MAX_CHUNK_SIZE, not at any
    // ciphertext-derived offset.
    const secondChunkBytes = await runtime.getBytes(
      MAX_CHUNK_SIZE,
      plaintextSize,
    );

    expect(secondChunkBytes).toHaveLength(777);
    expect(
      bytesEqual(
        secondChunkBytes,
        fullPlaintext.slice(MAX_CHUNK_SIZE, plaintextSize),
      ),
    ).toBe(true);
  });
});

describe("byteRuntime — N chunks", () => {
  it("sum of all plaintext chunk lengths equals plaintextSize", async () => {
    // 2 full chunks + 1 partial => 3 chunks total.
    const plaintextSize = MAX_CHUNK_SIZE * 2 + 12_345;
    const { fullPlaintext, chunks, plaintextByIndex } =
      buildTestMedia(plaintextSize);

    expect(chunks).toHaveLength(3);
    wireLoader(plaintextByIndex);

    const runtime = createByteRuntime(
      CAPSULE_ID,
      FAKE_CRYPTO_KEY,
      chunks,
      plaintextSize,
    );

    const full = await runtime.getBytes(0, plaintextSize);

    expect(full).toHaveLength(plaintextSize);
    expect(bytesEqual(full, fullPlaintext)).toBe(true);
  });
});

describe("byteRuntime — invariant violations", () => {
  it("throws when chunk.size does not match the derived plaintext length", () => {
    const plaintextSize = 10_000;
    const { chunks } = buildTestMedia(plaintextSize);

    // Corrupt the (only) chunk's reported ciphertext size.
    const corrupted = [
      { ...chunks[0]!, size: chunks[0]!.size + 1 },
    ];

    expect(() =>
      createByteRuntime(
        CAPSULE_ID,
        FAKE_CRYPTO_KEY,
        corrupted,
        plaintextSize,
      ),
    ).toThrow(/ciphertext size does not match/i);
  });

  it("throws on a non-contiguous chunk index sequence", () => {
    const plaintextSize = MAX_CHUNK_SIZE + 500;
    const { chunks } = buildTestMedia(plaintextSize);

    // Drop the first chunk so the sequence starts at index 1.
    const brokenSequence = [chunks[1]!];

    expect(() =>
      createByteRuntime(
        CAPSULE_ID,
        FAKE_CRYPTO_KEY,
        brokenSequence,
        plaintextSize,
      ),
    ).toThrow(/invalid chunk sequence/i);
  });

  it("throws when reconstructed size does not match the declared media size", () => {
    const plaintextSize = MAX_CHUNK_SIZE + 500;
    const { chunks } = buildTestMedia(plaintextSize);

    // Only publish the first chunk — declared size still says
    // MAX_CHUNK_SIZE + 500, but the map only covers MAX_CHUNK_SIZE.
    const truncated = [chunks[0]!];

    expect(() =>
      createByteRuntime(
        CAPSULE_ID,
        FAKE_CRYPTO_KEY,
        truncated,
        plaintextSize,
      ),
    ).toThrow(/reconstructed size does not match/i);
  });
});

describe("byteRuntime — range reads across a chunk boundary", () => {
  it("returns a continuous, correctly-aligned byte stream straddling two chunks", async () => {
    const plaintextSize = MAX_CHUNK_SIZE + 1_000;
    const { fullPlaintext, chunks, plaintextByIndex } =
      buildTestMedia(plaintextSize, MAX_CHUNK_SIZE, /* seed */ 7);

    expect(chunks).toHaveLength(2);
    wireLoader(plaintextByIndex);

    const runtime = createByteRuntime(
      CAPSULE_ID,
      FAKE_CRYPTO_KEY,
      chunks,
      plaintextSize,
    );

    // 50 bytes from the tail of chunk 0 + 50 bytes from the head
    // of chunk 1 — exactly the range that a misaligned ByteMap
    // would corrupt or misplace.
    const start = MAX_CHUNK_SIZE - 50;
    const end = MAX_CHUNK_SIZE + 50;

    const bytes = await runtime.getBytes(start, end);

    expect(bytes).toHaveLength(100);
    expect(bytesEqual(bytes, fullPlaintext.slice(start, end))).toBe(true);

    // The first 50 bytes must come from chunk 0's tail, the next
    // 50 from chunk 1's head — check both halves independently so
    // a coincidental full-match doesn't hide a shifted-by-N bug.
    expect(
      bytesEqual(
        bytes.slice(0, 50),
        fullPlaintext.slice(MAX_CHUNK_SIZE - 50, MAX_CHUNK_SIZE),
      ),
    ).toBe(true);
    expect(
      bytesEqual(
        bytes.slice(50, 100),
        fullPlaintext.slice(MAX_CHUNK_SIZE, MAX_CHUNK_SIZE + 50),
      ),
    ).toBe(true);
  });

  it("a read confined to a single chunk never touches the other chunk's loader call", async () => {
    const plaintextSize = MAX_CHUNK_SIZE + 1_000;
    const { fullPlaintext, chunks, plaintextByIndex } =
      buildTestMedia(plaintextSize);

    wireLoader(plaintextByIndex);

    const runtime = createByteRuntime(
      CAPSULE_ID,
      FAKE_CRYPTO_KEY,
      chunks,
      plaintextSize,
    );

    const bytes = await runtime.getBytes(100, 200);

    expect(bytesEqual(bytes, fullPlaintext.slice(100, 200))).toBe(true);
    expect(mockLoadChunk).toHaveBeenCalledTimes(1);
    expect(mockLoadChunk).toHaveBeenCalledWith(
      CAPSULE_ID,
      expect.objectContaining({ index: 0 }),
      FAKE_CRYPTO_KEY,
    );
  });
});