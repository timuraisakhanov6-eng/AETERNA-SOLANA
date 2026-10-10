import { useState, useEffect, useRef, useCallback } from "react"; 

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

import type {
  MediaSession,
  OpenableMediaItem,
} from "@/lib/capsule/open/openTypes";

import {
  resolveStreamableMimeType,
  MediaNotStreamableError,
  isMediaNotStreamableError,
} from "@/lib/capsule/open/mediaCompatibility";

import {
  assertInlinePreviewSize,
  isMediaPreviewTooLargeError,
  inlinePreviewTooLargeMessage,
} from "@/lib/capsule/open/mediaPreviewPolicy";

import {
  awaitEvent,
  withTimeout,
} from "@/lib/capsule/open/boundedAwait";

/**
 * Upper bound for a single bounded media handshake (sourceopen /
 * updateend / whole-file fallback read). Chosen generously so it only
 * fires on a genuinely wedged MediaSource pipeline, never on a
 * slow-but-working device, while still converting "forever" into a
 * terminal error the UI can render.
 */
const MEDIA_SOURCE_OPEN_TIMEOUT_MS = 20_000;
const MEDIA_APPEND_TIMEOUT_MS = 20_000;
const MEDIA_READ_TIMEOUT_MS = 30_000;

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
    // instead of hanging the caller.
    const bytes = await withTimeout(
      session.read(0, size),
      MEDIA_READ_TIMEOUT_MS,
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
              await withTimeout(
                session.read(
                  offset,
                  end,
                ),
                MEDIA_READ_TIMEOUT_MS,
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
      await withTimeout(
        session.read(0, size),
        MEDIA_READ_TIMEOUT_MS,
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
    throw new MediaNotStreamableError(mimeType);
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
    new MediaNotStreamableError(mimeType, reason);

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
              await withTimeout(
                session.read(
                  offset,
                  end,
                ),
                MEDIA_READ_TIMEOUT_MS,
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

  // Bounded read. MediaSession exposes no cancellation primitive, so a
  // late resolution after the timeout is simply discarded — the caller
  // has already moved to a terminal state and the bytes are unused.
  const bytes = await withTimeout(
    session.read(0, size),
    MEDIA_READ_TIMEOUT_MS,
    "media fallback read",
  );

  if (signal?.aborted) {
    throw new Error(
      "[AETERNA] Media fallback cancelled.",
    );
  }

  const blob = new Blob(
    [bytes],
    { type: mimeType || "application/octet-stream" },
  );

  return URL.createObjectURL(blob);

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
            containerChunks
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
    > | null | undefined
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
}: {
  item: MediaItemV2;
  cryptoKey: CryptoKey;
  capsuleId: string;
  containerChunks?:
    ReadonlyMap<
      string,
      PublishedChunkMetadata
    > | null | undefined;
}) {

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

  useEffect(() => {

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
    setObjectUrl(null);

    let createdUrl: string | null =
      null;

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

    const settleError = (reason?: string) => {
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
        const resolvedChunks =
          (item.chunks ?? []).map((chunk) => {

            /**
             * Every logical chunk of this item MUST have a container
             * position: the publication record is the media authority, so
             * a chunk the record does not cover means the record does not
             * describe this Vault — fail closed. There is NO legacy
             * pointer-map fallback: Container V1 is the only model.
             */
            const resolved =
              containerChunks?.get(chunk.chunkId);

            if (!resolved) {
              throw new Error(
                "[AETERNA] Container publication does not cover this chunk"
              );
            }

            return resolved;

          });

        const media: OpenableMediaItem = {
          ...item,
          chunks: resolvedChunks,
        };

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
              await withTimeout(
                openImage(request),
                MEDIA_READ_TIMEOUT_MS,
                "image preview",
              );

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
            );

            break;

          }

          case "file": {

            const session =
              await downloadFile(request);

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

            await sessionToDownloadStream(
              session,
              media.size,
              media.mimeType,
              media.filename,
            );

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
        // An oversized inline preview gets a precise, actionable reason
        // instead of the generic failure copy.
        settleError(
          isMediaPreviewTooLargeError(err)
            ? inlinePreviewTooLargeMessage(err.size)
            : undefined,
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

    return (
      <div className="space-y-2">
        {item.mediaType === "video" ? (
          <video
            ref={setMediaEl}
            controls
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


  if (loading)
    return (
      <LoadingBlock
        filename={sanitizeFilename(
          item.filename
        )}
      />
    );


  if (error || !objectUrl || item.mediaType === "file")
    return (
      <ErrorBlock
        filename={sanitizeFilename(item.filename)}
        mimeType={item.mimeType}
        mediaType={item.mediaType}
        size={item.size}
        notice={notice ?? undefined}
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
 */
export async function openStreamableOrFallback(
  session: MediaSession,
  media: OpenableMediaItem,
  signal: AbortSignal,
  attachTo?: HTMLMediaElement | null,
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

    return await sessionToBoundedBlobUrl(
      session,
      media.size,
      media.mimeType,
      signal,
    );

  }

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

  return (
    <div className="prose prose-neutral max-w-none">
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </div>
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

  switch (mediaType) {

    case "image":
      return (
        <img
          src={src}
          alt={filename}
          className="w-full rounded-xl"
        />
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
}: {
  filename?: string;
  mimeType?: string;
  mediaType?: string;
  size?: number;
  notice?: string | undefined;
}) {

  return (

    <div className="space-y-2 text-sm">

      <div className="text-destructive">
        {notice ?? "Failed to load preview"}
      </div>

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
