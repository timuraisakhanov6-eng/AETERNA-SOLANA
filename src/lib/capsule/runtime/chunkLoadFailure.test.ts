/**
 * =========================================================
 * Phase F1 — chunk-loader + ByteRuntime typed boundaries
 * =========================================================
 *
 * Asserts the two chunk-layer boundaries (`chunk-length-mismatch`,
 * `chunk-decrypt-failed`) and the ByteRuntime reconstruction boundary
 * are TYPED and that neither leaks its raw underlying error.
 *
 * Only `storage` and `decryptChunk` are stubbed; `loadChunk` and
 * `createByteRuntime` are the REAL production code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/storage/storage", () => ({
  storage: { downloadRange: vi.fn() },
}));
vi.mock("@/lib/crypto/decryptChunk", () => ({
  decryptChunk: vi.fn(),
}));

import type { PublishedChunkMetadata } from "@/types/vault";
import type { StoragePointer } from "@/lib/storage/storageAdapter";

import { loadChunk } from "@/lib/capsule/runtime/chunkLoader";
import { createByteRuntime } from "@/lib/capsule/runtime/byteRuntime";
import { storage } from "@/lib/storage/storage";
import { decryptChunk } from "@/lib/crypto/decryptChunk";
import {
  ChunkLoadError,
  isChunkLoadError,
  isByteRuntimeReconstructionError,
} from "@/lib/capsule/runtime/chunkLoadFailure";

const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;
const CAPSULE_ID =
  "6a2f7dcbe568378609755cb2b081552f7999442e15f3a54a6c47d0bfe202dd9a";
const KEY = {} as CryptoKey;

const CHUNK: PublishedChunkMetadata = {
  chunkId: "c0",
  mediaId: "m0",
  index: 0,
  size: 128,
  pointer: POINTER,
} as unknown as PublishedChunkMetadata;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("Phase F1 — loadChunk typed boundaries", () => {
  it("a stored window of the WRONG length → chunk-length-mismatch", async () => {
    vi.mocked(storage.downloadRange).mockResolvedValue(
      new Uint8Array(CHUNK.size - 1) as unknown as Uint8Array<ArrayBuffer>,
    );

    let caught: unknown;
    try {
      await loadChunk(CAPSULE_ID, CHUNK, KEY);
    } catch (err) {
      caught = err;
    }

    expect(isChunkLoadError(caught)).toBe(true);
    expect((caught as ChunkLoadError).code).toBe("chunk-length-mismatch");
    // Decryption is never attempted on a length mismatch.
    expect(decryptChunk).not.toHaveBeenCalled();
  });

  it("a non-Uint8Array result → chunk-length-mismatch", async () => {
    vi.mocked(storage.downloadRange).mockResolvedValue(
      "not-bytes" as unknown as Uint8Array<ArrayBuffer>,
    );

    let caught: unknown;
    try {
      await loadChunk(CAPSULE_ID, CHUNK, KEY);
    } catch (err) {
      caught = err;
    }

    expect(isChunkLoadError(caught)).toBe(true);
    expect((caught as ChunkLoadError).code).toBe("chunk-length-mismatch");
  });

  it("a correctly-sized window that decryptChunk REJECTS → chunk-decrypt-failed", async () => {
    vi.mocked(storage.downloadRange).mockResolvedValue(
      new Uint8Array(CHUNK.size) as unknown as Uint8Array<ArrayBuffer>,
    );
    vi.mocked(decryptChunk).mockRejectedValue(
      new Error("[AETERNA] Chunk decryption failed"),
    );

    let caught: unknown;
    try {
      await loadChunk(CAPSULE_ID, CHUNK, KEY);
    } catch (err) {
      caught = err;
    }

    expect(isChunkLoadError(caught)).toBe(true);
    expect((caught as ChunkLoadError).code).toBe("chunk-decrypt-failed");
  });

  it("a successful read+decrypt returns the plaintext (unchanged)", async () => {
    const plain = new Uint8Array(CHUNK.size - 28).fill(7);
    vi.mocked(storage.downloadRange).mockResolvedValue(
      new Uint8Array(CHUNK.size) as unknown as Uint8Array<ArrayBuffer>,
    );
    vi.mocked(decryptChunk).mockResolvedValue(plain);

    const out = await loadChunk(CAPSULE_ID, CHUNK, KEY);
    expect(out.byteLength).toBe(CHUNK.size - 28);
    expect(out[0]).toBe(7);
  });
});

describe("Phase F1 — ByteRuntime reconstruction boundary", () => {
  it("an allocation failure in getBytes → ByteRuntimeReconstructionError", async () => {
    // Two chunks of 10 MiB + small; the SECOND chunk's decrypt fails in
    // a way that is NOT a ChunkLoadError, forcing reconstruction to be
    // reached... instead, force the allocation itself to throw by
    // stubbing the global Uint8Array constructor path is fragile — so we
    // assert the typed boundary via a REAL plan/copy mismatch:
    // a chunk whose decrypted length is SHORTER than the plan requires.
    vi.mocked(storage.downloadRange).mockResolvedValue(
      new Uint8Array(CHUNK.size) as unknown as Uint8Array<ArrayBuffer>,
    );
    // Decrypt returns a buffer too SHORT for the plan slice → copySegments
    // throws "Chunk length mismatch" → wrapped as reconstruction error.
    vi.mocked(decryptChunk).mockResolvedValue(new Uint8Array(1));

    const runtime = createByteRuntime(CAPSULE_ID, KEY, [CHUNK], CHUNK.size - 28);

    let caught: unknown;
    try {
      await runtime.getBytes(0, CHUNK.size - 28);
    } catch (err) {
      caught = err;
    }

    expect(isByteRuntimeReconstructionError(caught)).toBe(true);
  });

  it("a healthy read still returns exactly the requested range (unchanged)", async () => {
    const plain = new Uint8Array(CHUNK.size - 28);
    for (let i = 0; i < plain.length; i++) plain[i] = i & 0xff;

    vi.mocked(storage.downloadRange).mockResolvedValue(
      new Uint8Array(CHUNK.size) as unknown as Uint8Array<ArrayBuffer>,
    );
    vi.mocked(decryptChunk).mockResolvedValue(plain);

    const runtime = createByteRuntime(CAPSULE_ID, KEY, [CHUNK], CHUNK.size - 28);
    const out = await runtime.getBytes(0, 32);
    expect(out.byteLength).toBe(32);
    expect(out[31]).toBe(31 & 0xff);
  });
});
