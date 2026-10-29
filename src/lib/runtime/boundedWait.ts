/**
 * AETERNA — bounded IndexedDB wait (fail-closed robustness layer).
 *
 * IndexedDB operations are promise-based but their callbacks are NOT
 * guaranteed to fire: an `IDBOpenDBRequest` can remain pending forever
 * (e.g. an open connection in another tab that never fires
 * `versionchange`, a wedged transaction, or a browser-level quirk).
 * `onerror`/`onblocked` only cover the *reported* failure paths —
 * a silent stall leaves the promise pending with no error and no
 * network activity, which previously produced an invisible permanent
 * hang in the capsule finalization flow.
 *
 * This helper converts any such potentially-infinite wait into a
 * BOUNDED wait: the operation either settles normally, or rejects
 * with a `RuntimeStorageTimeoutError` carrying a stable, non-secret
 * diagnostic code. It never changes the semantics of a successful
 * operation, and it never swallows a real operation error — the
 * underlying rejection (e.g. the existing `onblocked` error or a
 * capsule-identity guard failure) propagates unchanged.
 *
 * NO SECRETS: only a fixed operation label and the capsuleId-derived
 * operation name are ever placed in the message. No ciphertext,
 * plaintext, vault bytes, recipientSecret, creatorAuthority, saltBase
 * or key material is read or included.
 */

/**
 * Default bounded wait for a single IndexedDB operation.
 *
 * Chosen to be generous rather than aggressive: IndexedDB reads/writes
 * of a 10 MiB ciphertext are sub-second in normal conditions, and the
 * largest single operation here is a `clear()` cursor sweep over the
 * capsule's own records. A 30 s ceiling therefore only ever fires on a
 * genuinely wedged database, never on a slow-but-working device, while
 * still bounding the wait far below "forever".
 */
export const RUNTIME_IDB_TIMEOUT_MS = 30_000;

/**
 * Bounded wait for opening the Runtime database. Kept equal to the
 * per-operation ceiling: `open` is a single request and the mobile
 * cold-open of a large store should not need more than the general
 * operation budget.
 */
export const RUNTIME_IDB_OPEN_TIMEOUT_MS = RUNTIME_IDB_TIMEOUT_MS;

/**
 * Typed, diagnosable, non-secret timeout error.
 *
 * `code` is a stable machine-readable identifier; `operation` names
 * the logical IDB step that stalled. Neither field can carry capsule
 * content, and the message intentionally contains no identifiers
 * beyond those two fixed values.
 */
export class RuntimeStorageTimeoutError extends Error {
  readonly code = "RUNTIME_STORAGE_TIMEOUT" as const;
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(
      `[AETERNA] Runtime storage operation timed out: ${operation} (${timeoutMs}ms)`
    );
    this.name = "RuntimeStorageTimeoutError";
    this.operation = operation;
  }
}

/**
 * Wrap a potentially-infinite promise in a bounded wait.
 *
 * - Resolves with the operation's value when it settles in time.
 * - Rejects with the operation's OWN error when it rejects in time
 *   (fail-closed behaviour is unchanged: the caller sees exactly the
 *   error it saw before).
 * - Rejects with `RuntimeStorageTimeoutError` when the deadline
 *   passes first. The losing operation promise is left to settle
 *   harmlessly; the timeout timer is always cleared so no dangling
 *   timer can keep a test runner or a tab alive.
 */
export function withBoundedWait<T>(
  operation: string,
  promise: Promise<T>,
  timeoutMs: number = RUNTIME_IDB_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RuntimeStorageTimeoutError(operation, timeoutMs));
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
