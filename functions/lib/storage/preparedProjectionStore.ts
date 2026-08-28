/**
 * AETERNA — Prepared Projection Store (Business/Storage Authority)
 *
 * Minimal metadata-only server projection for PREPARED capsules.
 *
 * This projection is NOT a new authority domain.
 * It intentionally excludes all secret material.
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

const PREFIX = "prepared-projection:";

export function projectionKey(capsuleId: string): string {
  return `${PREFIX}${capsuleId}`;
}

export async function getPreparedProjection(
  env: { PREPARED_PROJECTIONS: { get(key: string): Promise<string | null> } },
  capsuleId: string
): Promise<PreparedProjection | null> {
  const raw = await env.PREPARED_PROJECTIONS.get(projectionKey(capsuleId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PreparedProjection;
  } catch {
    return null;
  }
}

export async function putPreparedProjection(
  env: { PREPARED_PROJECTIONS: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } },
  projection: PreparedProjection
): Promise<void> {
  await env.PREPARED_PROJECTIONS.put(
    projectionKey(projection.capsuleId),
    JSON.stringify(projection)
  );
}
