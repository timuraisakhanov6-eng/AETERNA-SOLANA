/**
 * =========================================================
 * AETERNA — Storage range failure taxonomy
 * =========================================================
 *
 * A small, STABLE, non-sensitive classification of WHY a bounded
 * range read failed, so the media-preview diagnostic layer can
 * distinguish an inner per-range storage timeout from a gateway /
 * status / length rejection WITHOUT parsing any error message.
 *
 * WHY THIS EXISTS
 * ---------------
 * `storage.ts` (the façade) is fail-closed by design: it wraps every
 * adapter failure in one generic `[AETERNA] Storage failure`. That is
 * correct for the public contract but it ERASES the stage — a per-range
 * timeout, a non-206 response and a short body all become the same
 * opaque error, so a screenshot can no longer be narrowed.
 *
 * This type restores ONLY the classification. It does NOT:
 * - change any message rendered to the UI;
 * - change retry / gateway order / deadline / size limits;
 * - carry a pointer, URL, capsule id, byte or any other sensitive value.
 *
 * The single exported factory is the ONLY place a value is attached,
 * and it never interpolates anything dynamic into its `message`.
 */

/**
 * Stable, non-sensitive range-failure codes.
 *
 * Rendered nowhere on their own; they exist so a classifier can map a
 * failure to a fixed, safe diagnostic code.
 */
export type StorageRangeFailureCode =
  /**
   * The per-range deadline (`rangeDownloadDeadlineMs`) fired — the
   * shared budget for the whole range call was spent before any
   * gateway could deliver an acceptable window.
   */
  | "range-timeout"
  /**
   * Gateways were reachable but none delivered an acceptable window:
   * a non-206 status, an unreadable/mismatched `Content-Range`, a
   * short or long body, an HTML/error page, or an exhausted retry.
   */
  | "range-rejected"
  /**
   * The request itself could not complete — a network/TLS/CORS
   * rejection from `fetch` (NOT a user cancellation: a caller-driven
   * abort surfaces as the caller's own abort, see `openStreamableOrFallback`).
   */
  | "range-network";

/**
 * The ADAPTER's original, pre-existing message per code.
 *
 * These are the exact strings `executorStorage.downloadRange` threw
 * before this taxonomy existed, preserved so existing adapter-level
 * callers/tests keep their contract. They are NOT the façade's public
 * message (see `STORAGE_FAILURE_MESSAGE`).
 */
const ADAPTER_MESSAGES: Record<StorageRangeFailureCode, string> = {
  "range-timeout": "[AETERNA] Range read timed out",
  "range-rejected": "[AETERNA] Range read failed",
  "range-network": "[AETERNA] Range read failed",
};

/**
 * The façade's canonical, pre-existing public failure message.
 *
 * Preserved VERBATIM so `storage.ts` keeps its exact external
 * behaviour (including a test that asserts this text); the typed
 * `code` is the ONLY new information.
 */
export const STORAGE_FAILURE_MESSAGE = "[AETERNA] Storage failure";

/**
 * A typed storage range failure.
 *
 * `code` is the ONLY machine-readable discriminator. `message` is the
 * ADAPTER's original string for that code (unchanged contract); the
 * façade re-wraps the same code with its own canonical message.
 */
export class StorageRangeError extends Error {
  readonly code: StorageRangeFailureCode;

  constructor(code: StorageRangeFailureCode) {
    super(ADAPTER_MESSAGES[code]);
    this.name = "StorageRangeError";
    this.code = code;
  }
}

/**
 * Re-wraps a typed adapter range failure as the FAÇADE's canonical
 * error: same `code` (the only new information), but the façade's
 * pre-existing public message. This is how `storage.ts` preserves its
 * exact external contract while still exposing the classification.
 */
export function toFacadeStorageRangeError(
  cause: StorageRangeError,
): StorageRangeError {
  const wrapped = new StorageRangeError(cause.code);
  // Override only the message; the code (and class) are preserved.
  Object.defineProperty(wrapped, "message", {
    value: STORAGE_FAILURE_MESSAGE,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return wrapped;
}

/** Type guard — the sole way the classifier recognises this boundary. */
export function isStorageRangeError(
  error: unknown,
): error is StorageRangeError {
  return error instanceof StorageRangeError;
}
