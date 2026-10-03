import type {
  ManifestV1
} from "@/types/manifest";

import { MANIFEST_VERSION } from "@/types/manifest";

import type {
  ChunkPointerReadout,
  StoragePointer
} from "./storageAdapter";

import {
  assertStoragePointer
} from "./storageAdapter";

import {
  assertRangeWindow,
  executorStorage
} from "./executorStorage";

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


const storageAdapter =
  Object.freeze(executorStorage);


/**
 * Canonical chunk-safe limits
 *
 * Spec:
 * capsule ≤ 20GB
 * chunk ≤ 256MB (Safari-safe)
 */

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


export async function download(

  txId: StoragePointer

): Promise<Uint8Array<ArrayBuffer>> {

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
   BOUNDED RANGE READ
   ========================= */


/**
 * Bounded range read.
 *
 * Reads exactly `length` bytes starting at `offset`.
 *
 * Cap re-scope (Stage 1):
 *
 * The whole-object cap exists to bound how much a single read may
 * pull into memory. For a range read the bound is the REQUESTED
 * WINDOW, never the object size — a 20 GB object must remain
 * readable in a small window and must NOT be rejected merely
 * because the object exceeds the whole-object cap.
 *
 * `download()` keeps its existing whole-object cap and semantics
 * unchanged; only the range path is re-scoped here.
 */

export async function downloadRange(

  txId: StoragePointer,

  offset: number,

  length: number

): Promise<Uint8Array<ArrayBuffer>> {

  assertStoragePointer(txId);


  const window =
    assertRangeWindow(offset, length);


  if (
    window.length >
      MAX_CHUNK_DOWNLOAD_SIZE
  ) {

    sealedError();

  }


  if (

    !storageAdapter ||

    typeof storageAdapter.downloadRange !==
      "function"

  ) {

    sealedError();

  }


  try {

    const data =
      await storageAdapter.downloadRange(
        txId,
        window.offset,
        window.length
      );


    /**
     * Exact-length contract.
     *
     * A short body means the gateway truncated the window; a long
     * body means it ignored the Range header. Neither is a partial
     * success, and neither is repaired by falling back to a
     * whole-object download.
     */

    if (

      !(data instanceof Uint8Array) ||

      isDetachedBuffer(data) ||

      data.byteLength !== window.length

    ) {

      sealedError();

    }


    if (import.meta.env.DEV) {

      console.log(
        `[storage:${storageAdapter.name}] range read complete`
      );

    }


    return data;

  }

  catch (cause) {

    if (import.meta.env.DEV) {
      console.error("[storage] downloadRange failed", cause);
    }

    sealedError();

  }

}


/* =========================
   CONTAINER PUBLICATION READOUT
   ========================= */

/**
 * The canonical Container V1 publication readout.
 *
 * This is the ONLY client-side entry point that surfaces the container
 * publication, so the open path never has to know the endpoint's shape.
 * `container: null` means the capsule has no container publication yet.
 */
export async function getChunkPointerReadout(

  capsuleId: string

): Promise<ChunkPointerReadout> {

  if (!isValidCapsuleId(capsuleId)) {

    sealedError();

  }


  if (

    !storageAdapter ||

    typeof storageAdapter.getChunkPointerReadout !==
      "function"

  ) {

    sealedError();

  }


  try {

    const readout =
      await storageAdapter.getChunkPointerReadout(
        capsuleId
      );


    return Object.freeze({

      container:
        readout.container,

    });

  }

  catch (cause) {

    if (import.meta.env.DEV) {
      console.error("[storage] getChunkPointerReadout failed", cause);
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

    download,

    downloadRange,

    getManifest,

    getChunkPointerReadout,

    get name() {

      return getCurrentAdapterName();

    }

  });