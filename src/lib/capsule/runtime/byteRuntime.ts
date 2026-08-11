/**
 * =========================================================
 * AETERNA Byte Runtime
 * =========================================================
 *
 * Canonical Execution Layer.
 *
 * Responsibilities:
 *
 *  • reconstruct arbitrary byte ranges;
 *  • lazily load encrypted chunks;
 *  • decrypt chunks on demand;
 *  • reuse decrypted chunks;
 *  • return contiguous byte ranges.
 *
 * ByteRuntime MUST NEVER:
 *
 * • know Browser
 * • know HTML
 * • know Blob
 * • know Service Worker
 * • know Video
 * • know Audio
 * • know Image
 * • know HTTP
 * • modify Manifest
 * • modify Vault
 * • become Protocol Authority.
 */
import type {
    PublishedChunkMetadata,
} from "@/types/vault";
import type {
    ByteRuntime,
} from "./runtimeTypes";
import { loadChunk } from "./chunkLoader";
import {
    MAX_CHUNK_SIZE,
    AES_GCM_IV_LENGTH,
    AES_GCM_TAG_LENGTH,
} from "@/lib/crypto/constants";

/**
 * Ciphertext overhead added per chunk by AES-GCM:
 * 12-byte IV + 16-byte auth tag (128 bits).
 *
 * Used only to sanity-check chunk.size (a transport/crypto
 * value) against the independently-derived plaintext length.
 * Never used to compute file offsets.
 */
const CHUNK_CIPHERTEXT_OVERHEAD =
    AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH / 8;

interface ByteMapEntry {
    readonly chunk: PublishedChunkMetadata;
    readonly fileOffset: number;
    readonly length: number;
}

/**
 * A single instruction in a read plan: read `length` bytes
 * from `chunk` starting at `chunkOffset`, and place them at
 * `outputOffset` in the destination buffer.
 */
interface ReadPlanEntry {
    readonly chunk: PublishedChunkMetadata;
    readonly chunkOffset: number;
    readonly outputOffset: number;
    readonly length: number;
}

interface ByteMap {
    readonly entries: readonly ByteMapEntry[];
    readonly fileSize: number;
}

/**
 * Builds the byte map that drives all offset arithmetic.
 *
 * IMPORTANT: chunk.size (ChunkMetadata.size, see prepareMediaChunks.ts)
 * is the *ciphertext* length — plaintext + 12-byte IV + 16-byte GCM tag.
 * It is canonical, serialized Vault data and MUST NOT change meaning.
 *
 * Plaintext chunk length is therefore never read from chunk.size.
 * It is instead derived independently from `plaintextSize` (the
 * media item's total logical size) and the canonical MAX_CHUNK_SIZE
 * protocol constant — the same constant prepareMediaChunks.ts used
 * to cut the file into chunks in the first place. Since chunking is
 * deterministic (fixed-size chunks except the final, shorter one),
 * this fully reconstructs each chunk's plaintext length without
 * touching the canonical serialization format.
 *
 * chunk.size is still validated here, but only as a ciphertext
 * sanity check (transport/crypto layer), never for offset math.
 */
function buildByteMap(
    chunks: readonly PublishedChunkMetadata[],
    plaintextSize: number,
): ByteMap {

    if (chunks.length === 0) {
        throw new Error(
            "Missing chunk metadata.",
        );
    }

    if (
        !Number.isSafeInteger(plaintextSize) ||
        plaintextSize <= 0
    ) {
        throw new Error(
            "Invalid media size.",
        );
    }

    const entries: ByteMapEntry[] = [];

    let fileOffset = 0;
    let expectedIndex = 0;

    for (const chunk of chunks) {

        if (chunk.index !== expectedIndex) {
            throw new Error(
                "Invalid chunk sequence.",
            );
        }

        if (!Number.isInteger(chunk.size)) {
            throw new Error(
                "Chunk size must be an integer.",
            );
        }

        if (chunk.size <= 0) {
            throw new Error(
                "Chunk size must be positive.",
            );
        }

        // Deterministic plaintext length for this chunk: every
        // chunk is exactly MAX_CHUNK_SIZE except possibly the
        // last one, which holds the remainder.
        const plaintextLength =
            Math.min(
                MAX_CHUNK_SIZE,
                plaintextSize - fileOffset,
            );

        if (plaintextLength <= 0) {
            throw new Error(
                "Chunk metadata exceeds media size.",
            );
        }

        // Sanity check only: ciphertext size must match the
        // expected plaintext length plus fixed AES-GCM overhead.
        // This does not participate in offset computation.
        if (
            chunk.size !==
            plaintextLength + CHUNK_CIPHERTEXT_OVERHEAD
        ) {
            throw new Error(
                "Chunk ciphertext size does not match expected plaintext length.",
            );
        }

        const nextOffset =
            fileOffset + plaintextLength;

        if (!Number.isSafeInteger(nextOffset)) {
            throw new Error(
                "Invalid file size.",
            );
        }

        const entry = Object.freeze({

            chunk,

            fileOffset,

            length: plaintextLength,

        });

        entries.push(entry);

        fileOffset = nextOffset;
        expectedIndex++;

    }

    if (fileOffset !== plaintextSize) {
        throw new Error(
            "Reconstructed size does not match media size.",
        );
    }

    return Object.freeze({
        entries: Object.freeze(entries),
        fileSize: fileOffset,
    });

}

/**
 * Finds the index of the first ByteMapEntry whose range
 * [fileOffset, fileOffset + length) intersects the given
 * position. Assumes entries is sorted and contiguous.
 */
function findFirstEntryIndex(
    entries: readonly ByteMapEntry[],
    position: number,
): number {

    let low = 0;
    let high = entries.length - 1;

    while (low < high) {

        const mid =
            (low + high) >>> 1;

        const entry = entries[mid];

        if (!entry) {
            throw new Error(
                "Invalid byte map.",
            );
        }

        const entryEnd =
            entry.fileOffset + entry.length;

        if (entryEnd <= position) {
            low = mid + 1;
        } else {
            high = mid;
        }

    }

    return low;

}

/**
 * Resolves a byte range [start, end) into an ordered read
 * plan: a list of (chunk, chunkOffset, outputOffset, length)
 * instructions that, executed in order, reconstruct exactly
 * the requested range into a contiguous output buffer.
 *
 * Pure function: performs no I/O, no decryption, no caching.
 * All range arithmetic lives here, and nowhere else.
 */
function resolveRange(
    byteMap: ByteMap,
    start: number,
    end: number,
): readonly ReadPlanEntry[] {

    if (
        !Number.isInteger(start) ||
        !Number.isInteger(end)
    ) {
        throw new Error(
            "Range bounds must be integers.",
        );
    }

    if (start < 0 || end <= start) {
        throw new Error(
            "Invalid byte range.",
        );
    }

    if (end > byteMap.fileSize) {
        throw new Error(
            "Byte range exceeds file length.",
        );
    }

    const { entries } = byteMap;

    const firstIndex =
        findFirstEntryIndex(entries, start);

    const plan: ReadPlanEntry[] = [];

    let outputOffset = 0;

    for (let i = firstIndex; i < entries.length; i++) {

        const entry = entries[i];

        if (!entry) {
            throw new Error(
                "Invalid byte map.",
            );
        }

        if (entry.fileOffset >= end) {
            break;
        }

        const entryEnd =
            entry.fileOffset + entry.length;

        const sliceStart =
            Math.max(start, entry.fileOffset);

        const sliceEnd =
            Math.min(end, entryEnd);

        const length =
            sliceEnd - sliceStart;

        if (length <= 0) {
            continue;
        }

        const chunkOffset =
            sliceStart - entry.fileOffset;

        const nextOutput =
            outputOffset + length;

        if (!Number.isSafeInteger(nextOutput)) {
            throw new Error(
                "Output range overflow.",
            );
        }

        const planEntry = Object.freeze({

            chunk: entry.chunk,

            chunkOffset,

            outputOffset,

            length,

        });

        plan.push(planEntry);

        outputOffset = nextOutput;

    }

    return Object.freeze(plan);

}

export function createByteRuntime(
    capsuleId: string,
    cryptoKey: CryptoKey,
    chunks: readonly PublishedChunkMetadata[],
    plaintextSize: number,
): ByteRuntime {
    const byteMap =
        buildByteMap(chunks, plaintextSize);
    /**
     * Decrypted chunk cache.
     *
     * Owned exclusively by this runtime instance.
     *
     * Keyed by chunk.index — decrypted plaintext, ready to be
     * sliced and copied into output buffers on demand.
     */
    const cache =
        new Map<number, Uint8Array>();

    /**
     * Returns the fully decrypted bytes for a single chunk,
     * reusing the cache when possible.
     *
     * Sole responsibility: cache lookup, or delegate to
     * loadChunk() and populate the cache. No range math,
     * no output copying.
     */
    async function getChunkBytes(
        chunk: PublishedChunkMetadata,
    ): Promise<Uint8Array> {

        const cached =
            cache.get(chunk.index);

        if (cached) {
            return cached;
        }

        const decrypted =
            await loadChunk(
                capsuleId,
                chunk,
                cryptoKey,
            );

        cache.set(chunk.index, decrypted);

        return decrypted;

    }

    /**
     * Executes a read plan against already-decrypted chunk
     * bytes, copying each segment into its designated slot
     * in the output buffer.
     *
     * Sole responsibility: subarray + copy. No caching,
     * no I/O, no decryption.
     *
     * Fail-closed: verifies each plan entry and chunk entry
     * actually exist and are long enough to satisfy the plan
     * before slicing. A mismatch here means corrupted data, a
     * decryptChunk() bug, or a chunk.size that no longer
     * matches reality — any of which must stop the read, not
     * silently truncate or crash on undefined.
     */
    function copySegments(
        plan: readonly ReadPlanEntry[],
        chunkBytes: readonly Uint8Array[],
        output: Uint8Array,
    ): void {

        for (let i = 0; i < plan.length; i++) {

            const entry = plan[i];
            const bytes = chunkBytes[i];

            if (!entry || !bytes) {
                throw new Error(
                    "Missing plan entry or decrypted chunk.",
                );
            }

            if (
                entry.chunkOffset + entry.length >
                bytes.length
            ) {
                throw new Error(
                    "Chunk length mismatch.",
                );
            }

            const segment =
                bytes.subarray(
                    entry.chunkOffset,
                    entry.chunkOffset + entry.length,
                );

            output.set(
                segment,
                entry.outputOffset,
            );

        }

    }

    return Object.freeze({
        async getBytes(
            start: number,
            end: number,
        ): Promise<Uint8Array> {

            const plan =
                resolveRange(byteMap, start, end);

            const outputLength =
                end - start;

            if (outputLength <= 0) {
                throw new Error(
                    "Invalid byte range.",
                );
            }

            /**
             * Defensive integrity check: the plan built by
             * resolveRange() must account for exactly
             * outputLength bytes. This guards against any
             * future bug in resolveRange() producing a plan
             * that under- or over-covers the requested range —
             * cheap to compute, and fails closed instead of
             * silently returning a corrupt or short buffer.
             */
            const plannedLength =
                plan.reduce(
                    (sum, entry) => sum + entry.length,
                    0,
                );

            if (plannedLength !== outputLength) {
                throw new Error(
                    "Read plan length mismatch.",
                );
            }

            /**
             * Chunks are loaded sequentially, not via
             * Promise.all(). This keeps memory and network/CPU
             * usage bounded and deterministic — a range that
             * spans many chunks (e.g. large video seeks) will
             * not trigger an unbounded burst of concurrent
             * downloads and AES decryptions.
             *
             * If throughput ever needs improving, bounded
             * concurrency (e.g. 2–4 chunks at a time) should
             * replace this loop — never unbounded Promise.all().
             */
            const chunkBytes: Uint8Array[] = [];

            try {

                for (const entry of plan) {

                    chunkBytes.push(
                        await getChunkBytes(entry.chunk),
                    );

                }

                const output =
                    new Uint8Array(outputLength);

                copySegments(plan, chunkBytes, output);

                return output;

            } finally {

                // Release the temporary reference list even if
                // an error occurred mid-load or during copy. The
                // underlying decrypted bytes remain alive in
                // `cache`, which is intentional.
                chunkBytes.length = 0;

            }

        },
        dispose() {
            /**
             * Only clears what this runtime owns: the decrypted
             * chunk cache. cryptoKey is not zeroed here — this
             * runtime did not create the key and does not know
             * its owner, so it is not this runtime's decision to
             * destroy it. That responsibility belongs to whoever
             * owns the key's lifecycle (openRuntime.ts).
             */
            for (const bytes of cache.values()) {
                bytes.fill(0);
            }
            cache.clear();
        },
    });
}