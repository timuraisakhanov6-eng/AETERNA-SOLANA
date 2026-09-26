import {
  assertStoragePointer,
  type StorageAdapter,
  type UploadToken,
} from "@/lib/storage/storageAdapter";

import type {
  ChunkMetadata,
  PublishedChunkMetadata,
} from "@/types/vault";

import type {
  RuntimeStorage,
} from "@/lib/runtime/runtimeStorage";

/**
 * Maximum number of chunk jobs allowed to be in flight at once.
 *
 * Bounded by construction: a fixed worker pool of at most this many
 * workers is started, and every worker processes at most one chunk at
 * a time. This is deliberately NOT `Promise.all(chunks.map(...))` and
 * never scales with the input length — the peak number of active jobs
 * is C, regardless of how many chunks the capsule has.
 */
const MAX_CONCURRENT_CHUNK_UPLOADS = 2;

export async function uploadPreparedChunks(
  runtime: RuntimeStorage,
  chunkMetadata: readonly ChunkMetadata[],
  uploadToken: UploadToken,
  /* Phase D2b — storage DI: the Creator-paid path injects
     creatorIrysStorage; legacy callers default to the canonical
     Executor-bound singleton. */
  storageAdapter: StorageAdapter,
): Promise<
  readonly PublishedChunkMetadata[]
> {

  if (chunkMetadata.length === 0) {
    return Object.freeze([]);
  }

  /**
   * Result slots indexed by INPUT POSITION.
   *
   * Chunks complete out of order under bounded concurrency, so results
   * are written into the slot of the input position the worker claimed
   * (`results[i]`). This preserves today's output order exactly —
   * `[A, B, C, D]` stays `[A, B, C, D]` even if completion order is
   * `B, A, D, C`. The slot is deliberately keyed on the scheduler
   * position, not on `metadata.index`, so no assumption is made about
   * `index` being a dense zero-based sequence.
   */
  const results:
    (PublishedChunkMetadata | undefined)[] =
      new Array(chunkMetadata.length);

  /**
   * Shared dispatch state.
   *
   * `nextIndex` is the next input position to claim — the only mutable
   * scheduler state, shared by the worker pool.
   *
   * `stopDispatch` is set as soon as the FIRST job fails. Workers
   * already inside `runJob()` finish their current job (and their own
   * `finally` wipe) but MUST NOT claim a new position afterwards.
   */
  let nextIndex = 0;

  let stopDispatch = false;

  /**
   * First captured error. Later errors are ignored so the operation
   * rejects with the SAME error the sequential implementation would
   * have surfaced first.
   */
  let firstError: unknown = undefined;

  async function runJob(
    i: number,
  ): Promise<void> {

    /**
     * Semantic guard, not a type assertion.
     *
     * `i` is only ever produced by `nextIndex`, which is bounded by
     * `chunkMetadata.length` before a job is dispatched, so this can
     * never fire. It exists so the indexed read is provably safe
     * (`noUncheckedIndexedAccess` types `chunkMetadata[i]` as possibly
     * `undefined`, and this file must not weaken that check), and so a
     * future scheduler bug surfaces as an explicit error rather than a
     * confusing `undefined`-property crash.
     */
    const metadata =
      chunkMetadata[i];

    if (!metadata) {
      throw new Error(
        "[AETERNA] Chunk scheduler dispatched an out-of-range index."
      );
    }

    const chunk =
      await runtime.read(
        metadata.chunkId
      );

    try {

      const result =
        await storageAdapter.uploadChunk(
          chunk.ciphertext,
          metadata.chunkId,
          uploadToken
        );

      // Validate the storage pointer before removing
      // the temporary Runtime copy.
      const pointer =
        assertStoragePointer(
          result.txId
        );

      // Runtime data is removed only after
      // successful upload + pointer validation.
      await runtime.remove(
        metadata.chunkId
      );

      // Input-position slot: order is preserved regardless of
      // which worker completed first.
      results[i] =
        Object.freeze({

          chunkId:
            metadata.chunkId,

          mediaId:
            metadata.mediaId,

          index:
            metadata.index,

          size:
            metadata.size,

          pointer,

        });

    } finally {

      /**
       * Canonical memory hygiene.
       *
       * The Runtime copy has already been consumed.
       * Wipe the temporary in-memory ciphertext
       * regardless of upload outcome.
       *
       * This stays per-job: `chunk.ciphertext` is a fresh clone
       * produced by `runtime.read`, so no worker can wipe another
       * worker's buffer.
       */

      chunk.ciphertext.fill(0);

    }

  }

  async function worker(): Promise<void> {

    for (;;) {

      // No new position may be claimed once any job has failed.
      if (stopDispatch) return;

      const i = nextIndex;

      nextIndex += 1;

      if (i >= chunkMetadata.length) return;

      try {

        await runJob(i);

      } catch (error) {

        // Capture only the FIRST error and stop new dispatch.
        // Running workers are not force-cancelled; they settle on
        // their own and still execute their per-job `finally` wipe.
        if (!stopDispatch) {
          stopDispatch = true;
          firstError = error;
        }

        return;

      }

    }

  }

  /**
   * Bounded pool: at most MAX_CONCURRENT_CHUNK_UPLOADS workers, and
   * never more workers than there are chunks. Every worker promise is
   * settled before this function returns, so no rejection can escape
   * unobserved.
   */
  const workerCount = Math.min(
    MAX_CONCURRENT_CHUNK_UPLOADS,
    chunkMetadata.length
  );

  const workers:
    Promise<void>[] = [];

  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }

  // `worker()` never rejects (it captures and returns), so this await
  // always resolves — it only guarantees all workers have settled.
  await Promise.all(workers);

  if (stopDispatch) {
    throw firstError;
  }

  /**
   * Every slot must be filled: the pool only rejects via
   * `stopDispatch`, and a full run dispatches every input position.
   * This narrows `(T | undefined)[]` to `T[]` semantically (no cast),
   * which also keeps `noUncheckedIndexedAccess` satisfied.
   */
  if (!results.every((entry) => entry !== undefined)) {
    throw new Error(
      "[AETERNA] Chunk upload finished with an unfilled result slot."
    );
  }

  return Object.freeze(results);

}
