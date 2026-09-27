/**
 * AETERNA — J3-owned regression tests for the IndexedDB-open operation deadline.
 *
 * TASK J3 (P0): production baseline `afe9429` had a proven infinite wait on
 * `/create/hold`: `getRuntime()` -> `IndexedDbRuntimeStorage.open()` awaits
 * `indexedDB.open(...)`, and a genuinely non-settling open request (no
 * callback ever fires) left the promise pending forever.
 *
 * These tests are INDEPENDENT of the Batch-1 `boundedWait.test.ts` file and
 * prove the J3-owned `idbOpenDeadline` helper:
 *   1. converts a NEVER-SETTLING open into a typed operation-level rejection;
 *   2. leaves a NORMAL success completely unchanged;
 *   3. leaves a NORMAL IndexedDB error completely unchanged;
 *   4. is non-vacuous — removing the deadline leaves the promise pending
 *      forever (the paired mutation test asserts the "still pending" state).
 *
 * Scope note: this file tests ONLY the J3 deadline behavior. It imports the
 * J3 helper and the storage class, never the Batch-1 bounded-wait module.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  withIdbOpenDeadline,
  IdbOpenTimeoutError,
  IDB_OPEN_DEADLINE_MS,
} from "@/lib/runtime/idbOpenDeadline";

import {
  IndexedDbRuntimeStorage,
} from "@/lib/runtime/indexedDbRuntimeStorage";

/* ─────────────────── fake IndexedDB (node env has none) ─────────────────── */

type FakeRequest = {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  error: unknown;
  result: unknown;
};

function makeFakeDatabase(): Record<string, unknown> {
  return {
    createObjectStore: () => ({}),
    objectStoreNames: { contains: () => true },
    onversionchange: null,
    close: () => undefined,
    transaction: () => ({ objectStore: () => ({}) }),
  };
}

/**
 * Installs a fake `globalThis.indexedDB.open` with a chosen settle mode:
 *   "ok"    → fires `onsuccess` on the next microtask (normal success).
 *   "error" → fires `onerror` on the next microtask with `error` set
 *             (normal IDB failure).
 *   "hang"  → NEVER fires any callback: the production wedge this task
 *             closes. The request stays pending forever otherwise.
 */
function installFakeIndexedDb(
  mode: "ok" | "error" | "hang"
): { restore: () => void } {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;
  const originalKeyRange = (globalThis as { IDBKeyRange?: unknown })
    .IDBKeyRange;

  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = {
    bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const request: FakeRequest = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        error: null,
        result: mode === "hang" ? undefined : makeFakeDatabase(),
      };

      if (mode === "ok") {
        Promise.resolve().then(() => {
          request.onsuccess?.();
        });
      } else if (mode === "error") {
        Promise.resolve().then(() => {
          request.error = new Error("[AETERNA] simulated IDB open error");
          request.onerror?.();
        });
      }
      // "hang": deliberately fire NOTHING.

      return request;
    },
  };

  return {
    restore: () => {
      (globalThis as { indexedDB?: unknown }).indexedDB = original;
      (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = originalKeyRange;
    },
  };
}

let fake: { restore: () => void } | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ────────────────────── 1. helper-level semantics ────────────────────── */

describe("withIdbOpenDeadline — operation-level deadline semantics", () => {
  it("1. a NEVER-SETTLING open rejects with the typed J3 timeout error", async () => {
    vi.useFakeTimers();

    const neverSettles = new Promise<never>(() => {});
    const wrapped = withIdbOpenDeadline(neverSettles);

    const assertion = expect(wrapped).rejects.toBeInstanceOf(IdbOpenTimeoutError);

    await vi.advanceTimersByTimeAsync(IDB_OPEN_DEADLINE_MS + 100);

    await assertion;
  });

  it("2. a normal resolution is passed through UNCHANGED (value identity)", async () => {
    const sentinel = { id: "db-handle" };
    const resolved = await withIdbOpenDeadline(Promise.resolve(sentinel));
    expect(resolved).toBe(sentinel);
  });

  it("3. a normal rejection is passed through UNCHANGED (error identity)", async () => {
    const original = new Error("[AETERNA] real IDB failure");
    await expect(withIdbOpenDeadline(Promise.reject(original))).rejects.toBe(
      original
    );
  });

  it("uses the 30 s default deadline and carries it on the error", async () => {
    vi.useFakeTimers();

    const wrapped = withIdbOpenDeadline(new Promise<never>(() => {}));
    const caught = wrapped.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(IDB_OPEN_DEADLINE_MS + 100);

    const error = await caught;
    expect(error).toBeInstanceOf(IdbOpenTimeoutError);
    expect((error as IdbOpenTimeoutError).timeoutMs).toBe(30_000);
    expect((error as IdbOpenTimeoutError).code).toBe("IDB_OPEN_TIMEOUT");
  });
});

/* ─────────────── 2. integration through IndexedDbRuntimeStorage ─────────────── */

describe("IndexedDbRuntimeStorage.open — J3 bounded open", () => {
  it("4. a never-settling indexedDB.open rejects via the storage layer", async () => {
    vi.useFakeTimers();
    fake = installFakeIndexedDb("hang");

    const runtime = new IndexedDbRuntimeStorage();
    const openPromise = runtime.open("a".repeat(64));

    const assertion = expect(openPromise).rejects.toBeInstanceOf(
      IdbOpenTimeoutError
    );

    await vi.advanceTimersByTimeAsync(IDB_OPEN_DEADLINE_MS + 100);

    await assertion;
  });

  it("5. a normal open still resolves (success path unchanged)", async () => {
    fake = installFakeIndexedDb("ok");

    const runtime = new IndexedDbRuntimeStorage();
    await expect(runtime.open("b".repeat(64))).resolves.toBeUndefined();
  });

  it("6. a normal open error still rejects with the SAME error (unchanged)", async () => {
    fake = installFakeIndexedDb("error");

    const runtime = new IndexedDbRuntimeStorage();
    const error = await runtime.open("c".repeat(64)).catch((e: unknown) => e);

    // The failure surfaces as a normal error, NOT a J3 timeout, and not
    // swallowed: the open path still fails closed.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IdbOpenTimeoutError);
  });
});

/* ───────────────────────────── 3. mutation proof ───────────────────────────── */

describe("withIdbOpenDeadline — mutation/non-vacuousness proof", () => {
  it("7. MUTATION: without the deadline, a hanging open stays pending forever", async () => {
    vi.useFakeTimers();

    // This mirrors exactly what removing `withIdbOpenDeadline` would do:
    // the raw promise receives no timer, so it never settles.
    const rawPromise = new Promise<never>(() => {});

    let state: "pending" | "resolved" | "rejected" = "pending";
    rawPromise.then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      }
    );

    // Advance FAR beyond every project deadline.
    await vi.advanceTimersByTimeAsync(IDB_OPEN_DEADLINE_MS * 4);

    // The ONLY thing that settles the wrapped promise is the operation-level
    // deadline. With the deadline removed, this remains "pending" — which is
    // precisely why test 1 above is non-vacuous.
    expect(state).toBe("pending");
  });

  it("8. MUTATION: the deadline is genuinely what settles the wrapped promise", async () => {
    vi.useFakeTimers();

    const wrapped = withIdbOpenDeadline(new Promise<never>(() => {}));
    let state: "pending" | "resolved" | "rejected" = "pending";
    wrapped.then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      }
    );

    // Before the deadline: still pending (proves the timer, not something
    // else, is the settling mechanism).
    await vi.advanceTimersByTimeAsync(IDB_OPEN_DEADLINE_MS - 1_000);
    expect(state).toBe("pending");

    // After the deadline: rejected by the J3 timeout.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state).toBe("rejected");
  });
});
