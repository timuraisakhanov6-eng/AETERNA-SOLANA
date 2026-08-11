/**
 * =========================================================
 * AETERNA Load Chunk
 * =========================================================
 *
 * Thin Runtime adapter.
 *
 * Delegates loading and decryption of a single chunk to the
 * canonical Chunk Loader.
 *
 * Responsibilities:
 *
 * • expose a stable Runtime API;
 * • delegate work;
 *
 * MUST NEVER:
 *
 * • access Storage directly;
 * • perform decryption;
 * • perform caching;
 * • perform range calculations;
 * • know Browser objects.
 */

import type { PublishedChunkMetadata } from "@/types/vault";

import { loadChunk as loadChunkSource } from "./chunkLoader";

export async function loadChunk(
    capsuleId: string,
    chunk: PublishedChunkMetadata,
    cryptoKey: CryptoKey,
): Promise<Uint8Array> {

    return loadChunkSource(
        capsuleId,
        chunk,
        cryptoKey,
    );

}