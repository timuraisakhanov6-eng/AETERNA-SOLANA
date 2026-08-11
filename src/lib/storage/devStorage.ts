/**
 * =========================================================
 * AETERNA — DEV Storage Adapter (Local Recipient Path Support)
 * =========================================================
 *
 * DEV-only adapter wiring
 *
 * Purpose:
 * decorate mockStorage with manifest persistence so that
 * /capsule/:id can be opened locally during development.
 *
 * ❗ DEV ONLY
 * ❗ NEVER used in production runtime
 * ❗ NEVER used in emergency.html path
 * ❗ NO impact on custody / crypto / sealing core
 *
 * Layer:
 * Recipient Path (development only)
 */

import type {
  StorageAdapter
} from "./storageAdapter";

import {
  assertStoragePointer
} from "./storageAdapter";

import { mockStorage } from "./mockStorage";

import type {
  ManifestV1
} from "@/types/manifest";

import {
  saveManifest as persistManifest
} from "./mockManifestStore";

import {
  CAPSULE_ID_REGEX,
  SHA256_REGEX,
  SALT_BASE_REGEX
} from "@/lib/crypto/validators";


/**
 * HARD DEV-ONLY GUARD
 *
 * Prevents accidental production inclusion.
 */

if (import.meta.env.PROD) {

  throw new Error(
    "[AETERNA] devStorage used in production environment"
  );

}


/* ================= HELPERS ================= */

/**
 * Canonical plain-object validator.
 *
 * Rejects:
 * - null
 * - arrays
 * - exotic prototypes
 * - Object.create(null)
 */

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {

  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) ===
      Object.prototype
  );

}


/**
 * Strict manifest validator
 *
 * Spec authority:
 * §23.8 Manifest Parse Hardening
 *
 * Validates:
 * - structural integrity
 * - prototype safety
 * - temporal invariants
 * - pointer validity boundary
 * - vault integrity hash format
 */

function assertStrictManifestShape(
  manifest: ManifestV1
): void {

  if (

    !isPlainObject(manifest) ||

    manifest.version !== 1 ||

    typeof manifest.capsuleId !== "string" ||

    !CAPSULE_ID_REGEX.test(
      manifest.capsuleId
    ) ||

    typeof manifest.openAt !== "number" ||

    !Number.isFinite(
      manifest.openAt
    ) ||

    typeof manifest.sealedAt !== "number" ||

    !Number.isFinite(
      manifest.sealedAt
    ) ||

    /**
     * Temporal invariant:
     * capsule must open strictly after sealing
     */

    manifest.openAt <=
      manifest.sealedAt ||

    typeof manifest.saltBase !== "string" ||

    !SALT_BASE_REGEX.test(
      manifest.saltBase
    ) ||

    typeof manifest.encryptedSizeBytes !==
      "number" ||

    !Number.isFinite(
      manifest.encryptedSizeBytes
    ) ||

    !Number.isInteger(
      manifest.encryptedSizeBytes
    ) ||

    manifest.encryptedSizeBytes <= 0 ||

    !isPlainObject(manifest.ext) ||

    typeof manifest.ext.vaultSha256 !==
      "string" ||

    !SHA256_REGEX.test(
      manifest.ext.vaultSha256
    )

  ) {

    throw new Error(
      "[DEV Storage] Invalid manifest shape"
    );

  }


  /**
   * Storage pointer validation boundary
   *
   * Runtime validation delegated to:
   * assertStoragePointer()
   */

  assertStoragePointer(
    manifest.vaultTxId
  );

}


/**
 * DEV STORAGE WIRING (CANONICAL)
 *
 * Decorates mockStorage with manifest persistence
 * required for local recipient-path simulation.
 */

export const devStorage:
StorageAdapter & {

  saveManifest: (
    manifest: ManifestV1
  ) => void;

} = Object.freeze({

  ...mockStorage,


  /**
   * Persist public manifest locally
   *
   * Enables:
   * /capsule/:capsuleId route in DEV
   *
   * Guarantees:
   * - public data only
   * - strict validation
   * - no crypto-layer interaction
   * - no custody-layer interaction
   */

  saveManifest(
    manifest: ManifestV1
  ) {

    assertStrictManifestShape(
      manifest
    );

    persistManifest(
      manifest
    );

  }

});