import type { ManifestV1 } from "@/types/manifest";

import {
  CAPSULE_ID_REGEX,
  SHA256_REGEX
} from "@/lib/crypto/validators";

import {
  MAX_ENCRYPTED_VAULT_SIZE
} from "@/lib/crypto/constants";


function sealed(): never {

  throw new Error(
    "[AETERNA] Capsule sealed"
  );

}


/**
 * Detect detached ArrayBuffer
 */

function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return arr.buffer.byteLength === 0;

}


/**
 * Verify encrypted vault payload size
 *
 * Enforces strict equality:
 *
 * data.byteLength === manifest.encryptedSizeBytes
 */

export function verifyVaultSize(
  data: Uint8Array,
  manifest: ManifestV1
): void {

  /* ─────────────────────────────
     DATA VALIDATION
  ───────────────────────────── */

  /**
   * IMPORTANT:
   *
   * MAX_ENCRYPTED_VAULT_SIZE applies ONLY to the
   * encrypted vault JSON envelope.
   *
   * Binary media payloads are stored separately
   * as encrypted chunks and are NOT included
   * in this limit.
   *
   * Total capsule storage may exceed this value.
   */

  if (
    !(data instanceof Uint8Array) ||
    isDetachedBuffer(data) ||
    data.byteLength === 0 ||
    data.byteLength > MAX_ENCRYPTED_VAULT_SIZE
  ) {
    sealed();
  }


  /* ─────────────────────────────
     MANIFEST STRUCTURE VALIDATION
  ───────────────────────────── */

  if (
    !manifest ||
    typeof manifest !== "object" ||
    Object.getPrototypeOf(manifest) !== Object.prototype
  ) {
    sealed();
  }


  if (manifest.version !== 1) {
    sealed();
  }


  const expected =
    manifest.encryptedSizeBytes;


  if (
    typeof expected !== "number" ||
    !Number.isInteger(expected) ||
    expected <= 0 ||
    expected > MAX_ENCRYPTED_VAULT_SIZE
  ) {
    sealed();
  }


  /* ─────────────────────────────
     capsuleId integrity check
  ───────────────────────────── */

  if (
    typeof manifest.capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(
      manifest.capsuleId
    )
  ) {
    sealed();
  }


  /* ─────────────────────────────
     ext.vaultSha256 invariant check
  ───────────────────────────── */

  if (
    !manifest.ext ||
    typeof manifest.ext !== "object" ||
    Array.isArray(manifest.ext) ||
    Object.getPrototypeOf(manifest.ext)
      !== Object.prototype ||
    typeof manifest.ext.vaultSha256 !== "string" ||
    !SHA256_REGEX.test(manifest.ext.vaultSha256)
  ) {
    sealed();
  }


  /* ─────────────────────────────
     STRICT SIZE MATCH CHECK
  ───────────────────────────── */

  if (
    data.byteLength !== expected
  ) {
    sealed();
  }

}