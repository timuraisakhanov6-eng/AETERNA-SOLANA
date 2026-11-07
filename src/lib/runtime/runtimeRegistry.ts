import type {
  RuntimeStorage,
} from "@/lib/runtime/runtimeStorage";

import {
  IndexedDbRuntimeStorage,
} from "@/lib/runtime/indexedDbRuntimeStorage";

const sessions =
  new Map<string, RuntimeStorage>();

export async function createRuntime(
  capsuleId: string,
): Promise<RuntimeStorage> {

  const existing =
    sessions.get(capsuleId);

  if (existing) {
    return existing;
  }

  const runtime =
    new IndexedDbRuntimeStorage();

  try {

    await runtime.open(
      capsuleId,
    );

    sessions.set(
      capsuleId,
      runtime,
    );

    return runtime;

  } catch (error) {

    try {

      await runtime.clear();

    } catch {
      // Ignore cleanup errors.
    }

    throw error;

  }

}

export async function getRuntime(
  capsuleId: string,
): Promise<RuntimeStorage> {

  const runtime =
    sessions.get(capsuleId);

  if (runtime) {
    return runtime;
  }

  /**
   * Recovery after page reload (F5).
   *
   * RuntimeRegistry recreates the Runtime session
   * using the persistent Runtime implementation.
   *
   * The `open()` call is bounded by the Runtime storage layer (a
   * wedged IndexedDB can no longer hang this await forever). On ANY
   * failure — including that bounded timeout — the partially
   * constructed instance is cleared and never registered, mirroring
   * `createRuntime()`'s fail-closed cleanup so a broken session can
   * never be observed by a later caller.
   */
  const recovered =
    new IndexedDbRuntimeStorage();

  try {

    await recovered.open(
      capsuleId,
    );

  } catch (error) {

    try {

      await recovered.clear();

    } catch {
      // Ignore cleanup errors — the original failure is authoritative.
    }

    throw error;

  }

  sessions.set(
    capsuleId,
    recovered,
  );

  return recovered;

}

export async function destroyRuntime(
  capsuleId: string,
): Promise<void> {

  const runtime =
    sessions.get(capsuleId);

  if (!runtime) {
    return;
  }

  try {

    await runtime.clear();

  } finally {

    sessions.delete(
      capsuleId,
    );

  }

}

/**
 * R9-A92.1 — discard the PERSISTED Runtime of an authoritatively abandoned
 * attempt, even when no live session is registered in this page.
 *
 * WHY `destroyRuntime` ALONE IS NOT ENOUGH
 * ---------------------------------------
 * The session registry is in-memory only. After a reload (or in a fresh
 * tab) it is empty while IndexedDB can still hold the prepared encrypted
 * Vault and every encrypted chunk. `destroyRuntime` returns early when no
 * session is registered, so it can never reach that data.
 *
 * WHAT THIS DOES
 * --------------
 * `getRuntime` re-opens the SAME persistent store for exactly this
 * capsuleId and registers it; `destroyRuntime` then clears that store
 * (prefix `<capsuleId>:`) and unregisters the session. Both are the
 * EXISTING Runtime primitives — no new storage system, no sweeper, no TTL.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * • It never opens, creates or clears any OTHER capsule: both calls take
 *   this exact id and the store is keyed by its prefix.
 * • It writes no plaintext and no metadata of its own. Opening may create
 *   the empty object store on a browser that never prepared anything;
 *   that is an empty container, not a record.
 * • Errors propagate: callers decide whether local cleanup is best effort.
 *   For the recovery transition it is (a server-side restore must never be
 *   undone or misreported by a local deletion failure).
 */
export async function discardRuntime(
  capsuleId: string,
): Promise<void> {

  await getRuntime(
    capsuleId,
  );

  await destroyRuntime(
    capsuleId,
  );

}