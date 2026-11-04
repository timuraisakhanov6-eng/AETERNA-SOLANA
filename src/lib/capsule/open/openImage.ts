import type {
    OpenImageResult,
    OpenMediaRequest,
} from "./openTypes";

import type {
    ByteRuntime,
} from "../runtime/runtimeTypes";

import {
    assertInlinePreviewSize,
    MediaPreviewConstructionError,
} from "./mediaPreviewPolicy";

/**
 * Image Runtime.
 *
 * Responsible only for reconstructing the image
 * through ByteRuntime and creating an Object URL.
 *
 * An inline image preview materialises the WHOLE file in memory (one
 * decrypted buffer + one Blob), so the size gate runs BEFORE the read:
 * an oversized image is refused instead of being assembled just to be
 * previewed. ByteRuntime's lazy/chunked reads and LRU are untouched.
 */
export async function openImage(
    runtime: ByteRuntime,
    request: OpenMediaRequest,
    /**
     * R9-A87.7 (F3) - caller-scoped cancellation. The caller aborts this
     * signal when its own ceiling expires, so the read is actually torn down
     * instead of being abandoned mid-flight.
     */
    signal?: AbortSignal,
): Promise<OpenImageResult> {

    try {

        assertInlinePreviewSize(
            request.media.size,
            "Image",
        );

        /**
         * R9-A87.7 (F3) - the signal is forwarded only when the caller
         * supplied one. The legacy two-argument read shape is preserved
         * exactly, so an unchanged call site is not silently re-plumbed.
         */
        const bytes =
            signal === undefined
                ? await runtime.getBytes(
                      0,
                      request.media.size,
                  )
                : await runtime.getBytes(
                      0,
                      request.media.size,
                      signal,
                  );

        /**
         * The read has SUCCEEDED. Blob / object-URL construction is a
         * distinct, typed boundary: a failure here is a construction
         * failure, never a read failure. The original platform error
         * is retained only as `cause` for local debugging and is never
         * rendered.
         */
        try {

            const blob =
                new Blob(
                    [bytes],
                    {
                        type: request.media.mimeType,
                    },
                );

            return {

                objectUrl:
                    URL.createObjectURL(blob),

            };

        } catch (err) {

            throw new MediaPreviewConstructionError(err);

        }

    } finally {

        /**
         * Runtime ownership ends once the Blob has been
         * constructed (or the operation fails).
         *
         * Object URL owns the Blob afterwards.
         */
        runtime.dispose();

    }

}