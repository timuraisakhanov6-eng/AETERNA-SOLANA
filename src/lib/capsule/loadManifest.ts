import type {
  ManifestV1,
} from "@/types/manifest";

import { deepFreeze } from "@/lib/utils/deepFreeze";

import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
} from "@/lib/crypto/validators";

import {
  assertStoragePointer
} from "@/lib/storage/storageAdapter";

import {
  MAX_ENCRYPTED_VAULT_SIZE
} from "@/lib/crypto/constants";


/**
 * Legacy compatibility validation for already-sealed manifests.
 *
 * Canonical Manifest authority does not include chunk pointers.
 * If a legacy manifest still carries `ext.chunkPointers`, validate
 * it only as raw compatibility input, then strip it before the
 * canonical ManifestV1 object is returned.
 */
function validateLegacyChunkPointers(
  value: unknown
): void {

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw SEALED_ERROR;
  }

  for (const pointer of Object.values(value)) {

    try {
      assertStoragePointer(pointer);
    } catch {
      throw SEALED_ERROR;
    }

  }

}


const SEALED_ERROR =
  new Error("[AETERNA] Capsule is sealed");


const MIN_TIMESTAMP =
  1577836800000;

const MAX_TIMESTAMP =
  4102444800000;


const ALLOWED_EXT_FIELDS =
  Object.freeze(
    new Set([
      "vaultSha256",
      "chunkPointers"
    ])
  );


export async function loadManifest(
  capsuleId: string
): Promise<ManifestV1> {

  if (
    typeof crypto === "undefined" ||
    !crypto.subtle
  ) {
    throw SEALED_ERROR;
  }


  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    throw SEALED_ERROR;
  }


  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      8000
    );


  let res: Response;

  try {

    res = await fetch(
      `/api/capsule/${capsuleId}`,
      {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      }
    );

  } catch {

    throw SEALED_ERROR;

  } finally {

    // FIX (LOW): clearTimeout moved to finally so timeout lifecycle
    // is always closed — both on success and on network/abort error.
    // Previously clearTimeout was called once in the catch and once
    // after the try-catch, leaving a window where a hung body-stream
    // phase (res.text()) could hold an orphaned timer reference.
    clearTimeout(timeout);

  }


  if (!res.ok) {
    throw SEALED_ERROR;
  }


  const contentType =
    res.headers.get("content-type") ?? "";


  if (
    !contentType.includes(
      "application/json"
    )
  ) {
    throw SEALED_ERROR;
  }


  const text =
    await res.text();


  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > 20_000 ||
    /"__proto__"\s*:/.test(text) ||
    /"constructor"\s*:/.test(text) ||
    /"prototype"\s*:/.test(text)
  ) {
    throw SEALED_ERROR;
  }


  let manifest: ManifestV1 & {
    ext: ManifestV1["ext"] & {
      chunkPointers?: unknown;
    };
  };

  try {

    manifest =
      JSON.parse(text) as ManifestV1 & {
        ext: ManifestV1["ext"] & {
          chunkPointers?: unknown;
        };
      };

  } catch {

    throw SEALED_ERROR;

  }


  if (

    !manifest ||

    Array.isArray(manifest) ||

    Object.getPrototypeOf(manifest)
      !== Object.prototype ||

    manifest.version !== 1 ||

    typeof manifest.capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(manifest.capsuleId) ||
    manifest.capsuleId !== capsuleId

  ) {

    throw SEALED_ERROR;

  }


  if (

    typeof manifest.openAt !== "number" ||

    !Number.isInteger(manifest.openAt) ||

    typeof manifest.sealedAt !== "number" ||

    !Number.isInteger(manifest.sealedAt)

  ) {

    throw SEALED_ERROR;

  }


  if (

    manifest.sealedAt < MIN_TIMESTAMP ||

    manifest.sealedAt > MAX_TIMESTAMP ||

    manifest.openAt <= manifest.sealedAt ||

    manifest.openAt < MIN_TIMESTAMP ||

    manifest.openAt > MAX_TIMESTAMP

  ) {

    throw SEALED_ERROR;

  }


  if (

    typeof manifest.saltBase !== "string" ||

    !SALT_BASE_REGEX.test(manifest.saltBase)

  ) {

    throw SEALED_ERROR;

  }


  try {

    assertStoragePointer(manifest.vaultTxId);

  } catch {

    throw SEALED_ERROR;

  }


  if (

    typeof manifest.encryptedSizeBytes !== "number" ||

    !Number.isInteger(manifest.encryptedSizeBytes) ||

    /**
     * Lower bound is > 0, not ≥ 1024.
     *
     * All runtime layers (seal, open, emergency) use > 0 semantics.
     * A 1024-byte floor here would mean a manifest that passes every
     * other layer gets rejected at the authority boundary — creating
     * a capsule that seals successfully but can never be loaded.
     * The SHA-256 integrity check and size-continuity check are the
     * authoritative integrity anchors, not a minimum size floor.
     */

    manifest.encryptedSizeBytes <= 0 ||

    manifest.encryptedSizeBytes > MAX_ENCRYPTED_VAULT_SIZE

  ) {

    throw SEALED_ERROR;

  }


  if (

    manifest.description !== undefined &&

    (

      typeof manifest.description !== "string" ||

      manifest.description.length > 500

    )

  ) {

    throw SEALED_ERROR;

  }


  if (

    typeof manifest.ext !== "object" ||

    manifest.ext === null ||

    Array.isArray(manifest.ext) ||

    Object.getPrototypeOf(manifest.ext) !== Object.prototype

  ) {

    throw SEALED_ERROR;

  }


  const keys = Object.keys(manifest.ext);

  for (const key of keys) {

    if (
      !ALLOWED_EXT_FIELDS.has(key)
    ) {
      throw SEALED_ERROR;
    }

  }


  if (

    typeof manifest.ext.vaultSha256 !== "string" ||

    !SHA256_REGEX.test(manifest.ext.vaultSha256)

  ) {

    throw SEALED_ERROR;

  }


  if (manifest.ext.chunkPointers !== undefined) {

    validateLegacyChunkPointers(
      manifest.ext.chunkPointers
    );

    delete manifest.ext.chunkPointers;

  }


  return deepFreeze(
    manifest as ManifestV1
  );

}