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
   */
  const recovered =
    new IndexedDbRuntimeStorage();

  await recovered.open(
    capsuleId,
  );

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