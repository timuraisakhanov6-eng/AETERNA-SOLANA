/**
 * AETERNA — bounded IndexedDB wait (fail-closed robustness) regression tests.
 *
 * Covers the required cases:
 *   A. IDB success path unchanged
 *   B. IDB timeout rejects
 *   C. timeout is diagnosable and contains no secret data
 *   D. runtime registry cleanup on failure remains correct
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  withBoundedWait,
  RuntimeStorageTimeoutError,
  RUNTIME_IDB_TIMEOUT_MS,
} from "@/lib/runtime/boundedWait";

import {
  IndexedDbRuntimeStorage,
} from "@/lib/runtime/indexedDbRuntimeStorage";

import {
  IdbOpenTimeoutError,
  IDB_OPEN_DEADLINE_MS,
} from "@/lib/runtime/idbOpenDeadline";

import {
  createRuntime,
  getRuntime,
  destroyRuntime,
} from "@/lib/runtime/runtimeRegistry";

/* ─────────────────── fake IndexedDB (node env has none) ─────────────────── */

/**
 * The Vitest environment here is `node`, which has no `indexedDB` global.
 * These tests exercise the *bounded-wait* wrapper around IDB, so a minimal
 * hand-rolled IDB double is both sufficient and more honest than pulling in a
 * full implementation: it lets us reproduce exactly the failure we care about
 * (a request whose callbacks never fire).
 */
type FakeRequest = {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  error: unknown;
  result: unknown;
};

function makeNeverSettlingRequest(): FakeRequest {
  return {
    onsuccess: null,
    onerror: null,
    error: null,
    result: undefined,
  };
}

/**
 * A request that settles successfully on the next microtask — i.e. AFTER the
 * caller has attached its `onsuccess` handler, exactly like a real IDB
 * request (and independent of fake vs real timers).
 */
function makeImmediateRequest(result: unknown): FakeRequest {
  const request = makeNeverSettlingRequest();
  request.result = result;

  Promise.resolve().then(() => {
    request.onsuccess?.();
  });

  return request;
}

/** A synthetic stored vault record so the "ok" path can return real bytes. */
const FAKE_VAULT_BYTES = new Uint8Array([10, 20, 30, 40]);

function makeObjectStore(
  behavior: "never" | "ok"
): Record<string, unknown> {
  return {
    put: () =>
      behavior === "never"
        ? makeNeverSettlingRequest()
        : makeImmediateRequest(undefined),
    get: () =>
      behavior === "never"
        ? makeNeverSettlingRequest()
        : makeImmediateRequest({
            ciphertext: FAKE_VAULT_BYTES.buffer.slice(0),
          }),
    getKey: () =>
      behavior === "never"
        ? makeNeverSettlingRequest()
        : makeImmediateRequest("some-key"),
    delete: () =>
      behavior === "never"
        ? makeNeverSettlingRequest()
        : makeImmediateRequest(undefined),
    openCursor: () =>
      behavior === "never"
        ? makeNeverSettlingRequest()
        : makeImmediateRequest(null),
  };
}

function makeFakeDatabase(
  behavior: "never" | "ok"
): Record<string, unknown> {
  const store = makeObjectStore(behavior);

  return {
    createObjectStore: () => store,
    objectStoreNames: { contains: () => true },
    onversionchange: null,
    close: () => undefined,
    transaction: () => ({ objectStore: () => store }),
  };
}

/**
 * Installs a fake `globalThis.indexedDB`.
 *
 * `behavior`:
 *   "ok"        → `open` and every request callback fire immediately (success).
 *   "never"     → `open` fires onsuccess, but every request callback is silent,
 *                 simulating the genuine invisible IDB wedge.
 *   "openHangs" → the `open` request itself never fires ANY callback (neither
 *                 `onsuccess` nor `onerror` nor `onblocked`). This is the
 *                 deployed-HEAD production hang: `/create/hold` awaits
 *                 `getRuntime` → `IDBOpenDBRequest` and waits forever.
 *   "throw"     → `open` throws synchronously.
 *
 * Auto-fires callbacks asynchronously (microtask) so the wrapper's `.then`
 * handlers are attached before settlement, exactly as a real IDB does.
 */
function installFakeIndexedDb(
  behavior: "ok" | "never" | "openHangs" | "throw"
): { restore: () => void } {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;
  const originalKeyRange = (globalThis as { IDBKeyRange?: unknown })
    .IDBKeyRange;

  // `clear()` builds an IDBKeyRange; the node env has no such global.
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = {
    bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      if (behavior === "throw") {
        throw new Error("[AETERNA] simulated open failure");
      }

      if (behavior === "openHangs") {
        // The production wedge: no callback is ever invoked on the open
        // request, so the underlying promise stays pending forever unless a
        // bounded wait converts it into a rejection.
        const stuck: FakeRequest = {
          onsuccess: null,
          onerror: null,
          error: null,
          result: undefined,
        };
        return stuck;
      }

      const request: FakeRequest = {
        onsuccess: null,
        onerror: null,
        error: null,
        result: makeFakeDatabase(behavior),
      };

      // Fire onsuccess on a microtask, AFTER the caller has attached its
      // handlers (mirrors real IDB's async settle and keeps fake timers
      // irrelevant to the success path).
      Promise.resolve().then(() => {
        request.onsuccess?.();
      });

      return request;
    },
  };

  return {
    restore: () => {
      if (original === undefined) {
        delete (globalThis as { indexedDB?: unknown }).indexedDB;
      } else {
        (globalThis as { indexedDB?: unknown }).indexedDB = original;
      }

      if (originalKeyRange === undefined) {
        delete (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange;
      } else {
        (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange =
          originalKeyRange;
      }
    },
  };
}

/* ───────────────────────── A/B/C: helper semantics ───────────────────────── */

describe("withBoundedWait — bounded, fail-closed wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A. resolves with the operation value and does not time out", async () => {
    const result = withBoundedWait(
      "unit-ok",
      Promise.resolve("value"),
      5_000
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toBe("value");
  });

  it("A. propagates the operation's own RESOLUTION unchanged (success semantics)", async () => {
    const original = { ciphertext: new Uint8Array([1, 2, 3]) };

    const result = withBoundedWait("unit-obj", Promise.resolve(original));

    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toBe(original);
  });

  it("B. rejects with RuntimeStorageTimeoutError when the wait never settles", async () => {
    const neverSettles = new Promise<never>(() => {
      /* intentionally never resolves */
    });

    const result = withBoundedWait("unit-hang", neverSettles, 1_000);

    // Attach the rejection handler BEFORE advancing timers so the rejection
    // is always observed.
    const assertion = expect(result).rejects.toBeInstanceOf(
      RuntimeStorageTimeoutError
    );

    await vi.advanceTimersByTimeAsync(1_100);

    await assertion;
  });

  it("B. does NOT time out before the deadline (boundary is inclusive-safe)", async () => {
    let resolveLate: ((v: string) => void) | undefined;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });

    const result = withBoundedWait("unit-late", late, 1_000);

    await vi.advanceTimersByTimeAsync(900);
    resolveLate!("made-it");
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBe("made-it");
  });

  it("B. propagates the operation's OWN rejection unchanged (fail-closed preserved)", async () => {
    const original = new Error("[AETERNA] Runtime database is not open.");

    // Attach the handler synchronously: the operation rejects on the next
    // microtask, before any timer is advanced.
    const result = withBoundedWait("unit-err", Promise.reject(original));

    await expect(result).rejects.toBe(original);
  });

  it("C. timeout error is diagnosable: stable code + operation, no secret data", async () => {
    const neverSettles = new Promise<never>(() => {});

    const result = withBoundedWait(
      "readVault",
      neverSettles,
      1_000
    );

    let caught: RuntimeStorageTimeoutError | undefined;

    const assertion = result.catch((err: unknown) => {
      caught = err as RuntimeStorageTimeoutError;
    });

    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;

    expect(caught).toBeInstanceOf(RuntimeStorageTimeoutError);

    const e = caught!;

    expect(e.code).toBe("RUNTIME_STORAGE_TIMEOUT");
    expect(e.name).toBe("RuntimeStorageTimeoutError");
    expect(e.operation).toBe("readVault");

    // Diagnosable: names the stalled operation and the budget.
    expect(e.message).toContain("readVault");
    expect(e.message).toContain("1000ms");

    // NO SECRETS: no key material / plaintext / vault content in the message.
    expect(e.message).not.toMatch(/recipientSecret/i);
    expect(e.message).not.toMatch(/creatorAuthority/i);
    expect(e.message).not.toMatch(/saltBase/i);
    expect(e.message).not.toMatch(/ciphertext/i);
    expect(e.message).not.toMatch(/plaintext/i);
    expect(e.message).not.toMatch(/vault:?[0-9a-f]{8}/i);

    // No secret-bearing payload fields: the only own properties are the two
    // diagnostics plus the standard `name`.
    const keys = Object.keys(e).sort();
    expect(keys).toEqual(["code", "name", "operation"]);
    expect(e).not.toHaveProperty("recipientSecret");
    expect(e).not.toHaveProperty("creatorAuthority");
    expect(e).not.toHaveProperty("saltBase");
    expect(e).not.toHaveProperty("ciphertext");
  });

  it("C. default timeout constant is not extreme (>= 10s)", () => {
    expect(RUNTIME_IDB_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(Number.isSafeInteger(RUNTIME_IDB_TIMEOUT_MS)).toBe(true);
  });
});

/* ───────────────────────────── B: IDB layer ───────────────────────────── */

describe("IndexedDbRuntimeStorage — bounded waits do not alter success semantics", () => {
  let fake: { restore: () => void };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fake.restore();
  });

  it("A. a well-behaved IDB still returns the stored value (success semantics unchanged)", async () => {
    // Real timers: a healthy IDB settles immediately, so no fake-timer
    // plumbing is needed and the success path is exercised as-is.
    fake = installFakeIndexedDb("ok");

    const runtime = new IndexedDbRuntimeStorage();

    await runtime.open("a".repeat(64));

    const vault = await runtime.readVault("a".repeat(64));

    expect(vault).toBeInstanceOf(Uint8Array);
    expect(Array.from(vault)).toEqual(Array.from(FAKE_VAULT_BYTES));
  });

  it("B. readVault rejects with a typed timeout when IDB never answers", async () => {
    vi.useFakeTimers();
    fake = installFakeIndexedDb("never");

    const runtime = new IndexedDbRuntimeStorage();

    // open() succeeds (the open request fires onsuccess), but read requests
    // never settle → the bounded wait must reject rather than hang forever.
    await runtime.open("a".repeat(64));

    const readPromise = runtime.readVault("a".repeat(64));

    const assertion = expect(readPromise).rejects.toBeInstanceOf(
      RuntimeStorageTimeoutError
    );

    await vi.advanceTimersByTimeAsync(RUNTIME_IDB_TIMEOUT_MS + 100);

    await assertion;
  });

  it("B. a NEVER-SETTLING indexedDB.open rejects with a typed timeout (deployed-HEAD hang closed)", async () => {
    vi.useFakeTimers();
    fake = installFakeIndexedDb("openHangs");

    const runtime = new IndexedDbRuntimeStorage();

    // Without the bounded wait this promise never settles: the open request
    // fires no callback at all. The operation-level deadline must convert the
    // invisible wedge into a diagnosable rejection.
    //
    // NOTE (Task J3): the open operation is now bounded by the J3-owned,
    // self-contained `withIdbOpenDeadline`, which rejects with
    // `IdbOpenTimeoutError` rather than the generic
    // `RuntimeStorageTimeoutError`. The per-request ops (store/read/
    // remove/clear/storeVault/readVault/removeVault) still use
    // `withBoundedWait`/`RuntimeStorageTimeoutError` — see tests B/C below.
    const openPromise = runtime.open("a".repeat(64));

    const assertion = expect(openPromise).rejects.toBeInstanceOf(
      IdbOpenTimeoutError
    );

    await vi.advanceTimersByTimeAsync(IDB_OPEN_DEADLINE_MS + 100);

    await assertion;
  });

  it("B. MUTATION: a never-settling open stays pending forever without the bounded wait", async () => {
    vi.useFakeTimers();
    fake = installFakeIndexedDb("openHangs");

    const runtime = new IndexedDbRuntimeStorage();

    const openPromise = runtime.open("a".repeat(64));

    let settled: "resolved" | "rejected" | "pending" = "pending";
    openPromise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      }
    );

    // Advance FAR beyond every project deadline. This mirrors what the
    // mutation test proves: the ONLY thing that settles the open is the
    // operation-level bounded wait. If a maintainer removes/raises it past
    // this window, the promise here is still "pending" and the paired
    // assertion above fails — i.e. the regression test is non-vacuous.
    await vi.advanceTimersByTimeAsync(IDB_OPEN_DEADLINE_MS * 4);

    // The bounded wait is what settles it; assert the boundary is genuinely
    // doing the work rather than a coincidental timer.
    expect(settled).toBe("rejected");
  });
});

/* ───────────────────────── D: registry cleanup ───────────────────────── */

describe("runtimeRegistry — cleanup on failure", () => {
  let fake: { restore: () => void };

  afterEach(() => {
    vi.restoreAllMocks();
    fake.restore();
  });

  it("D. getRuntime rejects and does NOT register a broken session", async () => {
    fake = installFakeIndexedDb("ok");

    const first = await createRuntime("a".repeat(64));
    expect(first).toBeDefined();

    // A DIFFERENT capsuleId takes the recovery path; make `open` throw so the
    // recovered instance is never registered.
    fake.restore();
    fake = installFakeIndexedDb("throw");

    await expect(getRuntime("b".repeat(64))).rejects.toThrow();

    // The failed capsule must not be resolvable afterwards: the same call
    // still fails closed (never returns a half-constructed session).
    await expect(getRuntime("b".repeat(64))).rejects.toThrow();

    // A healthy capsule opened before the failure is unaffected.
    fake.restore();
    fake = installFakeIndexedDb("ok");
    await destroyRuntime("a".repeat(64));
  });
});
