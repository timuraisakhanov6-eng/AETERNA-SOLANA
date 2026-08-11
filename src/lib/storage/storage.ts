import type {
  ChunkId,
  ManifestV1
} from "@/types/manifest";

import { MANIFEST_VERSION } from "@/types/manifest";

import type {
  StoragePointer,
  UploadToken,
  StorageAdapter
} from "./storageAdapter";

import {
  assertChunkPointerMap,
  assertStoragePointer,
  assertUploadToken
} from "./storageAdapter";

import { executorStorage } from "./executorStorage";

import {
  CAPSULE_ID_REGEX,
  SHA256_REGEX
} from "@/lib/crypto/validators";


/**
 * AETERNA STORAGE LAYER
 *
 * Canonical behavior:
 *
 * • deterministic adapter
 * • fail-closed
 * • immutable vault storage
 * • canonical pointer validation
 */


const storageAdapter: StorageAdapter =
  Object.freeze(executorStorage);


/**
 * Canonical chunk-safe limits
 *
 * Spec:
 * capsule ≤ 20GB
 * chunk ≤ 256MB (Safari-safe)
 */

const MAX_CHUNK_UPLOAD_SIZE =
  256 * 1024 * 1024;

const MAX_CHUNK_DOWNLOAD_SIZE =
  256 * 1024 * 1024;


function sealedError(): never {

  throw new Error(
    "[AETERNA] Storage failure"
  );

}


function isValidCapsuleId(
  value: unknown
): boolean {

  return (

    typeof value === "string" &&

    CAPSULE_ID_REGEX.test(value)

  );

}


// Accepts null-prototype objects;
// rejects anything with exotic proto.
function isPlainObject(
  obj: unknown
): boolean {

  if (!obj || typeof obj !== "object") {
    return false;
  }

  const proto = Object.getPrototypeOf(obj);

  return (
    proto === Object.prototype ||
    proto === null
  );

}


// FIX 1 — Harden detached-buffer detection.
// Dual check covers edge runtimes (Safari,
// Workers, structured-clone variants) where
// arr.byteLength may collapse independently
// of arr.buffer.byteLength.
function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return (
  arr.byteLength === 0 ||
  arr.buffer.byteLength === 0
);

}


/**
 * Strict manifest validator
 *
 * Spec §23.8 manifest parse hardening
 */

function assertStrictManifestShape(
  manifest: ManifestV1,
  capsuleId: string
): void {

  if (

    !manifest ||

    typeof manifest !== "object" ||

    Array.isArray(manifest) ||

    // FIX 7 — compare against the canonical MANIFEST_VERSION constant
    // instead of the literal `1`, so this check and the manifest
    // producer (sealCapsuleCore.ts) can never silently drift apart.
    manifest.version !== MANIFEST_VERSION ||

    manifest.capsuleId !== capsuleId ||

    typeof manifest.vaultTxId !== "string" ||

    typeof manifest.openAt !== "number" ||
    !Number.isFinite(manifest.openAt) ||

    typeof manifest.sealedAt !== "number" ||
    !Number.isFinite(manifest.sealedAt) ||

    /**
     * Temporal invariant:
     * capsule must open strictly after sealing
     */

    manifest.openAt <= manifest.sealedAt ||

    typeof manifest.encryptedSizeBytes !== "number" ||
    !Number.isFinite(
      manifest.encryptedSizeBytes
    ) ||
    // FIX 3 — Enforce integer encryptedSizeBytes.
    // Byte counts must be whole numbers; fractional
    // values indicate schema drift or parser error.
    !Number.isInteger(
      manifest.encryptedSizeBytes
    ) ||
    manifest.encryptedSizeBytes <= 0 ||

    typeof manifest.saltBase !== "string" ||

    !isPlainObject(manifest.ext) ||

    typeof manifest.ext.vaultSha256 !== "string" ||

    !SHA256_REGEX.test(
      manifest.ext.vaultSha256
    )

  ) {

    sealedError();

  }

}


/* =========================
   VAULT / CHUNK UPLOAD
   ========================= */


export async function upload(

  data: Uint8Array,

  uploadToken: UploadToken

): Promise<{

  txId: StoragePointer

}> {

  if (!(data instanceof Uint8Array)) {

    sealedError();

  }


  if (isDetachedBuffer(data)) {

    sealedError();

  }


  if (

    data.byteLength <= 0 ||

    // NOTE: Number.isFinite(data.byteLength) is
    // technically redundant (byteLength is always
    // an integer per the JS runtime), but retained
    // here as an explicit audit-visible assertion.
    !Number.isFinite(data.byteLength) ||

    data.byteLength >
      MAX_CHUNK_UPLOAD_SIZE

  ) {

    sealedError();

  }


  /**
   * Canonical upload-token validator
   *
   * Spec:
   * uploadToken MUST be verified
   * before adapter.upload()
   */

  assertUploadToken(uploadToken);


  if (

    !storageAdapter ||

    typeof storageAdapter.upload !==
      "function"

  ) {

    sealedError();

  }


  try {

    const result =
      await storageAdapter.upload(
        data,
        uploadToken
      );


    if (

      !result ||

      !isPlainObject(result) ||

      typeof result.txId !==
        "string"

    ) {

      sealedError();

    }


    const pointer =
      assertStoragePointer(
        result.txId
      );


    // FIX 4 — Storage pointers are authority-relevant
    // runtime identifiers and must not appear in logs,
    // even in DEV (browser log / extension exposure).
    if (import.meta.env.DEV) {

      console.log(
        `[storage:${storageAdapter.name}] upload complete`
      );

    }


    return {

      txId: pointer

    };

  }

  catch (cause) {

    // FIX 6 — Preserve causal context in DEV without
    // leaking it to callers. Fail-closed behavior is
    // unchanged; sealedError() still throws opaquely.
    if (import.meta.env.DEV) {
      console.error("[storage] upload failed", cause);
    }

    sealedError();

  }

}


/* =========================
   CHUNK UPLOAD (STORAGE AUTHORITY)
   ========================= */


/**
 * Chunk upload with mandatory chunkId binding.
 *
 * Capability boundary:
 *
 * chunkId REQUIRED
 * NO chunkId → NO UPLOAD
 *
 * Canonical rule:
 *
 * Chunk Pointer Registry belongs to the Storage Authority
 * and is independent of the Manifest Authority.
 * manifest.ext.chunkPointers is NOT the canonical source.
 */

export async function uploadChunk(

  data: Uint8Array,

  chunkId: ChunkId,

  uploadToken: UploadToken

): Promise<{

  txId: StoragePointer

}> {

  if (!(data instanceof Uint8Array)) {

    sealedError();

  }


  if (isDetachedBuffer(data)) {

    sealedError();

  }


  if (

    data.byteLength <= 0 ||

    !Number.isFinite(data.byteLength) ||

    data.byteLength >
      MAX_CHUNK_UPLOAD_SIZE

  ) {

    sealedError();

  }


  /**
   * Mandatory chunkId boundary.
   *
   * chunkId MUST be provided by the caller.
   * It is never generated here and never
   * extracted from ciphertext.
   */

  if (

    typeof chunkId !== "string" ||

    chunkId.length === 0

  ) {

    sealedError();

  }


  assertUploadToken(uploadToken);


  if (

    !storageAdapter ||

    typeof storageAdapter.uploadChunk !==
      "function"

  ) {

    sealedError();

  }


  try {

    const result =
      await storageAdapter.uploadChunk(
        data,
        chunkId,
        uploadToken
      );


    if (

      !result ||

      !isPlainObject(result) ||

      typeof result.txId !==
        "string"

    ) {

      sealedError();

    }


    const pointer =
      assertStoragePointer(
        result.txId
      );


    if (import.meta.env.DEV) {

      console.log(
        `[storage:${storageAdapter.name}] uploadChunk complete`
      );

    }


    return {

      txId: pointer

    };

  }
  catch (cause) {

    if (import.meta.env.DEV) {
      console.error("[storage] uploadChunk failed", cause);
    }

    sealedError();

  }

}


/* =========================
   VAULT / CHUNK DOWNLOAD
   ========================= */


export async function download(

  txId: StoragePointer

): Promise<Uint8Array> {

  assertStoragePointer(txId);


  if (

    !storageAdapter ||

    typeof storageAdapter.download !==
      "function"

  ) {

    sealedError();

  }


  try {

    const data =
      await storageAdapter.download(
        txId
      );


    if (

      !(data instanceof Uint8Array) ||

      isDetachedBuffer(data) ||

      data.byteLength <= 0 ||

      !Number.isFinite(
        data.byteLength
      ) ||

      data.byteLength >
        MAX_CHUNK_DOWNLOAD_SIZE

    ) {

      sealedError();

    }


    // FIX — byteLength is capsule-metadata-adjacent and adds no
    // debugging value that "download complete" doesn't already
    // provide; drop it from the DEV log for consistency with the
    // upload()/getManifest() logs, which log presence, not payload
    // shape.
    if (import.meta.env.DEV) {

      console.log(
        `[storage:${storageAdapter.name}] download complete`
      );

    }


    return data;

  }

  catch (cause) {

    if (import.meta.env.DEV) {
      console.error("[storage] download failed", cause);
    }

    sealedError();

  }

}


/* =========================
   RUNTIME CHUNK POINTER REGISTRY
   ========================= */


export async function getChunkPointers(

  capsuleId: string

): Promise<
  Readonly<Record<
    ChunkId,
    StoragePointer
  >>
> {

  if (!isValidCapsuleId(capsuleId)) {

    sealedError();

  }


  if (

    !storageAdapter ||

    typeof storageAdapter.getChunkPointers !==
      "function"

  ) {

    sealedError();

  }


  try {

    const chunkPointers =
      await storageAdapter.getChunkPointers(
        capsuleId
      );


    return assertChunkPointerMap(
      chunkPointers
    );

  }

  catch (cause) {

    if (import.meta.env.DEV) {
      console.error("[storage] getChunkPointers failed", cause);
    }

    sealedError();

  }

}


/* =========================
   MANIFEST LOAD
   ========================= */


export async function getManifest(

  capsuleId: string

): Promise<ManifestV1> {

  if (!isValidCapsuleId(capsuleId)) {

    sealedError();

  }


  if (

    !storageAdapter ||

    typeof storageAdapter.getManifest !==
      "function"

  ) {

    sealedError();

  }


  try {

    const manifest =
      await storageAdapter.getManifest(
        capsuleId
      );


    if (

      !manifest ||

      !isPlainObject(manifest)

    ) {

      sealedError();

    }


    assertStrictManifestShape(
      manifest,
      capsuleId
    );


    assertStoragePointer(
      manifest.vaultTxId
    );


    // FIX 4 — capsuleId is an authority-relevant
    // identifier; omit it from DEV logs.
    if (import.meta.env.DEV) {

      console.log(
        `[storage:${storageAdapter.name}] manifest loaded`
      );

    }


    return manifest;

  }

  catch (cause) {

    if (import.meta.env.DEV) {
      console.error("[storage] getManifest failed", cause);
    }

    sealedError();

  }

}


/* =========================
   DEBUG
   ========================= */


export function getCurrentAdapterName(): string {

  return storageAdapter.name ||
    "unknown";

}


/* =========================
   NAMED OBJECT EXPORT
   ========================= */


export const storage =
  Object.freeze({

    upload,

    uploadChunk,

    download,

    getManifest,

    getChunkPointers,

    get name() {

      return getCurrentAdapterName();

    }

  });