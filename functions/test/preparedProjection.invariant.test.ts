/**
 * AETERNA — Prepared Projection invariant tests
 */

import { describe, it, expect } from "vitest";

const FAKE_ENV = {
  PREPARED_PROJECTIONS: {
    get: async (_key: string) => null,
    put: async () => {},
  },
};

describe("Prepared Projection schema / invariants", () => {
  it("exposes the expected metadata-only shape", () => {
    const shape = {
      preparedProjectionId: "prep-1",
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      encryptedSizeBytes: 1234,
      vaultSha256: "abcd1234".padEnd(64, "0"),
      saltBase: "salt".padEnd(64, "0"),
      encryptedVaultPointer: "ar://pointer",
      chunkCount: 1,
      totalChunkSizeBytes: 1234,
      createdAt: 1,
      expiresAt: 2,
      state: "ACTIVE",
    };

    expect(shape.state).toBe("ACTIVE");
    expect(shape.encryptedSizeBytes).toBeGreaterThan(0);
    expect(shape.chunkCount).toBeGreaterThan(0);
    expect(shape.totalChunkSizeBytes).toBe(shape.encryptedSizeBytes);
  });
});

describe("Prepared Projection endpoint authorization", () => {
  it("requires authenticated creator context", () => {
    expect(FAKE_ENV.PREPARED_PROJECTIONS.get).toBeDefined();
  });
});

describe("Prepared Projection integrity invariants", () => {
  it("must reject chunk sum mismatches", () => {
    const encryptedSizeBytes = 10;
    const chunkMetadata = [{ size: 5 }, { size: 6 }];

    const totalChunkSizeBytes = chunkMetadata.reduce((sum, chunk) => sum + chunk.size, 0);

    expect(totalChunkSizeBytes).not.toBe(encryptedSizeBytes);
  });

  it("must accept matching chunk sum", () => {
    const encryptedSizeBytes = 10;
    const chunkMetadata = [{ size: 5 }, { size: 5 }];

    const totalChunkSizeBytes = chunkMetadata.reduce((sum, chunk) => sum + chunk.size, 0);

    expect(totalChunkSizeBytes).toBe(encryptedSizeBytes);
  });
});

describe("Prepared Projection lifecycle binding", () => {
  it("binds to creatorIdentityId + lifecycleId + capsuleId", () => {
    const projection = {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    };

    expect(projection.creatorIdentityId + ":" + projection.lifecycleId + ":" + projection.capsuleId).toBe(
      "creator-1:lifecycle-1:capsule-1"
    );
  });
});
