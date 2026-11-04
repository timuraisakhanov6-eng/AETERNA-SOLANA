import type {
    OpenMediaRequest,
    OpenVideoSession,
} from "./openTypes";

import type {
    ByteRuntime,
} from "../runtime/runtimeTypes";

import {
    createSessionReadGuard,
} from "./sessionReadGuard";

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

    const guard = createSessionReadGuard();

    const session: OpenVideoSession = {

        async read(
            start: number,
            end: number,
            signal?: AbortSignal,
        ): Promise<Uint8Array<ArrayBuffer>> {

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

            /**
             * R9-A87.7 (F3) - the read runs under a controller owned by
             * THIS session: a caller abort reaches the storage stream, and
             * disposing the session aborts the read even if the caller's
             * signal never fires.
             */
            return guard.run(
                signal,
                (linked) =>
                    runtime.getBytes(
                        start,
                        end,
                        linked,
                    ),
            );

        },

        dispose(): void {

            if (disposed) {
                return;
            }

            disposed = true;

            // Abort any read still in flight BEFORE the runtime cache dies.
            guard.dispose();

            runtime.dispose();

        },

    };

    return session;

}