import type {
    OpenMediaRequest,
    OpenVideoSession,
} from "./openTypes";

import type {
    ByteRuntime,
} from "../runtime/runtimeTypes";

/**
 * Opens a Runtime-managed video session.
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
export async function openVideo(
    runtime: ByteRuntime,
    _request: OpenMediaRequest,
): Promise<OpenVideoSession> {

    /**
     * Prevents further reads after the session
     * relinquishes ownership of the Runtime.
     */
    let disposed = false;

    const session: OpenVideoSession = {

        async read(
            start: number,
            end: number,
        ): Promise<Uint8Array> {

            if (disposed) {
                throw new Error(
                    "Video session has been disposed.",
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