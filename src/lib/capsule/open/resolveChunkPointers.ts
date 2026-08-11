/**
 * AETERNA — RFC-001 Runtime Resolution
 *
 * Resolves transport-independent ChunkMetadata[]
 * into PublishedChunkMetadata[] using
 * Manifest.ext.chunkPointers.
 *
 * This is the Runtime boundary between
 * Manifest Authority and ByteRuntime.
 *
 * Fail-Closed:
 *  - missing pointer -> throw
 *  - duplicate chunkId -> throw
 *  - unknown pointer -> throw
 */

import type {
  ChunkId,
} from "@/types/manifest";

import type {
  ChunkMetadata,
  PublishedChunkMetadata,
} from "@/types/vault";

import type {
  StoragePointer,
} from "@/lib/storage/storageAdapter";

export function resolveChunkPointers(
  chunks: readonly ChunkMetadata[],
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>,
): readonly PublishedChunkMetadata[] {

  const resolved: PublishedChunkMetadata[] = [];

  const seen = new Set<ChunkId>();

  for (const chunk of chunks) {

    if (seen.has(chunk.chunkId)) {

      throw new Error(
        `[AETERNA] Duplicate chunkId: ${chunk.chunkId}`
      );

    }

    seen.add(chunk.chunkId);

    const pointer = chunkPointers[chunk.chunkId];

    if (!pointer) {

      throw new Error(
        `[AETERNA] Missing storage pointer for chunk ${chunk.chunkId}`
      );

    }

    resolved.push(
      Object.freeze({
        ...chunk,
        pointer,
      })
    );

  }

  // Detect orphan pointers.
  for (const chunkId of Object.keys(chunkPointers) as ChunkId[]) {

    if (!seen.has(chunkId)) {

      throw new Error(
        `[AETERNA] Unknown chunkPointer: ${chunkId}`
      );

    }

  }

  return Object.freeze(resolved);

}