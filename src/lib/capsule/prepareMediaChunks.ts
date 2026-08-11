import type {
  CapsuleItem,
} from "@/types/capsule";

import type {
  PreparedMediaResult,
  ChunkMetadata,
} from "@/types/vault";

import type {
  RuntimeStorage,
} from "@/lib/runtime/runtimeStorage";

import {
  MAX_CHUNK_SIZE,
} from "@/lib/crypto/constants";

import {
  deriveChunkBaseIV,
} from "@/lib/crypto/deriveChunkBaseIV";

import {
  encryptChunk,
} from "@/lib/crypto/encryptChunk";

import {
  sha256,
} from "@/lib/crypto/sha256";

const PREPARE_MEDIA_ERROR =
  new Error(
    "[AETERNA] prepareMediaChunks failed"
  );

export async function prepareMediaChunks(
  capsuleId: string,
  items: CapsuleItem[],
  getMediaFile: (
    id: string
  ) => File | undefined,
  key: CryptoKey,
  runtime: RuntimeStorage,
): Promise<PreparedMediaResult> {

  const chunkMetadata: ChunkMetadata[] = [];

  let plaintextBytes = 0;

  let encryptedBytes = 0;

  try {

    for (const item of items) {

      if (item.type !== "media") {
        continue;
      }

      const file =
        getMediaFile(
          item.id
        );

      if (!file) {
        throw PREPARE_MEDIA_ERROR;
      }

      plaintextBytes += file.size;

      const baseIV =
        await deriveChunkBaseIV(
          capsuleId,
          item.id
        );

      let offset = 0;

      let chunkIndex = 0;

      while (
        offset < file.size
      ) {

        const end =
          Math.min(
            offset + MAX_CHUNK_SIZE,
            file.size
          );

        const blob =
          file.slice(
            offset,
            end
          );

        const buffer =
          await blob.arrayBuffer();

        const plaintext =
          new Uint8Array(
            buffer
          );

        let ciphertext: Uint8Array | null = null;

        try {

          if (
            plaintext.byteLength === 0
          ) {
            throw PREPARE_MEDIA_ERROR;
          }

          ciphertext =
            await encryptChunk(
              plaintext,
              key,
              baseIV,
              chunkIndex,
              capsuleId
            );

          if (
            ciphertext.byteLength === 0
          ) {
            throw PREPARE_MEDIA_ERROR;
          }

          const chunkId =
            await sha256(
              ciphertext
            );

          if (
            chunkId.length !== 64
          ) {
            throw PREPARE_MEDIA_ERROR;
          }

          const metadata: ChunkMetadata = {
            chunkId,
            mediaId: item.id,
            index: chunkIndex,
            size: ciphertext.byteLength,
          };

          const frozenMetadata =
            Object.freeze(
              metadata
            );

          chunkMetadata.push(
            frozenMetadata
          );

          await runtime.store({
            chunkId,
            mediaId: item.id,
            chunkIndex,
            ciphertext,
          });

          encryptedBytes += ciphertext.byteLength;

        } finally {

          // Zero out sensitive buffers after use
          try {
            plaintext.fill(0);
          } catch {}

          try {
            ciphertext?.fill(0);
          } catch {}

        }

        offset = end;

        chunkIndex++;

      }

    }

    return Object.freeze({

      chunkMetadata:
        Object.freeze(
          chunkMetadata
        ),

      plaintextBytes,

      encryptedBytes,

    });

  } catch {

    throw PREPARE_MEDIA_ERROR;

  }

}