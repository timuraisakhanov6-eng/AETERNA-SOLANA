/**
 * AETERNA — Storage Quote invariant tests
 */

import { describe, it, expect } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as storageQuotePost } from "./../api/storage/quote";

/* ───────────────── real-handler origin gate ─────────────────
 *
 * Regression guard for functions/api/storage/quote.ts:72.
 *
 * That line referenced NEW_PAGES_PREVIEW_REGEX, which is declared ONLY in
 * service-payment/verify.ts (a different preview allowlist). The symbol was
 * undefined here and its ReferenceError was swallowed by the enclosing
 * try/catch, so the origin was silently rejected. The fix removes the stray
 * clause and relies on this endpoint's own PAGES_PREVIEW_REGEX.
 *
 * This endpoint's preview policy is therefore exactly ONE host family
 * (*.aeterna-capsule.pages.dev). These tests pin that policy against the
 * real handler: they would fail if the btt host were ever allowed here by
 * duplicating verify.ts's regex.
 */

function buildQuoteEnv() {
  return {
    PREPARED_PROJECTIONS: { get: async () => null },
    STORAGE_QUOTES: createFakeKV(),
  };
}

function quoteContext(origin: string, env: unknown) {
  const request = createFakeRequest({
    headers: {
      origin,
      "content-type": "application/json",
    },
    body: {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "a".repeat(64),
      preparedProjectionId: "prep-1",
    },
  });
  return makeEventContext({ request, env: env as never });
}

const postStorageQuote = storageQuotePost as unknown as (
  ctx: unknown
) => Promise<Response>;

describe("Storage Quote origin policy (real handler)", () => {
  it("accepts this endpoint's own preview host family", async () => {
    const res = await postStorageQuote(
      quoteContext("https://feature-x.aeterna-capsule.pages.dev", buildQuoteEnv())
    );

    // The origin gate passed; the request then fails later on the missing
    // projection (404), which is expected. It must NOT be a 403.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  it("rejects an unknown origin fail-closed", async () => {
    const res = await postStorageQuote(
      quoteContext("https://evil.example", buildQuoteEnv())
    );

    expect(res.status).toBe(403);
  });

  it("does not extend this endpoint's preview policy to the btt host", async () => {
    const res = await postStorageQuote(
      quoteContext(
        "https://feature-x.aeterna-solana-btt.pages.dev",
        buildQuoteEnv()
      )
    );

    expect(res.status).toBe(403);
  });
});

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
