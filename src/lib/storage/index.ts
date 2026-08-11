/**
 * =========================================================
 * AETERNA — Canonical Storage Adapter Binding
 * =========================================================
 *
 * Production storage adapter entrypoint.
 *
 * Canonical guarantees:
 *
 * • single production storage adapter
 * • immutable adapter binding
 * • fail-closed
 *
 * Import contract:
 *
 *   import { storage } from "@/lib/storage"
 *
 * DEV adapters (mockStorage / devStorage)
 * must be imported explicitly where required.
 *
 * Spec layer:
 * Storage Capability Boundary
 */

import type { StorageAdapter } from "./storageAdapter";

import { executorStorage } from "./executorStorage";


/**
 * Canonical failure helper
 */

function sealedError(): never {

  throw new Error(
    "[AETERNA] Storage unavailable"
  );

}


/**
 * Adapter existence invariant
 */

if (!executorStorage) {

  sealedError();

}


/**
 * Immutable canonical adapter binding
 */

export const storage: StorageAdapter =
  Object.freeze(executorStorage);