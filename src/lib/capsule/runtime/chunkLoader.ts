/**
 * =========================================================
 * AETERNA Chunk Loader
 * =========================================================
 *
 * Downloads one encrypted chunk from Storage,
 * decrypts it,
 * returns the decrypted bytes.
 *
 * Canonical Runtime storage adapter.
 */

import type { PublishedChunkMetadata } from "@/types/vault";

import { storage } from "@/lib/storage/storage";
import { decryptChunk } from "@/lib/crypto/decryptChunk";

/**
 * Canonical detached-buffer guard.
 *
 * A Uint8Array can appear non-empty at the view level
 * while its backing ArrayBuffer has been detached.
 *
 * finally blocks must never throw while attempting to
 * wipe temporary ciphertext buffers.
 */
function isDetachedBuffer(
    arr: Uint8Array,
): boolean {

    return (
        arr.byteLength === 0 ||
        arr.buffer.byteLength === 0
    );

}

export async function loadChunk(
    capsuleId: string,
    chunk: PublishedChunkMetadata,
    cryptoKey: CryptoKey,
): Promise<Uint8Array> {

    const encrypted =
        await storage.download(
            chunk.pointer,
        );

    if (
        !(encrypted instanceof Uint8Array) ||
        encrypted.byteLength === 0
    ) {
        throw new Error(
            "[AETERNA] Chunk download failed",
        );
    }

    try {

        return await decryptChunk(
            encrypted,
            cryptoKey,
            chunk.index,
            capsuleId,
        );

    } finally {

        if (!isDetachedBuffer(encrypted)) {
            encrypted.fill(0);
        }

    }

}