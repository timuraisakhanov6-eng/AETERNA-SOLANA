/**
 * AETERNA — Prepared Projection
 *
 * Minimal server-authoritative metadata for a PREPARED capsule.
 *
 * This projection is NOT a new authority domain.
 * It belongs to Business/Storage Authority and intentionally
 * excludes all secret material.
 */

export interface PreparedProjection {
  readonly preparedProjectionId: string;

  readonly creatorIdentityId: string;

  readonly lifecycleId: string;

  readonly capsuleId: string;

  readonly encryptedSizeBytes: number;

  readonly vaultSha256: string;

  readonly saltBase: string;

  readonly encryptedVaultPointer: string;

  readonly chunkCount: number;

  readonly totalChunkSizeBytes: number;

  readonly createdAt: number;

  readonly expiresAt: number;

  readonly state: "ACTIVE" | "CONSUMED" | "EXPIRED";
}
