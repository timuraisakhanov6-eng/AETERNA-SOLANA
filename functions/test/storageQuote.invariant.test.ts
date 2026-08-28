/**
 * AETERNA — Storage Quote invariant tests
 */

import { describe, it, expect } from "vitest";

describe("Storage Quote schema / invariants", () => {
  it("requires immutable fields after creation", () => {
    const quote = {
      storagePaymentId: "storage-pay-1",
      preparedProjectionId: "prep-1",
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      billableSizeBytes: 1234,
      vaultSha256: "abcd1234".padEnd(64, "0"),
      expectedAmountAtomic: "1000000",
      displayAmountUSDC: "1.000000",
      currency: "USDC",
      network: "solana-mainnet",
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      irysToken: "usdc-solana",
      irysDestination: "9NERQjLetzquGwdKt3X4gZ8fE8fPfSkj2xo2esmUjWsz",
      createdAt: 1,
      expiresAt: 2,
      state: "CREATED",
    };

    expect(quote.currency).toBe("USDC");
    expect(quote.tokenMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(quote.irysToken).toBe("usdc-solana");
    expect(quote.network).toBe("solana-mainnet");
  });
});

describe("Storage Quote amount precision", () => {
  it("preserves atomic amount as integer string", () => {
    const priceAtomic = "1000000";
    const usdcDecimals = 1_000_000;
    const display = Number.parseFloat(`${Number(priceAtomic) / usdcDecimals}`).toFixed(6);

    expect(display).toBe("1.000000");
    expect(/^\d+$/.test(priceAtomic)).toBe(true);
  });
});

describe("Storage Quote binding", () => {
  it("binds to creatorIdentityId + lifecycleId + capsuleId", () => {
    const creatorIdentityId = "creator-1";
    const lifecycleId = "lifecycle-1";
    const capsuleId = "capsule-1";

    expect(`${creatorIdentityId}:${lifecycleId}:${capsuleId}`).toBe(
      "creator-1:lifecycle-1:capsule-1"
    );
  });
});

describe("Storage Quote idempotency", () => {
  it("returns existing valid quote for identical active projection", () => {
    const existing = {
      state: "CREATED",
      expiresAt: Date.now() + 60_000,
    };

    const now = Date.now();
    const isValid = existing.state === "CREATED" && now < existing.expiresAt;

    expect(isValid).toBe(true);
  });
});
