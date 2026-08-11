/**
 * Mock storage (in-memory)
 *
 * Used ONLY in development.
 * Simulates immutable storage backend behavior (Arweave / Irys).
 *
 * Data lives in memory and disappears after reload.
 *
 * MUST NEVER run in production.
 */

import type {
  StorageAdapter,
  StoragePointer,
  UploadToken,
} from "./storageAdapter";

import {
  assertChunkPointerMap,
  assertUploadToken,
  assertStoragePointer
} from "./storageAdapter";

import type {
  ChunkId,
  ManifestV1
} from "@/types/manifest";

import {
  CAPSULE_ID_REGEX
} from "@/lib/crypto/validators";


/**
 * HARD GUARD
 */

if (import.meta.env.PROD) {

  throw new Error(
    "[AETERNA] mockStorage used in production environment"
  );

}


/**
 * In-memory vault storage
 */

const vaultMemory:
Record<string, Uint8Array> = {};


/**
 * In-memory manifest storage
 */

const manifestMemory:
Record<string, ManifestV1> = {};


/* ================= HELPERS ================= */

/**
 * Canonical detached-buffer check.
 */

function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return (
    arr.byteLength === 0 ||
    arr.buffer.byteLength === 0
  );

}


/**
 * Canonical plain-object check.
 * Parity with devManifestStore.ts.
 */

function isPlainObject(
  v: unknown
): v is Record<string, unknown> {

  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) ===
      Object.prototype
  );

}


/**
 * Generate canonical-compatible StoragePointer.
 *
 * FIX ⚠️ ISSUE 1 — base64url output instead of hex slice:
 * Arweave / Irys txIds are 43-char base64url strings.
 * Hex was valid per STORAGE_POINTER_REGEX but had a
 * distribution of only [0-9a-f], hiding bugs that depend
 * on the full [A-Za-z0-9_-] alphabet.
 *
 * Matches STORAGE_POINTER_REGEX: /^[a-zA-Z0-9_-]{43}$/
 */

function generateMockPointer():
StoragePointer {

  const cryptoObj =
    globalThis.crypto;

  if (!cryptoObj?.getRandomValues) {

    throw new Error(
      "[AETERNA] WebCrypto unavailable"
    );

  }

  // 32 bytes → 43 base64url chars (ceil(32 * 4/3) = 43, no padding)
  const bytes =
    cryptoObj.getRandomValues(
      new Uint8Array(32)
    );

  const b64 = btoa(
    String.fromCharCode(...bytes)
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  bytes.fill(0);

  // btoa(32 bytes) → 44 chars with one trailing "="; after strip: 43
  return assertStoragePointer(
    b64.slice(0, 43)
  );

}


/* ================= ADAPTER ================= */

/**
 * Mock adapter implementation
 */

export const mockStorage:
StorageAdapter & {

  /**
   * DEV helper
   * NOT part of StorageAdapter interface
   */

  saveManifest:
    (manifest: ManifestV1) => void;

} = {

  name: "mock-storage",


  /* =========================
     VAULT STORAGE
  ========================= */

  async upload(
    data: Uint8Array,
    uploadToken: UploadToken
  ): Promise<{
    txId: StoragePointer
  }> {

    /**
     * REQUIRED PROTOCOL INVARIANT
     *
     * NO TOKEN → NO STORAGE WRITE
     */

    assertUploadToken(uploadToken);


    if (!(data instanceof Uint8Array)) {

      throw new Error(
        "mockStorage: invalid upload data"
      );

    }


    // FIX ⚠️ ISSUE 2 — detached-buffer parity with production adapters:
    // bare byteLength === 0 misses detached ArrayBuffer case
    if (isDetachedBuffer(data)) {

      throw new Error(
        "mockStorage: empty or detached upload"
      );

    }


    /**
     * Simulate immutable pointer
     */

    const pointer =
      generateMockPointer();


    /**
     * Store copy (immutability simulation)
     */

    vaultMemory[pointer] =
      new Uint8Array(data);


    return {
      txId: pointer,
    };

  },


  async uploadChunk(
    data: Uint8Array,
    chunkId: ChunkId,
    uploadToken: UploadToken
  ): Promise<{
    txId: StoragePointer
  }> {

    /**
     * MANDATORY CHUNK ID BOUNDARY
     *
     * chunkId REQUIRED
     * NO chunkId → NO UPLOAD
     *
     * The adapter receives the canonical chunkId (SHA-256 of the
     * chunk ciphertext, produced upstream by prepareMediaChunks)
     * from the caller; it is never generated here and never
     * extracted from ciphertext.
     */

    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0
    ) {

      throw new Error(
        "mockStorage: invalid chunkId"
      );

    }


    /**
     * REQUIRED PROTOCOL INVARIANT
     *
     * NO TOKEN → NO STORAGE WRITE
     */

    assertUploadToken(uploadToken);


    if (!(data instanceof Uint8Array)) {

      throw new Error(
        "mockStorage: invalid upload data"
      );

    }


    // detached-buffer parity with upload()
    if (isDetachedBuffer(data)) {

      throw new Error(
        "mockStorage: empty or detached upload"
      );

    }


    /**
     * Simulate immutable pointer
     */

    const pointer =
      generateMockPointer();


    /**
     * Store copy (immutability simulation)
     */

    vaultMemory[pointer] =
      new Uint8Array(data);


    return {
      txId: pointer,
    };

  },


  async download(
    pointer: StoragePointer
  ): Promise<Uint8Array> {

    assertStoragePointer(pointer);


    const data =
      vaultMemory[pointer];


    if (!data) {

      throw new Error(
        `mockStorage: vault not found: ${pointer}`
      );

    }


    /**
     * Return copy (immutability simulation)
     */

    return new Uint8Array(data);

  },


  /* =========================
     MANIFEST STORAGE
  ========================= */

  async getManifest(
    capsuleId: string
  ): Promise<ManifestV1> {

    if (
      typeof capsuleId !== "string" ||
      !CAPSULE_ID_REGEX.test(capsuleId)
    ) {

      throw new Error(
        "mockStorage: invalid capsuleId"
      );

    }


    const manifest =
      manifestMemory[capsuleId];


    if (!manifest) {

      throw new Error(
        `mockStorage: manifest not found: ${capsuleId}`
      );

    }


    /**
     * Return clone (immutability simulation)
     *
     * Mirrors Uint8Array copy discipline in upload/download.
     * Prevents caller mutation of the stored manifest reference.
     */

    return structuredClone(manifest);

  },


  async getChunkPointers(
    capsuleId: string
  ): Promise<
    Readonly<Record<
      ChunkId,
      StoragePointer
    >>
  > {

    if (
      typeof capsuleId !== "string" ||
      !CAPSULE_ID_REGEX.test(capsuleId)
    ) {

      throw new Error(
        "mockStorage: invalid capsuleId"
      );

    }


    const manifest =
      manifestMemory[capsuleId];


    if (!manifest) {

      throw new Error(
        `mockStorage: manifest not found: ${capsuleId}`
      );

    }


    const ext =
      (manifest as ManifestV1 & {
        ext?: unknown;
      }).ext;


    if (!isPlainObject(ext)) {

      throw new Error(
        "mockStorage: invalid manifest ext"
      );

    }


    const rawChunkPointers =
      (ext as Record<string, unknown>)["chunkPointers"];


    if (rawChunkPointers === undefined) {
      return Object.freeze({});
    }


    return assertChunkPointerMap(
      rawChunkPointers
    );

  },


  /* =========================
     DEV HELPER ONLY
  ========================= */

  // FIX ⚠️ ISSUE 4 — parity with devManifestStore.saveManifest():
  // validate plain-object shape and version in addition to capsuleId
  saveManifest(
    manifest: ManifestV1
  ): void {

    if (!isPlainObject(manifest)) {

      throw new Error(
        "[AETERNA] mockStorage: invalid manifest structure"
      );

    }

    if (manifest["version"] !== 1) {

      throw new Error(
        "[AETERNA] mockStorage: unsupported manifest version"
      );

    }

    if (
      typeof manifest["capsuleId"] !== "string" ||
      !CAPSULE_ID_REGEX.test(manifest["capsuleId"] as string)
    ) {

      throw new Error(
        "[AETERNA] mockStorage: invalid capsuleId"
      );

    }

    manifestMemory[
      manifest.capsuleId
    ] = structuredClone(manifest);

  },

};