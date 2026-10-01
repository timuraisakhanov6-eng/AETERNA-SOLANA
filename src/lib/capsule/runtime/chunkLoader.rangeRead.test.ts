/**
 * =========================================================
 * chunkLoader — range-read regression (Stage 1)
 * =========================================================
 *
 * The CURRENT multi-DataItem layout must be preserved:
 * every chunk is already its own DataItem, so the loader must
 * read it with offset = 0 and length = chunk.size, verify the
 * returned length exactly, and hand the same bytes to
 * decryptChunk() as before.
 *
 * Storage and decryptChunk are both mocked — no network, no
 * real AES-GCM. What is under test is the loader's contract.
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

vi.mock("@/lib/storage/storage", () => ({
  storage: {
    downloadRange: vi.fn(),
    download: vi.fn(),
  },
}));

vi.mock("@/lib/crypto/decryptChunk", () => ({
  decryptChunk: vi.fn(),
}));

import { loadChunk } from "@/lib/capsule/runtime/chunkLoader";
import { storage } from "@/lib/storage/storage";
import { decryptChunk } from "@/lib/crypto/decryptChunk";

const mockDownloadRange =
  storage.downloadRange as unknown as ReturnType<typeof vi.fn>;
const mockDownload =
  storage.download as unknown as ReturnType<typeof vi.fn>;
const mockDecrypt =
  decryptChunk as unknown as ReturnType<typeof vi.fn>;

const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

const CAPSULE_ID = "cap-0000000000000000";

const CRYPTO_KEY = {} as CryptoKey;

/** 4096 = a plausible AES-GCM ciphertext length for a small chunk. */
const CHUNK_SIZE = 4096;

function makeChunk(
  overrides: Partial<PublishedChunkMetadata> = {}
): PublishedChunkMetadata {
  return {
    chunkId: "chunk-0",
    mediaId: "media-0",
    index: 3,
    size: CHUNK_SIZE,
    pointer: POINTER,
    ...overrides,
  } as unknown as PublishedChunkMetadata;
}

function ciphertext(length = CHUNK_SIZE, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 7 + seed) & 0xff;
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecrypt.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

/* ------------------------------------------------------------------ *
 * The current multi-DataItem contract
 * ------------------------------------------------------------------ */

describe("chunkLoader — current multi-DataItem path", () => {
  it("reads offset=0 with the expected encrypted chunk length", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext());

    await loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY);

    expect(mockDownloadRange).toHaveBeenCalledTimes(1);
    expect(mockDownloadRange).toHaveBeenCalledWith(
      POINTER,
      0,
      CHUNK_SIZE
    );
  });

  it("never falls back to a whole-object download", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext());

    await loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY);

    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("uses offset=0 for every chunk index (no container offsets yet)", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext());

    await loadChunk(CAPSULE_ID, makeChunk({ index: 0 }), CRYPTO_KEY);
    await loadChunk(CAPSULE_ID, makeChunk({ index: 7 }), CRYPTO_KEY);
    await loadChunk(CAPSULE_ID, makeChunk({ index: 12345 }), CRYPTO_KEY);

    expect(mockDownloadRange).toHaveBeenCalledTimes(3);
    for (const call of mockDownloadRange.mock.calls) {
      expect(call[1]).toBe(0);
      expect(call[2]).toBe(CHUNK_SIZE);
    }
  });

  it("requests exactly the chunk's own ciphertext length", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext(999));

    await loadChunk(CAPSULE_ID, makeChunk({ size: 999 }), CRYPTO_KEY);

    expect(mockDownloadRange).toHaveBeenCalledWith(POINTER, 0, 999);
  });

  it("returns the decrypted bytes", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext());
    mockDecrypt.mockResolvedValue(new Uint8Array([9, 9, 9]));

    const out = await loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY);

    expect(Array.from(out)).toEqual([9, 9, 9]);
  });
});

/* ------------------------------------------------------------------ *
 * Integrity / crypto boundary preservation
 * ------------------------------------------------------------------ */

describe("chunkLoader — decrypt boundary preserved", () => {
  it("passes the downloaded ciphertext to decryptChunk unchanged", async () => {
    const bytes = ciphertext();
    const expected = Array.from(bytes);
    mockDownloadRange.mockResolvedValue(bytes);

    // Snapshot INSIDE the call: the loader zeroizes the buffer in its
    // finally block, so inspecting the mock's stored reference after
    // the await would only ever show zeros.
    let seenAtCallTime: number[] | null = null;
    mockDecrypt.mockImplementation(async (buf: Uint8Array) => {
      seenAtCallTime = Array.from(buf);
      return new Uint8Array([1, 2, 3]);
    });

    await loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY);

    expect(seenAtCallTime).toEqual(expected);
  });

  it("preserves deriveChunkIV inputs (chunk.index and capsuleId)", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext());

    await loadChunk(CAPSULE_ID, makeChunk({ index: 42 }), CRYPTO_KEY);

    expect(mockDecrypt).toHaveBeenCalledTimes(1);

    const call = mockDecrypt.mock.calls[0] as unknown[] | undefined;
    if (!call) throw new Error("decryptChunk was not called");

    expect(call[1]).toBe(CRYPTO_KEY);
    expect(call[2]).toBe(42);
    expect(call[3]).toBe(CAPSULE_ID);
  });

  it("propagates a decryption failure", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext());
    mockDecrypt.mockRejectedValue(
      new Error("[AETERNA] Chunk decryption failed")
    );

    await expect(
      loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY)
    ).rejects.toThrow("[AETERNA] Chunk decryption failed");
  });
});

/* ------------------------------------------------------------------ *
 * Fail-closed behaviour
 * ------------------------------------------------------------------ */

describe("chunkLoader — fails closed", () => {
  it("rejects a returned window shorter than expected", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext(CHUNK_SIZE - 1));

    await expect(
      loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY)
    ).rejects.toThrow("[AETERNA] Chunk download failed");

    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("rejects a returned window longer than expected", async () => {
    mockDownloadRange.mockResolvedValue(ciphertext(CHUNK_SIZE + 1));

    await expect(
      loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY)
    ).rejects.toThrow("[AETERNA] Chunk download failed");

    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("rejects a non-Uint8Array result", async () => {
    mockDownloadRange.mockResolvedValue("not bytes");

    await expect(
      loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY)
    ).rejects.toThrow("[AETERNA] Chunk download failed");

    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("propagates a storage failure", async () => {
    mockDownloadRange.mockRejectedValue(
      new Error("[AETERNA] Storage failure")
    );

    await expect(
      loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY)
    ).rejects.toThrow("[AETERNA] Storage failure");
  });

  it("rejects an invalid chunk.size without issuing a read", async () => {
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        loadChunk(CAPSULE_ID, makeChunk({ size }), CRYPTO_KEY)
      ).rejects.toThrow("[AETERNA] Invalid chunk metadata");
    }

    expect(mockDownloadRange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Memory hygiene
 * ------------------------------------------------------------------ */

describe("chunkLoader — ciphertext zeroization", () => {
  it("wipes the downloaded ciphertext after a successful load", async () => {
    const bytes = ciphertext();
    mockDownloadRange.mockResolvedValue(bytes);

    await loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY);

    expect(Array.from(bytes).every((b) => b === 0)).toBe(true);
  });

  it("wipes the ciphertext even when decryption fails", async () => {
    const bytes = ciphertext();
    mockDownloadRange.mockResolvedValue(bytes);
    mockDecrypt.mockRejectedValue(
      new Error("[AETERNA] Chunk decryption failed")
    );

    await expect(
      loadChunk(CAPSULE_ID, makeChunk(), CRYPTO_KEY)
    ).rejects.toThrow();

    expect(Array.from(bytes).every((b) => b === 0)).toBe(true);
  });
});
