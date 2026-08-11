import {
  UploadToken,
  assertUploadToken
} from "./storageAdapter";


/**
 * Convert unknown
 * → UploadToken
 *
 * Runtime validation boundary
 * prevents unsafe casting.
 *
 * Uses canonical validator from:
 *
 * storageAdapter.ts
 *
 * Canonical refinement pipeline:
 *
 * unknown
 * → validated UploadToken
 * → opaque capability
 *
 * Spec invariant:
 *
 * uploadToken MUST be validated
 * before usage.
 */

export function asUploadToken(
  value: unknown
): UploadToken {

  /**
   * Intentionally catches both:
   *
   * null
   * undefined
   */

  if (value == null) {

    throw new Error(
      "[StorageAdapter] uploadToken missing"
    );

  }

  return assertUploadToken(value);

}