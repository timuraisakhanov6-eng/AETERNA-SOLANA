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
import { ChunkLoadError } from "./chunkLoadFailure";

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

    /**
     * Trusted, digest-verified container totals for the bounded
     * full-container fallback. They are OPTIONAL: a resolution that does
     * not carry them (or carries anything but safe integers) simply keeps
     * the pure Range path. They are NEVER taken from a response — they come
     * from the verified Stage 2 layout.
     */
    let containerHint:
        { size: number; chunkCount: number } | undefined;

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

        const containerSize = container.containerSize;
        const containerChunkCount = container.containerChunkCount;

        if (
            typeof containerSize === "number" &&
            Number.isSafeInteger(containerSize) &&
            containerSize > 0 &&
            typeof containerChunkCount === "number" &&
            Number.isSafeInteger(containerChunkCount) &&
            containerChunkCount >= 1
        ) {
            containerHint = {
                size: containerSize,
                chunkCount: containerChunkCount,
            };
        }
    }

    /**
     * The 4th argument is passed ONLY when a trusted container hint exists,
     * so a legacy (non-container) read keeps the EXACT pre-existing
     * three-argument call.
     */
    const encrypted =
        containerHint === undefined
            ? await storage.downloadRange(
                  chunk.pointer,
                  offset,
                  expectedLength,
              )
            : await storage.downloadRange(
                  chunk.pointer,
                  offset,
                  expectedLength,
                  containerHint,
              );

    /**
     * Exact-length contract: the returned window must be precisely
     * the expected ciphertext length. Anything else fails closed
     * before the bytes reach the decryptor.
     *
     * Typed (`chunk-length-mismatch`) so the media diagnostic layer
     * can distinguish a length/transport mismatch from a decrypt
     * rejection — the message text is unchanged.
     */
    if (
        !(encrypted instanceof Uint8Array) ||
        encrypted.byteLength !== expectedLength
    ) {
        throw new ChunkLoadError("chunk-length-mismatch");
    }

    try {

        return await decryptChunk(
            encrypted,
            cryptoKey,
            chunk.index,
            capsuleId,
        );

    } catch {

        /**
         * AES-GCM rejection (bad tag / key / IV) — typed as
         * `chunk-decrypt-failed`. A detached/mismatched buffer that
         * reaches the decryptor is also reported here; both are
         * "the bytes were present but unusable", which the diagnostic
         * layer treats identically and safely.
         */
        throw new ChunkLoadError("chunk-decrypt-failed");

    } finally {

        if (!isDetachedBuffer(encrypted)) {
            encrypted.fill(0);
        }

    }

}