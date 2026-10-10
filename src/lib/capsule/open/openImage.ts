import type {
    OpenImageResult,
    OpenMediaRequest,
} from "./openTypes";

import type {
    ByteRuntime,
} from "../runtime/runtimeTypes";

import {
    assertInlinePreviewSize,
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
): Promise<OpenImageResult> {

    try {

        assertInlinePreviewSize(
            request.media.size,
            "Image",
        );

        const bytes =
            await runtime.getBytes(
                0,
                request.media.size,
            );

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