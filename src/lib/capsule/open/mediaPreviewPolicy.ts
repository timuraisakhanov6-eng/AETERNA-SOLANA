/**
 * =========================================================
 * AETERNA Media Preview Size Policy
 * =========================================================
 *
 * Presentation/runtime-only size policy for INLINE previews.
 *
 * An inline preview reconstructs the whole file in memory (one
 * decrypted buffer + one Blob), so it must be bounded: without a
 * limit, a large image could be assembled entirely in RAM just to be
 * shown as a thumbnail.
 *
 * This module:
 * - does NOT touch protocol, crypto, chunk, or authority semantics;
 * - does NOT own lifecycle policy — callers decide what exceeding the
 *   bound means for their surface.
 *
 * The bound deliberately REUSES the existing media-view size policy
 * (the same 25 MiB used by the video/audio whole-file fallback), so a
 * single number governs every in-memory media materialisation.
 */

/**
 * Maximum size of a file that may be materialised in memory for an
 * inline preview. Mirrors MAX_MEDIA_FALLBACK_BYTES /
 * EMERGENCY_MEDIA_FALLBACK_MAX_BYTES.
 */
export const MAX_INLINE_PREVIEW_BYTES = 25 * 1024 * 1024;

/**
 * Raised when a media item is too large for an inline preview.
 *
 * Carries the offending size and the limit so the UI can show a
 * precise, actionable terminal message instead of a generic failure.
 */
export class MediaPreviewTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;

  constructor(
    size: number,
    limit: number = MAX_INLINE_PREVIEW_BYTES,
  ) {
    super(
      `[AETERNA] Media too large for inline preview ` +
        `(${size} bytes, limit ${limit} bytes).`,
    );
    this.name = "MediaPreviewTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

export function isMediaPreviewTooLargeError(
  error: unknown,
): error is MediaPreviewTooLargeError {
  return error instanceof MediaPreviewTooLargeError;
}

/**
 * Raised when a preview's OBJECT URL cannot be constructed AFTER its
 * bytes were read successfully — i.e. `new Blob(...)` or
 * `URL.createObjectURL(...)` threw.
 *
 * This is deliberately a distinct, typed boundary: the read already
 * succeeded, so this is NOT a read failure and MUST NOT be reported as
 * a network error. It carries no media bytes and no message from the
 * underlying platform error (which is preserved only as `cause` for
 * local debugging — it is never rendered).
 */
export class MediaPreviewConstructionError extends Error {
  constructor(cause?: unknown) {
    super("[AETERNA] Media preview construction failed.");
    this.name = "MediaPreviewConstructionError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export function isMediaPreviewConstructionError(
  error: unknown,
): error is MediaPreviewConstructionError {
  return error instanceof MediaPreviewConstructionError;
}

/**
 * Fail-closed size gate.
 *
 * MUST be called BEFORE any full-file read, so an oversized item is
 * never materialised. Throws:
 * - a plain Error for a malformed size (fail closed), or
 * - a MediaPreviewTooLargeError when the size exceeds the bound.
 *
 * `size === MAX_INLINE_PREVIEW_BYTES` is ALLOWED (the bound is
 * inclusive); only a strictly larger size is rejected.
 */
export function assertInlinePreviewSize(
  size: number,
  label = "Media",
): void {

  if (
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    throw new Error(
      `[AETERNA] Invalid ${label.toLowerCase()} size.`,
    );
  }

  if (size > MAX_INLINE_PREVIEW_BYTES) {
    throw new MediaPreviewTooLargeError(size);
  }

}

/**
 * Human-readable terminal message for an oversized inline preview.
 * Kept here so the primary renderer and the Emergency Runtime word it
 * identically.
 */
export function inlinePreviewTooLargeMessage(
  size: number,
): string {
  const mb = (n: number) =>
    (n / (1024 * 1024)).toFixed(1);
  return (
    `This file is too large for an inline preview ` +
    `(${mb(size)} MB, limit ${mb(MAX_INLINE_PREVIEW_BYTES)} MB).`
  );
}
