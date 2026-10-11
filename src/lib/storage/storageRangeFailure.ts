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
 * Stable, non-sensitive REASONS a reachable gateway's response was
 * REJECTED while the range reader was still looping (i.e. the
 * `continue` branches of `executorStorage.downloadRange`).
 *
 * WHY THIS EXISTS
 * ---------------
 * `range-rejected` (one opaque terminal code) cannot distinguish a
 * non-206 status from an HTML body from a `Content-Range` mismatch
 * from a wrong-length body. A physical-device screenshot therefore
 * could not be narrowed past "a gateway rejected the window". Each
 * reason below is exactly ONE of the existing rejection branches, and
 * each is captured as a fixed enum — NEVER by parsing any message.
 *
 * ORDERING INVARIANT (must match the adapter):
 *   1. `status-not-206`   — checked FIRST, so it is always the reason
 *      recorded when the status gate fires (an HTML body served with a
 *      non-206 status is therefore reported as `status-not-206`, NOT
 *      as `html-response`: the HTML guard is only reached at HTTP 206).
 *   2. `html-response`    — only reached when the status WAS 206.
 *   3. `content-range-mismatch` — a READABLE-but-malformed/mismatched
 *      `Content-Range`. A missing/unreadable (`null`) header is NOT a
 *      reason — it is explicitly ACCEPTED upstream.
 *   4. `body-short` / `body-long` — the 206 body length was below /
 *      above the requested window.
 *
 * These carry no pointer, URL, index, size or byte — an enum only.
 */
export type StorageRangeRejectionReason =
  /** The response status was not 206 (includes 2xx-not-206, 4xx, 5xx). */
  | "status-not-206"
  /** A 206 whose `content-type` contained `text/html` (error/portal page). */
  | "html-response"
  /**
   * A READABLE `Content-Range` was malformed or did not describe the
   * requested window. A missing/unreadable header is NOT this reason.
   */
  | "content-range-mismatch"
  /** A 206 whose body was SHORTER than the requested window. */
  | "body-short"
  /** A 206 whose body was LONGER than the requested window. */
  | "body-long";

/**
 * Canonical, stable order for the reason set — so a diagnostic is
 * deterministic regardless of the order gateways happened to be tried
 * in. NEVER reordered or re-sorted by callers.
 */
const REJECTION_REASON_ORDER: readonly StorageRangeRejectionReason[] = [
  "status-not-206",
  "html-response",
  "content-range-mismatch",
  "body-short",
  "body-long",
];

/**
 * Normalises an observed reason set into the canonical order, with
 * duplicates removed. Pure and total: unknown members are dropped.
 *
 * Exported so tests can assert the ordering contract directly.
 */
export function normalizeRejectionReasons(
  reasons: readonly StorageRangeRejectionReason[],
): readonly StorageRangeRejectionReason[] {
  const seen = new Set<StorageRangeRejectionReason>();
  for (const r of reasons) {
    if (REJECTION_REASON_ORDER.includes(r)) seen.add(r);
  }
  return REJECTION_REASON_ORDER.filter((r) => seen.has(r));
}

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
 *
 * `reasons` is ADDITIVE and set ONLY for a `range-rejected` failure: it
 * is the normalised, safe set of rejection reasons observed across the
 * exhausted gateway attempts. It is never interpolated into `message`
 * and carries no sensitive value. Every other code leaves it empty.
 */
export class StorageRangeError extends Error {
  readonly code: StorageRangeFailureCode;

  /**
   * The normalised set of rejection reasons actually observed while the
   * gateway loop was exhausted. Empty (frozen) unless `code` is
   * `range-rejected`.
   */
  readonly reasons: readonly StorageRangeRejectionReason[];

  constructor(
    code: StorageRangeFailureCode,
    reasons: readonly StorageRangeRejectionReason[] = [],
  ) {
    super(ADAPTER_MESSAGES[code]);
    this.name = "StorageRangeError";
    this.code = code;
    this.reasons = Object.freeze(
      code === "range-rejected" ? normalizeRejectionReasons(reasons) : [],
    );
  }
}

/**
 * Re-wraps a typed adapter range failure as the FAÇADE's canonical
 * error: same `code` (the only new information), but the façade's
 * pre-existing public message. This is how `storage.ts` preserves its
 * exact external contract while still exposing the classification.
 *
 * The `reasons` set is carried across unchanged.
 */
export function toFacadeStorageRangeError(
  cause: StorageRangeError,
): StorageRangeError {
  const wrapped = new StorageRangeError(cause.code, cause.reasons);
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
