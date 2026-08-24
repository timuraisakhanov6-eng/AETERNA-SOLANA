import { useState, useEffect, useRef } from "react"; 

import type {
  Vault,
  VaultV1,
  VaultV2,
  CapsuleItemV1,
  CapsuleItemV2,
  MediaItemV2,
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

import type {
  ChunkId,
} from "@/types/manifest";

import type {
  StoragePointer,
} from "@/lib/storage/storageAdapter";

import {
  resolveChunkPointers,
} from "@/lib/capsule/open/resolveChunkPointers";

/**
 * Reads a full MediaSession into a single Blob object URL.
 *
 * This bounded fallback is used only when the File System Access
 * API is unavailable and the file is small enough to materialize
 * safely in JS memory.
 */
export async function sessionToObjectUrl(
  session: MediaSession,
  size: number,
  mimeType: string,
): Promise<string> {

  try {

    const bytes = await session.read(0, size);

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

        const handle =
          await (window as Window).showSaveFilePicker({
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

            const bytes =
              await session.read(
                offset,
                end,
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

    const bytes =
      await session.read(0, size);

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
): Promise<string> {

  if (
    typeof MediaSource === "undefined" ||
    !MediaSource.isTypeSupported(mimeType)
  ) {
    throw new Error(
      `[AETERNA] Progressive playback unavailable for ${mimeType}`,
    );
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  await new Promise<void>((resolve, reject) => {

    if (signal?.aborted) {
      URL.revokeObjectURL(objectUrl);
      reject(
        new Error(
          "[AETERNA] MediaSource stream cancelled.",
        ),
      );
      return;
    }

    mediaSource.addEventListener(
      "sourceopen",
      async () => {
        try {

          const sourceBuffer =
            mediaSource.addSourceBuffer(
              mimeType,
            );

          let offset = 0;
          const chunkSize = 256 * 1024;

          const appendNext = async () => {

            if (
              signal?.aborted ||
              offset >= size
            ) {
              if (
                offset >= size &&
                mediaSource.readyState === "open"
              ) {
                try {
                  mediaSource.endOfStream();
                } catch {
                  // endOfStream can throw if already ended;
                  // retain current state.
                }
              }
              return;
            }

            const end =
              Math.min(
                offset + chunkSize,
                size,
              );

            let bytes: Uint8Array;

            try {

              bytes =
                await session.read(
                  offset,
                  end,
                );

            } catch (err) {

              console.error(
                "[AETERNA] MediaSource read failed",
                err,
              );

              return;

            }

            if (signal?.aborted) {
              return;
            }

            try {

              sourceBuffer.appendBuffer(
                bytes,
              );

            } catch (err) {

              console.error(
                "[AETERNA] MediaSource append failed",
                err,
              );

            }

            offset = end;

          };

          sourceBuffer.addEventListener(
            "updateend",
            appendNext,
          );

          sourceBuffer.addEventListener(
            "error",
            () => {
              try {
                if (
                  mediaSource.readyState ===
                  "open"
                ) {
                  mediaSource.endOfStream();
                }
              } catch {
                // SourceBuffer error should not crash playback.
              }
            },
          );

          await appendNext();

          resolve();

        } catch (err) {

          reject(err);

        }
      },
      { once: true },
    );

  });

  return objectUrl;

}

/*
VaultRenderer — CANON production-safe renderer
AETERNA Technical Spec v1.0 compliant
*/

type Props = {
  vault: Vault;
  cryptoKey?: CryptoKey;

  chunkPointers:
    Readonly<Record<
      ChunkId,
      StoragePointer
    >>;
};

export default function VaultRenderer({
  vault,
  cryptoKey,
  chunkPointers,
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
          chunkPointers={chunkPointers}
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
  chunkPointers,
}: {
  vault: VaultV2;
  cryptoKey: CryptoKey;
  chunkPointers:
    Readonly<Record<
      ChunkId,
      StoragePointer
    >>;
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
            chunkPointers
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
  chunkPointers:
    Readonly<Record<
      ChunkId,
      StoragePointer
    >>
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
          chunkPointers={chunkPointers}
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
  chunkPointers,
}: {
  item: MediaItemV2;
  cryptoKey: CryptoKey;
  capsuleId: string;
  chunkPointers:
    Readonly<Record<
      ChunkId,
      StoragePointer
    >>;
}) {

  const [objectUrl, setObjectUrl] =
    useState<string | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(false);

  const startedSignatureRef =
    useRef<string | null>(null);

  const abortRef =
    useRef<(() => void) | null>(null);

  const mediaSessionRef =
    useRef<MediaSession | null>(null);


  useEffect(() => {

    const chunks =
      item.chunks ?? [];

    const signature =
      JSON.stringify(chunks);

    if (
      startedSignatureRef.current ===
      signature
    ) return;

    startedSignatureRef.current =
      signature;

    // Reset UI state before starting a new load. Without this,
    // a stale objectUrl/loading/error from the previous item
    // remains on screen until the new load settles — including
    // through a failure path, which would leave a now-invalid
    // objectUrl displayed as if it were still current.
    setLoading(true);
    setError(false);
    setObjectUrl(null);

    let cancelled = false;

    let createdUrl: string | null =
      null;


    async function load() {

      try {

        const resolvedChunks =
          resolveChunkPointers(
            item.chunks ?? [],
            chunkPointers,
          );

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

            const result =
              await openImage(request);

            url = result.objectUrl;

            break;

          }

          case "video": {

            const session =
              await openVideo(request);

            mediaSessionRef.current =
              session;

            const controller =
              new AbortController();

            url = await sessionToMediaSource(
              session,
              media.mimeType,
              media.size,
              controller.signal,
            );

            abortRef.current = () =>
              controller.abort();

            break;

          }

          case "audio": {

            const session =
              await openAudio(request);

            mediaSessionRef.current =
              session;

            const controller =
              new AbortController();

            url = await sessionToMediaSource(
              session,
              media.mimeType,
              media.size,
              controller.signal,
            );

            abortRef.current = () =>
              controller.abort();

            break;

          }

          case "file": {

            const session =
              await downloadFile(request);

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

        if (cancelled) {

          if (url)
            URL.revokeObjectURL(url);

          return;

        }

        createdUrl = url;

        if (createdUrl && !cancelled) {

          setObjectUrl(createdUrl);
          setLoading(false);

        } else if (!createdUrl && !cancelled) {

          setError(true);
          setLoading(false);

        }

      }

      catch (err) {

        if (import.meta.env.DEV) {
          console.error(
            "[AETERNA MEDIA LOAD ERROR]",
            err,
          );
        }


        if (mediaSessionRef.current) {
          mediaSessionRef.current.dispose();
          mediaSessionRef.current = null;
        }

        if (!cancelled) {

          setError(true);

          setLoading(false);

        }

      }

    }

    load();


    return () => {


      cancelled = true;

      if (mediaSessionRef.current) {
        mediaSessionRef.current.dispose();
        mediaSessionRef.current = null;
      }


      if (abortRef.current) {
        abortRef.current();
      }

      if (createdUrl)
        URL.revokeObjectURL(createdUrl);

    };

  }, [
    cryptoKey,
    capsuleId,
    item,
    item.chunks,
    chunkPointers,
  ]);


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
}: {
  filename?: string;
  mimeType?: string;
  mediaType?: string;
  size?: number;
}) {

  return (

    <div className="space-y-2 text-sm">

      <div className="text-destructive">
        Failed to load preview
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
