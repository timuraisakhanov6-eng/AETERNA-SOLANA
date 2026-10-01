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

    /**
     * Expected encrypted chunk length.
     *
     * In the CURRENT multi-DataItem layout every chunk is already its
     * own DataItem, so the object's total length IS the chunk length.
     * The range read is therefore offset=0 / length=chunk.size —
     * byte-identical to the previous whole-object download, but
     * routed through the bounded range primitive.
     *
     * `chunk.size` (ChunkMetadata.size) is the CIPHERTEXT length:
     * plaintext + 12-byte IV + 16-byte GCM tag. It is canonical
     * serialized Vault data and its meaning MUST NOT change
     * (see prepareMediaChunks.ts / byteRuntime.ts).
     *
     * Container offsets are NOT implemented here — this remains a
     * single-DataItem read per chunk.
     */
    const expectedLength =
        chunk.size;

    if (
        !Number.isSafeInteger(expectedLength) ||
        expectedLength <= 0
    ) {
        throw new Error(
            "[AETERNA] Invalid chunk metadata",
        );
    }

    /**
     * Read window inside the source object.
     *
     * LEGACY (per-chunk DataItem): the pointer identifies an object that IS
     * the chunk, so the window starts at offset 0. This is unchanged.
     *
     * CONTAINER (Stage 4 / Model 3): every logical chunk lives in ONE
     * container DataItem, so the window is the chunk's DERIVED position.
     * The offset is never persisted — it comes from the Stage 2 layout via
     * `resolveContainerChunks()`.
     */
    const container = chunk.container;

    let offset = 0;

    if (container !== undefined) {
        if (
            container.containerTxId !== chunk.pointer ||
            container.length !== expectedLength ||
            !Number.isSafeInteger(container.offset) ||
            container.offset < 0 ||
            !Number.isSafeInteger(container.globalIndex) ||
            container.globalIndex < 0
        ) {
            throw new Error(
                "[AETERNA] Invalid chunk container position",
            );
        }

        offset = container.offset;
    }

    const encrypted =
        await storage.downloadRange(
            chunk.pointer,
            offset,
            expectedLength,
        );

    /**
     * Exact-length contract: the returned window must be precisely
     * the expected ciphertext length. Anything else fails closed
     * before the bytes reach the decryptor.
     */
    if (
        !(encrypted instanceof Uint8Array) ||
        encrypted.byteLength !== expectedLength
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