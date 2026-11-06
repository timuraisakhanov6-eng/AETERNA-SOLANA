import { useState, useEffect, useRef, useCallback, useMemo } from "react";

import { Play } from "lucide-react";

import type {
  Vault,
  VaultV1,
  VaultV2,
  CapsuleItemV1,
  CapsuleItemV2,
  MediaItemV2,
  PublishedChunkMetadata,
} from "@/types/vault";

import {
  openImage,
  openVideo,
  openAudio,
  downloadFile,
} from "@/lib/capsule/open/openRuntime";

import { LetterCard } from "./LetterCard";

import { ImageViewer } from "@/components/capsule/ImageViewer";

import { Button } from "@/components/ui/button";

import type {
  MediaSession,
  OpenableMediaItem,
  OpenMediaRequest,
  OpenImageResult,
} from "@/lib/capsule/open/openTypes";

import {
  resolveStreamableMimeType,
  MediaNotStreamableError,
  isMediaNotStreamableError,
} from "@/lib/capsule/open/mediaCompatibility";

import {
  assertInlinePreviewSize,
  MediaPreviewConstructionError,
} from "@/lib/capsule/open/mediaPreviewPolicy";

import {
  classifyMediaFailure,
  type MediaOpenDiagnosticContext,
  type MediaFailureDiagnosis,
} from "@/lib/capsule/open/mediaFailureDiagnostics";

import {
  awaitEvent,
  BoundedAwaitTimeoutError,
} from "@/lib/capsule/open/boundedAwait";

import {
  retainContainerWindowStream,
} from "@/lib/storage/container/containerWindowStream";

import { isStorageRangeError } from "@/lib/storage/storageRangeFailure";

/**
 * Upper bound for a single bounded media handshake (sourceopen /
 * updateend / whole-file fallback read). Chosen generously so it only
 * fires on a genuinely wedged MediaSource pipeline, never on a
 * slow-but-working device, while still converting "forever" into a
 * terminal error the UI can render.
 */
const MEDIA_SOURCE_OPEN_TIMEOUT_MS = 20_000;
const MEDIA_APPEND_TIMEOUT_MS = 20_000;

/**
 * R9-A87.7 (F3) — PROGRESS-AWARE READ BUDGET.
 *
 * The old wrapper gave EVERY read a flat 30 s. That bound is simultaneously too
 * short and too long, depending on what the read actually has to move:
 *
 *   - a 206 answer transfers exactly `length` bytes;
 *   - a 200 answer (the gateway ignored `Range`) must stream and DISCARD every
 *     byte before `offset` first, so its honest cost is `offset + length`.
 *
 * A late window of the real 22.47 MiB container therefore needs ~46 s at
 * 0.5 MiB/s and could never finish inside 30 s. The budget below is derived
 * from the ABSOLUTE END position of the request — the honest HTTP-200 cost —
 * with the old 30 s kept as the FLOOR (so a cheap read behaves exactly as
 * before) and a finite 130 s CEILING.
 *
 * The ceiling sits above the reader's own 120 s hard ceiling and above the
 * storage layer's progress-aware deadline, so the storage layer always wins the
 * race and its typed `StorageRangeError` (`range-timeout`) reaches the
 * diagnostic layer instead of being replaced by a generic caller abort.
 *
 * Honest limit, documented rather than hidden: a late window of a 100 MiB
 * container needs ~200 s at 0.5 MiB/s and CANNOT be guaranteed under a 130 s
 * ceiling. It fails closed with a typed timeout; it never hangs.
 */
const MEDIA_READ_TIMEOUT_MS = 30_000;
const MEDIA_READ_CEILING_MS = 130_000;
const MEDIA_READ_SETUP_MS = 1_500;
const MEDIA_READ_MIN_BYTES_PER_SEC = 512 * 1024;
/**
 * Deliberate head start for the storage layer's own deadline.
 *
 * Both clocks measure the same transfer with the same formula, so without this
 * they would expire at the same instant and the OUTER wrapper could win the
 * race — replacing the storage layer's typed `StorageRangeError` with a
 * generic caller timeout. The grace guarantees the typed failure is the one
 * the diagnostic layer sees.
 */
const MEDIA_READ_GRACE_MS = 5_000;

/**
 * Budget for ONE media read, given the absolute end byte of the range:
 *
 *   `clamp(30 s, 1.5 s + end / 0.5 MiB/s + 5 s, 130 s)`
 *
 * Mirrors the storage layer's own formula plus the grace, so the two clocks
 * cannot disagree about what "too slow" means for the same window while the
 * storage layer always classifies the failure first.
 */
function mediaReadBudgetMs(absoluteEnd: number): number {

  if (!Number.isFinite(absoluteEnd) || absoluteEnd <= 0) {
    return MEDIA_READ_TIMEOUT_MS;
  }

  const transferMs = Math.ceil(
    (absoluteEnd / MEDIA_READ_MIN_BYTES_PER_SEC) * 1000,
  );

  return Math.min(
    MEDIA_READ_CEILING_MS,
    Math.max(
      MEDIA_READ_TIMEOUT_MS,
      MEDIA_READ_SETUP_MS + transferMs + MEDIA_READ_GRACE_MS,
    ),
  );
}

/**
 * Runs one read under a budget, with REAL cancellation.
 *
 * Two properties matter, and the old `withTimeout` had neither:
 *
 *   1. when the budget expires the signal is ABORTED, so the storage layer
 *      cancels its fetch/stream instead of running on for up to 120 s;
 *   2. the caller is released by the DEADLINE, not by the callee's good
 *      behaviour — a read that ignores its signal cannot hang the UI.
 */
async function readWithBudget<T>(
  label: string,
  budgetMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {

  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | null = null;

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Abort FIRST: losing the race must still tear the transport down.
      try {
        controller.abort();
      } catch {
        /* best-effort */
      }
      reject(new BoundedAwaitTimeoutError(label, budgetMs));
    }, budgetMs);
  });

  const running = operation(controller.signal);

  /**
   * A read that loses the race may still reject later (its abort surfaces as
   * a storage error). That rejection is expected and must never be reported as
   * an unhandled rejection.
   */
  void running.catch(() => undefined);

  try {

    return await Promise.race([running, expired]);

  } catch (err) {

    /**
     * R9-A87.7 (F3) - the storage layer reports its own typed failure first
     * (its deadline is strictly shorter than this budget); that diagnostic is
     * preserved verbatim. Only a read that produced NO typed failure of its
     * own is reported as a timeout — so a cancellation is never disguised as a
     * data defect, and a data defect is never disguised as a timeout.
     */
    if (err instanceof BoundedAwaitTimeoutError) throw err;

    if (controller.signal.aborted && !isStorageRangeError(err)) {
      throw new BoundedAwaitTimeoutError(label, budgetMs);
    }

    throw err;

  } finally {

    if (timer) clearTimeout(timer);

  }
}

/** One bounded, cancellable media-window read. */
function readWithCeiling(
  session: MediaSession,
  start: number,
  end: number,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return readWithBudget(
    label,
    mediaReadBudgetMs(end),
    (signal) => session.read(start, end, signal),
  );
}

/**
 * R9-A87.7 (F3) - the same bounded, cancellable read for the IMAGE path.
 *
 * An image preview materialises the whole file, so it is the read most likely
 * to exceed a fixed budget; wrapping `openImage()` in `withTimeout` left that
 * read running after the caller had already given up. Here the budget aborts
 * the signal that reaches `runtime.getBytes`, so the storage read is torn down
 * with the preview.
 */
function openImageWithCeiling(
  request: OpenMediaRequest,
): Promise<OpenImageResult> {
  return readWithBudget(
    "image preview",
    mediaReadBudgetMs(request.media.size),
    (signal) => openImage(request, signal),
  );
}

/**
 * Maximum whole-file fallback size for a NON-streamable media item.
 *
 * A bare `video/webm` (or any type MSE cannot demux) is otherwise
 * unreachable on the primary path. Rather than leave the UI in an
 * infinite Loading state, the primary path may fall back to a
 * single Blob — but ONLY for files at or below this bound, so a
 * large unsupported file never gets materialised into one buffer.
 * Above the bound the caller shows a terminal error instead.
 *
 * This preserves the bounded-memory architecture: ByteRuntime stays
 * lazy, the LRU cache bounds are unchanged, and only small items
 * (which are already held transiently) are ever assembled whole.
 */
const MAX_MEDIA_FALLBACK_BYTES = 25 * 1024 * 1024;

export async function sessionToObjectUrl(
  session: MediaSession,
  size: number,
  mimeType: string,
): Promise<string> {

  try {

    // Size gate FIRST: this helper materialises the whole file in
    // memory, so an oversized item is refused before any read.
    assertInlinePreviewSize(size, "Image");

    // Bounded read: a stalled read must reach a terminal error
    // instead of hanging the caller — and the ceiling ABORTS the read
    // rather than abandoning it.
    const bytes = await readWithCeiling(
      session,
      0,
      size,
      "media object url read",
    );

    const blob = new Blob(
      [bytes],
      { type: mimeType },
    );

    return URL.createObjectURL(blob);

  } finally {

    session.dispose();

  }

}

/**
 * Streams a MediaSession into a browser-native file download
 * without assembling the full decrypted file in JS memory.
 *
 * Uses the File System Access API when available.
 */
export async function sessionToDownloadStream(
  session: MediaSession,
  size: number,
  mimeType: string,
  filename?: string,
): Promise<void> {

  const safeName =
    typeof filename === "string" &&
    filename.trim().length > 0
      ? filename.trim()
      : "download.bin";

  try {

    if (
      typeof window !== "undefined" &&
      "showSaveFilePicker" in window &&
      typeof (window as Window).showSaveFilePicker === "function"
    ) {

      try {

        const saveFilePicker =
          (window as Window).showSaveFilePicker;

        if (typeof saveFilePicker !== "function") {
          return;
        }

        const handle =
          await saveFilePicker({
            suggestedName: safeName,
            types: [
              {
                description: "AETERNA capsule file",
                accept: {
                  [mimeType]: [safeName],
                },
              },
            ],
          });

        const writable =
          await handle.createWritable();

        try {

          let offset = 0;
          const chunkSize = 256 * 1024;

          while (offset < size) {

            const end =
              Math.min(
                offset + chunkSize,
                size,
              );

            // Bounded chunk read: a stalled read must terminate the
            // download rather than hang it.
            const bytes =
              await readWithCeiling(
                session,
                offset,
                end,
                "media download chunk read",
              );

            await writable.write(bytes);
            offset = end;
          }

          await writable.close();

        } catch (err) {

          try {
            await writable.abort();
          } catch {
            // best-effort abort
          }

          throw err;

        }

        return;

      } catch (err) {

        if (
          err instanceof Error &&
          (err.name === "AbortError" ||
            err.message.includes("user"))
        ) {
          // User cancelled picker; exit silently.
          return;
        }

        // Fall through to bounded fallback.
      }

    }

    // Bounded fallback for unsupported browsers.
    const maxFallbackBytes = 256 * 1024;

    if (typeof document === "undefined" || size > maxFallbackBytes) {
      throw new Error(
        `[AETERNA] Streaming download unavailable for ${size} bytes. ` +
          "Use a Chromium-based browser with File System Access API.",
      );
    }

    // Bounded read for the small-file fallback.
    const bytes =
      await readWithCeiling(
        session,
        0,
        size,
        "media download fallback read",
      );

    const blob =
      new Blob(
        [bytes],
        { type: mimeType },
      );

    const objectUrl =
      URL.createObjectURL(blob);

    const anchor =
      document.createElement("a");

    anchor.href = objectUrl;
    anchor.download = safeName;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(objectUrl);

  } finally {

    session.dispose();

  }

}

export async function sessionToMediaSource(
  session: MediaSession,
  mimeType: string,
  size: number,
  signal?: AbortSignal,
  attachTo?: HTMLMediaElement | null,
): Promise<string> {

  /**
   * Resolve the concrete MSE mime type. Legacy bare `video/webm` (and
   * bare `video/mp4`) are expanded through a bounded capability probe,
   * because MediaSource rejects the bare container form even though
   * MediaRecorder accepts it. See mediaCompatibility.ts.
   */
  const streamableMime =
    resolveStreamableMimeType(mimeType);

  if (streamableMime === null) {
    // Capability rejection: the browser has no MediaSource candidate
    // for the stored type. Tagged with the typed `capability` stage so
    // the terminal classifier can report it without message parsing.
    throw new MediaNotStreamableError(mimeType, undefined, "capability");
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  /**
   * ATTACH BEFORE AWAITING `sourceopen`.
   *
   * A MediaSource transitions to "open" — and fires `sourceopen` — only
   * once its object URL is assigned to a media element. Awaiting the
   * event first could therefore NEVER succeed: the caller cannot hand
   * the URL to an element that is rendered only after this function
   * resolves. That circular dependency made every progressive playback
   * burn the full open-timeout and fall back to a whole-file Blob.
   *
   * `attachTo` is the already-mounted element owned by the caller, so
   * the handshake runs in the correct order: create → attach → await.
   */
  const attachedTo =
    attachTo === undefined || attachTo === null ? null : attachTo;

  const detachFromMedia = () => {
    if (!attachedTo) return;
    try {
      // Only release the element if it still points at OUR url — a
      // newer attempt may already own it.
      if (attachedTo.src === objectUrl) {
        attachedTo.removeAttribute("src");
        attachedTo.load();
      }
    } catch {
      // best-effort teardown
    }
  };

  if (attachedTo) {
    try {
      attachedTo.src = objectUrl;
    } catch {
      // A rejected assignment leaves the element un-attached; the
      // bounded open timeout below still terminates the attempt.
    }
  }

  const abortError = () =>
    new Error(
      "[AETERNA] MediaSource stream cancelled.",
    );

  /**
   * MSE-layer failure — the container/codec layer could not be driven
   * (addSourceBuffer rejected the type, the sourceopen/updateend
   * handshake stalled, or the SourceBuffer errored).
   *
   * Classified as MediaNotStreamableError so the caller MAY recover
   * through the bounded whole-file fallback. A READ failure is never
   * wrapped this way — it propagates unchanged, so it can never be
   * silently retried as a full-file download.
   */
  const mseError = (reason: string) =>
    new MediaNotStreamableError(mimeType, reason, "mse-setup");

  /**
   * Single settlement gate. The MediaSource handshake has several
   * asynchronous edges (sourceopen, each updateend, abort, dispose);
   * this guarantees the returned promise settles EXACTLY once with a
   * terminal outcome, so the caller can never be left waiting.
   */
  await new Promise<void>((resolve, reject) => {

    let settled = false;
    let sourceBuffer: SourceBuffer | null = null;
    let sourceBufferErrorHandler: (() => void) | null = null;

    /**
     * The manual SourceBuffer `error` listener must be removed on
     * EVERY outcome — success, error, timeout, abort — so a settled
     * attempt does not retain the listener (and its closure over
     * `objectUrl`) for the lifetime of the SourceBuffer.
     */
    const detachSourceBufferError = () => {
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

    const finishOk = () => {
      if (settled) return;
      settled = true;
      detachSourceBufferError();
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    };

    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      detachSourceBufferError();
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      // Release the media element BEFORE revoking, so it never holds a
      // dead object URL (a later attempt — or the Blob fallback — owns
      // the element's src from here on).
      detachFromMedia();
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // best-effort; the caller may already have released it
      }
      reject(err);
    };

    const onAbort = () => {
      finishErr(abortError());
    };

    if (signal) {
      if (signal.aborted) {
        finishErr(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Bound the sourceopen handshake: if it never fires, fail closed
    // rather than awaiting forever.
    awaitEvent(
      mediaSource,
      "sourceopen",
      MEDIA_SOURCE_OPEN_TIMEOUT_MS,
      "MediaSource sourceopen",
    ).then(
      async () => {

        if (settled) return;

        if (signal?.aborted) {
          finishErr(abortError());
          return;
        }

        let sb: SourceBuffer;

        try {
          sb =
            mediaSource.addSourceBuffer(
              streamableMime,
            );
        } catch (err) {
          // MSE layer — MediaSource rejected the type.
          finishErr(
            mseError(
              err instanceof Error
                ? err.message
                : "MediaSource addSourceBuffer failed.",
            ),
          );
          return;
        }

        sourceBuffer = sb;

        let offset = 0;
        const chunkSize = 256 * 1024;

        const appendNext = async (): Promise<void> => {

          if (settled || signal?.aborted) {
            return;
          }

          if (offset >= size) {
            if (mediaSource.readyState === "open") {
              try {
                mediaSource.endOfStream();
              } catch {
                // endOfStream can throw if already ended;
                // retain current state.
              }
            }
            finishOk();
            return;
          }

          const end =
            Math.min(
              offset + chunkSize,
              size,
            );

          let bytes: Uint8Array<ArrayBuffer>;

          try {

            // CONFIRMED DEFECT FIX (regression test #1): a chunk read
            // that never settles must not hang the whole stream and
            // leave the UI on "Loading" forever. Bound it so a stalled
            // fetch/decrypt rejects and the promise settles to a
            // terminal error.
            bytes =
              await readWithCeiling(
                session,
                offset,
                end,
                "media chunk read",
              );

          } catch (err) {

            finishErr(err);
            return;

          }

          if (settled || signal?.aborted) {
            return;
          }

          try {

            sb.appendBuffer(
              bytes,
            );

          } catch (err) {

            // MSE layer — a container/codec rejection.
            finishErr(
              mseError(
                err instanceof Error
                  ? err.message
                  : "MediaSource appendBuffer failed.",
              ),
            );
            return;

          }

          offset = end;

          // The next append is driven by updateend. Bound that wait so
          // a stalled SourceBuffer cannot hang the stream forever.
          try {
            await awaitEvent(
              sb,
              "updateend",
              MEDIA_APPEND_TIMEOUT_MS,
              "MediaSource updateend",
            );
          } catch {
            // MSE layer — the pipeline stalled.
            finishErr(
              mseError("MediaSource updateend timed out."),
            );
            return;
          }

          void appendNext();

        };

        sourceBufferErrorHandler = () => {
          // MSE layer — SourceBuffer error event. The listener is
          // detached by finishErr().
          finishErr(
            mseError("MediaSource SourceBuffer error."),
          );
        };

        sb.addEventListener(
          "error",
          sourceBufferErrorHandler,
        );

        void appendNext();

      },
      () => {
        // MSE layer — sourceopen never arrived.
        finishErr(
          mseError("MediaSource sourceopen timed out."),
        );
      },
    );

  });

  return objectUrl;

}

/**
 * Bounded whole-file fallback for a media item that MediaSource cannot
 * stream (e.g. a legacy bare `video/webm`, or an exotic container).
 *
 * The bytes are assembled into ONE Blob only when `size` is within
 * MAX_MEDIA_FALLBACK_BYTES; above that bound the read is refused so a
 * large unsupported file is never materialised in memory. The read
 * itself is bounded by withTimeout so a stalled read cannot hang the
 * caller — a timeout rejects and the UI shows a terminal error.
 */
export async function sessionToBoundedBlobUrl(
  session: MediaSession,
  size: number,
  mimeType: string,
  signal?: AbortSignal,
): Promise<string> {

  if (
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    throw new Error(
      "[AETERNA] Invalid media size for fallback.",
    );
  }

  if (size > MAX_MEDIA_FALLBACK_BYTES) {
    throw new Error(
      `[AETERNA] Media too large for in-memory fallback (${size} bytes).`,
    );
  }

  if (signal?.aborted) {
    throw new Error(
      "[AETERNA] Media fallback cancelled.",
    );
  }

  // Bounded read. R9-A87.7: MediaSession.read() now takes an AbortSignal, so
  // the ceiling cancels the storage read instead of discarding a late
  // resolution; the `signal` check below remains for the caller's own signal.
  const bytes = await readWithCeiling(
    session,
    0,
    size,
    "media fallback read",
  );

  if (signal?.aborted) {
    throw new Error(
      "[AETERNA] Media fallback cancelled.",
    );
  }

  /**
   * The read has SUCCEEDED by this point. Building the Blob / object
   * URL is a distinct, typed boundary: a failure here is a
   * construction failure, never a read/network failure. The original
   * platform error is retained only as `cause` for local debugging
   * and is never rendered.
   */
  let blob: Blob;
  try {
    blob = new Blob(
      [bytes],
      { type: mimeType || "application/octet-stream" },
    );
    return URL.createObjectURL(blob);
  } catch (err) {
    throw new MediaPreviewConstructionError(err);
  }

}

/*
VaultRenderer — CANON production-safe renderer
AETERNA Technical Spec v1.0 compliant
*/

type Props = {
  vault: Vault;
  cryptoKey?: CryptoKey;

  /**
   * Stage 4.5 — container resolution indexed by logical chunkId.
   *
   * Present ONLY for a container capsule. When an entry exists for a chunk,
   * that chunk carries a DERIVED container position (offset/length inside
   * the ONE container DataItem) instead of a per-chunk pointer, so the
   * legacy pointer map is not consulted for it.
   *
   * null / undefined = no container publication (the legacy case).
   */
  containerChunks?:
    ReadonlyMap<
      string,
      PublishedChunkMetadata
    > | null | undefined;
};

export default function VaultRenderer({
  vault,
  cryptoKey,
  containerChunks,
}: Props) {

  if (
    !vault ||
    typeof vault !== "object" ||
    !("version" in vault)
  ) {
    return (
      <p className="text-sm text-muted-foreground">
        Empty capsule
      </p>
    );
  }

  switch (vault.version) {

    case 1:
      return <VaultV1Renderer vault={vault} />;

    case 2:

      if (!cryptoKey) {
        return (
          <p className="text-sm text-muted-foreground">
            Capsule media unavailable
          </p>
        );
      }

      return (
        <VaultV2Renderer
          vault={vault}
          cryptoKey={cryptoKey}
          containerChunks={containerChunks}
        />
      );

    default:
      return (
        <p className="text-sm text-muted-foreground">
          Unsupported vault version
        </p>
      );
  }

}


/* =========================
VERSION RENDERERS
========================= */


function VaultV1Renderer({
  vault,
}: {
  vault: VaultV1;
}) {

  const items =
    vault?.capsule?.items ?? [];

  if (!Array.isArray(items))
    return null;

  if (!items.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Capsule is empty
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {items.map((item, index) => (
        <div key={index}>
          {renderItemV1(item)}
        </div>
      ))}
    </div>
  );

}


function VaultV2Renderer({
  vault,
  cryptoKey,
  containerChunks,
}: {
  vault: VaultV2;
  cryptoKey: CryptoKey;
  containerChunks?:
    ReadonlyMap<
      string,
      PublishedChunkMetadata
    > | null | undefined;
}) {

  /**
   * R9-A86.2 — SINGLE-ACTIVE-VIDEO OWNERSHIP.
   *
   * `activeVideoIndex` is the ONE authority for which video item owns a
   * playback session. `null` means no video is active: every video renders
   * a lightweight card and owns no session, no ByteRuntime, no bytes and
   * no object URL. The state lives here (the parent), not in the blocks,
   * so two video items can never both believe they are active — selecting
   * one is what deactivates the other, in a single state commit.
   *
   * Declared before the fail-closed guards so the hook order is identical
   * on every render that reaches the hooks at all.
   */
  const [activeVideoIndex, setActiveVideoIndex] =
    useState<number | null>(null);

  const selectVideo = useCallback(
    (index: number) => {
      setActiveVideoIndex(index);
    },
    [],
  );

  /**
   * R9-A87.7 (F2) — CAPSULE-SCOPED STREAM TEARDOWN.
   *
   * The bounded window reader keeps ONE forward HTTP stream per container so
   * ascending windows can reuse it. That stream must not outlive the capsule.
   * Disposing here — at the component that owns media rendering, and keyed by
   * the CONTAINER identity — is capsule-scoped: a different capsule's stream is
   * unaffected, and unmounting a single media item never runs this.
   */
  const containerTxId = useMemo(() => {
    if (!containerChunks) return null;
    for (const entry of containerChunks.values()) {
      const id = entry.container?.containerTxId;
      if (id) return String(id);
    }
    return null;
  }, [containerChunks]);

  useEffect(() => {
    if (!containerTxId) return;

    /**
     * R9-A87.7 (F2) - a LEASE, not a hard close.
     *
     * The stream belongs to the capsule, and several media readers inside it
     * share that stream. Releasing here therefore only decrements the capsule's
     * reference; the reader is closed when the LAST owner goes away. That keeps
     * a route transition or a React StrictMode remount from destroying a stream
     * it is about to reuse, and it never lets one child reader's teardown kill
     * another child's live stream.
     */
    return retainContainerWindowStream(containerTxId);
  }, [containerTxId]);

  const items =
    vault?.capsule?.items ?? [];

  const capsuleId =
    vault?.capsule?.capsuleId;

  // REQUIRED FIX #3 — fail-closed capsuleId enforcement
  if (!capsuleId) {
    throw new Error(
      "[AETERNA] capsuleId missing in vault"
    );
  }

  if (!Array.isArray(items))
    return null;

  if (!items.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Capsule is empty
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {items.map((item, index) => (
        <div key={index}>
          {renderItemV2(
            item,
            cryptoKey,
            capsuleId,
            containerChunks,
            {
              index,
              activeIndex: activeVideoIndex,
              onSelect: selectVideo,
            }
          )}
        </div>
      ))}
    </div>
  );

}


/* =========================
ITEM RENDERING
========================= */


function renderItemV1(
  item: CapsuleItemV1
) {

  if (!item)
    return null;

  switch (item.type) {

    case "text":
      return (
        <TextBlock
          content={item.text}
        />
      );

    case "media":
      return (
        <MediaBlock
          mediaType={item.mediaType}
          src={item.data}
          filename={sanitizeFilename(
            item.filename
          )}
        />
      );

    default:
      // Unknown item types are silently dropped.
      // Canonical renderer law: render only validated structures.
      // No JSON dump — unknown payloads must never reach presentation.
      return null;
  }

}


function renderItemV2(
  item: CapsuleItemV2,
  cryptoKey: CryptoKey,
  capsuleId: string,
  containerChunks?:
    ReadonlyMap<
      string,
      PublishedChunkMetadata
    > | null,
  videoControl?: {
    index: number;
    activeIndex: number | null;
    onSelect: (index: number) => void;
  } | undefined,
) {

  if (!item)
    return null;

  switch (item.type) {

    case "text":
      return (
        <TextBlock
          content={item.text}
        />
      );

    case "media":
      return (
        <MediaItemV2Block
          item={item}
          cryptoKey={cryptoKey}
          capsuleId={capsuleId}
          containerChunks={containerChunks}
          videoControl={videoControl}
        />
      );

    default:
      // Unknown item types are silently dropped.
      // Canonical renderer law: render only validated structures.
      // No JSON dump — unknown payloads must never reach presentation.
      return null;
  }

}


/* =========================
MEDIA V2 BLOCK
========================= */


function MediaItemV2Block({
  item,
  cryptoKey,
  capsuleId,
  containerChunks,
  videoControl,
}: {
  item: MediaItemV2;
  cryptoKey: CryptoKey;
  capsuleId: string;
  containerChunks?:
    ReadonlyMap<
      string,
      PublishedChunkMetadata
    > | null | undefined;
  /**
   * R9-A86.2 — parent-owned single-active-video control. Supplied for
   * every media item by `renderItemV2`; only `video` items act on it.
   * Audio, image and file items keep their pre-existing mount-time
   * behaviour untouched.
   */
  videoControl?: {
    index: number;
    activeIndex: number | null;
    onSelect: (index: number) => void;
  } | undefined;
}) {

  const isVideo =
    item.mediaType === "video";

  /**
   * R9-A86.2 — a video item is ACTIVE only when the parent's single
   * authority says so, and a video whose control is somehow MISSING can
   * never self-activate (fail closed). Non-video types are always active,
   * which reproduces their original mount-time pipeline exactly.
   */
  const active = isVideo
    ? videoControl !== undefined &&
      videoControl.activeIndex === videoControl.index
    : true;

  /** Activate THIS item as the single active video. */
  const activateVideo = useCallback(() => {
    videoControl?.onSelect(videoControl.index);
  }, [videoControl]);

  /**
   * R9-A86.2 — explicit retry. Bumped ONLY by the Retry control on the
   * terminal error surface of an active video; including it in the load
   * effect's dependencies re-runs the attempt through the exact same
   * generation/cleanup machinery as any other rerun.
   */
  const [retryNonce, setRetryNonce] =
    useState(0);

  const retryLoad = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  const [objectUrl, setObjectUrl] =
    useState<string | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(false);

  /**
   * Optional, human-readable reason for a terminal failure. Used for
   * outcomes the generic "Failed to load preview" cannot explain —
   * notably an item refused by the inline-preview size policy.
   */
  const [notice, setNotice] =
    useState<string | null>(null);

  /**
   * Fixed, safe label naming WHY the bounded Blob fallback was entered,
   * set ONLY when a fallback was attempted AND failed (i.e. the
   * diagnosis carries a known trigger). Rendered as a distinct line so
   * the visible error card pinpoints both the final failure stage and
   * the fallback reason. Never a raw exception message, MIME string,
   * identifier or URL; dropped whenever there is no fallback.
   */
  const [fallbackTriggerNotice, setFallbackTriggerNotice] =
    useState<string | null>(null);

  /**
   * The signature of the attempt that currently OWNS the UI.
   *
   * When null, no attempt is authoritative and a new one may start —
   * including a repeat of a signature seen before. A failed or
   * cancelled attempt resets this to null (below) so a later
   * same-signature retry is not permanently suppressed.
   */
  const startedSignatureRef =
    useRef<string | null>(null);

  /**
   * Attempt generation. Every started attempt takes a fresh, strictly
   * increasing id. A stale attempt (one whose generation no longer
   * matches `generationRef.current`) MUST NOT write any state — this
   * is what prevents an old cancelled/failed load from clobbering a
   * newer attempt's UI.
   */
  const generationRef =
    useRef(0);

  const abortRef =
    useRef<(() => void) | null>(null);

  const mediaSessionRef =
    useRef<MediaSession | null>(null);

  /**
   * The A/V element that owns the MediaSource.
   *
   * It MUST already be mounted when `sessionToMediaSource` runs: a
   * MediaSource only becomes "open" — and only then fires `sourceopen`
   * — once its object URL is assigned to a media element. The element
   * is therefore rendered for the WHOLE lifetime of an A/V item, so
   * the handshake order is create → attach → await.
   *
   * A stable callback ref keeps the same element across the
   * loading → loaded render (a fresh callback identity would make
   * React detach/reattach the ref on every render).
   */
  const mediaElRef =
    useRef<HTMLMediaElement | null>(null);

  const setMediaEl = useCallback(
    (el: HTMLMediaElement | null) => {
      mediaElRef.current = el;
    },
    [],
  );

  /** Idempotent, safe dispose of the current media session. */
  const safeDisposeSession = () => {
    const session = mediaSessionRef.current;
    mediaSessionRef.current = null;
    if (!session) return;
    try {
      session.dispose();
    } catch {
      // A throwing dispose() must never suppress a terminal state.
    }
  };

  /**
   * R9-A85.2 — explicit download state for a `file` attachment.
   *
   * idle   → the control is available;
   * busy   → one download is in flight (further clicks are ignored, so a
   *          double click cannot start two);
   * failed → the last attempt failed and the control offers a retry.
   */
  const [fileDownload, setFileDownload] =
    useState<"idle" | "busy" | "failed">("idle");

  /**
   * Re-entrancy guard. State alone cannot carry this: two clicks dispatched in
   * the same tick would both read the old value before React re-renders.
   */
  const fileDownloadBusyRef =
    useRef(false);

  /**
   * Download an attachment ONLY because the user asked for it.
   *
   * The session is opened here and disposed in this function's own `finally`,
   * deliberately NOT through `mediaSessionRef`: an unmount, a dependency
   * change or a re-render must never be able to abort a download the user
   * started, and equally must never keep one alive by accident.
   */
  const onDownloadFile = useCallback(
    async () => {

      if (fileDownloadBusyRef.current) return;

      fileDownloadBusyRef.current = true;

      setFileDownload("busy");

      let session: MediaSession | null = null;

      try {

        const media: OpenableMediaItem =
          resolveOpenableMedia(item, containerChunks);

        session = await downloadFile({
          capsuleId,
          cryptoKey,
          media,
        });

        await sessionToDownloadStream(
          session,
          media.size,
          media.mimeType,
          media.filename,
        );

        setFileDownload("idle");

      } catch {

        setFileDownload("failed");

      } finally {

        /**
         * `sessionToDownloadStream` disposes the session in its own `finally`;
         * this is a backstop so a failure between opening and streaming can
         * never leak one. A throwing dispose() must not mask the outcome.
         */
        try {
          session?.dispose();
        } catch {
          // ignored by design
        }

        fileDownloadBusyRef.current = false;

      }

    },
    [capsuleId, cryptoKey, item, containerChunks],
  );

  useEffect(() => {

    /**
     * R9-A85.2 — RENDERING NEVER DOWNLOADS AN ATTACHMENT.
     *
     * A `file` item has no inline preview, and the previous implementation
     * answered that by streaming the whole decrypted file to disk from this
     * effect — so opening or refreshing a capsule produced a download every
     * time. Nothing is opened, read or written here now: the card renders
     * metadata, and the bytes are fetched only by the explicit control, which
     * owns and disposes its own session.
     */
    if (item.mediaType === "file") return;

    /**
     * R9-A86.2 — LAZY VIDEO INITIALIZATION.
     *
     * A video that is not the single active video must never open a
     * session, read bytes, or create any media object. Reaching this body
     * with `active === false` means the PREVIOUS run's cleanup (below) has
     * already aborted the attempt, disposed the session and revoked its
     * URL — React runs every effect destroy before any effect create in a
     * commit, so the previous owner is disposed BEFORE any newly selected
     * video starts. The generation bump here additionally invalidates any
     * still-in-flight async work of a deactivated attempt, so a stale
     * initialization can never write state or reactivate a disposed
     * player after a newer selection.
     *
     * Audio keeps its mount-time pipeline: `active` is always true for
     * non-video types, so this branch is unreachable for them.
     */
    if (item.mediaType === "video" && !active) {
      generationRef.current += 1;
      startedSignatureRef.current = null;
      return;
    }

    const chunks =
      item.chunks ?? [];

    const signature =
      `${containerChunks ? "container" : "legacy"}:` +
      JSON.stringify(chunks);

    if (
      startedSignatureRef.current ===
      signature
    ) return;

    startedSignatureRef.current =
      signature;

    const generation =
      ++generationRef.current;

    // Only the current generation may mutate UI state.
    const isCurrent = () =>
      generationRef.current === generation;

    // Reset UI state before starting a new load. Without this,
    // a stale objectUrl/loading/error from the previous item
    // remains on screen until the new load settles — including
    // through a failure path, which would leave a now-invalid
    // objectUrl displayed as if it were still current.
    setLoading(true);
    setError(false);
    setNotice(null);
    setFallbackTriggerNotice(null);
    setObjectUrl(null);

    let createdUrl: string | null =
      null;

    /**
     * In-memory-only diagnostic context for THIS attempt.
     *
     * `openStreamableOrFallback` records here WHY it entered the
     * bounded Blob fallback, so a fallback failure can report the
     * trigger alongside the final cause. `mediaType` lets the
     * classifier avoid mislabelling an image/file failure as an MSE
     * failure. Never persisted, never transmitted; it dies with this
     * effect invocation.
     */
    const diagnostics: MediaOpenDiagnosticContext = {
      mediaType: item.mediaType,
    };

    /**
     * Terminal-state writers. Each guards on generation so a stale
     * attempt cannot overwrite a newer attempt's state, and are
     * idempotent within a generation.
     */
    const settleLoaded = (url: string) => {
      if (!isCurrent()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // best-effort
        }
        return;
      }
      createdUrl = url;
      setObjectUrl(url);
      setLoading(false);
    };

    const settleError = (
      reason?: string,
      fallbackTrigger?: string,
    ) => {
      // Release any partially-created URL for THIS attempt.
      if (createdUrl) {
        try {
          URL.revokeObjectURL(createdUrl);
        } catch {
          // best-effort
        }
        createdUrl = null;
      }
      // Allow a future same-signature retry (e.g. user retry, or a
      // re-mount) — the failure is terminal for THIS attempt only.
      if (startedSignatureRef.current === signature) {
        startedSignatureRef.current = null;
      }
      if (!isCurrent()) return;
      setError(true);
      setNotice(reason ?? null);
      // Present only when the failure happened INSIDE the fallback and
      // the trigger is genuinely known; otherwise it stays absent.
      setFallbackTriggerNotice(fallbackTrigger ?? null);
      setLoading(false);
      setObjectUrl(null);
    };


    async function load() {

      try {

        /**
         * Stage 4.5 — CONTAINER items resolve through the DERIVED layout.
         *
         * When the capsule has a container publication, the container
         * resolution for this media item already carries every logical
         * chunk's `pointer` (= the ONE container txId), `offset`, `length`
         * and LOCAL index — derived from the canonical Vault metadata by
         * `resolveContainerChunks`, never loaded from storage.
         *
         * The legacy pointer-map path is untouched for items that have no
         * container entry, so a legacy capsule behaves exactly as before.
         */
        const media: OpenableMediaItem =
          resolveOpenableMedia(item, containerChunks);

        const request = {
          capsuleId,
          cryptoKey,
          media,
        };

        let url: string | null = null;

        switch (media.mediaType) {

          case "image": {

            // Bounded open: a stalled image read must reach a terminal
            // state instead of leaving the UI on "Loading" forever.
            const result =
              await openImageWithCeiling(request);

            url = result.objectUrl;

            break;

          }

          case "video": {

            const session =
              await openVideo(request);

            // A newer attempt may already own the UI by now.
            if (!isCurrent()) {
              try {
                session.dispose();
              } catch {
                // best-effort
              }
              return;
            }

            mediaSessionRef.current =
              session;

            const controller =
              new AbortController();

            abortRef.current = () =>
              controller.abort();

            url = await openStreamableOrFallback(
              session,
              media,
              controller.signal,
              mediaElRef.current,
              diagnostics,
            );

            break;

          }

          case "audio": {

            const session =
              await openAudio(request);

            if (!isCurrent()) {
              try {
                session.dispose();
              } catch {
                // best-effort
              }
              return;
            }

            mediaSessionRef.current =
              session;

            const controller =
              new AbortController();

            abortRef.current = () =>
              controller.abort();

            url = await openStreamableOrFallback(
              session,
              media,
              controller.signal,
              mediaElRef.current,
              diagnostics,
            );

            break;

          }

          case "file": {

            /**
             * Unreachable: `file` items return before any session is opened
             * (see the top of this effect). Kept so the switch stays total and
             * a future edit cannot silently fall through to `default`, which
             * throws for an unsupported type.
             */
            break;

          }

          default: {

            throw new Error(
              `[AETERNA] Unsupported media type: ${media.mediaType}`,
            );

          }

        }

        /**
         * Terminal reconciliation. A cancelled/stale attempt writes
         * nothing; the current attempt settles to loaded or error.
         * The `file` branch intentionally leaves `url`null (a download
         * was already triggered) → ErrorBlock-style terminal surface.
         */
        if (url) {
          settleLoaded(url);
        } else {
          settleError();
        }

      }

      catch (err) {

        if (import.meta.env.DEV) {
          console.error(
            "[AETERNA MEDIA LOAD ERROR]",
            err,
          );
        }

        safeDisposeSession();

        // Always reach a terminal state for the CURRENT attempt, even
        // if dispose() threw above (it is guarded) or the failure was
        // in a stale attempt (guarded by generation inside settleError).
        //
        // Every terminal media failure is classified into a stable,
        // non-sensitive diagnostic code so a screenshot can be narrowed
        // to a stage. The classifier never renders raw exception text,
        // MIME strings, identifiers or URL fragments, and the
        // oversized-preview case keeps its exact pre-existing message.
        //
        // When the failure happened INSIDE the bounded Blob fallback the
        // diagnosis also carries a fixed, safe label naming WHY the
        // fallback was entered; it is forwarded so the card shows the
        // trigger (null/undefined when no fallback was attempted).
        const diagnosis: MediaFailureDiagnosis =
          classifyMediaFailure(err, diagnostics);
        settleError(
          diagnosis.message,
          diagnosis.fallbackTriggerLabel,
        );

      }

    }

    load();


    return () => {

      /**
       * Cancellation. We do NOT write UI state here: on unmount the
       * component is gone, and on a dependency change the NEXT effect
       * run owns the UI (and will set loading=true itself). Writing
       * state here is exactly what previously left a permanent
       * `Loading` when cleanup raced an in-flight load.
       *
       * We do release THIS attempt's resources: session, abort,
       * object URL.
       */
      abortRef.current?.();
      abortRef.current = null;

      safeDisposeSession();

      if (createdUrl) {
        try {
          URL.revokeObjectURL(createdUrl);
        } catch {
          // best-effort
        }
        createdUrl = null;
      }

      /**
       * Clear the signature claim so a subsequent mount/effect with the
       * SAME signature is allowed to start a fresh attempt. Without
       * this, a cancelled attempt could permanently suppress a retry.
       */
      if (startedSignatureRef.current === signature) {
        startedSignatureRef.current = null;
      }

    };

  }, [
    active,
    retryNonce,
    cryptoKey,
    capsuleId,
    item,
    item.chunks,
    containerChunks,
  ]);

  /**
   * SINGLE imperative owner of the A/V element's `src`.
   *
   * React must not render `src` for this element. The MediaSource path
   * attaches its object URL itself, before awaiting `sourceopen`, and a
   * second — even identical — assignment re-runs the media element load
   * algorithm, which CLOSES the MediaSource. Measured in Chromium:
   * `duration` 1.04 s → NaN, `readyState` "ended" → "closed", and no
   * new `sourceopen`, leaving the player permanently empty.
   *
   * So:
   *  • a URL is written ONLY when the element does not already carry it;
   *  • a URL the component owns is released when it has none left.
   * This keeps the Blob fallback working too: its URL is written once,
   * through this same path.
   */
  useEffect(() => {
    const el = mediaElRef.current;
    if (!el) return;

    if (!objectUrl) {
      // The component owns no URL: release the one it set earlier.
      if (el.src.startsWith("blob:")) {
        el.removeAttribute("src");
        el.load();
      }
      return;
    }

    // Already attached — by the MediaSource handshake, or by an earlier
    // render. Re-writing the identical URL would reset the element.
    if (el.src === objectUrl) return;

    el.src = objectUrl;
  }, [objectUrl]);


  /**
   * A/V items mount their media element for the WHOLE lifetime of the
   * item — including while loading.
   *
   * This is what makes progressive playback possible at all: a
   * MediaSource only opens once its object URL is attached to an
   * element that already exists, so the element must NOT be deferred
   * until after the load resolves. It stays the SINGLE player — never
   * duplicated.
   *
   * `src` is deliberately NOT a React prop: the URL is owned
   * imperatively (see the `src` effect above) so the MediaSource
   * attachment is never re-written.
   */
  if (item.mediaType === "video" || item.mediaType === "audio") {
    const filename = sanitizeFilename(item.filename);

    /**
     * R9-A86.2 — Step 1: an INACTIVE video renders a lightweight metadata
     * card and owns nothing: no <video> element, no session, no ByteRuntime,
     * no chunk resolution, no MediaSource/SourceBuffer, no Blob URL. The
     * only metadata shown is what the Vault itself carries (filename, MIME
     * type, size); no poster is invented, because a poster would require
     * reading the encrypted bytes — which is exactly what the card must not
     * do. Audio never reaches this branch (always active) and keeps its
     * pre-existing element-plus-mount-time-pipeline behaviour.
     */
    if (isVideo && !active) {
      return (
        <VideoCard
          filename={filename}
          mimeType={item.mimeType}
          size={item.size}
          onPlay={videoControl ? activateVideo : undefined}
        />
      );
    }

    return (
      <div className="space-y-2">
        {item.mediaType === "video" ? (
          <video
            ref={setMediaEl}
            controls
            playsInline
            className="w-full rounded-xl"
          />
        ) : (
          <audio
            ref={setMediaEl}
            controls
            className="w-full"
          />
        )}

        {loading && <LoadingBlock filename={filename} />}

        {!loading && (error || !objectUrl) && (
          <ErrorBlock
            filename={filename}
            mimeType={item.mimeType}
            mediaType={item.mediaType}
            size={item.size}
            notice={notice ?? undefined}
            fallbackTrigger={fallbackTriggerNotice ?? undefined}
            onRetry={isVideo ? retryLoad : undefined}
          />
        )}

        {objectUrl && (
          <a
            href={objectUrl}
            download={filename}
            className="underline text-sm"
          >
            Download file
          </a>
        )}
      </div>
    );
  }


  /**
   * R9-A85.2 — a file attachment has no inline preview, so it renders a
   * metadata card with ONE explicit control. Placed before the loading/error
   * branches: the card is this item type's terminal surface and does not
   * depend on any load having been attempted.
   */
  if (item.mediaType === "file") {
    return (
      <FileAttachmentCard
        filename={sanitizeFilename(item.filename)}
        mimeType={item.mimeType}
        size={item.size}
        state={fileDownload}
        onDownload={onDownloadFile}
      />
    );
  }

  if (loading)
    return (
      <LoadingBlock
        filename={sanitizeFilename(
          item.filename
        )}
      />
    );


  /**
   * Reached only for `image` items now: video/audio returned above and every
   * `file` item renders the metadata card, so no media-shaped surface can be
   * produced without a URL.
   */
  if (error || !objectUrl)
    return (
      <ErrorBlock
        filename={sanitizeFilename(item.filename)}
        mimeType={item.mimeType}
        mediaType={item.mediaType}
        size={item.size}
        notice={notice ?? undefined}
        fallbackTrigger={fallbackTriggerNotice ?? undefined}
      />
    );


  return (
    <MediaBlock
      mediaType={item.mediaType}
      src={objectUrl}
      filename={sanitizeFilename(
        item.filename
      )}
    />
  );

}

/**
 * Opens a video/audio item for progressive playback, falling back to
 * a BOUNDED whole-file Blob ONLY when the failure is a genuine
 * MSE/container-capability problem.
 *
 * `attachTo` is the caller's already-mounted media element. It is
 * REQUIRED for progressive playback to work at all: a MediaSource only
 * opens once its object URL is attached, so the handshake must run as
 * create → attach → await `sourceopen`. Passing null simply means the
 * MSE attempt is expected to time out (used by tests that exercise the
 * capability probe only).
 *
 * Terminal outcomes:
 * - streamable → a MediaSource object URL (or throws on real failure);
 * - not streamable (MSE/MIME incompatibility) + within limit → a
 *   bounded Blob object URL;
 * - not streamable + too large → throws (caller shows terminal error);
 * - any READ/decrypt/auth failure → throws unchanged (never silently
 *   retried as a whole-file download).
 *
 * `diagnostics` is an OPTIONAL, in-memory-only out-parameter. When
 * supplied, this function records WHY the bounded Blob fallback was
 * entered (capability vs. MSE setup) so the caller's terminal
 * classifier can report the trigger as additional context. It never
 * alters playback behaviour and is never persisted or transmitted.
 */
export async function openStreamableOrFallback(
  session: MediaSession,
  media: OpenableMediaItem,
  signal: AbortSignal,
  attachTo?: HTMLMediaElement | null,
  diagnostics?: MediaOpenDiagnosticContext,
): Promise<string> {

  try {
    return await sessionToMediaSource(
      session,
      media.mimeType,
      media.size,
      signal,
      attachTo,
    );
  } catch (err) {

    /**
     * The bounded whole-file fallback is a COMPATIBILITY path: it is
     * permitted ONLY when the failure is an MSE/container-capability
     * problem (`MediaNotStreamableError`) — i.e. the browser cannot
     * demux the stored type at all.
     *
     * A genuine read / range / decrypt / authentication failure is NOT
     * eligible. It already failed once, and retrying it as a single
     * large read would waste bandwidth and could mask corrupt data.
     * Such failures propagate unchanged to the terminal error path.
     */
    if (!isMediaNotStreamableError(err)) {
      throw err;
    }

    /**
     * Record why we are about to enter the fallback — a typed value
     * derived from the error's own `stage`, never parsed from text.
     * Mutating the caller-owned context is the whole point of the
     * out-parameter: it survives into a later fallback failure.
     */
    if (diagnostics) {
      diagnostics.fallbackTrigger =
        err.stage === "capability" ? "capability" : "mse-setup";
    }

    return await sessionToBoundedBlobUrl(
      session,
      media.size,
      media.mimeType,
      signal,
    );

  }

}


/**
 * Resolve the openable payload for one item.
 *
 * Every logical chunk MUST have a published container position: the
 * publication record is the media authority, so a chunk the record does not
 * cover means the record does not describe this Vault — fail closed. There is
 * NO legacy pointer-map fallback: Container V1 is the only model.
 *
 * Shared by the preview loader and the explicit download so the two can never
 * disagree about what an item refers to.
 */
function resolveOpenableMedia(
  item: MediaItemV2,
  containerChunks?:
    | ReadonlyMap<string, PublishedChunkMetadata>
    | null,
): OpenableMediaItem {

  const resolvedChunks =
    (item.chunks ?? []).map((chunk) => {

      const resolved =
        containerChunks?.get(chunk.chunkId);

      if (!resolved) {
        throw new Error(
          "[AETERNA] Container publication does not cover this chunk"
        );
      }

      return resolved;

    });

  return {
    ...item,
    chunks: resolvedChunks,
  };

}


/**
 * R9-A86.2 — the lazy video card: the ONLY surface an inactive video item
 * renders.
 *
 * It performs no I/O of any kind: no session, no ByteRuntime, no chunk
 * resolution or decryption, no MediaSource/SourceBuffer, no Blob or object
 * URL, and no download session. Playback begins only when the user
 * activates the control, which asks the parent's single-active-video
 * authority to select this item. The metadata shown is exactly what the
 * Vault carries — nothing invented, no poster decoded.
 */
function VideoCard({
  filename,
  mimeType,
  size,
  onPlay,
}: {
  filename?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  onPlay?: (() => void) | undefined;
}) {

  return (
    <div className="space-y-3 text-sm">

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex shrink-0 items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
          VIDEO
        </span>

        <span className="min-w-0 flex-1 font-medium break-all">
          {filename}
        </span>
      </div>

      <div className="text-muted-foreground">
        {mimeType ?? "unknown type"}
        {" · "}
        {typeof size === "number"
          ? `${size} bytes`
          : "unknown size"}
      </div>

      <Button
        type="button"
        onClick={onPlay}
        disabled={!onPlay}
        variant="capsule"
        size="lg"
        className="h-12 min-h-12 w-full justify-center rounded-lg px-5 text-sm sm:w-auto sm:px-6"
      >
        <Play aria-hidden="true" className="h-4 w-4 fill-current" />
        Play video
      </Button>

      <div className="text-muted-foreground">
        Video is loaded only when you start it.
      </div>

    </div>
  );

}


/**
 * R9-A85.2 — the terminal surface for an attachment with no inline preview.
 *
 * Shows what the item is (filename, MIME type, size) and exactly ONE action.
 * Rendering it performs no I/O: the download begins only when the user
 * activates the control.
 */
function FileAttachmentCard({
  filename,
  mimeType,
  size,
  state,
  onDownload,
}: {
  filename: string;
  mimeType?: string;
  size?: number;
  state: "idle" | "busy" | "failed";
  onDownload: () => void;
}) {

  return (
    <div className="space-y-2 text-sm">

      <div className="font-medium break-all">
        {filename}
      </div>

      <div className="text-muted-foreground">
        {mimeType ?? "unknown type"}
        {" · "}
        {typeof size === "number"
          ? `${size} bytes`
          : "unknown size"}
      </div>

      <div className="text-muted-foreground">
        No preview is available for this file type.
      </div>

      <button
        type="button"
        onClick={onDownload}
        disabled={state === "busy"}
        className="underline text-sm disabled:opacity-50"
      >
        {state === "busy"
          ? "Downloading…"
          : state === "failed"
            ? "Download failed — retry"
            : "Download file"}
      </button>

    </div>
  );

}


/* =========================
BLOCKS
========================= */


function TextBlock({
  content,
}: {
  content: string;
}) {

  if (!content)
    return null;

  /**
   * Letter presentation (F3.3.6).
   *
   * The text is rendered unchanged — the card clamps it visually for
   * the preview and opens the FULL original string in a reader. No
   * letter title is invented (the vault stores none), and the
   * decrypted text never leaves the browser.
   */
  return (
    <LetterCard content={content} />
  );

}


function MediaBlock({
  mediaType,
  src,
  filename,
}: {
  mediaType:
    | "image"
    | "video"
    | "audio"
    | "file";
  src: string;
  filename?: string;
}) {

  /**
   * R9-A88.1 — full-screen viewer state for THIS image only.
   *
   * Local to the block on purpose: one image's viewer can never open
   * another image's bytes, and closing returns focus to this block's own
   * trigger (Radix restores focus to the element that opened the dialog).
   */
  const [viewerOpen, setViewerOpen] = useState(false);

  /** The image control that opened the viewer; focus returns here. */
  const imageTriggerRef = useRef<HTMLButtonElement | null>(null);

  switch (mediaType) {

    case "image":
      return (
        <>
          <button
            ref={imageTriggerRef}
            type="button"
            onClick={() => setViewerOpen(true)}
            aria-label={`Open ${filename ?? "image"} full screen`}
            aria-haspopup="dialog"
            className="block w-full cursor-zoom-in rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <img
              src={src}
              alt={filename}
              className="w-full rounded-xl"
            />
          </button>

          {/*
            The viewer receives the URL this block already displays. It
            creates no object URL, fetches nothing and revokes nothing —
            the inline image above stays the owner of `src`.
          */}
          {viewerOpen && (
            <ImageViewer
              src={src}
              alt={filename ?? "Image"}
              returnFocusTo={imageTriggerRef}
              onClose={() => setViewerOpen(false)}
            />
          )}
        </>
      );

    case "video":
      return (
        <div className="space-y-2">
          <video
            controls
            src={src}
            className="w-full rounded-xl"
          />

          <a
            href={src}
            download={filename}
            className="underline text-sm"
          >
            Download file
          </a>
        </div>
      );

    case "audio":
      return (
        <div className="space-y-2">
          <audio
            controls
            src={src}
            className="w-full"
          />

          <a
            href={src}
            download={filename}
            className="underline text-sm"
          >
            Download file
          </a>
        </div>
      );

    case "file":
      return (
        <a
          href={src}
          download
          className="underline text-sm"
        >
          {filename ?? "Download file"}
        </a>
      );

    default:
      // Unknown mediaType is silently dropped.
      // Canonical renderer law: render only validated structures.
      return null;
  }

}


function LoadingBlock({
  filename,
}: {
  filename?: string;
}) {

  return (
    <div className="text-sm text-muted-foreground">
      Loading {filename ?? "media"}…
    </div>
  );

}


function ErrorBlock({
  filename,
  mimeType,
  mediaType,
  size,
  notice,
  fallbackTrigger,
  onRetry,
}: {
  filename?: string;
  mimeType?: string;
  mediaType?: string;
  size?: number;
  notice?: string | undefined;
  /**
   * Fixed, safe label naming why the bounded Blob fallback was entered.
   * Supplied by the caller ONLY when a fallback was attempted and the
   * failure happened inside it — never composed here.
   */
  fallbackTrigger?: string | undefined;
  /**
   * R9-A86.2 — explicit retry for an ACTIVE video's terminal failure.
   * Present only when the caller provides one; the image/file surfaces
   * pass none, so their behaviour is unchanged.
   */
  onRetry?: (() => void) | undefined;
}) {

  return (

    <div className="space-y-2 text-sm">

      <div className="text-destructive">
        {notice ?? "Failed to load preview"}
      </div>

      {fallbackTrigger && (
        <div className="text-destructive">
          {fallbackTrigger}
        </div>
      )}

      <div>
        <strong>Filename:</strong>{" "}
        {filename ?? "file"}
      </div>

      <div>
        <strong>Media type:</strong>{" "}
        {mediaType ?? "unknown"}
      </div>

      <div>
        <strong>MIME type:</strong>{" "}
        {mimeType ?? "unknown"}
      </div>

      <div>
        <strong>Size:</strong>{" "}
        {typeof size === "number"
          ? `${size} bytes`
          : "unknown"}
      </div>

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="underline text-sm"
        >
          Retry
        </button>
      )}

      <div className="text-muted-foreground">
        Media preview unavailable
      </div>

    </div>

  );

}


/* =========================
SANITIZERS
========================= */


function sanitizeFilename(
  value?: string
) {

  // FIX: MAX_FILENAME_LENGTH = 1024 per canonical spec
  if (
    typeof value !== "string" ||
    value.length > 1024
  )
    return "file";

  return value;

}
