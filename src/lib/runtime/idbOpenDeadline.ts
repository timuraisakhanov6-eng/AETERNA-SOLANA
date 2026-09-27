/**
 * AETERNA — operation-level deadline for opening the Runtime IndexedDB.
 *
 * Scope: this module provides EXACTLY ONE thing — a bounded wait around a
 * single `indexedDB.open()` request. It is deliberately self-contained and
 * intentionally does NOT import, extend, or depend on the broader Batch-1
 * `boundedWait` runtime layer. No other IndexedDB operation is wrapped here.
 *
 * WHY THIS EXISTS
 * ---------------
 * An `IDBOpenDBRequest` is NOT guaranteed to settle. `onerror` and
 * `onblocked` cover the *reported* failure paths, but a silent stall (e.g.
 * an open connection in another tab that never fires `versionchange`) can
 * leave the request pending with no callback, no error and no network
 * activity. The post-payment `/create/hold` flow awaits
 * `getRuntime()` -> `IndexedDbRuntimeStorage.open()`, so such a stall
 * previously produced an invisible permanent hang.
 *
 * WHAT IT DOES
 * ------------
 * `withIdbOpenDeadline(promise, timeoutMs)`:
 *   - resolves with the open request's value when it settles in time
 *     (normal success — completely unchanged);
 *   - rejects with the request's OWN error when it errors in time
 *     (normal failure — completely unchanged);
 *   - rejects with a typed `IdbOpenTimeoutError` when the operation-level
 *     deadline passes first (a genuinely non-settling open).
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It bounds ONE browser operation. It is NOT a capsule timeout, not a page
 * timeout, and not an upload timeout — a slow-but-working device is never
 * cut short; only a genuinely wedged open is converted into a diagnosable
 * rejection. The internal timer is always cleared so no dangling timer can
 * keep a tab or a test runner alive.
 *
 * NO SECRETS: the error carries only a fixed message. No capsule content,
 * bytes, keys, or identifiers are read or included.
 */

/**
 * Default operation-level deadline for a single `indexedDB.open()`.
 *
 * Generous rather than aggressive: a cold open of the Runtime store is
 * sub-second in normal conditions on every supported device. 30 s
 * therefore only ever fires on a genuinely wedged database, while still
 * bounding the wait far below "forever".
 */
export const IDB_OPEN_DEADLINE_MS = 30_000;

/**
 * Typed, diagnosable, non-secret timeout error for a non-settling
 * `indexedDB.open()`.
 */
export class IdbOpenTimeoutError extends Error {
  readonly code = "IDB_OPEN_TIMEOUT" as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `[AETERNA] Runtime database open did not settle within ${timeoutMs}ms`
    );
    this.name = "IdbOpenTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wrap a single `indexedDB.open()` request promise in an operation-level
 * deadline.
 *
 * Semantics:
 * - the underlying promise settling (resolve OR reject) within the
 *   deadline is passed through UNCHANGED (value or error identity);
 * - a promise still pending at the deadline rejects with
 *   `IdbOpenTimeoutError`;
 * - the timer is always cleared on settlement (no dangling timer).
 */
export function withIdbOpenDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number = IDB_OPEN_DEADLINE_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new IdbOpenTimeoutError(timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
