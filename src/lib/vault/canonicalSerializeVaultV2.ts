import type {
  CapsuleItemV2,
  TextItemV2,
  MediaItemV2,
  ChunkMetadata,
} from "@/types/vault";

import {
  CAPSULE_ID_REGEX,
  ISO8601_REGEX
} from "@/lib/crypto/validators";


const encoder = new TextEncoder();


const VERSION = 2 as const;

const MAX_FILENAME_LENGTH = 1024;
const MAX_MIMETYPE_LENGTH = 255;
const MAX_MEDIATYPE_LENGTH = 64;


// Canonical mediaType whitelist.
// Serializer must not trust upstream validation —
// defence-in-depth requires the whitelist to be
// enforced at the serialization boundary itself.
const VALID_MEDIA_TYPES =
  new Set<string>([
    "image",
    "video",
    "audio",
    "file",
  ]);


export function canonicalSerializeVaultV2(params: {
  createdAt: string;
  capsuleId: string;
  items: CapsuleItemV2[];
}): Uint8Array {

  if (Object.getPrototypeOf(params) !== Object.prototype) {
    throw new Error("[AETERNA] Invalid params prototype");
  }

  validateISO8601(params.createdAt);

  if (
    typeof params.capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(params.capsuleId)
  ) {
    throw new Error("[AETERNA] Invalid capsuleId");
  }

  if (!Array.isArray(params.items)) {
    throw new Error("[AETERNA] items must be array");
  }

  if (Object.getPrototypeOf(params.items) !== Array.prototype) {
    throw new Error("[AETERNA] Invalid items prototype");
  }

  if (params.items.length > 100) {
    throw new Error("[AETERNA] too many items");
  }


  // Deterministic ordering invariant:
  // Sort by createdAt ascending so the serialized output is
  // identical regardless of upstream insertion order.
  // Tie-breaker: serializeItemV2() canonical output comparison —
  // engine-independent and schema-stable, unlike JSON.stringify
  // whose field ordering depends on insertion order and engine
  // behavior. Using the canonical serializer itself as the
  // comparator guarantees vaultSha256-stable ordering.
  // The serializer must not trust that toVaultItems() or any
  // other caller has already sorted — canonical output requires
  // the sort to happen at the serialization boundary itself.
  const items = params.items
    .map(item => ({
      item,
      key: serializeItemV2(item),
    }))
    .sort((a, b) => {

      if (a.item.createdAt < b.item.createdAt) return -1;
      if (a.item.createdAt > b.item.createdAt) return 1;

      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;

      return 0;

    })
    .map(entry => entry.item);


  const serialized =
    `{"version":${VERSION},` +
    `"createdAt":"${escapeString(params.createdAt)}",` +
    `"capsule":{"capsuleId":"${escapeString(params.capsuleId)}","items":[` +
    items.map(serializeItemV2).join(",") +
    `]}}`;


  return encoder.encode(serialized);

}


function serializeItemV2(item: CapsuleItemV2): string {

  if (!item || typeof item !== "object") {
    throw new Error("[AETERNA] Invalid CapsuleItemV2");
  }

  if (Object.getPrototypeOf(item) !== Object.prototype) {
    throw new Error("[AETERNA] Invalid item prototype");
  }

  switch (item.type) {

    case "text":
      return serializeTextItem(item);

    case "media":
      return serializeMediaItem(item);

    default: {
      const _exhaustiveCheck: never = item;
      return _exhaustiveCheck;
    }

  }

}


function serializeTextItem(item: TextItemV2): string {

  validateISO8601(item.createdAt);

  if (typeof item.text !== "string") {
    throw new Error("[AETERNA] Invalid text payload");
  }

  return (
    `{"type":"text",` +
    `"text":"${escapeString(item.text)}",` +
    `"createdAt":"${escapeString(item.createdAt)}"` +
    `}`
  );

}


function serializeMediaItem(item: MediaItemV2): string {

  validateISO8601(item.createdAt);

  validateMediaType(item.mediaType);
  validateSize(item.size);


  if (
    typeof item.filename !== "string" ||
    item.filename.length === 0 ||
    item.filename.length > MAX_FILENAME_LENGTH
  ) {
    throw new Error("[AETERNA] Invalid filename");
  }


  if (
    typeof item.mimeType !== "string" ||
    item.mimeType.length === 0 ||
    item.mimeType.length > MAX_MIMETYPE_LENGTH
  ) {
    throw new Error("[AETERNA] Invalid mimeType");
  }


  if (item.mediaType.length > MAX_MEDIATYPE_LENGTH) {
    throw new Error("[AETERNA] Invalid mediaType length");
  }


  if (
    !Array.isArray(item.chunks) ||
    Object.getPrototypeOf(item.chunks) !== Array.prototype
  ) {
    throw new Error("[AETERNA] Invalid chunks prototype");
  }

  const chunks: readonly ChunkMetadata[] =
    item.chunks.slice();


  for (const chunk of chunks) {

    if (
      !chunk ||
      typeof chunk !== "object"
    ) {

      throw new Error(
        "[AETERNA] Invalid chunk metadata"
      );

    }

  }


  if (chunks.length > 65535) {
    throw new Error("[AETERNA] Too many chunks");
  }


  const chunksStr =
    "[" +
    chunks
      .map(serializeChunkMetadata)
      .join(",") +
    "]";


  return (
    `{"type":"media",` +
    `"mediaType":"${escapeString(item.mediaType)}",` +
    `"filename":"${escapeString(item.filename)}",` +
    `"mimeType":"${escapeString(item.mimeType)}",` +
    `"size":${item.size},` +
    `"chunks":${chunksStr},` +
    `"createdAt":"${escapeString(item.createdAt)}"` +
    `}`
  );

}


function validateISO8601(value: string) {

  if (
    typeof value !== "string" ||
    !ISO8601_REGEX.test(value)
  ) {
    throw new Error("[AETERNA] Invalid ISO8601 timestamp");
  }

}


function validateSize(value: number) {

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error("[AETERNA] Invalid media size");
  }

}


function validateMediaType(value: string) {

  if (!VALID_MEDIA_TYPES.has(value)) {
    throw new Error("[AETERNA] Invalid mediaType");
  }

}


// Serializer must never trust upstream validation (prepareVault(),
// callers, or any prior stage). Every field consumed here is
// re-validated at the serialization boundary itself — defence in
// depth for the layer that produces the canonical, hash-relevant
// wire format.
function serializeChunkMetadata(
  chunk: ChunkMetadata
): string {

  if (
    !chunk ||
    typeof chunk !== "object"
  ) {
    throw new Error(
      "[AETERNA] Invalid chunk metadata"
    );
  }

  if (
    Object.getPrototypeOf(chunk) !== Object.prototype
  ) {
    throw new Error(
      "[AETERNA] Invalid chunk metadata prototype"
    );
  }

  if (
    typeof chunk.chunkId !== "string" ||
    chunk.chunkId.length === 0
  ) {
    throw new Error(
      "[AETERNA] Invalid chunk chunkId"
    );
  }

  if (
    typeof chunk.mediaId !== "string" ||
    chunk.mediaId.length === 0
  ) {
    throw new Error(
      "[AETERNA] Invalid chunk mediaId"
    );
  }

  if (
    !Number.isInteger(chunk.index) ||
    chunk.index < 0 ||
    chunk.index > 0xffffffff
  ) {
    throw new Error(
      "[AETERNA] Invalid chunk index"
    );
  }

  if (
    !Number.isInteger(chunk.size) ||
    chunk.size < 0
  ) {
    throw new Error(
      "[AETERNA] Invalid chunk size"
    );
  }

  return (
    `{"chunkId":"${escapeString(chunk.chunkId)}",` +
    `"mediaId":"${escapeString(chunk.mediaId)}",` +
    `"index":${chunk.index},` +
    `"size":${chunk.size}}`
  );

}


function escapeString(value: string): string {

  if (typeof value !== "string") {
    throw new Error("[AETERNA] escapeString expected string");
  }

  let result = "";

  for (let i = 0; i < value.length; i++) {

    const code = value.charCodeAt(i);

    // UTF-16 surrogate validation
    //
    // Valid surrogate pairs MUST be preserved.
    // Only malformed surrogate sequences are rejected.
    //
    // This keeps canonical Unicode compatibility
    // while preserving fail-closed behavior for
    // broken UTF-16 payloads.

    if (
      code >= 0xd800 &&
      code <= 0xdbff
    ) {

      // High surrogate must be followed
      // by low surrogate.

      const next =
        value.charCodeAt(i + 1);

      if (

        next < 0xdc00 ||

        next > 0xdfff

      ) {

        throw new Error(
          "[AETERNA] Invalid UTF-16 surrogate pair"
        );

      }

    }

    else if (

      code >= 0xdc00 &&

      code <= 0xdfff

    ) {

      // Low surrogate must follow
      // high surrogate.

      const prev =
        value.charCodeAt(i - 1);

      if (

        prev < 0xd800 ||

        prev > 0xdbff

      ) {

        throw new Error(
          "[AETERNA] Invalid UTF-16 surrogate pair"
        );

      }

    }

    switch (value[i]) {

      case '"':
        result += '\\"';
        break;

      case "\\":
        result += "\\\\";
        break;

      case "\b":
        result += "\\b";
        break;

      case "\f":
        result += "\\f";
        break;

      case "\n":
        result += "\\n";
        break;

      case "\r":
        result += "\\r";
        break;

      case "\t":
        result += "\\t";
        break;

      default:

        if (code <= 0x1f) {

          result += "\\u" +
            code
              .toString(16)
              .padStart(4, "0");

        }

        else {

          result += value[i];

        }

    }

  }

  return result;

}