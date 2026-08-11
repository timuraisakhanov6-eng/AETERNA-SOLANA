/**
 * AETERNA — ArweaveTxId refinement helper
 *
 * Canonical storage pointer refinement
 *
 * Converts validated StoragePointer
 * → ArweaveTxId
 *
 * SAFE REFINEMENT RULE:
 *
 * StoragePointer MUST already be validated
 * upstream via:
 *
 * assertStoragePointer()
 *
 * Canonical refinement pipeline:
 *
 * unknown
 * → validated StoragePointer
 * → refined ArweaveTxId
 *
 * Structural invariant:
 *
 * StoragePointer and ArweaveTxId
 * share identical canonical runtime format.
 *
 * Therefore this function performs:
 *
 * compile-time refinement only
 * zero runtime validation
 *
 * Layer:
 *
 * Storage Adapter Boundary
 * → Manifest Type Layer
 */

import type { ArweaveTxId } from "@/types/manifest";
import type { StoragePointer } from "@/lib/storage/storageAdapter";


export function asArweaveTxId(
  pointer: StoragePointer
): ArweaveTxId {

  /**
   * SAFE TYPE REFINEMENT
   *
   * pointer validity already guaranteed by:
   *
   * assertStoragePointer(pointer)
   *
   * Intentional double-cast required because:
   *
   * StoragePointer and ArweaveTxId
   * use different nominal branding strategies.
   *
   * Runtime representation remains identical.
   */

  return pointer as unknown as ArweaveTxId;

}