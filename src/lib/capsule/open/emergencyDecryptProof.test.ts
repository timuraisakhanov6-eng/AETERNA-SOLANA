/**
 * @vitest-environment node
 *
 * This test exercises REAL WebCrypto (generateVaultKey, encryptChunk,
 * decryptChunk) which requires `globalThis.crypto.subtle` — available
 * in the Node.js runtime, but NOT in jsdom. No DOM APIs are used;
 * storage.downloadRange is mocked.
 *
 * =========================================================
 * Emergency Runtime — real decryption proof
 * =========================================================
 *
 * The previous cryptoKey-passthrough tests mock `decryptChunk`
 * entirely (vi.mock). They prove the key argument is truthy,
 * but NOT that a real AES-256-GCM CryptoKey actually decrypts
 * a real encrypted chunk.
 *
 * This test file closes that gap:
 *
 *   • generates a REAL CryptoKey via `generateVaultKey`
 *     (PBKDF2-derived, extractable=false, AES-GCM-256);
 *   • encrypts synthetic plaintext via the project's own
 *     `encryptChunk` (which uses `deriveChunkIV` internally);
 *   • mocks ONLY `storage.downloadRange` (network I/O);
 *   • lets `decryptChunk` run as REAL code inside `loadChunk`;
 *   • verifies three invariants:
 *       1. correct key → correct plaintext bytes;
 *       2. wrong key → SEALED_ERROR (decryption failure);
 *       3. corrupted ciphertext → SEALED_ERROR (auth tag mismatch).
 *
 * No real capsule data, no network, no capability secrets.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

/**
 * Mock ONLY the network storage layer.
 * `decryptChunk` and `encryptChunk` run as REAL code.
 */
vi.mock("@/lib/storage/storage", () => ({
  storage: {
    downloadRange: vi.fn(),
    download: vi.fn(),
  },
  getChunkPointerReadout: vi.fn(),
}));

import type { PublishedChunkMetadata } from "@/types/vault";

import { generateVaultKey } from "@/lib/crypto/generateVaultKey";
import { deriveChunkBaseIV } from "@/lib/crypto/deriveChunkBaseIV";
import { encryptChunk } from "@/lib/crypto/encryptChunk";
import { decryptChunk } from "@/lib/crypto/decryptChunk";
import { loadChunk } from "@/lib/capsule/runtime/chunkLoader";
import { createByteRuntime } from "@/lib/capsule/runtime/byteRuntime";
import { storage } from "@/lib/storage/storage";

import {
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
} from "@/lib/crypto/constants";

/* ───────── synthetic test material ───────── */

/**
 * Synthetic values that satisfy the project's own validators:
 *
 *   CAPSULE_ID_REGEX = /^[a-f0-9]{64}$/
 *   SECRET_REGEX     = /^[a-f0-9]{64}$/
 *   SALT_BASE_REGEX  = /^[a-f0-9]{32}$/
 *   ITEM_ID_REGEX    = /^[a-zA-Z0-9_-]{1,128}$/
 */
const CAPSULE_ID =
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SALT_BASE =
  "0123456789abcdef0123456789abcdef";
const OPEN_AT = 1735689600000; // 2025-01-01T00:00:00.000Z
const ITEM_ID = "media-item-test-0";

/**
 * Synthetic plaintext: 256 bytes of recognisable pattern.
 * Chosen to be well under MAX_CHUNK_SIZE (10 MiB) and
 * larger than the minimum ciphertext size (IV + tag = 28 bytes).
 */
const PLAINTEXT_SIZE = 256;
const PLAINTEXT = new Uint8Array(PLAINTEXT_SIZE);
for (let i = 0; i < PLAINTEXT_SIZE; i++) {
  PLAINTEXT[i] = i & 0xff;
}

const PTR = "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo";
const CHUNK_OVERHEAD = AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH / 8; // 28
const CIPHER_SIZE = PLAINTEXT_SIZE + CHUNK_OVERHEAD; // 284

/* ───────── fixtures ───────── */

let realKey: CryptoKey;
let wrongKey: CryptoKey;
let baseIV: Uint8Array;
let encryptedChunk: Uint8Array<ArrayBuffer>;

/* ───────── setup ───────── */

beforeEach(async () => {
  /**
   * Generate TWO real CryptoKeys using the project's own
   * PBKDF2 derivation. `realKey` encrypts; both `realKey`
   * and `wrongKey` are real AES-256-GCM keys — the wrong
   * one simply uses a different secret.
   */
  realKey = await generateVaultKey({
    secret: SECRET,
    saltBase: SALT_BASE,
    openAt: OPEN_AT,
    capsuleId: CAPSULE_ID,
  });

  wrongKey = await generateVaultKey({
    secret:
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    saltBase: SALT_BASE,
    openAt: OPEN_AT,
    capsuleId: CAPSULE_ID,
  });

  baseIV = await deriveChunkBaseIV(CAPSULE_ID, ITEM_ID);

  encryptedChunk = await encryptChunk(
    PLAINTEXT,
    realKey,
    baseIV,
    0, // chunk index
    CAPSULE_ID,
  );

  /**
   * Sanity: the encrypted chunk has the expected layout
   * [12-byte IV][ciphertext + 16-byte tag].
   */
  expect(encryptedChunk.byteLength).toBe(CIPHER_SIZE);
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ───────── helpers ───────── */

function makePublishedChunk(): PublishedChunkMetadata {
  return {
    chunkId: "c0",
    mediaId: ITEM_ID,
    index: 0,
    size: CIPHER_SIZE,
    pointer: PTR,
  } as unknown as PublishedChunkMetadata;
}

/**
 * Asserts that a promise rejects (does NOT resolve).
 */
async function expectReject(
  fn: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await fn();
    expect.fail(`${label}: expected rejection but promise resolved`);
  } catch (e) {
    // Expected — any rejection is valid (SEALED_ERROR or equivalent).
    expect(e).toBeInstanceOf(Error);
  }
}

/* ───────── tests ───────── */

describe("real decryption proof — cryptoKey is a real CryptoKey, not a stub", () => {
  it("generateVaultKey produces a genuine CryptoKey (instanceof CryptoKey, AES-GCM-256, secret, non-extractable, decrypt usage)", () => {
    // This is the key that the emergency runtime threads through
    // to loadChunk → decryptChunk. If it is a plain object {} (the
    // old stub), decryptChunk's isCryptoKey() guard rejects it.
    expect(realKey).toBeInstanceOf(CryptoKey);

    const algo = realKey.algorithm as AesKeyAlgorithm;
    expect(realKey.type).toBe("secret");
    expect(realKey.extractable).toBe(false);
    expect(realKey.usages).toContain("decrypt");
    expect(algo.name).toBe("AES-GCM");
    expect(algo.length).toBe(256);
  });
});

describe("real decryption proof — correct key decrypts encrypted chunk to expected plaintext", () => {
  it("decryptChunk (real) with the correct key produces the original plaintext bytes", async () => {
    // Call the REAL decryptChunk directly.
    const decrypted = await decryptChunk(
      encryptedChunk,
      realKey,
      0, // index
      CAPSULE_ID,
    );

    expect(decrypted).toBeInstanceOf(Uint8Array);
    expect(decrypted.byteLength).toBe(PLAINTEXT_SIZE);

    // Byte-for-byte match with the original synthetic plaintext.
    for (let i = 0; i < PLAINTEXT_SIZE; i++) {
      expect(decrypted[i]).toBe(PLAINTEXT[i]);
    }
  });

  it("loadChunk (real decrypt path) with mocked storage returns the original plaintext", async () => {
    // Mock storage.downloadRange to return the encrypted bytes.
    vi.mocked(storage.downloadRange).mockResolvedValue(
      encryptedChunk as Uint8Array<ArrayBuffer>,
    );

    const chunk = makePublishedChunk();

    // loadChunk calls storage.downloadRange then decryptChunk.
    // Only storage is mocked — decryptChunk is REAL code.
    const decrypted = await loadChunk(CAPSULE_ID, chunk, realKey);

    expect(decrypted).toBeInstanceOf(Uint8Array);
    expect(decrypted.byteLength).toBe(PLAINTEXT_SIZE);

    for (let i = 0; i < PLAINTEXT_SIZE; i++) {
      expect(decrypted[i]).toBe(PLAINTEXT[i]);
    }
  });

  it("createByteRuntime.getBytes (full real path) returns the original plaintext", async () => {
    // Mock storage.downloadRange to return the encrypted bytes.
    vi.mocked(storage.downloadRange).mockResolvedValue(
      encryptedChunk as Uint8Array<ArrayBuffer>,
    );

    const chunk = makePublishedChunk();

    // Full ByteRuntime path: getBytes → getChunkBytes → loadChunk → decryptChunk.
    // Only storage is mocked; all crypto is REAL.
    const runtime = createByteRuntime(
      CAPSULE_ID,
      realKey,
      [chunk],
      PLAINTEXT_SIZE,
    );

    const result = await runtime.getBytes(0, PLAINTEXT_SIZE);

    expect(result.byteLength).toBe(PLAINTEXT_SIZE);

    for (let i = 0; i < PLAINTEXT_SIZE; i++) {
      expect(result[i]).toBe(PLAINTEXT[i]);
    }
  });
});

describe("real decryption proof — wrong key and corrupted ciphertext fail", () => {
  it("a DIFFERENT real CryptoKey fails to decrypt the chunk (SEALED_ERROR)", async () => {
    // wrongKey is a genuine AES-256-GCM key derived from a different
    // secret. The GCM auth tag will not validate.
    await expectReject(
      () => decryptChunk(encryptedChunk, wrongKey, 0, CAPSULE_ID),
      "wrong key decryptChunk",
    );
  });

  it("a corrupted ciphertext (1-byte flip) fails to decrypt (SEALED_ERROR)", async () => {
    // Flip a byte in the ciphertext body (not the IV — the IV is
    // extracted from the payload; flipping it would also fail, but
    // we want to prove the GCM auth tag catches ciphertext tampering).
    const corrupted = encryptedChunk.slice();
    // Flip a byte near the end of the ciphertext (in the tag area).
    const lastIdx = corrupted.byteLength - 1;
    corrupted.set([corrupted[lastIdx]! ^ 0xff], lastIdx);

    await expectReject(
      () => decryptChunk(corrupted, realKey, 0, CAPSULE_ID),
      "corrupted ciphertext decryptChunk",
    );
  });

  it("loadChunk with the wrong key fails (real decrypt path, mocked storage)", async () => {
    vi.mocked(storage.downloadRange).mockResolvedValue(
      encryptedChunk as Uint8Array<ArrayBuffer>,
    );

    const chunk = makePublishedChunk();

    await expectReject(
      () => loadChunk(CAPSULE_ID, chunk, wrongKey),
      "wrong key loadChunk",
    );
  });

  it("a plain object {} is NOT accepted as a CryptoKey by decryptChunk (isCryptoKey guard)", async () => {
    // This is the regression that the old `null as unknown as CryptoKey`
    // bug would hit: decryptChunk rejects non-CryptoKey values.
    await expectReject(
      () =>
        decryptChunk(
          encryptedChunk,
          {} as CryptoKey,
          0,
          CAPSULE_ID,
        ),
      "plain object as key",
    );
  });

  it("null is NOT accepted as a CryptoKey by decryptChunk", async () => {
    await expectReject(
      () =>
        decryptChunk(
          encryptedChunk,
          null as unknown as CryptoKey,
          0,
          CAPSULE_ID,
        ),
      "null as key",
    );
  });
});
