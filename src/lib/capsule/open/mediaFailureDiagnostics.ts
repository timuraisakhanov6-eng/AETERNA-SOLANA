/**
 * =========================================================
 * AETERNA Media Failure Diagnostics
 * =========================================================
 *
 * Presentation-only diagnostic classification for the SPA
 * media-preview path.
 *
 * PURPOSE
 * -------
 * The primary renderer used to collapse EVERY terminal media
 * failure into the single copy "Failed to load preview", so a
 * user report (e.g. from an iPhone) could not be narrowed to a
 * stage. This module maps the ALREADY-TYPED boundaries of the
 * open pipeline onto a small, stable, non-sensitive code plus a
 * short human-readable label.
 *
 * This module MUST NOT:
 * - alter protocol, crypto, chunk, container, or authority semantics;
 * - change playback behaviour;
 * - inspect or transmit media bytes;
 * - ever surface a raw exception message, stack trace, MIME string,
 *   capsule id, storage pointer, capability secret, URL fragment,
 *   ciphertext or plaintext.
 *
 * It is a pure classifier over the module's own typed errors plus
 * one explicit fallback context. No string parsing of arbitrary
 * exceptions is performed; unknown inputs degrade to a generic code.
 */

import {
  isMediaNotStreamableError,
} from "./mediaCompatibility";
import { BoundedAwaitTimeoutError } from "./boundedAwait";
import {
  isMediaPreviewTooLargeError,
  isMediaPreviewConstructionError,
  inlinePreviewTooLargeMessage,
} from "./mediaPreviewPolicy";
import {
  isStorageRangeError,
  type StorageRangeRejectionReason,
} from "@/lib/storage/storageRangeFailure";import {
  isChunkLoadError,
  isByteRuntimeReconstructionError,
} from "@/lib/capsule/runtime/chunkLoadFailure";

/**
 * Stable, non-sensitive diagnostic codes.
 *
 * These are the ONLY identifiers ever rendered. They carry no
 * capsule content and are safe to appear in a screenshot.
 */
export type MediaDiagnosticCode =
  /**
   * The browser could not stream the stored container/codec at all
   * (`resolveStreamableMimeType` returned null). This is the
   * capability answer, NOT a read failure.
   */
  | "MEDIA_UNSUPPORTED"
  /** MSE was supported but the setup/handshake failed (stall/reject). */
  | "MSE_SETUP_FAILED"
  /** A byte read (Range/decrypt/storage) failed before any fallback. */
  | "STREAM_READ_FAILED"
  /**
   * A byte read (Range/decrypt/storage) TIMED OUT before any fallback.
   *
   * Distinct from `STREAM_READ_FAILED` (a read error) and from
   * `MSE_SETUP_FAILED` (a MediaSource handshake failure): a slowed
   * stream read on the progressive path is a READ-layer timeout, not
   * a MediaSource setup problem.
   */
  | "STREAM_READ_TIMEOUT"
  /** The bounded whole-file fallback read timed out. */
  | "PREVIEW_READ_TIMEOUT"
  /** The bounded whole-file fallback read failed. */
  | "PREVIEW_READ_FAILED"
  /**
   * A per-range STORAGE deadline inside the fallback read fired — the
   * inner `rangeDownloadDeadlineMs` budget was spent. Distinct from
   * `PREVIEW_READ_TIMEOUT` (the OUTER whole-file bound) so the two
   * deadline layers can be told apart.
   */
  | "PREVIEW_RANGE_TIMEOUT"
  /**
   * A per-range STORAGE read was rejected while the fallback was
   * running: a non-206 status, an unreadable/mismatched Content-Range,
   * or a short/long body — i.e. gateways could not provide the
   * expected window.
   *
   * Retained as the MIXED / unclassifiable rejection code: used when
   * the exhausted attempts observed more than one distinct reason (or
   * none that a single specific code below can name), so no single
   * cause is overstated.
   */
  | "PREVIEW_RANGE_FAILED"
  /**
   * Every rejected attempt answered with a status OTHER than 206. This
   * is a REACHABLE gateway that refused to serve the window as Partial
   * Content (so an HTML body served with a non-206 status is reported
   * here, NOT as `PREVIEW_RANGE_HTML_RESPONSE` — the HTML guard runs
   * only at HTTP 206).
   */
  | "PREVIEW_RANGE_STATUS_REJECTED"
  /**
   * Every rejected attempt returned a 206 whose `content-type` was
   * `text/html` — an error / portal page served in place of the bytes.
   */
  | "PREVIEW_RANGE_HTML_RESPONSE"
  /**
   * Every rejected attempt returned a READABLE but malformed or
   * mismatched `Content-Range`. A missing/unreadable header is NOT this
   * cause — a `null` header is explicitly accepted upstream.
   */
  | "PREVIEW_RANGE_CONTENT_RANGE_MISMATCH"
  /** Every rejected attempt returned a 206 body SHORTER than requested. */
  | "PREVIEW_RANGE_BODY_SHORT"
  /** Every rejected attempt returned a 206 body LONGER than requested. */
  | "PREVIEW_RANGE_BODY_LONG"
  /**
   * A per-range storage request could not COMPLETE at the transport
   * layer (network/TLS/CORS rejection from `fetch`) while the fallback
   * was running. Distinct from `PREVIEW_RANGE_FAILED` (a reachable
   * gateway that rejected the window) and from user cancellation.
   */
  | "PREVIEW_RANGE_NETWORK"
  /**
   * The fallback read produced a ciphertext window whose length did
   * not match the chunk metadata (truncation / layout mismatch).
   */
  | "PREVIEW_CHUNK_LENGTH_MISMATCH"
  /** AES-GCM decryption of a correctly-sized chunk was rejected. */
  | "PREVIEW_DECRYPT_FAILED"
  /**
   * The decrypted chunks could not be assembled/allocated in memory
   * after a successful read (e.g. a large fallback buffer on a
   * memory-constrained device).
   */
  | "PREVIEW_RECONSTRUCTION_FAILED"
  /** The item is too large for an in-memory preview. */
  | "PREVIEW_TOO_LARGE"
  /** Building the Blob / object URL failed after a successful read. */
  | "PREVIEW_OBJECT_URL_FAILED"
  /** Anything not attributable to a known typed boundary. */
  | "MEDIA_FAILED";

/**
 * Why the bounded Blob fallback was entered. Recorded in memory by
 * `openStreamableOrFallback` and attached to a subsequent fallback
 * failure as ADDITIONAL context — never as the primary cause.
 */
export type MediaFallbackTrigger =
  /** `resolveStreamableMimeType` found no MSE candidate — capability. */
  | "capability"
  /** MSE was entered but the setup/handshake failed. */
  | "mse-setup";

/**
 * Mutable, in-memory-only context thread for a single media attempt.
 *
 * Passed by the caller into `openStreamableOrFallback`; the function
 * records WHY it entered the fallback so the terminal classifier can
 * report the trigger alongside the final failure. Never persisted,
 * never transmitted, dropped as soon as the attempt settles.
 */
export interface MediaOpenDiagnosticContext {
  /**
   * The item's media surface (`video` | `audio` | `image` | `file`).
   *
   * Retained as descriptive context only. Classification no longer
   * depends on it: the MSE-vs-stream-read distinction is carried by
   * the thrown error's own typed boundary, not by the media type.
   */
  mediaType?: "video" | "audio" | "image" | "file";
  fallbackTrigger?: MediaFallbackTrigger;
}

/**
 * The classification result: a stable code plus a short, safe label.
 *
 * `fallbackTrigger` is present ONLY when the bounded Blob fallback was
 * actually entered AND the failure happened inside it — i.e. when the
 * trigger is genuinely known. It is additive context, never the
 * primary cause.
 */
export interface MediaFailureDiagnosis {
  readonly code: MediaDiagnosticCode;
  readonly message: string;
  /**
   * Set only for a failure that occurred INSIDE the bounded Blob
   * fallback, naming why the fallback was entered. Never set for
   * failures that never reached the fallback.
   */
  readonly fallbackTrigger?: MediaFallbackTrigger;
  /**
   * Fixed, safe copy labelling `fallbackTrigger` (see
   * `fallbackTriggerLabel`). Present EXACTLY when `fallbackTrigger` is,
   * so a renderer can display it without a second lookup and without
   * ever composing a dynamic string.
   */
  readonly fallbackTriggerLabel?: string;
}

/**
 * Fixed, safe, user-facing copy for the FALLBACK TRIGGER — the known
 * reason the bounded Blob fallback was entered. Rendered alongside the
 * final failure so a screenshot can distinguish "progressive (MSE)
 * streaming was not available" from "MSE setup failed" when the
 * fallback then failed.
 *
 * The capability copy deliberately does NOT claim the device cannot
 * play the format: a MediaSource capability rejection only establishes
 * that progressive streaming via `MediaSource` was unavailable — the
 * Blob fallback may still play it. The wording states exactly that.
 *
 * Static by construction: no interpolation of any raw value.
 */
const FALLBACK_TRIGGER_LABELS: Record<MediaFallbackTrigger, string> = {
  capability:
    "Fallback reason: progressive streaming unavailable (capability check).",
  "mse-setup":
    "Fallback reason: media streaming could not start (MSE setup).",
};

/**
 * Maps a known fallback trigger to its fixed, safe user-facing label.
 *
 * Returns `undefined` when no fallback was entered, so a caller can
 * render the trigger ONLY when it is genuinely known.
 */
export function fallbackTriggerLabel(
  trigger?: MediaFallbackTrigger,
): string | undefined {
  return trigger === undefined
    ? undefined
    : FALLBACK_TRIGGER_LABELS[trigger];
}

/** Short, safe, user-facing copy per code. No dynamic interpolation. */
const MESSAGES: Record<MediaDiagnosticCode, string> = {
  MEDIA_UNSUPPORTED:
    "This device cannot play this media format (MEDIA_UNSUPPORTED).",
  MSE_SETUP_FAILED:
    "Media streaming could not start on this device (MSE_SETUP_FAILED).",
  STREAM_READ_FAILED:
    "Media data could not be read (STREAM_READ_FAILED).",
  STREAM_READ_TIMEOUT:
    "Media data took too long to read (STREAM_READ_TIMEOUT).",
  PREVIEW_READ_TIMEOUT:
    "Media preview took too long to load (PREVIEW_READ_TIMEOUT).",
  PREVIEW_READ_FAILED:
    "Media preview could not be read (PREVIEW_READ_FAILED).",
  PREVIEW_RANGE_TIMEOUT:
    "Media preview read timed out at storage (PREVIEW_RANGE_TIMEOUT).",
  PREVIEW_RANGE_FAILED:
    "Storage could not provide the requested media range (PREVIEW_RANGE_FAILED).",
  PREVIEW_RANGE_STATUS_REJECTED:
    "Storage answered the media range with an unexpected status (PREVIEW_RANGE_STATUS_REJECTED).",
  PREVIEW_RANGE_HTML_RESPONSE:
    "Storage returned an error page instead of media data (PREVIEW_RANGE_HTML_RESPONSE).",
  PREVIEW_RANGE_CONTENT_RANGE_MISMATCH:
    "Storage returned media data for the wrong range (PREVIEW_RANGE_CONTENT_RANGE_MISMATCH).",
  PREVIEW_RANGE_BODY_SHORT:
    "Storage returned less media data than requested (PREVIEW_RANGE_BODY_SHORT).",
  PREVIEW_RANGE_BODY_LONG:
    "Storage returned more media data than requested (PREVIEW_RANGE_BODY_LONG).",
  PREVIEW_RANGE_NETWORK:
    "The media range request could not complete (PREVIEW_RANGE_NETWORK).",
  PREVIEW_CHUNK_LENGTH_MISMATCH:
    "Media data length did not match its metadata (PREVIEW_CHUNK_LENGTH_MISMATCH).",
  PREVIEW_DECRYPT_FAILED:
    "Media data could not be decrypted (PREVIEW_DECRYPT_FAILED).",
  PREVIEW_RECONSTRUCTION_FAILED:
    "Media data could not be assembled in memory (PREVIEW_RECONSTRUCTION_FAILED).",
  PREVIEW_TOO_LARGE:
    "This file is too large for an inline preview (PREVIEW_TOO_LARGE).",
  PREVIEW_OBJECT_URL_FAILED:
    "Media preview could not be prepared (PREVIEW_OBJECT_URL_FAILED).",
  MEDIA_FAILED:
    "Media preview failed (MEDIA_FAILED).",
};

function result(
  code: MediaDiagnosticCode,
  fallbackTrigger?: MediaFallbackTrigger,
): MediaFailureDiagnosis {
  const message = MESSAGES[code];
  return fallbackTrigger === undefined
    ? { code, message }
    : {
        code,
        message,
        fallbackTrigger,
        fallbackTriggerLabel: FALLBACK_TRIGGER_LABELS[fallbackTrigger],
      };
}

/**
 * Maps the SAFE, non-sensitive set of observed range-rejection reasons
 * to a single diagnostic code.
 *
 *   • EXACTLY ONE distinct reason  → its own specific code, so a
 *     physical-device screenshot names the actual failure boundary.
 *   • MIXED (≥2 distinct reasons)  → the generic `PREVIEW_RANGE_FAILED`
 *     catch-all. No single cause is overstated when the gateways
 *     disagreed; the full safe set stays on the (non-rendered) error's
 *     `reasons` field for any future structured use.
 *   • EMPTY (unclassifiable)       → the generic catch-all.
 *
 * Pure and total: no message is ever parsed.
 */
function rejectionReasonToCode(
  reasons: readonly StorageRangeRejectionReason[],
): MediaDiagnosticCode {
  if (reasons.length !== 1) {
    return "PREVIEW_RANGE_FAILED";
  }
  switch (reasons[0]) {
    case "status-not-206":
      return "PREVIEW_RANGE_STATUS_REJECTED";
    case "html-response":
      return "PREVIEW_RANGE_HTML_RESPONSE";
    case "content-range-mismatch":
      return "PREVIEW_RANGE_CONTENT_RANGE_MISMATCH";
    case "body-short":
      return "PREVIEW_RANGE_BODY_SHORT";
    case "body-long":
      return "PREVIEW_RANGE_BODY_LONG";
    default:
      return "PREVIEW_RANGE_FAILED";
  }
}

/**
 * Classifies a terminal media failure on the SPA path.
 *
 * Ordering matters: the oversized-preview case is checked FIRST so its
 * precise, pre-existing user-facing message is preserved verbatim
 * (`inlinePreviewTooLargeMessage`), and the fallback context is only
 * consulted when the failure happened inside the fallback.
 *
 * No message text is ever parsed or rendered.
 */
export function classifyMediaFailure(
  err: unknown,
  context?: MediaOpenDiagnosticContext,
): MediaFailureDiagnosis {
  const trigger = context?.fallbackTrigger;

  // Preserve the exact, pre-existing oversized-preview message.
  if (isMediaPreviewTooLargeError(err)) {
    return result("PREVIEW_TOO_LARGE", trigger);
  }

  /**
   * A construction failure (Blob / object URL) happened AFTER a
   * successful read. It is typed explicitly, so it can never be
   * confused with a read failure or attributed to the network.
   */
  if (isMediaPreviewConstructionError(err)) {
    return result("PREVIEW_OBJECT_URL_FAILED", trigger);
  }

  if (isMediaNotStreamableError(err)) {
    /**
     * Typed discriminator set at the throw site — never a message
     * match. A `capability` stage means the browser cannot demux the
     * type; an `mse-setup` stage means MSE was reachable but failed.
     *
     * Every MSE handshake failure (sourceopen / updateend / addSourceBuffer
     * / SourceBuffer error) is raised HERE, so an MSE setup timeout is
     * classified as `MSE_SETUP_FAILED` — never as a stream-read failure.
     */
    return result(
      err.stage === "capability" ? "MEDIA_UNSUPPORTED" : "MSE_SETUP_FAILED",
      trigger,
    );
  }

  if (err instanceof BoundedAwaitTimeoutError) {
    /**
     * Only READ-layer waits reach here as a bare timeout: the MSE
     * handshake timeouts are converted to `MediaNotStreamableError`
     * (`mse-setup`) before propagating. So:
     * - inside the fallback (trigger known) → a fallback read timeout;
     * - otherwise → a stream-read timeout (Range/decrypt/storage),
     *   NEVER MSE setup.
     */
    if (trigger !== undefined) {
      return result("PREVIEW_READ_TIMEOUT", trigger);
    }
    return result("STREAM_READ_TIMEOUT");
  }

  /**
   * A typed storage range failure — the INNER per-range deadline or a
   * gateway/window rejection. Distinct from the outer read timeout
   * above. Only attributed when the failure happened inside the
   * fallback; otherwise it is a stream-read failure and keeps the
   * pre-existing generic code so no new code appears off the fallback.
   */
  if (isStorageRangeError(err)) {
    if (trigger === undefined) {
      return result("STREAM_READ_FAILED");
    }
    if (err.code === "range-timeout") {
      return result("PREVIEW_RANGE_TIMEOUT", trigger);
    }
    if (err.code === "range-network") {
      return result("PREVIEW_RANGE_NETWORK", trigger);
    }
    return result(rejectionReasonToCode(err.reasons), trigger);
  }

  /**
   * A typed chunk-layer failure: the ciphertext window length did not
   * match the metadata, or AES-GCM rejected the chunk. Only attributed
   * as a preview code inside the fallback.
   */
  if (isChunkLoadError(err)) {
    if (trigger === undefined) {
      return result("STREAM_READ_FAILED");
    }
    return result(
      err.code === "chunk-decrypt-failed"
        ? "PREVIEW_DECRYPT_FAILED"
        : "PREVIEW_CHUNK_LENGTH_MISMATCH",
      trigger,
    );
  }

  /**
   * A typed ByteRuntime reconstruction/allocation failure — the bytes
   * were already read and decrypted; the in-memory assembly failed.
   */
  if (isByteRuntimeReconstructionError(err)) {
    if (trigger === undefined) {
      return result("STREAM_READ_FAILED");
    }
    return result("PREVIEW_RECONSTRUCTION_FAILED", trigger);
  }

  /**
   * Everything else reaching this point is an untagged error. When the
   * fallback was entered, it is a fallback read failure; otherwise it
   * is a stream read failure BEFORE the fallback.
   *
   * We deliberately do NOT inspect the message: a "range read failed"
   * message does not prove a network cause, so no network attribution
   * is made either way.
   */
  if (trigger !== undefined) {
    return result("PREVIEW_READ_FAILED", trigger);
  }

  return result("STREAM_READ_FAILED");
}

/**
 * Classifies a failure that happened while BUILDING the preview object
 * URL (Blob construction / createObjectURL), i.e. AFTER a successful
 * read. Kept separate so it can never be confused with a read failure
 * or reported as a network error.
 *
 * Prefer letting `classifyMediaFailure` see the typed
 * `MediaPreviewConstructionError` directly; this helper exists for a
 * caller that already knows the failure was in the construction step.
 */
export function classifyPreviewConstructionFailure(
  context?: MediaOpenDiagnosticContext,
): MediaFailureDiagnosis {
  return result("PREVIEW_OBJECT_URL_FAILED", context?.fallbackTrigger);
}

/**
 * Test/safety helper: the complete set of codes, so a test can assert
 * that every rendered diagnostic uses one of them.
 */
export const MEDIA_DIAGNOSTIC_CODES: readonly MediaDiagnosticCode[] =
  Object.freeze(Object.keys(MESSAGES) as MediaDiagnosticCode[]);

/** Re-exported for callers that need the preserved oversized copy. */
export { inlinePreviewTooLargeMessage };
