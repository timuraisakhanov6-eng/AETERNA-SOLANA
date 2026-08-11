import type {
  ChunkPointer,
  ChunkPointerRegistry,
  PublishedChunkMetadata,
} from "@/types/vault";

const REGISTRY_ERROR =
  new Error(
    "[AETERNA] Chunk Pointer Registry creation failed"
  );

export function createChunkPointerRegistry(
  uploadedChunks: readonly PublishedChunkMetadata[],
): ChunkPointerRegistry {

  try {

    const pointers: ChunkPointer[] =
      uploadedChunks.map(
        (chunk) =>
          Object.freeze({

            chunkId:
              chunk.chunkId,

            pointer:
              chunk.pointer,

          })
      );

    return Object.freeze({

      pointers:
        Object.freeze(
          pointers
        ),

    });

  }

  catch {

    throw REGISTRY_ERROR;

  }

}