import type {
    ByteRuntime,
} from "../runtime/runtimeTypes";

import type {
    OpenAudioSession,
    OpenMediaRequest,
} from "./openTypes";

/**
 * Opens a Runtime-managed audio session.
 *
 * This layer owns only the Media Runtime session.
 *
 * It MUST NOT know:
 *
 * - Storage
 * - Crypto
 * - Chunk layout
 * - Browser APIs
 * - Service Worker
 * - HTTP
 */
export async function openAudio(
    runtime: ByteRuntime,
    _request: OpenMediaRequest,
): Promise<OpenAudioSession> {

    /**
     * Prevents further reads after the session
     * relinquishes ownership of the Runtime.
     */
    let disposed = false;

    const session: OpenAudioSession = {

        async read(
            start: number,
            end: number,
        ): Promise<Uint8Array> {

            if (disposed) {
                throw new Error(
                    "Audio session has been disposed.",
                );
            }

            if (
                !Number.isInteger(start) ||
                !Number.isInteger(end)
            ) {
                throw new Error(
                    "Range bounds must be integers.",
                );
            }

            if (
                start < 0 ||
                end <= start
            ) {
                throw new Error(
                    "Invalid byte range.",
                );
            }

            return runtime.getBytes(
                start,
                end,
            );

        },

        dispose(): void {

            if (disposed) {
                return;
            }

            disposed = true;

            runtime.dispose();

        },

    };

    return session;

}