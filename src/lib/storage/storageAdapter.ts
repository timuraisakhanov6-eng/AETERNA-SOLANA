import type {
  ChunkId,
  ManifestV1
} from "@/types/manifest";

import {
  STORAGE_POINTER_REGEX,
  UPLOAD_TOKEN_REGEX
} from "@/lib/crypto/validators";


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


export function assertChunkPointerMap(
  value: unknown
): Readonly<Record<ChunkId, StoragePointer>> {

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(
      "[AETERNA] Invalid chunk pointer map"
    );
  }

  const normalized: Record<ChunkId, StoragePointer> = {};

  for (const [chunkId, pointer] of Object.entries(value)) {
    normalized[chunkId as ChunkId] =
      assertStoragePointer(pointer);
  }

  return Object.freeze(normalized);

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
   * Upload encrypted chunk payload
   *
   * Mandatory capability boundary:
   *
   * chunkId REQUIRED
   * NO chunkId → NO UPLOAD
   *
   * MUST:
   *
   * upload raw encrypted bytes
   * bind chunkId to the uploaded pointer
   * return canonical txId pointer
   *
   * Ownership invariant:
   *
   * caller MUST NOT mutate `data`
   * after uploadChunk() invocation.
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

  uploadChunk(
    data: Uint8Array,
    chunkId: ChunkId,
    uploadToken: UploadToken
  ): Promise<{

    txId: string

  }>;


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
  ): Promise<Uint8Array>;


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
   * Runtime Chunk Pointer Registry access
   *
   * Runtime-only Storage Authority lookup surface.
   * Not part of Manifest authority.
   */

  getChunkPointers?(
    capsuleId: string
  ): Promise<
    Readonly<Record<
      ChunkId,
      StoragePointer
    >>
  >;

}