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
 * NOTE: the canonical streaming path (Service Worker intercepting
 * range requests against a live MediaSession) is not wired up yet —
 * runtime-sw.ts's fetch handler is still a stub. Until that lands,
 * video/audio/file sessions are read once, fully, into memory here,
 * exactly like openImage() already does. This keeps media actually
 * playable today without pretending to stream what isn't streamed.
 */
async function sessionToObjectUrl(
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

        let url: string;

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

            url = await sessionToObjectUrl(
              session,
              media.size,
              media.mimeType,
            );

            break;

          }

          case "audio": {

            const session =
              await openAudio(request);

            url = await sessionToObjectUrl(
              session,
              media.size,
              media.mimeType,
            );

            break;

          }

          case "file": {

            const session =
              await downloadFile(request);

            url = await sessionToObjectUrl(
              session,
              media.size,
              media.mimeType,
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

          URL.revokeObjectURL(url);

          return;

        }

        createdUrl = url;

        if (!cancelled) {

          setObjectUrl(createdUrl);

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

        if (!cancelled) {

          setError(true);

          setLoading(false);

        }

      }

    }

    load();


    return () => {

      cancelled = true;

      if (createdUrl)
        URL.revokeObjectURL(createdUrl);

    };

  }, [
    cryptoKey,
    capsuleId,
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


  if (error || !objectUrl)
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