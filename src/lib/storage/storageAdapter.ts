import type {
  ManifestV1
} from "@/types/manifest";

import type { ChunkMetadata } from "@/types/vault";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import type { ContainerPublicationRecord } from "@/lib/storage/container/containerPublication";

import {
  STORAGE_POINTER_REGEX,
  UPLOAD_TOKEN_REGEX
} from "@/lib/crypto/validators";

/**
 * Stage 4.5 — the result of ONE container media upload.
 *
 * `containerTxId` is the Irys data-item id of the single container DataItem;
 * `chunkIds` is the canonical ORDERED logical chunk identity list; and
 * `layoutDigest` is the sha256 of the canonical layout descriptor that binds
 * that order AND the ciphertext sizes. Together these are exactly what the
 * container publication claim records.
 *
 * Offsets are deliberately absent: they are derived at read time from the
 * Stage 2 layout, never persisted.
 */
export interface ContainerUploadOutcome {
  readonly containerTxId: string;
  readonly chunkIds: readonly string[];
  readonly layoutDigest: string;
}

/**
 * The Container V1 publication READOUT.
 *
 * The chunk-pointers endpoint answers with the capsule's ONE container
 * publication record.
 *
 * `container === null` means the capsule has no container publication yet.
 * A non-null container means the capsule's media authority IS that
 * publication.
 */
export interface ChunkPointerReadout {
  readonly container: ContainerPublicationRecord | null;
}


/**
 * =========================================================
 * AETERNA CAPABILITY BRAND SYMBOLS
 * =========================================================
 *
 * Strong nominal typing boundary:
 *
 * prevents accidental cross-capability casts
 * pointer ↔ token mixing
 * unsafe structural reuse
 *
 * zero runtime cost
 */

declare const storagePointerBrand: unique symbol;

declare const uploadTokenBrand: unique symbol;


/**
 * =========================================================
 * STORAGE POINTER CAPABILITY
 * =========================================================
 *
 * Обычно это Arweave / Irys txId
 * Формат: base64url
 * Длина: 43 символа
 *
 * Opaque read-location capability
 */

/**
 * Capability branding boundary
 *
 * MUST NEVER be constructed manually.
 * MUST be produced only via validators.
 *
 * Refinement boundary:
 *
 * unknown
 * → validated
 * → branded immutable primitive
 */

export type StoragePointer = string & {
  readonly [storagePointerBrand]: true;
};


/**
 * =========================================================
 * UPLOAD TOKEN CAPABILITY
 * =========================================================
 *
 * Выдаётся backend после verify.ts
 *
 * Opaque write-authority capability
 */

/**
 * Capability branding boundary
 *
 * MUST NEVER be constructed manually.
 * MUST be produced only via validators.
 *
 * Refinement boundary:
 *
 * unknown
 * → validated
 * → branded immutable primitive
 */

export type UploadToken = string & {
  readonly [uploadTokenBrand]: true;
};


/**
 * =========================================================
 * STORAGE POINTER VALIDATOR
 * =========================================================
 *
 * MUST be used:
 *
 * after adapter.upload()
 * before adapter.download()
 */

export function assertStoragePointer(
  value: unknown
): StoragePointer {

  if (
    typeof value !== "string" ||
    !STORAGE_POINTER_REGEX.test(value)
  ) {
    throw new Error(
      "[AETERNA] Invalid storage pointer"
    );
  }

  return value as StoragePointer;

}


/**
 * Type guard
 */

export function isStoragePointer(
  value: unknown
): value is StoragePointer {

  return (
    typeof value === "string" &&
    STORAGE_POINTER_REGEX.test(value)
  );

}


/**
 * =========================================================
 * UPLOAD TOKEN VALIDATOR
 * =========================================================
 *
 * MUST be used:
 *
 * after upload-token.ts response
 * BEFORE adapter.upload()
 */

export function assertUploadToken(
  value: unknown
): UploadToken {

  if (
    typeof value !== "string" ||
    !UPLOAD_TOKEN_REGEX.test(value)
  ) {
    throw new Error(
      "[AETERNA] Invalid upload token"
    );
  }

  return value as UploadToken;

}


/**
 * Type guard
 */

export function isUploadToken(
  value: unknown
): value is UploadToken {

  return (
    typeof value === "string" &&
    UPLOAD_TOKEN_REGEX.test(value)
  );

}


/**
 * =========================================================
 * STORAGE ADAPTER INTERFACE
 * =========================================================
 *
 * Canonical invariant:
 *
 * uploadToken REQUIRED
 * NO PAYMENT → NO UPLOAD
 */

export interface StorageAdapter {

  /**
   * Adapter identifier
   *
   * MUST remain stable during runtime.
   */

  readonly name: string;


  /* =========================
     VAULT / CHUNKS (ENCRYPTED)
     ========================= */


  /**
   * Upload encrypted payload
   *
   * MUST:
   *
   * upload raw encrypted bytes
   * preserve byte order
   * return canonical txId pointer
   *
   * Ownership invariant:
   *
   * caller MUST NOT mutate `data`
   * after upload() invocation.
   *
   * Adapters retaining async references
   * MUST clone bytes defensively.
   *
   * Adapters MUST:
   *
   * fail closed
   * reject partial uploads
   * reject corrupted payloads
   * avoid silent gateway downgrade
   */

  upload(
    data: Uint8Array,
    uploadToken: UploadToken
  ): Promise<{

    txId: StoragePointer

  }>;


  /**
   * Upload the whole encrypted media payload as ONE Container V1 DataItem.
   *
   * Canonical media upload capability. It is REQUIRED on every adapter
   * that participates in sealing: a per-chunk upload path no longer
   * exists, so an adapter that cannot upload containers fails closed.
   *
   * The adapter reads the encrypted chunks itself through `runtime`, so
   * no plaintext and no whole-container buffer crosses this boundary.
   */
  uploadContainer(
    runtime: RuntimeStorage,
    chunkMetadata: readonly ChunkMetadata[],
    uploadToken: UploadToken
  ): Promise<ContainerUploadOutcome>;


  /**
   * Download encrypted payload
   *
   * Adapters MUST:
   *
   * fail closed
   * reject corrupted payloads
   * preserve byte integrity
   * avoid silent gateway downgrade
   */

  download(
    pointer: StoragePointer
  ): Promise<Uint8Array<ArrayBuffer>>;


  /**
   * Bounded range read
   *
   * Reads exactly `length` bytes starting at `offset` of the object
   * identified by `pointer`.
   *
   * Adapters MUST:
   *
   * fail closed
   * reject corrupted payloads
   * preserve byte integrity
   * avoid silent gateway downgrade
   * return EXACTLY `length` bytes
   *
   * Adapters MUST NOT:
   *
   * satisfy a range read from a full-object download
   * (the whole point of the primitive is to avoid downloading
   * an object larger than the requested window)
   *
   * Optional: read-only adapters that cannot serve ranges may
   * omit it; callers MUST treat its absence as fail-closed.
   */

  downloadRange?(
    pointer: StoragePointer,
    offset: number,
    length: number
  ): Promise<Uint8Array<ArrayBuffer>>;


  /* =========================
     MANIFEST (PUBLIC)
     ========================= */


  /**
   * Optional manifest loader
   *
   * Some storage backends
   * do not store manifest
   */

  getManifest?(
    capsuleId: string
  ): Promise<ManifestV1>;


  /**
   * The Container V1 publication readout.
   *
   * Runtime-only Storage Authority lookup surface.
   * Not part of Manifest authority.
   */

  /**
   * Stage 4.5 — additive readout that ALSO surfaces the container
   * publication record when the capsule has one.
   *
   * Implementations MUST fail closed if both representations are populated:
   * a container capsule writes NO per-chunk registry entries, so a non-empty
   * pointer map alongside a container record is an inconsistent state.
   */
  getChunkPointerReadout?(
    capsuleId: string
  ): Promise<ChunkPointerReadout>;

}