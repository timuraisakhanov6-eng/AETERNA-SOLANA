/**
 * =========================================================
 * AETERNA — Container media upload (Stage 4.5)
 * =========================================================
 *
 * The WRITE-SIDE integration of the Stage 2 layout, the Stage 3
 * writer/uploader and the Stage 4 publication model:
 *
 *   flat ChunkMetadata[]                     (the existing pipeline output)
 *        ↓  group by media item (first-appearance order)
 *   Stage 2 `buildContainerLayout()`         (canonical order + offsets)
 *        ↓  Stage 3 `createContainerWriter()`   (pulls ciphertext from Runtime)
 *   [HEADER][CHUNK 0]…[CHUNK N-1]
 *        ↓  Stage 3 `uploadContainer()`          (ONE DataItem, ONE signature)
 *   ONE container txId
 *        ↓  the caller's container publication claim
 *   ONE authoritative container publication record
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 *  • does not decrypt, re-encrypt or compress anything
 *  • does not build a whole-container buffer (the writer is a pull producer)
 *  • does not touch the Vault (which stays a separate DataItem)
 *  • does not write N chunk-pointer registry entries
 *  • does not claim a publication itself — the claim is injected, so the
 *    authority path stays owned by `creatorIrysStorage`
 *
 * ORDERING CONTRACT
 * -----------------
 * `groupChunkMetadataByMediaItem()` reproduces the Vault's chunk-bearing
 * item grouping EXACTLY: the flat list produced by `prepareMediaChunks()`
 * is pushed in `items[]` order and then per-item chunk order, and
 * `ChunkMetadata.mediaId` IS the source item id (unique per item). The
 * read path (`resolveContainerChunks`) derives the same layout from
 * `items[].chunks`, so write and read cannot drift.
 *
 * FAIL-CLOSED
 * -----------
 * Empty input, an inconsistent layout, a Runtime read error, a short/long
 * chunk, a stream that does not complete, or an upload failure all throw.
 * The publication claim is issued ONLY after the container DataItem exists
 * AND the stream reported an exact byte count — so a failed upload can
 * never produce a successful publication.
 */

import type { ChunkingUploader } from "@irys/upload-core";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";
import type { ChunkMetadata } from "@/types/vault";
import type { ContainerUploadOutcome } from "@/lib/storage/storageAdapter";

import { buildContainerLayout } from "@/lib/storage/container/containerLayout";
import {
  createContainerWriter,
} from "@/lib/storage/container/containerWriter";
import {
  uploadContainer,
  type ContainerUploadOptions,
} from "@/lib/storage/container/containerUploader";
import { computeContainerLayoutDigest } from "@/lib/storage/container/containerPublication";
import { tagSealFailure } from "@/lib/capsule/sealDiagnostic";

function failClosed(reason: string): never {
  throw new Error(reason);
}

/**
 * Issues the container publication claim for the ONE container txId.
 *
 * Injected rather than imported so this module stays free of any HTTP or
 * authority knowledge — `creatorIrysStorage` owns the claim boundary.
 */
export type ContainerClaimFn = (
  containerTxId: string,
  chunkIds: readonly string[],
  layoutDigest: string
) => Promise<void>;

/**
 * Groups the flat, item-ordered chunk metadata into per-media-item groups,
 * preserving FIRST-APPEARANCE order of `mediaId`.
 *
 * This is the inverse of the flattening that `prepareMediaChunks()` performs
 * and therefore reproduces the Vault's `items[].chunks` grouping for every
 * chunk-bearing item. Non-media items carry no chunks and are absent from
 * the flat list by construction, which is exactly what
 * `resolveContainerChunks()` expects (it filters empty groups).
 */
export function groupChunkMetadataByMediaItem(
  chunkMetadata: readonly ChunkMetadata[]
): readonly (readonly ChunkMetadata[])[] {
  if (!Array.isArray(chunkMetadata) || chunkMetadata.length === 0) {
    failClosed("[AETERNA] Container upload requires at least one chunk");
  }

  const order: string[] = [];
  const groups = new Map<string, ChunkMetadata[]>();

  for (const chunk of chunkMetadata) {
    if (
      !chunk ||
      typeof chunk.mediaId !== "string" ||
      chunk.mediaId.length === 0
    ) {
      failClosed("[AETERNA] Invalid chunk metadata for container upload");
    }

    let group = groups.get(chunk.mediaId);
    if (!group) {
      group = [];
      groups.set(chunk.mediaId, group);
      order.push(chunk.mediaId);
    }
    group.push(chunk);
  }

  return Object.freeze(
    order.map((mediaId) => Object.freeze(groups.get(mediaId)!))
  );
}

/**
 * Uploads the media container as ONE Irys DataItem and claims its
 * publication.
 *
 * Returns the exact tuple the container publication claim records.
 */
export async function uploadPreparedContainer(
  runtime: RuntimeStorage,
  chunkMetadata: readonly ChunkMetadata[],
  uploader: ChunkingUploader,
  claimContainer: ContainerClaimFn,
  options: ContainerUploadOptions = {}
): Promise<ContainerUploadOutcome> {
  /**
   * Sub-stage A — CONTAINER_UPLOAD_CONSTRUCT.
   *
   * Everything before the first wallet interaction: runtime/adapter
   * validation, chunk grouping, the canonical layout, the layout digest
   * and the streaming writer. No signature can exist yet.
   */
  let chunkIds: readonly string[];
  let layoutDigest: string;
  let writer: ReturnType<typeof createContainerWriter>;

  try {
    if (!runtime || typeof runtime.read !== "function") {
      failClosed("[AETERNA] Runtime storage is required");
    }
    if (typeof claimContainer !== "function") {
      failClosed("[AETERNA] A container publication claim is required");
    }

    const items = groupChunkMetadataByMediaItem(chunkMetadata);

    // buildContainerLayout also validates every ChunkMetadata record.
    const layout = buildContainerLayout(items);

    /**
     * Canonical ORDERED logical chunk identity — the SAME order the reader
     * reproduces from the Vault, and the same order the layout digest binds.
     */
    chunkIds = Object.freeze(layout.entries.map((entry) => entry.chunkId));

    /**
     * The digest binds ORDER and ciphertext SIZES (which is what fixes the
     * physical offsets) — it is computed from the layout the writer will
     * actually emit, so it cannot describe a different byte stream.
     */
    layoutDigest = await computeContainerLayoutDigest(
      layout.entries.map((entry) => ({
        chunkId: entry.chunkId,
        size: entry.length,
      }))
    );

    writer = createContainerWriter(layout, runtime);
  } catch (error) {
    throw tagSealFailure(error, "CONTAINER_UPLOAD_CONSTRUCT");
  }

  let containerTxId: string;

  try {
    const result = await uploadContainer(uploader, writer.readable, options);
    containerTxId = result.txId;
  } catch (error) {
    // Release the producer and rethrow — NO claim is issued for a failed
    // upload, so a failure can never produce a successful publication.
    // The container uploader's own sub-stage tag (B/C/D/E) is preserved;
    // only an unclassified failure becomes CONTAINER_UPLOAD_UNKNOWN.
    writer.abort("[AETERNA] Container upload failed");
    throw tagSealFailure(error, "CONTAINER_UPLOAD_UNKNOWN");
  }

  /**
   * The stream must have ended with an EXACT byte count. `uploadContainer`
   * only resolves after the SDK consumed the whole stream, but the writer's
   * own terminal check is the authoritative statement that every chunk was
   * emitted at exactly `layout.containerSize`.
   */
  if (!writer.stats().completed) {
    throw tagSealFailure(null, "CONTAINER_UPLOAD_UNKNOWN");
  }

  // Only now — ONE container DataItem exists — is the publication claimed.
  try {
    await claimContainer(containerTxId, chunkIds, layoutDigest);
  } catch (error) {
    throw tagSealFailure(error, "CONTAINER_PUBLICATION");
  }

  return Object.freeze({
    containerTxId,
    chunkIds,
    layoutDigest,
  });
}
