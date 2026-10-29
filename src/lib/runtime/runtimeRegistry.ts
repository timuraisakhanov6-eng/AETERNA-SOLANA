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