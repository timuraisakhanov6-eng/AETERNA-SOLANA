/**
 * =========================================================
 * AETERNA — Seal-side upload outcome contract (Stage 4)
 * =========================================================
 *
 * Seal must accept TWO legitimate media-upload outcomes:
 *
 *   LEGACY   : N logical chunks → N uploaded per-chunk records
 *   CONTAINER: N logical chunks → 1 container publication record
 *
 * The previous inline assertions in `sealCapsuleCore` only understood the
 * legacy shape, and only compared COUNTS (plus uniqueness) — they never
 * proved that the uploaded set actually IS the expected set.
 *
 * This module encodes the contract once, for both modes, and STRENGTHENS the
 * legacy check to require set membership: "every expected logical chunk is
 * represented" is now actually verified, not merely implied by a count.
 *
 * Purity: no I/O, no crypto, no Vault, no publication access.
 */

import type { ChunkMetadata } from "@/types/vault";

function failClosed(reason: string): never {
  throw new Error(reason);
}

export type SealUploadOutcome =
  | {
      readonly mode: "legacy";
      readonly uploadedChunks: readonly { readonly chunkId: string }[];
    }
  | {
      readonly mode: "container";
      /** Canonical ORDERED logical chunk identity from the publication record. */
      readonly containerChunkIds: readonly string[];
    };

function expectedIds(expected: readonly ChunkMetadata[]): Set<string> {
  const ids = new Set<string>();
  for (const chunk of expected) {
    if (!chunk || typeof chunk.chunkId !== "string" || chunk.chunkId.length === 0) {
      failClosed("[AETERNA] Invalid chunk metadata");
    }
    ids.add(chunk.chunkId);
  }
  return ids;
}

function assertExactlyCovers(
  expected: readonly ChunkMetadata[],
  actualIds: readonly string[],
  duplicateReason: string,
  missingReason: string
): void {
  const expectedSet = expectedIds(expected);

  const seen = new Set<string>();
  for (const id of actualIds) {
    if (typeof id !== "string" || id.length === 0) {
      failClosed("[AETERNA] Invalid uploaded chunk identity");
    }
    if (seen.has(id)) {
      failClosed(duplicateReason);
    }
    seen.add(id);
  }

  if (seen.size !== expectedSet.size) {
    failClosed(missingReason);
  }

  for (const id of expectedSet) {
    if (!seen.has(id)) {
      failClosed(missingReason);
    }
  }
}

/**
 * Validates a media upload outcome against the capsule's expected logical
 * chunk set. Throws (fail closed) on any mismatch.
 */
export function assertSealUploadOutcome(
  expected: readonly ChunkMetadata[],
  outcome: SealUploadOutcome
): void {
  if (!Array.isArray(expected)) {
    failClosed("[AETERNA] Invalid chunk metadata");
  }
  if (!outcome || typeof outcome !== "object") {
    failClosed("[AETERNA] Invalid upload outcome");
  }

  if (outcome.mode === "legacy") {
    if (!Array.isArray(outcome.uploadedChunks)) {
      failClosed("[AETERNA] Invalid upload outcome");
    }

    assertExactlyCovers(
      expected,
      outcome.uploadedChunks.map((c) => c.chunkId),
      "[AETERNA] Duplicate chunk upload",
      "[AETERNA] Chunk upload count mismatch"
    );

    return;
  }

  if (outcome.mode === "container") {
    if (!Array.isArray(outcome.containerChunkIds)) {
      failClosed("[AETERNA] Invalid upload outcome");
    }

    // A container must cover MORE THAN ONE logical chunk: a single-chunk
    // container would be a legacy DataItem wearing a container label.
    if (expected.length > 1 && outcome.containerChunkIds.length < 2) {
      failClosed("[AETERNA] Container publication covers too few chunks");
    }

    assertExactlyCovers(
      expected,
      outcome.containerChunkIds,
      "[AETERNA] Duplicate chunk in container publication",
      "[AETERNA] Container publication chunk set mismatch"
    );

    return;
  }

  failClosed("[AETERNA] Unknown upload outcome mode");
}
