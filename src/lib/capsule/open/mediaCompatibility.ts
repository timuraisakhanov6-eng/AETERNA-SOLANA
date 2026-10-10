/**
 * =========================================================
 * AETERNA Media Compatibility Helper
 * =========================================================
 *
 * Presentation-only helpers shared by the primary renderer
 * (VaultRenderer) and the Emergency Runtime.
 *
 * This module MUST NOT:
 * - alter protocol semantics
 * - alter chunk semantics
 * - alter crypto
 * - become protocol authority
 *
 * It only answers two browser-capability questions:
 *
 *   1. Which concrete MSE mime type should be used for a stored
 *      mime type (legacy bare `video/webm` is a real case: the
 *      MediaRecorder accepts it, but MediaSource does not).
 *
 *   2. Is a given mime type streamable through MediaSource at all,
 *      so the caller can choose progressive playback vs. a bounded
 *      whole-file fallback.
 *
 * No media bytes are inspected here — codec selection is a
 * browser-capability probe, never a guess about the encrypted
 * payload's actual codec.
 */

/**
 * Concrete codec-qualified candidates probed for a bare WebM
 * container. Order = preference. Each candidate is a well-known,
 * widely-supported WebM codec string; the browser decides via
 * `MediaSource.isTypeSupported`.
 */
const WEBM_VIDEO_CODEC_CANDIDATES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9",
] as const;

const WEBM_AUDIO_CODEC_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm;codecs=vorbis",
] as const;

const MP4_VIDEO_CODEC_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=hvc1",
] as const;

function mseSupported(mimeType: string): boolean {
  if (typeof MediaSource === "undefined") {
    return false;
  }
  try {
    return MediaSource.isTypeSupported(mimeType);
  } catch {
    return false;
  }
}

/**
 * Returns the concrete MSE mime type to use for a stored mime type,
 * or null when the type cannot be streamed through MediaSource.
 *
 * Behaviour:
 * - a codec-qualified type is used verbatim if MSE supports it;
 * - a BARE `video/webm` / `audio/webm` is expanded through a bounded
 *   capability probe (the stored container has no codec parameter,
 *   and MSE rejects the bare form even though MediaRecorder accepts it);
 * - a bare `video/mp4` is expanded the same way (Safari/iOS recordings);
 * - anything else unsupported returns null.
 *
 * IMPORTANT: returning a candidate only asserts the BROWSER can
 * demux/play that codec — it is NOT a claim about the payload's
 * actual codec. If the probe yields a codec the payload does not
 * carry, playback will simply fail at the media element, which the
 * caller turns into a terminal error.
 */
export function resolveStreamableMimeType(
  storedMimeType: string | undefined,
): string | null {
  if (typeof storedMimeType !== "string" || storedMimeType.length === 0) {
    return null;
  }

  const normalized = storedMimeType.trim().toLowerCase();

  // Already codec-qualified (or otherwise concrete): trust MSE directly.
  if (normalized.includes("codecs=")) {
    return mseSupported(storedMimeType) ? storedMimeType : null;
  }

  // Bare container types that MSE rejects but recorders accept.
  if (normalized === "video/webm") {
    for (const candidate of WEBM_VIDEO_CODEC_CANDIDATES) {
      if (mseSupported(candidate)) return candidate;
    }
    return null;
  }

  if (normalized === "audio/webm") {
    for (const candidate of WEBM_AUDIO_CODEC_CANDIDATES) {
      if (mseSupported(candidate)) return candidate;
    }
    return null;
  }

  if (normalized === "video/mp4") {
    for (const candidate of MP4_VIDEO_CODEC_CANDIDATES) {
      if (mseSupported(candidate)) return candidate;
    }
    return null;
  }

  // Some other type (image/*, application/pdf, …): only streamable if
  // MSE supports it verbatim (almost never — those go to element/blob).
  return mseSupported(storedMimeType) ? storedMimeType : null;
}

/**
 * True when the stored mime type is a bare container that MSE does
 * not accept without a codec parameter. Used to decide whether a
 * streamable-candidate probe is required.
 */
export function isBareWebmOrMp4(mimeType: string | undefined): boolean {
  if (typeof mimeType !== "string") return false;
  const normalized = mimeType.trim().toLowerCase();
  return (
    normalized === "video/webm" ||
    normalized === "audio/webm" ||
    normalized === "video/mp4"
  );
}

/**
 * Raised when a media item cannot be streamed through MediaSource for
 * a CAPABILITY reason — i.e. the MSE/container layer itself is the
 * problem — as opposed to a failure of the underlying byte read
 * (fetch / range / decrypt / authentication).
 *
 * This distinction is the whole point of the class: the caller is
 * allowed to recover a genuinely non-streamable item through the
 * bounded whole-file Blob fallback, but it MUST NOT do so for a real
 * read/decrypt failure — retrying a failed read as a full-file
 * download would waste bandwidth, and could mask corrupt data.
 *
 * Only MSE-layer failures are wrapped in this error:
 *   - the concrete mime type has no MediaSource candidate
 *     (`resolveStreamableMimeType` returned null);
 *   - `addSourceBuffer` rejected the type;
 *   - the `sourceopen` / `updateend` handshake stalled (a wedged MSE
 *     pipeline);
 *   - the SourceBuffer emitted an `error` event.
 *
 * Read-layer failures (a rejecting or stalling `session.read`) are
 * deliberately NOT wrapped and propagate unchanged.
 */
export class MediaNotStreamableError extends Error {
  readonly mimeType: string;

  constructor(mimeType: string, reason?: string) {
    super(
      reason
        ? `[AETERNA] ${reason}`
        : `[AETERNA] Progressive playback unavailable for ${mimeType}`,
    );
    this.name = "MediaNotStreamableError";
    this.mimeType = mimeType;
  }
}

/**
 * True only for a capability-level MSE/MIME failure. Used by the
 * primary renderer to decide whether the bounded whole-file fallback
 * is permitted.
 */
export function isMediaNotStreamableError(
  error: unknown,
): error is MediaNotStreamableError {
  return error instanceof MediaNotStreamableError;
}
