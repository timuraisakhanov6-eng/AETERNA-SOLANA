/**
 * =========================================================
 * AETERNA — Container uploader (Stage 3)
 * =========================================================
 *
 * Uploads a container byte stream as ONE Irys DataItem:
 *
 *   ONE uploadData()  ·  ONE DataItem  ·  ONE creator signature
 *
 * The uploader is the REAL `ChunkingUploader` from the installed
 * `@irys/upload-core` — this module never re-implements it and never
 * introduces a second uploader abstraction. The caller supplies the
 * instance (built from the creator wallet by the existing
 * `creatorIrys` builder path); this module only configures and drives
 * it, exactly as the Stage 0 browser harness proved works.
 *
 * WHY THE SDK DOES THE CHUNKING, NOT US
 * -------------------------------------
 * `ChunkingUploader.runUpload()` prepends the DataItem header to the
 * supplied stream, reads it in `chunkSize` windows, and POSTs each
 * window to `/chunks/<token>/<id>/<offset>`; the DataItem header and
 * signature are uploaded last. So the SDK's own HTTP chunking is an
 * implementation detail BELOW the container: the container is the
 * DataItem payload, and there is exactly one signature for it.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 *  • no payment, no funding, no balance read
 *  • no publication claim, no chunk-pointer registry write
 *  • no whole-container Buffer — the stream is consumed by the SDK
 *  • no retry of its own (the SDK's per-chunk retry is left intact)
 *
 * PROVISIONAL TUNING — NOT FROZEN
 * -------------------------------
 * Stage 0 measured, in a real browser:
 *   • valid SDK chunkSize range = [500000, 95000000]
 *   • DEFAULT 25 MB / batch 5 → ~1.1 s main-thread stall at 60 MiB
 *   • TUNED 10 MiB / batch 2  → passed the browser stall checks
 *   • AGGRESSIVE 1 MiB / 1    → lowest memory/stall, ~23x more requests
 *
 * Stage 3 therefore starts at 10 MiB / 2 as a CLEARLY PROVISIONAL
 * value. It is NOT a production tuning decision: it still needs real
 * end-to-end upload evidence and larger-object testing before it can
 * be frozen.
 */

import type { ChunkingUploader } from "@irys/upload-core";
import type { Readable } from "stream";

function failClosed(reason: string): never {
  throw new Error(`[AETERNA] ${reason}`);
}

/** Measured SDK floor (Stage 0, real browser). */
export const CONTAINER_CHUNK_SIZE_MIN = 500_000;

/** Measured SDK ceiling (Stage 0, real browser). */
export const CONTAINER_CHUNK_SIZE_MAX = 95_000_000;

/**
 * PROVISIONAL container chunk size — 10 MiB.
 *
 * Pending real end-to-end upload + larger-object testing.
 */
export const PROVISIONAL_CONTAINER_CHUNK_SIZE = 10_485_760;

/**
 * PROVISIONAL container batch size.
 *
 * Pending real end-to-end upload + larger-object testing.
 */
export const PROVISIONAL_CONTAINER_BATCH_SIZE = 2;

export interface ContainerUploadOptions {
  readonly chunkSize?: number;
  readonly batchSize?: number;
}

export interface ContainerUploadResult {
  /** Irys data-item id of the ONE container DataItem. */
  readonly txId: string;
}

/**
 * Validates a chunk size against the measured SDK range and the
 * integer/safe-integer domain.
 */
export function assertContainerChunkSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < CONTAINER_CHUNK_SIZE_MIN ||
    value > CONTAINER_CHUNK_SIZE_MAX
  ) {
    failClosed("Container chunk size out of the SDK-supported range");
  }
  return value;
}

/** Validates a batch size (positive safe integer). */
export function assertContainerBatchSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    failClosed("Invalid container batch size");
  }
  return value;
}

/**
 * Uploads `readable` as ONE Irys DataItem and returns its txId.
 *
 * `uploader` MUST be the real `ChunkingUploader`. The stream MUST be
 * the producer from `createContainerWriter()` (or an equivalent
 * Node-style Readable) — the SDK consumes it with `.pipe()`.
 */
export async function uploadContainer(
  uploader: ChunkingUploader,
  readable: Readable,
  options: ContainerUploadOptions = {}
): Promise<ContainerUploadResult> {
  if (!uploader || typeof uploader !== "object") {
    failClosed("Irys chunking uploader is required");
  }
  if (typeof uploader.setChunkSize !== "function" || typeof uploader.setBatchSize !== "function") {
    failClosed("Irys chunking uploader is not configurable");
  }
  if (typeof uploader.uploadData !== "function") {
    failClosed("Irys chunking uploader cannot upload streams");
  }
  if (!readable || typeof readable.pipe !== "function") {
    failClosed("Container stream must be a Node-style Readable");
  }

  const chunkSize = assertContainerChunkSize(
    options.chunkSize ?? PROVISIONAL_CONTAINER_CHUNK_SIZE
  );
  const batchSize = assertContainerBatchSize(
    options.batchSize ?? PROVISIONAL_CONTAINER_BATCH_SIZE
  );

  // Configure EXPLICITLY — the SDK's own defaults are 25 MB / 5, the
  // configuration Stage 0 measured as stalling the main thread.
  uploader.setChunkSize(chunkSize);
  uploader.setBatchSize(batchSize);

  let response: unknown;
  try {
    response = await uploader.uploadData(readable);
  } catch (error) {
    failClosed(
      `container upload failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const status = (response as { status?: unknown } | null)?.status;
  if (status !== 200) {
    failClosed(`container upload returned HTTP_${String(status)}`);
  }

  const data = (response as { data?: unknown } | null)?.data;
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0) {
    failClosed("container upload receipt has no data item id");
  }

  return Object.freeze({ txId: id });
}
