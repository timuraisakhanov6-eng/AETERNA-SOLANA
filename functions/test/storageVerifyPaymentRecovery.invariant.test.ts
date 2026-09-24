/**
 * AETERNA — /api/storage/verify-payment: expired-quote recovery + idempotency.
 *
 * A storage quote lives 5 minutes. A creator who paid inside that window could
 * still lose the credit if verification could not complete in time, because the
 * expiry gate ran BEFORE verification and rejected the request outright — the
 * funds stayed with Irys while the UI demanded a second payment.
 *
 * The gate now runs AFTER verification:
 *   - verification succeeds -> an expired quote still completes (the payment was
 *     checked against the quote's own bound wallet/amount/mint/destination);
 *   - verification fails    -> STORAGE_QUOTE_EXPIRED is preserved.
 *
 * The on-chain verifier is mocked; no network, no transaction, no signing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeKV, createFakeRequest } from "./harness";

const verifyMock = vi.fn();

vi.mock("./../lib/storage/solanaUsdcVerifier", () => ({
  verifySolanaUsdcStoragePayment: (...args: unknown[]) =>
    verifyMock(...(args as [])),
}));

import { onRequestPost } from "./../api/storage/verify-payment";

const ALLOWED_ORIGIN = "https://aeterna-solana.pages.dev";
const STORAGE_PAYMENT_ID = "storage-pay-765239e5-f0b7-4aa8-ad18-7835b429954e";
const SIGNATURE =
  "3ET8Mg8axvZNgkwPDyGv9XDa5PonogHZTmESV8f7CcEsZhnZm5s67qk92Xtkezd3XNYvDNbLBaoP8p8bQSszZBTi";
const PAYER = "5doR6H8Ln328vtNG6ncr31BzxAAV3NtDdrY3JPbBHjFk";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DESTINATION = "9NERQjLetzquGwdKt3X4gZ8fE8fPfSkj2xo2esmUjWsz";

const HOUR_MS = 60 * 60 * 1000;

/** A quote that expired long ago — exactly the real incident's shape. */
function expiredQuote() {
  const createdAt = Date.now() - 24 * HOUR_MS;
  return {
    storagePaymentId: STORAGE_PAYMENT_ID,
    preparedProjectionId: "prep-1",
    creatorIdentityId: "creator-1",
    walletAccount: PAYER,
    lifecycleId: "lifecycle-1",
    capsuleId: "capsule-1",
    billableSizeBytes: 1024,
    vaultSha256: "a".repeat(64),
    expectedAmountAtomic: "235",
    displayAmountUSDC: "0.000235",
    currency: "USDC" as const,
    network: "solana-mainnet" as const,
    tokenMint: MINT as "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    irysToken: "usdc-solana" as const,
    irysDestination: DESTINATION,
    createdAt,
    // Expired 5 minutes after creation, i.e. ~24h ago.
    expiresAt: createdAt + 5 * 60 * 1000,
    state: "CREATED" as const,
  };
}

function buildEnv() {
  const quotes = createFakeKV();
  const payments = createFakeKV();
  return {
    quotes,
    payments,
    env: {
      STORAGE_QUOTES: quotes,
      STORAGE_PAYMENTS: payments,
      SOLANA_MAINNET_RPC_URL: "https://rpc.internal.invalid",
    },
  };
}

function buildContext(env: Record<string, unknown>, body: unknown) {
  return {
    request: createFakeRequest({
      headers: {
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
      },
      body,
    }),
    env,
  } as never;
}

async function seedQuote(quotes: ReturnType<typeof createFakeKV>) {
  await quotes.put(`storage-payment-quote:${STORAGE_PAYMENT_ID}`, JSON.stringify(expiredQuote()));
}

beforeEach(() => {
  verifyMock.mockReset();
});

describe("/api/storage/verify-payment — expired quote recovery", () => {
  it("D. expired quote + valid on-chain payment -> verification succeeds", async () => {
    const { quotes, payments, env } = buildEnv();
    await seedQuote(quotes);

    verifyMock.mockResolvedValue({
      ok: true,
      signature: SIGNATURE,
      payer: PAYER,
      mint: MINT,
      destination: DESTINATION,
      amountAtomic: "235",
      slot: 449753313,
      blockTime: 1789747795,
    });

    const response = await onRequestPost(
      buildContext(env, {
        storagePaymentId: STORAGE_PAYMENT_ID,
        transactionSignature: SIGNATURE,
      })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; state: string };
    expect(payload.ok).toBe(true);
    expect(payload.state).toBe("PAYMENT_VERIFIED");

    // The verifier received the quote-bound expectations, not client claims.
    expect(verifyMock).toHaveBeenCalledTimes(1);
    const call = verifyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.expectedPayer).toBe(PAYER);
    expect(call.expectedAmountAtomic).toBe("235");
    expect(call.expectedMint).toBe(MINT);
    expect(call.expectedDestination).toBe(DESTINATION);

    // Exactly one record was persisted.
    const stored = await payments.get(`storage-payment:${STORAGE_PAYMENT_ID}`);
    expect(stored).not.toBeNull();
  });

  it("E. expired quote + unverifiable payment -> STORAGE_QUOTE_EXPIRED, nothing persisted", async () => {
    const { quotes, payments, env } = buildEnv();
    await seedQuote(quotes);

    verifyMock.mockResolvedValue({ ok: false, reason: "AMOUNT_MISMATCH" });

    const response = await onRequestPost(
      buildContext(env, {
        storagePaymentId: STORAGE_PAYMENT_ID,
        transactionSignature: SIGNATURE,
      })
    );

    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      ok: boolean;
      error: string;
      reason?: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("STORAGE_QUOTE_EXPIRED");
    // Observability: the verifier's own reason is surfaced for diagnosis. The
    // rejection itself is unchanged — it was already a 409.
    expect(payload.reason).toBe("AMOUNT_MISMATCH");

    // An expired quote with mismatched payment data is never accepted.
    expect(
      await payments.get(`storage-payment:${STORAGE_PAYMENT_ID}`)
    ).toBeNull();
  });

  it("F. same storagePaymentId + same signature after success -> idempotent VERIFIED response", async () => {
    const { quotes, env } = buildEnv();
    await seedQuote(quotes);

    verifyMock.mockResolvedValue({
      ok: true,
      signature: SIGNATURE,
      payer: PAYER,
      mint: MINT,
      destination: DESTINATION,
      amountAtomic: "235",
      slot: 449753313,
      blockTime: 1789747795,
    });

    const body = {
      storagePaymentId: STORAGE_PAYMENT_ID,
      transactionSignature: SIGNATURE,
    };

    const first = await onRequestPost(buildContext(env, body));
    expect(first.status).toBe(200);

    const second = await onRequestPost(buildContext(env, body));
    expect(second.status).toBe(200);
    const secondPayload = (await second.json()) as { ok: boolean; state: string };
    expect(secondPayload.ok).toBe(true);
    expect(secondPayload.state).toBe("PAYMENT_VERIFIED");

    // Replay short-circuits BEFORE the verifier: no second on-chain lookup.
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });
});
