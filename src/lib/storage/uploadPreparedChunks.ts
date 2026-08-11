import { storage } from "@/lib/storage";

import type {
  ChunkMetadata,
  PublishedChunkMetadata,
} from "@/types/vault";

import type {
  RuntimeStorage,
} from "@/lib/runtime/runtimeStorage";

import {
  assertStoragePointer,
} from "@/lib/storage/storageAdapter";

import type {
  UploadToken,
} from "@/lib/storage/storageAdapter";

export async function uploadPreparedChunks(
  runtime: RuntimeStorage,
  chunkMetadata: readonly ChunkMetadata[],
  uploadToken: UploadToken,
): Promise<
  readonly PublishedChunkMetadata[]
> {

  if (chunkMetadata.length === 0) {
    return Object.freeze([]);
  }

  const uploaded: PublishedChunkMetadata[] = [];

  for (const metadata of chunkMetadata) {

    const chunk =
      await runtime.read(
        metadata.chunkId
      );

    try {

      const result =
        await storage.uploadChunk(
          chunk.ciphertext,
          metadata.chunkId,
          uploadToken
        );

      // Validate the storage pointer before removing
      // the temporary Runtime copy.
      const pointer =
        assertStoragePointer(
          result.txId
        );

      // Runtime data is removed only after
      // successful upload + pointer validation.
      await runtime.remove(
        metadata.chunkId
      );

      uploaded.push(
        Object.freeze({

          chunkId:
            metadata.chunkId,

          mediaId:
            metadata.mediaId,

          index:
            metadata.index,

          size:
            metadata.size,

          pointer,

        })
      );

    } finally {

      /**
       * Canonical memory hygiene.
       *
       * The Runtime copy has already been consumed.
       * Wipe the temporary in-memory ciphertext
       * regardless of upload outcome.
       */

      chunk.ciphertext.fill(0);

    }

  }

  return Object.freeze(
    uploaded
  );

}