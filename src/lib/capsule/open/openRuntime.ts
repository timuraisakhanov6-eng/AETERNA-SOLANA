/**
 * =========================================================
 * AETERNA Open Runtime
 * =========================================================
 *
 * Public Runtime API used by the presentation layer.
 *
 * VaultRenderer MUST communicate only with this module.
 *
 * Runtime hides:
 *
 * - Storage
 * - Crypto
 * - Chunk retrieval
 * - Reconstruction
 * - Streaming
 * - Memory lifetime
 *
 * Runtime is implementation-only.
 *
 * Runtime NEVER becomes part of:
 *
 * - Manifest
 * - Vault
 * - Capability
 * - Authority Model
 * - Protocol Layer
 */

import type {
    OpenMediaRequest,
    OpenImageResult,
    OpenVideoSession,
    OpenAudioSession,
    DownloadFileSession,
} from "./openTypes";

import type {
    ByteRuntime,
} from "../runtime/runtimeTypes";

import { createByteRuntime } from "../runtime/byteRuntime";
import { openImage as openImageRuntime } from "./openImage";
import { openVideo as openVideoRuntime } from "./openVideo";
import { openAudio as openAudioRuntime } from "./openAudio";
import {
    downloadFile as downloadFileRuntime,
} from "./downloadFile";

/**
 * Internal helper.
 *
 * Creates a fresh ByteRuntime for a single open request.
 *
 * Every call to openImage/openVideo/openAudio/downloadFile
 * owns exactly one ByteRuntime instance — its cache, its
 * decrypted chunks, its lifetime. openRuntime.ts itself never
 * touches chunks, offsets, or decryption; that is entirely
 * ByteRuntime's responsibility now.
 */
function createRuntime(
    request: OpenMediaRequest,
): ByteRuntime {

    return createByteRuntime(
        request.capsuleId,
        request.cryptoKey,
        request.media.chunks,
        request.media.size,
    );

}

/**
 * Image opening.
 *
 * Image is a one-shot read: the full byte range is fetched,
 * handed to openImage(), and the runtime is disposed
 * immediately afterward — there is no ongoing session to keep
 * it alive for.
 */
export async function openImage(
    request: OpenMediaRequest,
): Promise<OpenImageResult> {

    const runtime =
        createRuntime(request);

    try {

        return await openImageRuntime(
            runtime,
            request,
        );

    } finally {

        runtime.dispose();

    }

}

/**
 * Video runtime.
 *
 * Video is a long-lived session: playback seeks around the
 * byte range repeatedly, so the runtime must stay alive for
 * the lifetime of the session, not just for this call.
 * Ownership of runtime.dispose() passes to the returned
 * session — openVideoRuntime() is responsible for calling
 * runtime.dispose() when the session itself is closed.
 */
export async function openVideo(
    request: OpenMediaRequest,
): Promise<OpenVideoSession> {

    const runtime =
        createRuntime(request);

    return openVideoRuntime(
        runtime,
        request,
    );

}

/**
 * Audio runtime.
 *
 * Same session lifetime rules as openVideo(): the runtime is
 * handed off, and openAudioRuntime() owns disposing it when
 * the audio session closes.
 */
export async function openAudio(
    request: OpenMediaRequest,
): Promise<OpenAudioSession> {

    const runtime =
        createRuntime(request);

    return openAudioRuntime(
        runtime,
        request,
    );

}

/**
 * File runtime.
 *
 * A download session streams the full range once. Ownership
 * of runtime.dispose() passes to downloadFileRuntime(), which
 * must dispose it once the download completes or is aborted.
 */
export async function downloadFile(
    request: OpenMediaRequest,
): Promise<DownloadFileSession> {

    const runtime =
        createRuntime(request);

    return downloadFileRuntime(
        runtime,
        request,
    );

}