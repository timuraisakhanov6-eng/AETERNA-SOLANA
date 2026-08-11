/**
 * =========================================================
 * AETERNA Open Runtime Types
 * =========================================================
 *
 * Canonical data contracts for the Open Runtime Layer.
 *
 * These structures describe Runtime entry points and media
 * session contracts.
 *
 * They are implementation-only and MUST NEVER become part of:
 *
 * - Manifest
 * - Vault
 * - Capability
 * - Protocol State
 * - Authority Model
 */

import type {
    MediaItemV2,
    PublishedChunkMetadata,
} from "@/types/vault";

/**
 * Runtime-facing media item.
 *
 * Identical to MediaItemV2 except `chunks`, which has already
 * been resolved from Vault's transport-independent ChunkMetadata[]
 * to PublishedChunkMetadata[] via resolveChunkPointers() (RFC-001
 * §4, §7) *before* an OpenMediaRequest is constructed.
 *
 * This type intentionally diverges from MediaItemV2 rather than
 * reusing it: MediaItemV2 is the Vault's canonical shape and must
 * never carry `pointer` (see vault.ts). Runtime, on the other side
 * of the resolution boundary, always needs `pointer` to be present.
 * Reusing MediaItemV2 here would let a request be constructed with
 * unresolved chunks and only fail deep inside ByteRuntime.
 */
export interface OpenableMediaItem
    extends Omit<MediaItemV2, "chunks"> {

    readonly chunks:
        readonly PublishedChunkMetadata[];

}

/**
 * Common media opening request.
 */
export interface OpenMediaRequest {

    readonly capsuleId: string;

    readonly cryptoKey: CryptoKey;

    readonly media: OpenableMediaItem;

}

/**
 * Image opening result.
 *
 * Image Runtime fully reconstructs the image before
 * returning an object URL.
 */
export interface OpenImageResult {

    readonly objectUrl: string;

}

/**
 * Base Media Runtime session.
 *
 * Owns Runtime resources for a single opened media object.
 *
 * Browser adapters (Service Worker, HTMLMediaElement,
 * download helpers, etc.) live above this layer.
 */
export interface MediaSession {

    /**
     * Returns the requested byte range.
     *
     * Implementations must fail closed for invalid ranges
     * or after the session has been disposed.
     */
    read(
        start: number,
        end: number,
    ): Promise<Uint8Array>;

    /**
     * Releases all Runtime-owned resources.
     *
     * Must be idempotent.
     */
    dispose(): void;

}

/**
 * Video Runtime session.
 */
export interface OpenVideoSession
    extends MediaSession {

}

/**
 * Audio Runtime session.
 */
export interface OpenAudioSession
    extends MediaSession {

}

/**
 * Download Runtime session.
 */
export interface DownloadFileSession
    extends MediaSession {

}