/**
 * =========================================================
 * AETERNA — Container read resolution (Stage 4 / Model 3)
 * =========================================================
 *
 * Expands ONE container publication record + the capsule's canonical
 * ordered chunk metadata into per-chunk `PublishedChunkMetadata` carrying
 * an explicit `container` position.
 *
 * SOURCE OF ORDER
 * ---------------
 * The Vault's own `items[].chunks: ChunkMetadata[]` — item order, then each
 * item's chunk order. This is the SAME ordering the Stage 2 writer used, so
 * the layout is reproduced exactly without persisting any index.
 *
 * FAIL CLOSED
 * -----------
 *   • no container publication           → throw
 *   • chunk count mismatch               → throw
 *   • unexpected / reordered chunk id    → throw
 *   • layout digest mismatch             → throw
 *   • invalid layout                     → throw
 *
 * The digest comparison is the integrity gate: it binds the Vault-derived
 * layout (order AND ciphertext sizes) to the layout that was published.
 */

import type { ChunkMetadata, PublishedChunkMetadata } from "@/types/vault";

import { buildContainerLayout } from "@/lib/storage/container/containerLayout";
import {
  computeContainerLayoutDigest,
  type ContainerPublicationRecord,
} from "@/lib/storage/container/containerPublication";

function failClosed(reason: string): never {
  throw new Error(reason);
}

/**
 * Resolves container-mode chunks.
 *
 * `items` is the capsule's ordered per-item chunk metadata. Items that carry
 * no chunks (for example text items) are FILTERED OUT here — they contribute
 * no bytes to the container and `buildContainerLayout()` rejects empty
 * groups by design. Relative order of the remaining items is preserved.
 */
export async function resolveContainerChunks(
  items: readonly (readonly ChunkMetadata[])[],
  publication: ContainerPublicationRecord
): Promise<readonly PublishedChunkMetadata[]> {
  if (!publication || typeof publication !== "object") {
    failClosed("[AETERNA] Container publication record is required");
  }
  if (!Array.isArray(items)) {
    failClosed("[AETERNA] Invalid capsule chunk metadata");
  }

  const chunkBearing = items.filter((group) => Array.isArray(group) && group.length > 0);

  // buildContainerLayout also validates each ChunkMetadata record.
  const layout = buildContainerLayout(chunkBearing);

  if (layout.chunkCount !== publication.chunkIds.length) {
    failClosed("[AETERNA] Container chunk count mismatch");
  }

  for (let i = 0; i < layout.entries.length; i++) {
    const entry = layout.entries[i];
    if (!entry || entry.chunkId !== publication.chunkIds[i]) {
      failClosed("[AETERNA] Container chunk identity mismatch");
    }
  }

  const digest = await computeContainerLayoutDigest(
    layout.entries.map((e) => ({ chunkId: e.chunkId, size: e.length }))
  );

  if (digest !== publication.layoutDigest) {
    failClosed("[AETERNA] Container layout digest mismatch");
  }

  const containerTxId = publication.containerTxId;

  return Object.freeze(
    layout.entries.map((entry) =>
      Object.freeze({
        chunkId: entry.chunkId,
        mediaId: entry.mediaId,
        // LOCAL to the media item — never the global index.
        index: entry.localIndex,
        size: entry.length,
        // The container DataItem is the object every chunk lives in.
        pointer: containerTxId,
        container: Object.freeze({
          containerTxId,
          globalIndex: entry.globalIndex,
          offset: entry.offset,
          length: entry.length,
        }),
      }) as PublishedChunkMetadata
    )
  );
}
