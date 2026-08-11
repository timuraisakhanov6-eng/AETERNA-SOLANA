/**
 * DEV-ONLY MANIFEST STORE (PERSISTENT)
 *
 * creator === recipient
 * Works:
 * - after payment
 * - after refresh
 * - in a new tab
 * - via direct link
 *
 * ⚠️ DEV ONLY — never reaches production.
 * In production Vite alias replaces this file with
 * implementation using GET /api/capsule/:capsuleId.
 *
 * Spec §23: dev modules must throw in production.
 * Spec §27: manifest localStorage forbidden in production.
 */

import type {
  ManifestV1
} from "@/types/manifest";

import {
  CAPSULE_ID_REGEX
} from "@/lib/crypto/validators";


/**
 * HARD PRODUCTION GUARD
 */

if (import.meta.env.PROD) {

  throw new Error(

    "[AETERNA] DEV manifest store used in production environment. " +
    "Vite alias misconfigured."

  );

}


const STORAGE_KEY =
  "aeterna:dev:manifests";


/* ================= HELPERS ================= */

/**
 * Canonical plain-object check.
 * Rejects null, arrays, Object.create(null),
 * and exotic prototypes.
 *
 * FIX ⚠️ ISSUE 1 — replaces bare typeof === "object" checks
 * throughout this file for consistent prototype hardening.
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


/* ================= STORAGE I/O ================= */

/**
 * Safe loader with prototype guard.
 *
 * FIX ⚠️ ISSUE 1 — container validated with isPlainObject()
 * FIX ⚠️ ISSUE 2 — each entry validated before being returned:
 *   plain object, version === 1, capsuleId matches regex.
 *   Corrupted or schema-drifted entries are silently dropped.
 */

function loadAll():
Record<string, ManifestV1> {

  try {

    const raw =
      localStorage.getItem(
        STORAGE_KEY
      );

    if (!raw) {
      return {};
    }

    const parsed =
      JSON.parse(raw);

    if (!isPlainObject(parsed)) {
      return {};
    }

    const clean: Record<string, ManifestV1> = {};

    for (const [key, value] of Object.entries(parsed)) {

      if (
        typeof key === "string" &&
        CAPSULE_ID_REGEX.test(key) &&
        isPlainObject(value) &&
        value["version"] === 1 &&
        typeof value["capsuleId"] === "string" &&
        CAPSULE_ID_REGEX.test(value["capsuleId"] as string)
      ) {

        clean[key] = value as unknown as ManifestV1;

      }

    }

    return clean;

  }

  catch {

    return {};

  }

}


/**
 * Safe saver
 */

function saveAll(
  data: Record<string, ManifestV1>
): void {

  try {

    localStorage.setItem(

      STORAGE_KEY,

      JSON.stringify(data)

    );

  }

  catch {

    /**
     * DEV-only:
     * ignore quota errors
     */

  }

}


/* ================= PUBLIC API ================= */

/**
 * Save manifest with canonical boundary validation
 */

export function saveManifest(
  manifest: ManifestV1
): void {

  // FIX ⚠️ ISSUE 1 — isPlainObject() replaces manual
  // typeof + Array.isArray + getPrototypeOf inline checks
  if (!isPlainObject(manifest)) {

    throw new Error(
      "[AETERNA] Invalid manifest structure"
    );

  }


  if (
    manifest.version !== 1
  ) {

    throw new Error(
      "[AETERNA] Unsupported manifest version"
    );

  }


  if (

    typeof manifest.capsuleId !==
      "string" ||

    !CAPSULE_ID_REGEX.test(
      manifest.capsuleId
    )

  ) {

    throw new Error(
      "[AETERNA] Invalid capsuleId"
    );

  }


  const all =
    loadAll();


  /**
   * Preserve immutable storage semantics
   */

  all[
    manifest.capsuleId
  ] = structuredClone(manifest);


  saveAll(all);

}


/**
 * Load manifest by capsuleId
 */

export function loadManifest(
  capsuleId: string
): ManifestV1 | null {

  if (

    typeof capsuleId !== "string" ||

    !CAPSULE_ID_REGEX.test(
      capsuleId
    )

  ) {

    return null;

  }


  const all =
    loadAll();

  const manifest =
    all[capsuleId];


  /**
   * Prevent mutable reference leakage
   */

  return manifest
    ? structuredClone(manifest)
    : null;

}