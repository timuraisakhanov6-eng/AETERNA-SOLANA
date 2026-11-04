/**
 * =========================================================
 * AETERNA - Session read guard
 * =========================================================
 *
 * R9-A87.7 (F3) - SESSION-OWNED READ CANCELLATION.
 *
 * A MediaSession can be disposed while one of its reads is still in flight:
 * the capsule was closed, the item was replaced, or the caller gave up. Before
 * this module existed, `dispose()` only flipped a flag and cleared the runtime
 * cache, so the read continued to the storage layer's own ceiling and could
 * still hand bytes back to a consumer that no longer existed.
 *
 * The guard owns every read the session starts:
 *
 *   - it links the CALLER's signal to a per-read controller, so a caller
 *     timeout reaches the storage stream;
 *   - it aborts those controllers when the SESSION is disposed, so a disposed
 *     session never leaves an orphaned read behind;
 *   - it touches no storage, crypto or transport detail: its only product is
 *     an AbortSignal.
 *
 * It carries no protocol meaning and changes no media, chunk or authority
 * semantics.
 */
export interface SessionReadGuard {
    /** False once dispose() has been called. */
    alive(): boolean;
    /** Runs one read under a controller owned by the session. */
    run<T>(
        signal: AbortSignal | undefined,
        operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
    /** Aborts every in-flight read. Idempotent. */
    dispose(): void;
}

export function createSessionReadGuard(): SessionReadGuard {

    const inflight = new Set<AbortController>();

    let disposed = false;

    return {

        alive(): boolean {
            return !disposed;
        },

        async run<T>(
            signal: AbortSignal | undefined,
            operation: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> {

            if (disposed) {
                throw new Error(
                    "[AETERNA] Media session has been disposed",
                );
            }

            const controller = new AbortController();

            const onAbort = (): void => {
                try {
                    controller.abort();
                } catch {
                    /* best-effort */
                }
            };

            if (signal) {

                if (signal.aborted) {
                    controller.abort();
                } else {
                    signal.addEventListener("abort", onAbort, { once: true });
                }

            }

            inflight.add(controller);

            try {

                return await operation(controller.signal);

            } finally {

                inflight.delete(controller);
                signal?.removeEventListener("abort", onAbort);

            }
        },

        dispose(): void {

            if (disposed) return;

            disposed = true;

            for (const controller of inflight) {
                try {
                    controller.abort();
                } catch {
                    /* best-effort */
                }
            }

            inflight.clear();

        },

    };

}
