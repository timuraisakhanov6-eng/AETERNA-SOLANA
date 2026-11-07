/**
 * R9-A92.1 — discarding an abandoned Runtime after a reload.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `destroyRuntime(capsuleId)` returns immediately when the in-memory session
 * registry has no entry. After a page reload the registry is empty while
 * IndexedDB can still hold the prepared encrypted Vault — so an abandoned
 * attempt's ciphertext was unreachable and retained forever.
 *
 * WHAT IS PROVEN HERE
 * -------------------
 * Against the REAL `IndexedDbRuntimeStorage` + registry (only the browser's
 * IndexedDB global is faked, because the node test environment has none):
 *
 *   1. a fresh module instance (empty registry) can still clear EXACTLY the
 *      abandoned capsule's persisted records;
 *   2. another capsule's records are untouched and remain readable;
 *   3. a capsule that never stored anything is a harmless no-op;
 *   4. a deletion failure propagates, so the caller can treat it as best
 *      effort (the recovery transition must never fail because of it).
 *
 * No package was added: the fake implements only the surface
 * `IndexedDbRuntimeStorage` uses (open, one object store, put/get/getKey/
 * delete, prefix cursor).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CAPSULE_A = "a".repeat(64);
const CAPSULE_B = "b".repeat(64);
const CAPSULE_C = "c".repeat(64);

interface FakeDbRecord {
  key: string;
  capsuleId: string;
  ciphertext: ArrayBuffer;
}

interface FakeCursorRange {
  lower: string;
  upper: string;
}

function createFakeIndexedDb() {
  const data = new Map<string, FakeDbRecord>();
  let failCursor = false;

  const makeRequest = <T,>(result: T): Record<string, unknown> => {
    const request: Record<string, unknown> = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
      result,
      error: null,
    };
    Promise.resolve().then(() => {
      (request["onsuccess"] as (() => void) | null)?.();
    });
    return request;
  };

  const store = {
    put(record: FakeDbRecord) {
      data.set(record.key, record);
      return makeRequest(undefined);
    },
    get(key: string) {
      return makeRequest(data.get(key));
    },
    getKey(key: string) {
      return makeRequest(data.has(key) ? key : undefined);
    },
    delete(key: string) {
      data.delete(key);
      return makeRequest(undefined);
    },
    openCursor(range: FakeCursorRange) {
      const request: Record<string, unknown> = {
        onsuccess: null,
        onerror: null,
        result: null,
        error: null,
      };

      if (failCursor) {
        Promise.resolve().then(() => {
          (request["onerror"] as (() => void) | null)?.();
        });
        return request;
      }

      const keys = [...data.keys()]
        .filter((key) => key >= range.lower && key <= range.upper)
        .sort();
      let index = 0;

      const step = (): void => {
        if (index >= keys.length) {
          request["result"] = null;
          (request["onsuccess"] as (() => void) | null)?.();
          return;
        }

        const key = keys[index] as string;
        request["result"] = {
          key,
          value: data.get(key),
          delete() {
            data.delete(key);
            return makeRequest(undefined);
          },
          continue() {
            index += 1;
            Promise.resolve().then(step);
          },
        };
        (request["onsuccess"] as (() => void) | null)?.();
      };

      Promise.resolve().then(step);
      return request;
    },
  };

  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
    close: () => undefined,
    onversionchange: null,
  };

  const originalIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
  const originalKeyRange = (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange;

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const request: Record<string, unknown> = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
        result: database,
        error: null,
      };
      Promise.resolve().then(() => {
        (request["onupgradeneeded"] as (() => void) | null)?.();
        (request["onsuccess"] as (() => void) | null)?.();
      });
      return request;
    },
  };

  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = {
    bound: (lower: string, upper: string) => ({ lower, upper }),
  };

  return {
    keys: () => [...data.keys()].sort(),
    setFailCursor: (value: boolean) => {
      failCursor = value;
    },
    restore: () => {
      if (originalIndexedDb === undefined) {
        delete (globalThis as { indexedDB?: unknown }).indexedDB;
      } else {
        (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
      }
      if (originalKeyRange === undefined) {
        delete (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange;
      } else {
        (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = originalKeyRange;
      }
    },
  };
}

let fake: ReturnType<typeof createFakeIndexedDb>;

beforeEach(() => {
  vi.resetModules();
  fake = createFakeIndexedDb();
});

afterEach(() => {
  fake.restore();
  vi.resetModules();
});

describe("discardRuntime — abandoned attempt after a reload", () => {
  it("clears EXACTLY the abandoned capsule while the session registry is empty", async () => {
    let registry = await import("./runtimeRegistry");

    const runtimeA = await registry.createRuntime(CAPSULE_A);
    await runtimeA.storeVault(CAPSULE_A, new Uint8Array([1, 2, 3]));
    const runtimeB = await registry.createRuntime(CAPSULE_B);
    await runtimeB.storeVault(CAPSULE_B, new Uint8Array([4, 5, 6]));

    expect(fake.keys()).toEqual([`${CAPSULE_A}:__vault__`, `${CAPSULE_B}:__vault__`]);

    /**
     * "Reload": a NEW module instance, so the in-memory session registry is
     * empty, while the persisted records are still present. This is exactly
     * the state in which `destroyRuntime` alone silently does nothing.
     */
    vi.resetModules();
    registry = await import("./runtimeRegistry");

    await registry.discardRuntime(CAPSULE_A);

    expect(fake.keys()).toEqual([`${CAPSULE_B}:__vault__`]);

    // The OTHER capsule is still readable through the real API.
    const reopenedB = await registry.getRuntime(CAPSULE_B);
    await expect(reopenedB.readVault(CAPSULE_B)).resolves.toEqual(
      new Uint8Array([4, 5, 6])
    );
  });

  it("is a harmless no-op for a capsule that never persisted anything", async () => {
    let registry = await import("./runtimeRegistry");
    const runtimeB = await registry.createRuntime(CAPSULE_B);
    await runtimeB.storeVault(CAPSULE_B, new Uint8Array([7, 8, 9]));

    vi.resetModules();
    registry = await import("./runtimeRegistry");

    await expect(registry.discardRuntime(CAPSULE_C)).resolves.toBeUndefined();
    expect(fake.keys()).toEqual([`${CAPSULE_B}:__vault__`]);
  });

  it("propagates a deletion failure so the caller can treat it as best effort", async () => {
    let registry = await import("./runtimeRegistry");
    const runtimeA = await registry.createRuntime(CAPSULE_A);
    await runtimeA.storeVault(CAPSULE_A, new Uint8Array([1, 2, 3]));

    vi.resetModules();
    registry = await import("./runtimeRegistry");
    fake.setFailCursor(true);

    await expect(registry.discardRuntime(CAPSULE_A)).rejects.toThrow();
  });

  it("destroyRuntime alone still cannot reach a reloaded capsule (non-vacuity)", async () => {
    let registry = await import("./runtimeRegistry");
    const runtimeA = await registry.createRuntime(CAPSULE_A);
    await runtimeA.storeVault(CAPSULE_A, new Uint8Array([1, 2, 3]));

    vi.resetModules();
    registry = await import("./runtimeRegistry");

    // The OLD behaviour: no session registered ⇒ silent no-op.
    await registry.destroyRuntime(CAPSULE_A);
    expect(fake.keys()).toEqual([`${CAPSULE_A}:__vault__`]);

    // The new primitive reaches it.
    await registry.discardRuntime(CAPSULE_A);
    expect(fake.keys()).toEqual([]);
  });
});
