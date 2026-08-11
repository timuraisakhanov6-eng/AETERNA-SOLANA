import type {
    OpenImageResult,
    OpenMediaRequest,
} from "./openTypes";

import type {
    ByteRuntime,
} from "../runtime/runtimeTypes";

/**
 * Image Runtime.
 *
 * Responsible only for reconstructing the image
 * through ByteRuntime and creating an Object URL.
 */
export async function openImage(
    runtime: ByteRuntime,
    request: OpenMediaRequest,
): Promise<OpenImageResult> {

    try {

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