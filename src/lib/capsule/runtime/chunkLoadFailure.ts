/**
 * =========================================================
 * AETERNA — Chunk-load failure taxonomy
 * =========================================================
 *
 * Stable, non-sensitive classification of the two chunk-layer
 * boundaries that reach the media-fallback classifier as a bare
 * error today:
 *
 *   • the returned ciphertext window was not EXACTLY the expected
 *     length (a transport/gateway truncation that survived the range
 *     layer's own exact-length check, or a metadata/layout mismatch);
 *   • AES-GCM decryption of a correctly-sized chunk was rejected.
 *
 * WHY THIS EXISTS
 * ---------------
 * `chunkLoader.loadChunk()` already fails closed with plain `Error`s
 * carrying fixed messages. The media diagnostic layer deliberately
 * does NOT parse error text, so without a TYPED marker these two
 * distinct failures are indistinguishable and both collapse into the
 * generic `PREVIEW_READ_FAILED`.
 *
 * This type adds ONLY the marker. It:
 * - keeps the existing message text (`[AETERNA] Chunk download failed`
 *   / `[AETERNA] Chunk decryption failed`) so any external behaviour
 *   that keys on the string is unchanged;
 * - holds no pointer, URL, index, size or byte — codes are fixed and
 *   the message never interpolates a dynamic value.
 */

/**
 * Stable, non-sensitive chunk-failure codes.
 */
export type ChunkLoadFailureCode =
  /**
   * The decrypted-chunk ciphertext length did not match the metadata's
   * expected ciphertext length (short/long body, container-position
   * mismatch, or corrupt manifest/chunk metadata).
   */
  | "chunk-length-mismatch"
  /**
   * The chunk was the expected length but AES-GCM authentication (or
   * key/IV validation) rejected it.
   */
  | "chunk-decrypt-failed";

/**
 * A typed chunk-load failure. `code` is the sole discriminator;
 * `message` is fixed per code.
 */
export class ChunkLoadError extends Error {
  readonly code: ChunkLoadFailureCode;

  constructor(code: ChunkLoadFailureCode) {
    super(
      code === "chunk-decrypt-failed"
        ? "[AETERNA] Chunk decryption failed"
        : "[AETERNA] Chunk download failed",
    );
    this.name = "ChunkLoadError";
    this.code = code;
  }
}

/** Type guard — the sole way the classifier recognises this boundary. */
export function isChunkLoadError(
  error: unknown,
): error is ChunkLoadError {
  return error instanceof ChunkLoadError;
}

/**
 * A typed ByteRuntime reconstruction failure: the read PLAN could not
 * be executed against the decrypted chunks (chunk/plan length
 * mismatch, missing entry, output-range overflow) or the output
 * BUFFER could not be allocated (`new Uint8Array(outputLength)`).
 *
 * Distinct from `ChunkLoadError` because the bytes were already
 * fetched/decrypted — this is a pure in-memory assembly/allocation
 * failure, which is exactly what an over-large fallback read can hit
 * on a memory-constrained device.
 */
export class ByteRuntimeReconstructionError extends Error {
  constructor() {
    super("[AETERNA] Chunk reconstruction failed");
    this.name = "ByteRuntimeReconstructionError";
  }
}

/** Type guard for the reconstruction boundary. */
export function isByteRuntimeReconstructionError(
  error: unknown,
): error is ByteRuntimeReconstructionError {
  return error instanceof ByteRuntimeReconstructionError;
}
