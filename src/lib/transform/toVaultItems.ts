import type {
  CapsuleItemV2,
  TextItemV2,
  MediaItemV2,
  IsoUtcString,
  ChunkMetadata,
} from "@/types/vault";

import type {
  CapsuleItem,
} from "@/types/capsule";

import {
  ITEM_ID_REGEX,
  ISO8601_REGEX,
} from "@/lib/crypto/validators";

const TRANSFORM_ERROR =
  new Error("[AETERNA] toVaultItems failed");


/* ─────────────────────────────
   VALIDATORS
───────────────────────────── */

function ensureIsoString(
  value: string
): IsoUtcString {

  if (
    typeof value !== "string" ||
    !ISO8601_REGEX.test(value)
  ) {
    throw TRANSFORM_ERROR;
  }

  const parsed =
    Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw TRANSFORM_ERROR;
  }

  return value as IsoUtcString;

}

function ensureFilename(
  name: unknown
): string {

  if (typeof name !== "string") {
    return "file";
  }

  const trimmed =
    name.trim();

  if (!trimmed.length) {
    return "file";
  }

  if (trimmed.length > 255) {
    throw TRANSFORM_ERROR;
  }

  return trimmed;

}

function ensureMimeType(
  mime: unknown
): string {

  if (typeof mime !== "string") {
    return "application/octet-stream";
  }

  const trimmed =
    mime.trim();

  if (!trimmed.length) {
    return "application/octet-stream";
  }

  if (trimmed.length > 255) {
    throw TRANSFORM_ERROR;
  }

  return trimmed;

}

function ensureSize(
  size: unknown
): number {

  if (
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    !Number.isInteger(size) ||
    size < 0
  ) {
    throw TRANSFORM_ERROR;
  }

  return size;

}

function ensureMediaType(
  type: unknown
): "image" | "video" | "audio" | "file" {

  if (
    type !== "image" &&
    type !== "video" &&
    type !== "audio" &&
    type !== "file"
  ) {
    throw TRANSFORM_ERROR;
  }

  return type;

}


/* ─────────────────────────────
   DETERMINISTIC ORDERING
───────────────────────────── */

function sortDeterministic(
  items: CapsuleItem[]
): CapsuleItem[] {

  return [...items].sort((a, b) => {

    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;

    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;

    return 0;

  });

}


/* ─────────────────────────────
   MAIN TRANSFORMER
───────────────────────────── */

export async function toVaultItems(
  items: CapsuleItem[],
  getMediaFile: (
    id: string
  ) => File | undefined,
  chunkMetadata:
    readonly ChunkMetadata[]
): Promise<CapsuleItemV2[]> {

  if (!Array.isArray(items)) {
    throw TRANSFORM_ERROR;
  }

  if (!Array.isArray(chunkMetadata)) {
    throw TRANSFORM_ERROR;
  }

  const ordered =
    sortDeterministic(
      items.map(item => {

        if (
          !item ||
          typeof item !== "object"
        ) {
          throw TRANSFORM_ERROR;
        }

        ensureIsoString(
          item.createdAt
        );

        return item;

      })
    );

  const result: CapsuleItemV2[] = [];

  for (const item of ordered) {

    if (
      !item ||
      typeof item !== "object"
    ) {
      throw TRANSFORM_ERROR;
    }

    const proto =
      Object.getPrototypeOf(item);

    if (
      proto !== Object.prototype &&
      proto !== null
    ) {
      throw TRANSFORM_ERROR;
    }

    if (
      typeof item.id !== "string" ||
      !ITEM_ID_REGEX.test(item.id)
    ) {
      throw TRANSFORM_ERROR;
    }

    const createdAt =
      ensureIsoString(item.createdAt);

    if (item.type === "text") {

      if (
        typeof item.text !== "string"
      ) {
        throw TRANSFORM_ERROR;
      }

      const normalized =
        item.text.trim();

      if (!normalized.length) {
        throw TRANSFORM_ERROR;
      }

      result.push(
        Object.freeze({

          type: "text",

          text: normalized,

          createdAt,

        } satisfies TextItemV2)
      );

      continue;

    }

    if (item.type !== "media") {
      throw TRANSFORM_ERROR;
    }

    const file =
      getMediaFile(item.id);

    if (!file) {
      throw TRANSFORM_ERROR;
    }

    const mediaChunks =
      chunkMetadata
        .filter(
          chunk =>
            chunk.mediaId === item.id
        )
        .sort(
          (a, b) =>
            a.index - b.index
        );

    result.push(
      Object.freeze({

        type: "media",

        mediaType:
          ensureMediaType(item.mediaType),

        filename:
          ensureFilename(
            item.filename ??
            file.name
          ),

        mimeType:
          ensureMimeType(
            file.type
          ),

        size:
          ensureSize(
            file.size
          ),

        chunks:
          Object.freeze(
            [...mediaChunks]
          ),

        createdAt,

      } satisfies MediaItemV2)
    );

  }

  return result;

}