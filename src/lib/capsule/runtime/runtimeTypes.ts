/**
 * =========================================================
 * AETERNA Byte Runtime
 * Canonical Types
 * =========================================================
 */

export interface ByteRuntime {

    /**
     * Returns bytes in the half-open interval [start, end).
     */
    getBytes(
        start: number,
        end: number,
        /**
         * R9-A87.7 (F3) — caller-scoped cancellation.
         *
         * The caller aborts this signal when its own bound expires or the
         * component is disposed; the abort must reach the storage stream.
         */
        signal?: AbortSignal,
    ): Promise<Uint8Array<ArrayBuffer>>;

    /**
     * Releases all runtime-owned resources.
     *
     * The runtime must not be used after disposal.
     */
    dispose(): void;

}