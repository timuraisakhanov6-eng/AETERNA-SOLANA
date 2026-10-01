/**
 * =========================================================
 * AETERNA — Pure media-container layout (Stage 2)
 * =========================================================
 *
 * Deterministic physical framing for ONE media container:
 *
 *   HEADER
 *   CHUNK 0
 *   CHUNK 1
 *   ...
 *   CHUNK N-1
 *
 * SCOPE — PURE LAYOUT ONLY. This module:
 *
 *   • performs no filesystem, network or Irys access
 *   • performs no crypto and adds no second encryption layer
 *   • puts NO index inside the container
 *   • performs no compression
 *   • never touches the Vault (which remains a separate DataItem)
 *
 * The container describes physical framing only. The bytes of each
 * chunk remain the existing logical encrypted chunks produced by the
 * current chunking pipeline — this module does not create, transform
 * or re-encrypt any payload.
 *
 * GLOBAL ORDER
 * ------------
 *   Vault `items[]` order, then each item's `chunks[]` order.
 *
 * `ChunkMetadata.index` is LOCAL to its media item. It is preserved
 * verbatim on every entry as `localIndex` and is NEVER reinterpreted
 * as a global index. `deriveChunkIV()` inputs therefore stay
 * unchanged: per-item logical chunk index + capsuleId.
 *
 * DETERMINISM
 * -----------
 * The same metadata always yields a byte-identical layout: no clocks,
 * no randomness, no environment input.
 */

import type { ChunkId } from "@/types/manifest";
import type { ChunkMetadata } from "@/types/vault";

import { MAX_ENCRYPTED_CHUNK_SIZE } from "@/lib/crypto/constants";

/* =========================
   CANONICAL HEADER
   ========================= */

/**
 * Header magic — ASCII "AETC" (AETerna Container).
 *
 * Present so a reader can identify a container before trusting any
 * other header field.
 */
export const CONTAINER_MAGIC = Object.freeze([
  0x41, 0x45, 0x54, 0x43,
] as const);

/** Header schema version. */
export const CONTAINER_VERSION = 1;

/**
 * Canonical fixed header size, in bytes.
 *
 * FIXED and self-described: the value is written into the header
 * itself so a future revision can grow the header without ambiguity.
 */
export const HEADER_SIZE = 64;

/**
 * Canonical header byte layout (big-endian / network order):
 *
 *   offset  size  field
 *   ------  ----  --------------------------------------------
 *        0     4  magic            "AETC"
 *        4     1  version          uint8
 *        5     2  headerSize       uint16
 *        7     4  chunkCount       uint32
 *       11    53  reserved         zero-filled
 *   ------  ----  --------------------------------------------
 *       64        HEADER_SIZE
 *
 * `reserved` is fixed-length and MUST be all zero. It exists so a
 * future revision can add fields without moving the chunk area.
 * There is deliberately NO variable-length index and NO
 * cryptographic field here.
 */
export const HEADER_MAGIC_OFFSET = 0;
export const HEADER_VERSION_OFFSET = 4;
export const HEADER_HEADER_SIZE_OFFSET = 5;
export const HEADER_CHUNK_COUNT_OFFSET = 7;
export const HEADER_RESERVED_OFFSET = 11;
export const HEADER_RESERVED_LENGTH = HEADER_SIZE - HEADER_RESERVED_OFFSET;

const MAX_UINT32 = 0xffffffff;

function failClosed(reason: string): never {
  throw new Error(reason);
}

/* =========================
   LAYOUT TYPES
   ========================= */

/**
 * One chunk's physical placement in the container, plus the mapping
 * back to the source chunk metadata it was derived from.
 */
export interface ContainerEntry {
  /** Position in the canonical global order. */
  readonly globalIndex: number;

  /** Source media item identifier (`ChunkMetadata.mediaId`). */
  readonly mediaId: string;

  /**
   * Source `ChunkMetadata.index` — LOCAL to the media item.
   * Never a global index.
   */
  readonly localIndex: number;

  /** Source `ChunkMetadata.chunkId`. */
  readonly chunkId: ChunkId;

  /** Absolute byte offset of this chunk inside the container. */
  readonly offset: number;

  /** Physical length in bytes — equals the source ciphertext size. */
  readonly length: number;
}

/**
 * A fully resolved, immutable container layout.
 */
export interface ContainerLayout {
  /** Always `HEADER_SIZE`. */
  readonly headerSize: number;

  /** Number of chunks in the container. */
  readonly chunkCount: number;

  /** Total container size: header + every chunk. */
  readonly containerSize: number;

  /** Entries in canonical global order. */
  readonly entries: readonly ContainerEntry[];

  /** Absolute byte offset of the chunk at `globalIndex`. */
  offsetOf(globalIndex: number): number;

  /** Physical length of the chunk at `globalIndex`. */
  lengthOf(globalIndex: number): number;
}

/** Canonical parsed header. */
export interface ContainerHeader {
  readonly version: number;
  readonly headerSize: number;
  readonly chunkCount: number;
}

/* =========================
   METADATA VALIDATION
   ========================= */

/**
 * Fail-closed validation of one source chunk metadata record.
 *
 * `expectedLocalIndex` enforces the canonical per-item sequence:
 * within a media item, `ChunkMetadata.index` must run 0, 1, 2, …
 * contiguously — the same rule `byteRuntime.buildByteMap()` applies.
 */
function assertChunkMetadata(
  value: unknown,
  expectedLocalIndex: number
): asserts value is ChunkMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failClosed("[AETERNA] Invalid container chunk metadata");
  }

  const record = value as Record<string, unknown>;

  const chunkId = record["chunkId"];
  if (typeof chunkId !== "string" || chunkId.length === 0) {
    failClosed("[AETERNA] Invalid container chunk id");
  }

  const mediaId = record["mediaId"];
  if (typeof mediaId !== "string" || mediaId.length === 0) {
    failClosed("[AETERNA] Invalid container media id");
  }

  const index = record["index"];
  if (
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index !== expectedLocalIndex
  ) {
    failClosed("[AETERNA] Invalid container chunk index");
  }

  const size = record["size"];
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_ENCRYPTED_CHUNK_SIZE
  ) {
    failClosed("[AETERNA] Invalid container chunk size");
  }
}

/* =========================
   LAYOUT CONSTRUCTION
   ========================= */

/**
 * Builds the canonical container layout.
 *
 * `items` is the ordered list of chunk-bearing media items; each
 * element is that item's ordered chunk metadata. Items that carry no
 * chunks (for example text items) are simply not included — a group
 * with zero chunks is rejected rather than silently ignored, because
 * it cannot be distinguished from a caller bug.
 *
 * Empty `items` is VALID and yields a header-only container.
 */
export function buildContainerLayout(
  items: readonly (readonly ChunkMetadata[])[]
): ContainerLayout {
  if (!Array.isArray(items)) {
    failClosed("[AETERNA] Invalid container item list");
  }

  const entries: ContainerEntry[] = [];
  const seenPositions = new Set<string>();
  const seenChunkIds = new Set<string>();

  let cursor = HEADER_SIZE;
  let globalIndex = 0;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const group = items[itemIndex];

    if (!Array.isArray(group) || group.length === 0) {
      failClosed("[AETERNA] Invalid container item");
    }

    for (let local = 0; local < group.length; local++) {
      const chunk = group[local];
      assertChunkMetadata(chunk, local);

      // A chunk is identified by its (mediaId, local index) position.
      const positionKey = `${chunk.mediaId}\u0000${chunk.index}`;
      if (seenPositions.has(positionKey)) {
        failClosed("[AETERNA] Duplicate container chunk position");
      }
      seenPositions.add(positionKey);

      if (seenChunkIds.has(chunk.chunkId)) {
        failClosed("[AETERNA] Duplicate container chunk id");
      }
      seenChunkIds.add(chunk.chunkId);

      if (globalIndex > MAX_UINT32) {
        failClosed("[AETERNA] Container chunk count overflow");
      }

      entries.push(
        Object.freeze({
          globalIndex,
          mediaId: chunk.mediaId,
          localIndex: chunk.index,
          chunkId: chunk.chunkId,
          offset: cursor,
          length: chunk.size,
        })
      );

      // Safe-integer arithmetic: the running offset may never leave
      // the safe-integer domain.
      cursor += chunk.size;
      if (!Number.isSafeInteger(cursor)) {
        failClosed("[AETERNA] Container offset overflow");
      }

      globalIndex += 1;
    }
  }

  const frozenEntries = Object.freeze(entries);

  return Object.freeze({
    headerSize: HEADER_SIZE,
    chunkCount: frozenEntries.length,
    containerSize: cursor,
    entries: frozenEntries,
    offsetOf(globalIndex_: number): number {
      return entryAt(frozenEntries, globalIndex_).offset;
    },
    lengthOf(globalIndex_: number): number {
      return entryAt(frozenEntries, globalIndex_).length;
    },
  });
}

/* =========================
   ACCESSORS
   ========================= */

function entryAt(
  entries: readonly ContainerEntry[],
  globalIndex: number
): ContainerEntry {
  if (
    !Number.isSafeInteger(globalIndex) ||
    globalIndex < 0 ||
    globalIndex >= entries.length
  ) {
    failClosed("[AETERNA] Container index out of range");
  }

  const entry = entries[globalIndex];
  if (!entry) {
    failClosed("[AETERNA] Container index out of range");
  }

  return entry;
}

/** Absolute byte offset of the chunk at `globalIndex`. */
export function offsetOf(
  layout: ContainerLayout,
  globalIndex: number
): number {
  return entryAt(layout.entries, globalIndex).offset;
}

/** Physical length of the chunk at `globalIndex`. */
export function lengthOf(
  layout: ContainerLayout,
  globalIndex: number
): number {
  return entryAt(layout.entries, globalIndex).length;
}

/** Entry (global position ↔ source chunk metadata) at `globalIndex`. */
export function entryOf(
  layout: ContainerLayout,
  globalIndex: number
): ContainerEntry {
  return entryAt(layout.entries, globalIndex);
}

/**
 * Maps a physical container byte offset to the entry that contains it.
 *
 * Fails closed for offsets inside the header area or at/after the end
 * of the container.
 */
export function entryAtByteOffset(
  layout: ContainerLayout,
  byteOffset: number
): ContainerEntry {
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < HEADER_SIZE ||
    byteOffset >= layout.containerSize
  ) {
    failClosed("[AETERNA] Container byte offset out of range");
  }

  let low = 0;
  let high = layout.entries.length - 1;

  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const entry = layout.entries[mid];
    if (!entry) {
      failClosed("[AETERNA] Container layout is inconsistent");
    }

    if (byteOffset < entry.offset) {
      high = mid - 1;
    } else if (byteOffset >= entry.offset + entry.length) {
      low = mid + 1;
    } else {
      return entry;
    }
  }

  failClosed("[AETERNA] Container byte offset out of range");
}

/* =========================
   HEADER SERIALIZATION
   ========================= */

/**
 * Serializes the canonical fixed-size header.
 *
 * Deterministic: the same `chunkCount` always yields identical bytes.
 * `reserved` is zero-filled by construction.
 */
export function serializeContainerHeader(
  chunkCount: number
): Uint8Array<ArrayBuffer> {
  if (
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 0 ||
    chunkCount > MAX_UINT32
  ) {
    failClosed("[AETERNA] Invalid container chunk count");
  }

  const bytes = new Uint8Array(HEADER_SIZE);

  bytes[HEADER_MAGIC_OFFSET + 0] = CONTAINER_MAGIC[0];
  bytes[HEADER_MAGIC_OFFSET + 1] = CONTAINER_MAGIC[1];
  bytes[HEADER_MAGIC_OFFSET + 2] = CONTAINER_MAGIC[2];
  bytes[HEADER_MAGIC_OFFSET + 3] = CONTAINER_MAGIC[3];

  bytes[HEADER_VERSION_OFFSET] = CONTAINER_VERSION;

  const view = new DataView(bytes.buffer);
  view.setUint16(HEADER_HEADER_SIZE_OFFSET, HEADER_SIZE, false);
  view.setUint32(HEADER_CHUNK_COUNT_OFFSET, chunkCount, false);

  return bytes;
}

/**
 * Parses and validates a canonical header.
 *
 * Fails closed on: wrong magic, unsupported version, unexpected
 * header size, non-zero reserved bytes, or a truncated buffer.
 */
export function parseContainerHeader(bytes: unknown): ContainerHeader {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_SIZE) {
    failClosed("[AETERNA] Invalid container header");
  }

  for (let i = 0; i < CONTAINER_MAGIC.length; i++) {
    if (bytes[HEADER_MAGIC_OFFSET + i] !== CONTAINER_MAGIC[i]) {
      failClosed("[AETERNA] Invalid container magic");
    }
  }

  const version = bytes[HEADER_VERSION_OFFSET] ?? -1;
  if (version !== CONTAINER_VERSION) {
    failClosed("[AETERNA] Unsupported container version");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const headerSize = view.getUint16(HEADER_HEADER_SIZE_OFFSET, false);
  if (headerSize !== HEADER_SIZE) {
    failClosed("[AETERNA] Unsupported container header size");
  }

  for (let i = HEADER_RESERVED_OFFSET; i < HEADER_SIZE; i++) {
    if (bytes[i] !== 0) {
      failClosed("[AETERNA] Non-zero container header reserved byte");
    }
  }

  const chunkCount = view.getUint32(HEADER_CHUNK_COUNT_OFFSET, false);

  return Object.freeze({ version, headerSize, chunkCount });
}
