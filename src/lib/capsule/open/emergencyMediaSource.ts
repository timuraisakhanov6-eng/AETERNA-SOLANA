/**
 * AETERNA Emergency MediaSource Streamer
 *
 * Thin browser adapter for progressive video/audio playback.
 *
 * This module MUST NOT:
 * - alter protocol semantics
 * - alter chunk semantics
 * - alter crypto
 * - become protocol authority
 */

import type {
  MediaSession,
} from "./openTypes";

import {
  resolveStreamableMimeType,
} from "./mediaCompatibility";

import {
  awaitEvent,
  withTimeout,
} from "./boundedAwait";

const MEDIA_SOURCE_OPEN_TIMEOUT_MS = 20_000;
const MEDIA_APPEND_TIMEOUT_MS = 20_000;
const MEDIA_READ_TIMEOUT_MS = 30_000;

/**
 * Deadline for ONE bounded whole-file read (emergency image / fallback).
 *
 * A whole-file read is at most 25 MiB (see the caller's
 * EMERGENCY_MEDIA_FALLBACK_MAX_BYTES), so 30 s is generous; it only
 * fires on a genuinely wedged read, converting "forever" into a
 * terminal failure the status line can show.
 */
export const EMERGENCY_MEDIA_READ_TIMEOUT_MS = 30_000;

/**
 * Why the emergency streamer produced no object URL.
 *
 * - "not-streamable": the concrete mime has no MediaSource candidate.
 * - "mse":            an MSE-layer failure (addSourceBuffer rejected
 *                     the type, a stalled sourceopen / updateend
 *                     handshake, or a SourceBuffer error event).
 * - "read":           the underlying byte read failed or timed out.
 *
 * The distinction matters to the caller: a compatibility fallback is
 * only appropriate for the first two. A "read" failure must be
 * surfaced as a real error — retrying it as a whole-file download
 * would waste bandwidth and could mask corrupt data.
 */
export type EmergencyMediaFailureKind =
  | "not-streamable"
  | "mse"
  | "read";

/**
 * Reads a whole media file in ONE bounded call.
 *
 * `MediaSession` exposes no cancellation primitive (its `read()` has
 * no AbortSignal), so the underlying read CANNOT be truly cancelled.
 * `withTimeout` therefore only bounds how long the caller waits: on
 * timeout the returned promise rejects, the caller moves to a terminal
 * state, and any late resolution of the underlying read is discarded
 * (its bytes are never used, and memory is bounded by `size`).
 */
export async function readWholeFileBounded(
  session: MediaSession,
  size: number,
  timeoutMs: number = EMERGENCY_MEDIA_READ_TIMEOUT_MS,
): Promise<Uint8Array<ArrayBuffer>> {

  if (
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    throw new Error(
      "[AETERNA] Invalid media size for whole-file read.",
    );
  }

  return await withTimeout(
    session.read(0, size),
    timeoutMs,
    "emergency media read",
  );

}

/**
 * Streams a MediaSession into a MediaSource object URL.
 *
 * Returns the object URL on success, or null when:
 * - the type cannot be streamed through MediaSource at all, or
 * - the sourceopen / updateend handshake failed or timed out, or
 * - a chunk read failed or timed out, or
 * - a SourceBuffer `error` fired, or
 * - the signal was aborted.
 *
 * The caller is expected to fall back to a whole-file Blob (bounded)
 * when this resolves null — EXCEPT after a "read" failure, which the
 * caller must treat as terminal. `onFailureKind` reports which of
 * these happened, exactly once.
 *
 * Every asynchronous edge has an explicit deadline AND an explicit
 * settlement gate, so this promise always settles exactly once and can
 * never hang — including when a SourceBuffer error or an abort arrives
 * while the stream is parked on an `updateend` wait.
 */
export async function emergencyMediaSourceStream(args: {
  session: MediaSession;
  mimeType: string;
  size: number;
  signal: AbortSignal;
  onError: () => void;
  /**
   * Optional: reports WHY no object URL was produced. Never called on
   * success or on a plain abort.
   */
  onFailureKind?: (kind: EmergencyMediaFailureKind) => void;
}): Promise<string | null> {
  const streamableMime =
    resolveStreamableMimeType(args.mimeType);

  const reportFailure = (
    kind: EmergencyMediaFailureKind,
  ): void => {
    try {
      args.onFailureKind?.(kind);
    } catch {
      // Reporting must never mask the terminal outcome.
    }
  };

  if (streamableMime === null) {
    reportFailure("not-streamable");
    return null;
  }

  if (args.signal.aborted) {
    return null;
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  let ok = false;
  let sourceBuffer: SourceBuffer | null = null;
  let sourceBufferErrorHandler: (() => void) | null = null;

  const cleanup = () => {
    try {
      if (mediaSource.readyState === "open") {
        mediaSource.endOfStream();
      }
    } catch {
      // preserve current state on terminal errors
    }
  };

  /**
   * The manual SourceBuffer `error` listener is attached below and
   * MUST be removed on every outcome — success, error, timeout, abort,
   * or disposal. Otherwise a settled attempt keeps the listener (and
   * its closure over `objectUrl`) alive for the whole lifetime of the
   * SourceBuffer.
   */
  const detachSourceBufferError = (): void => {
    if (!sourceBuffer || !sourceBufferErrorHandler) return;
    try {
      sourceBuffer.removeEventListener(
        "error",
        sourceBufferErrorHandler,
      );
    } catch {
      // best-effort
    }
    sourceBufferErrorHandler = null;
  };

  /**
   * Explicit settlement gate.
   *
   * The streaming body is an async routine that parks on `awaitEvent`
   * waits; without a gate, a SourceBuffer `error` (or an abort) that
   * arrives while the body is parked on `updateend` could only be
   * observed after that wait's 20 s timeout. The gate lets those
   * out-of-band signals settle the promise IMMEDIATELY.
   */
  const outcome = await new Promise<string | null>((resolve) => {

    let settled = false;
    let abortHandler: (() => void) | null = null;

    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      detachSourceBufferError();
      if (abortHandler) {
        try {
          args.signal.removeEventListener("abort", abortHandler);
        } catch {
          // best-effort
        }
        abortHandler = null;
      }
      if (!ok) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          // best-effort
        }
      }
      resolve(value);
    };

    const fail = (kind: EmergencyMediaFailureKind): void => {
      if (settled) return;
      cleanup();
      reportFailure(kind);
      args.onError();
      settle(null);
    };

    /** Abort is not a failure — it is reported as a plain null. */
    const abort = (): void => {
      if (settled) return;
      cleanup();
      settle(null);
    };

    abortHandler = abort;
    args.signal.addEventListener("abort", abortHandler, { once: true });

    // The SourceBuffer `error` handler settles immediately via fail().
    sourceBufferErrorHandler = () => {
      fail("mse");
    };

    void (async () => {
      try {
        await awaitEvent(
          mediaSource,
          "sourceopen",
          MEDIA_SOURCE_OPEN_TIMEOUT_MS,
          "MediaSource sourceopen",
        );
      } catch {
        fail("mse");
        return;
      }

      if (settled) return;
      if (args.signal.aborted) {
        abort();
        return;
      }

      try {
        sourceBuffer =
          mediaSource.addSourceBuffer(streamableMime);
      } catch {
        fail("mse");
        return;
      }

      sourceBuffer.addEventListener(
        "error",
        sourceBufferErrorHandler,
      );

      let offset = 0;
      const chunkSize = 256 * 1024;

      while (!settled && !args.signal.aborted && offset < args.size) {
        const end = Math.min(offset + chunkSize, args.size);

        let bytes: Uint8Array<ArrayBuffer>;

        try {
          // CONFIRMED DEFECT FIX: a chunk read that never settles
          // must not hang the stream. Bound it so a stalled
          // fetch/decrypt rejects and the caller reaches a terminal
          // state.
          //
          // NOTE: MediaSession.read() cannot be cancelled, so a late
          // resolution of this read is simply discarded — it never
          // touches the (possibly already released) MediaSource.
          bytes = await withTimeout(
            args.session.read(offset, end),
            MEDIA_READ_TIMEOUT_MS,
            "media chunk read",
          );
        } catch {
          fail("read");
          return;
        }

        if (settled) return;
        if (args.signal.aborted) {
          abort();
          return;
        }

        try {
          sourceBuffer.appendBuffer(bytes);
        } catch {
          fail("mse");
          return;
        }

        offset = end;

        // Drive progress off updateend, but never wait forever.
        try {
          await awaitEvent(
            sourceBuffer,
            "updateend",
            MEDIA_APPEND_TIMEOUT_MS,
            "MediaSource updateend",
          );
        } catch {
          fail("mse");
          return;
        }
      }

      if (settled) return;
      if (args.signal.aborted) {
        abort();
        return;
      }

      if (mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          // already closed / closing
        }
      }

      ok = true;
      settle(objectUrl);
    })();

  });

  return outcome;
}
