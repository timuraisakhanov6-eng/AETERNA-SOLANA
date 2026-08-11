import type { ManifestV1 } from "@/types/manifest";

import {
  loadManifest as loadDevManifest,
} from "@/lib/storage/mockManifestStore";

import { deepFreeze } from "@/lib/utils/deepFreeze";

import {
  SHA256_REGEX
} from "@/lib/crypto/validators";


const SEALED_ERROR =
  new Error("[AETERNA] Capsule is sealed");


/**
 * DEV capsuleId validation regex
 *
 * Relaxed format allowed ONLY in dev
 * Production loader uses canonical HEX64
 */

const CAPSULE_ID_REGEX =
  /^[0-9a-f-]{16,120}$/;


/**
 * DEV manifest loader
 *
 * ❗ Used ONLY in development
 * ❗ Wired via vite.config.ts alias
 * ❗ NEVER included in production build
 *
 * Spec §23 compliant
 */

if (import.meta.env.PROD) {
  throw new Error(
    "[AETERNA] DEV manifest loader used in production environment. " +
    "Vite alias misconfigured."
  );
}


export async function loadManifest(
  capsuleId: string
): Promise<ManifestV1> {

  /**
   * capsuleId validation
   */

  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    throw SEALED_ERROR;
  }


  /**
   * load dev manifest
   */

  const manifest =
    loadDevManifest(capsuleId);


  if (!manifest) {
    throw SEALED_ERROR;
  }


  /**
   * prototype boundary protection
   */

  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    Object.getPrototypeOf(manifest) !== Object.prototype
  ) {
    throw SEALED_ERROR;
  }


  /**
   * identity continuity validation
   */

  if (
    manifest.capsuleId !== capsuleId
  ) {
    throw SEALED_ERROR;
  }


  /**
   * version guard
   */

  if (
    manifest.version !== 1
  ) {
    throw SEALED_ERROR;
  }


  /**
   * extension-layer validation
   * forward-compatible scaffold
   */

  if (manifest.ext !== undefined) {

    if (
      typeof manifest.ext !== "object" ||
      manifest.ext === null ||
      Array.isArray(manifest.ext) ||
      Object.getPrototypeOf(manifest.ext) !== Object.prototype
    ) {
      throw SEALED_ERROR;
    }


    if ("vaultSha256" in manifest.ext) {

      const hash =
        (manifest.ext as any).vaultSha256;


      if (
        typeof hash !== "string" ||
        !SHA256_REGEX.test(hash)
      ) {
        throw SEALED_ERROR;
      }

    }

  }


  /**
   * manifest immutability invariant
   *
   * Use deepFreeze for dev/prod parity
   */

  return deepFreeze(manifest);

}