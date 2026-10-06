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
  ContainerUploadOutcome,
  ChunkPointerReadout,
} from "./storageAdapter";

import {
  assertUploadToken,
  assertStoragePointer
} from "./storageAdapter";

import { uploadPreparedContainer } from "./uploadPreparedContainer";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import type { ChunkMetadata } from "@/types/vault";

import type { ChunkingUploader } from "@irys/upload-core";

import type { Readable } from "stream";

import type {
  ManifestV1
} from "@/types/manifest";


/**
 * DEV-only fake Irys chunking uploader.
 *
 * Consumes the canonical container stream and returns a synthetic
 * DataItem id. It exists so the mock can drive the REAL
 * `uploadPreparedContainer` writer with no network access and no
 * second container implementation.
 */
const mockChunkingUploader = {
  setChunkSize(_size: number): void {
    // No SDK tuning in the mock.
  },
  setBatchSize(_size: number): void {
    // No SDK tuning in the mock.
  },
  async uploadData(
    readable: Readable
  ): Promise<{ status: number; data: { id: string } }> {
    await new Promise<void>((resolve, reject) => {
      readable.on("data", () => {
        // Drain — the mock does not retain container bytes.
      });
      readable.on("end", () => resolve());
      readable.on("error", reject);
    });
    return { status: 200, data: { id: generateMockPointer() } };
  },
} as unknown as ChunkingUploader;

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


  async uploadContainer(
    runtime: RuntimeStorage,
    chunkMetadata: readonly ChunkMetadata[],
    uploadToken: UploadToken
  ): Promise<ContainerUploadOutcome> {

    /**
     * REQUIRED PROTOCOL INVARIANT
     *
     * NO TOKEN → NO STORAGE WRITE
     */

    assertUploadToken(uploadToken);


    /**
     * DEV-only: the mock reuses the CANONICAL Container V1 writer
     * (`uploadPreparedContainer`) so the mock exercises exactly the
     * same layout, chunk order and layoutDigest semantics as
     * production. ONLY the Irys transport is faked.
     *
     * Upload-only: the claim is a separate step
     * (`claimContainerUpload`) so the mock mirrors the production
     * upload/claim split.
     */

    return uploadPreparedContainer(
      runtime,
      chunkMetadata,
      mockChunkingUploader
    );

  },


  /**
   * No publication state exists in the mock backend, so the claim is a
   * no-op. Present so the mock satisfies the same upload/claim split the
   * production adapter exposes.
   */
  async claimContainerUpload(
    _outcome: ContainerUploadOutcome,
    uploadToken: UploadToken
  ): Promise<void> {
    assertUploadToken(uploadToken);
  },


  async download(
    pointer: StoragePointer
  ): Promise<Uint8Array<ArrayBuffer>> {

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


  /**
   * DEV-only: the mock backend keeps no container publication state, so the
   * readout is always `container: null`.
   */
  async getChunkPointerReadout(
    capsuleId: string
  ): Promise<ChunkPointerReadout> {

    if (
      typeof capsuleId !== "string" ||
      !CAPSULE_ID_REGEX.test(capsuleId)
    ) {

      throw new Error(
        "mockStorage: invalid capsuleId"
      );

    }


    return Object.freeze({

      container: null,

    });

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