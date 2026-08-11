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
    ): Promise<Uint8Array>;

    /**
     * Releases all runtime-owned resources.
     *
     * The runtime must not be used after disposal.
     */
    dispose(): void;

}