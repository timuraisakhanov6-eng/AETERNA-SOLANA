/**
 * AETERNA — Global Payment Transaction Uniqueness invariants
 *
 * Canonical invariant under test:
 *   ONE successful on-chain AETERNA service-payment transaction
 *   (network + transactionId)
 *   -> MAXIMUM ONE verified payment
 *   -> MAXIMUM ONE Creator Credit,
 *   GLOBALLY across quotes, paymentIntentIds, creatorIdentityIds and
 *   credits — proven at the transaction-signature level, NOT merely by
 *   grant-credit's (creatorIdentityId, quoteId) idempotency.
 *
 * All tests use mocks/fixtures only: no network, no KV mutation, no
 * blockchain transaction, no production endpoint calls.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext, createFakeCreditCoordinatorBinding } from "./harness";
import { createBusinessQuote } from "./../lib/business/businessQuoteStore";
import { onRequestPost as servicePaymentVerifyPost } from "./../api/service-payment/verify";
import { onRequestPost as grantCreditPost } from "./../api/creator/grant-credit";
import * as solanaRpc from "./../lib/solana/rpc";
import { paymentTxCoordinatorName } from "./../lib/paymentTxUniqueness";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

const CREATOR_IDENTITY_ID = "creator-1";
const CREATOR_IDENTITY_NETWORK = "solana";
const CREATOR_IDENTITY_ACCOUNT = "123456789ABCDEF";

const SOLANA_TX = "Base58SignatureForSolanaTransaction1234567890ABCDEF1234567890ABCDEF";
const SOLANA_TX_OTHER = "OtherBase58SignatureForSolanaTx1234567890ABCDEF1234567890ABCDEFX";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SETTLEMENT_ADDRESS = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";

const EVM_TX = "0x" + "b".repeat(64);

function createFakeCreatorIdentityKV() {
  const store = new Map<string, string>();

  store.set(
    `creator:identity:id:${CREATOR_IDENTITY_ID}`,
    `${CREATOR_IDENTITY_NETWORK}:${CREATOR_IDENTITY_ACCOUNT}`
  );
  store.set(
    `creator:identity:${CREATOR_IDENTITY_NETWORK}:${CREATOR_IDENTITY_ACCOUNT}`,
    JSON.stringify({
      id: CREATOR_IDENTITY_ID,
      network: CREATOR_IDENTITY_NETWORK,
      account: CREATOR_IDENTITY_ACCOUNT,
    })
  );

  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async () => {},
    delete: async () => {},
  };
}

function buildEnv() {
  const coordinator = createFakeCreditCoordinatorBinding();
  const env = {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_IDENTITIES: createFakeCreatorIdentityKV(),
    CREATOR_CREDITS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    SOLANA_MAINNET_RPC_URL: "https://solana-rpc.example.com",
    ALCHEMY_BASE_RPC_URL: "https://base-rpc.example.com",
    CREDIT_OP_COORDINATOR: coordinator,
  };
  return { env, coordinator };
}

async function seedQuote(
  kv: ReturnType<typeof createFakeKV>,
  paymentIntentId: string
) {
  await createBusinessQuote(
    { BUSINESS_QUOTES: kv },
    {
      paymentIntentId,
      expectedAmount: 1,
      currency: "USD",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
  );
}

function requestContext(env: unknown, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });
  return makeEventContext({ request, env: env as never });
}

async function verifyPayment(
  env: unknown,
  input: { paymentIntentId: string; evidenceId: string; transactionId?: string; txHash?: string }
) {
  return servicePaymentVerifyPost(
    requestContext(env, {
      paymentIntentId: input.paymentIntentId,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      evidenceId: input.evidenceId,
      ...(input.transactionId !== undefined ? { transactionId: input.transactionId } : {}),
      ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
    }) as never
  );
}

async function grantCredit(
  env: unknown,
  input: { paymentIntentId: string; evidenceId: string; transactionId: string }
) {
  return grantCreditPost(
    requestContext(env, {
      paymentIntentId: input.paymentIntentId,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      verifiedPaymentId: input.evidenceId,
      transactionId: input.transactionId,
    }) as never
  );
}

function successfulSolanaTransaction(account = CREATOR_IDENTITY_ACCOUNT) {
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    transaction: {
      message: {
        accountKeys: [{ pubkey: account, signer: true }],
      },
    },
    meta: {
      preTokenBalances: [
        {
          owner: account,
          mint: USDC_MINT,
          uiTokenAmount: { uiAmount: 1, decimals: 6 },
        },
        {
          owner: SETTLEMENT_ADDRESS,
          mint: USDC_MINT,
          uiTokenAmount: { uiAmount: 5, decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          owner: SETTLEMENT_ADDRESS,
          mint: USDC_MINT,
          uiTokenAmount: { uiAmount: 6, decimals: 6 },
        },
        {
          owner: account,
          mint: USDC_MINT,
          uiTokenAmount: { uiAmount: 0, decimals: 6 },
        },
      ],
    },
  };
}

function failedSolanaTransaction() {
  const tx = successfulSolanaTransaction() as {
    meta: { err?: unknown };
  };
  tx.meta.err = { InstructionError: [0, { Custom: 1 }] };
  return tx;
}

const originalGetSolanaTransaction = Object.getOwnPropertyDescriptor(
  solanaRpc,
  "getSolanaTransaction"
)!.value;

function mockSolanaTransaction(value: unknown) {
  Object.defineProperty(solanaRpc, "getSolanaTransaction", {
    value: vi.fn().mockResolvedValue(value),
    writable: true,
    configurable: true,
  });
}

function creditRecordIds(creditsKv: ReturnType<typeof createFakeKV>): string[] {
  return [...creditsKv.data.keys()]
    .filter((key) => /^creator:credit:[0-9a-f]{32}$/.test(key))
    .map((key) => String(creditsKv.data.get(key) && JSON.parse(String(creditsKv.data.get(key))).id));
}

async function claimRecordFor(
  coordinator: ReturnType<typeof createFakeCreditCoordinatorBinding>,
  network: string,
  transactionId: string
): Promise<Record<string, unknown> | undefined> {
  const name = await paymentTxCoordinatorName(
    network as "base" | "solana",
    transactionId
  );
  const storage = coordinator.storages.get(name);
  if (!storage) return undefined;
  return storage.data.get(`payment-tx-unique:${network}:${transactionId}`) as
    | Record<string, unknown>
    | undefined;
}

describe("Global payment transaction uniqueness invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  });

  afterEach(() => {
    Object.defineProperty(solanaRpc, "getSolanaTransaction", {
      value: originalGetSolanaTransaction,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("CASE A: first successful transaction verifies and grants exactly one Credit", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const verifyRes = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(verifyRes.status).toBe(200);
    expect(((await verifyRes.json()) as { status: string }).status).toBe("VERIFIED");

    const grantRes = await grantCredit(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(grantRes.status).toBe(200);
    const grantData = (await grantRes.json()) as { ok: boolean; creatorCreditId: string };
    expect(grantData.ok).toBe(true);
    expect(creditRecordIds(env.CREATOR_CREDITS)).toEqual([grantData.creatorCreditId]);
  });

  it("CASE B: same transaction + same quote replays idempotently, no second Credit", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    const firstGrant = await grantCredit(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(firstGrant.status).toBe(200);
    const creditId = ((await firstGrant.json()) as { creatorCreditId: string }).creatorCreditId;

    // Replay with the SAME evidenceId: existing idempotent behavior.
    const replayVerify = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(replayVerify.status).toBe(200);
    expect(((await replayVerify.json()) as { status: string }).status).toBe("VERIFIED");

    // Replay with a NEW evidenceId under the SAME quote: still the same
    // payment — accepted, and grant stays idempotent by (identity, quote).
    const newEvidenceVerify = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a2",
      transactionId: SOLANA_TX,
    });
    expect(newEvidenceVerify.status).toBe(200);

    const secondGrant = await grantCredit(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a2",
      transactionId: SOLANA_TX,
    });
    expect(secondGrant.status).toBe(200);
    expect(((await secondGrant.json()) as { creatorCreditId: string }).creatorCreditId).toBe(creditId);

    expect(creditRecordIds(env.CREATOR_CREDITS)).toEqual([creditId]);
  });

  it("CASE C: same transaction + DIFFERENT quote is rejected, no second verified payment, no second Credit", async () => {
    const { env, coordinator } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");
    await seedQuote(env.BUSINESS_QUOTES, "intent-b");

    await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    const firstGrant = await grantCredit(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(firstGrant.status).toBe(200);
    const creditId = ((await firstGrant.json()) as { creatorCreditId: string }).creatorCreditId;

    const replayVerify = await verifyPayment(env, {
      paymentIntentId: "intent-b",
      evidenceId: "ev-b1",
      transactionId: SOLANA_TX,
    });
    expect(replayVerify.status).toBe(409);
    expect(((await replayVerify.json()) as { error: string }).error).toBe("TRANSACTION_ALREADY_VERIFIED");

    // No verified payment may exist for the second quote.
    expect(await env.VERIFIED_PAYMENTS.get("verified-payment:intent-b:ev-b1")).toBeNull();
    expect(await env.VERIFIED_PAYMENTS.get("payment-intent:intent-b")).toBeNull();

    // Credit minting from the second quote is impossible.
    const replayGrant = await grantCredit(env, {
      paymentIntentId: "intent-b",
      evidenceId: "ev-b1",
      transactionId: SOLANA_TX,
    });
    expect(replayGrant.status).toBe(402);

    expect(creditRecordIds(env.CREATOR_CREDITS)).toEqual([creditId]);
  });

  it("CASE D: same transaction + different paymentIntentId is rejected", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");
    await seedQuote(env.BUSINESS_QUOTES, "intent-other");

    await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });

    const replayVerify = await verifyPayment(env, {
      paymentIntentId: "intent-other",
      evidenceId: "ev-other",
      transactionId: SOLANA_TX,
    });
    expect(replayVerify.status).toBe(409);
    expect(((await replayVerify.json()) as { error: string }).error).toBe("TRANSACTION_ALREADY_VERIFIED");

    expect(await env.VERIFIED_PAYMENTS.get("verified-payment:intent-other:ev-other")).toBeNull();
  });

  it("CASE E: different creatorIdentityId still fails payer validation (unchanged)", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(
      successfulSolanaTransaction("PayerMismatchAcc11111111111111111111111111111")
    );
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("PAYER_MISMATCH");

    // Failed verification must NOT establish the global binding.
    expect(
      await claimRecordFor(env.CREDIT_OP_COORDINATOR, "solana", SOLANA_TX)
    ).toBeUndefined();
  });

  it("CASE F: a different transaction is an independent legitimate payment", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");
    await seedQuote(env.BUSINESS_QUOTES, "intent-b");

    const verifyA = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(verifyA.status).toBe(200);

    const verifyB = await verifyPayment(env, {
      paymentIntentId: "intent-b",
      evidenceId: "ev-b1",
      transactionId: SOLANA_TX_OTHER,
    });
    expect(verifyB.status).toBe(200);

    const grantA = await grantCredit(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    const grantB = await grantCredit(env, {
      paymentIntentId: "intent-b",
      evidenceId: "ev-b1",
      transactionId: SOLANA_TX_OTHER,
    });
    expect(grantA.status).toBe(200);
    expect(grantB.status).toBe(200);

    const creditIds = creditRecordIds(env.CREATOR_CREDITS);
    expect(creditIds).toHaveLength(2);
    expect(creditIds[0]).not.toBe(creditIds[1]);
  });

  it("CASE G: concurrent verification of the same transaction admits at most one winner", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-race-1");
    await seedQuote(env.BUSINESS_QUOTES, "intent-race-2");

    const [res1, res2] = await Promise.all([
      verifyPayment(env, {
        paymentIntentId: "intent-race-1",
        evidenceId: "ev-race-1",
        transactionId: SOLANA_TX,
      }),
      verifyPayment(env, {
        paymentIntentId: "intent-race-2",
        evidenceId: "ev-race-2",
        transactionId: SOLANA_TX,
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winnerIntent = res1.status === 200 ? "intent-race-1" : "intent-race-2";
    const winnerEvidence = res1.status === 200 ? "ev-race-1" : "ev-race-2";
    const loserIntent = res1.status === 200 ? "intent-race-2" : "intent-race-1";
    const loserEvidence = res1.status === 200 ? "ev-race-2" : "ev-race-1";

    const grantWinner = await grantCredit(env, {
      paymentIntentId: winnerIntent,
      evidenceId: winnerEvidence,
      transactionId: SOLANA_TX,
    });
    expect(grantWinner.status).toBe(200);

    const grantLoser = await grantCredit(env, {
      paymentIntentId: loserIntent,
      evidenceId: loserEvidence,
      transactionId: SOLANA_TX,
    });
    expect(grantLoser.status).toBe(402);

    expect(creditRecordIds(env.CREATOR_CREDITS)).toHaveLength(1);
  });

  it("REGRESSION: Transaction X + Quote A -> Credit A, then Transaction X + Quote B must fail everywhere", async () => {
    const { env, coordinator } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");
    await seedQuote(env.BUSINESS_QUOTES, "intent-b");

    // 1. Transaction X + Quote A verifies and mints Credit A.
    const verifyA = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(verifyA.status).toBe(200);

    const grantA = await grantCredit(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });
    expect(grantA.status).toBe(200);
    const creditA = ((await grantA.json()) as { creatorCreditId: string }).creatorCreditId;

    // 2. Transaction X + Quote B: verification attempt.
    const verifyB = await verifyPayment(env, {
      paymentIntentId: "intent-b",
      evidenceId: "ev-b1",
      transactionId: SOLANA_TX,
    });
    expect(verifyB.status).toBe(409);
    expect(((await verifyB.json()) as { error: string }).error).toBe("TRANSACTION_ALREADY_VERIFIED");

    // 3. No second verified-payment success exists.
    expect(await env.VERIFIED_PAYMENTS.get("verified-payment:intent-b:ev-b1")).toBeNull();
    expect(await env.VERIFIED_PAYMENTS.get("payment-intent:intent-b")).toBeNull();

    // 4. No second Creator Credit exists.
    const replayGrant = await grantCredit(env, {
      paymentIntentId: "intent-b",
      evidenceId: "ev-b1",
      transactionId: SOLANA_TX,
    });
    expect(replayGrant.status).toBe(402);
    expect(creditRecordIds(env.CREATOR_CREDITS)).toEqual([creditA]);

    // 5. The global binding still points to the ORIGINAL successful
    //    payment identity (quote A / evidence ev-a1 / identity creator-1).
    const claim = await claimRecordFor(coordinator, "solana", SOLANA_TX);
    expect(claim).toBeDefined();
    expect(claim?.network).toBe("solana");
    expect(claim?.transactionId).toBe(SOLANA_TX);
    expect(claim?.paymentIntentId).toBe("intent-a");
    expect(claim?.evidenceId).toBe("ev-a1");
    expect(claim?.creatorIdentityId).toBe(CREATOR_IDENTITY_ID);
  });

  it("REGRESSION: grant-credit rejects a transactionId that differs from the verified payment record", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX,
    });

    const forgedGrant = await grantCredit(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-a1",
      transactionId: SOLANA_TX_OTHER,
    });
    expect(forgedGrant.status).toBe(409);
    expect(((await forgedGrant.json()) as { error: string }).error).toBe("VERIFIED_PAYMENT_TX_MISMATCH");
    expect(creditRecordIds(env.CREATOR_CREDITS)).toHaveLength(0);
  });

  it("INVALID AMOUNT: rejected with no uniqueness binding established", async () => {
    const { env, coordinator } = buildEnv();
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: "0x2105" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            status: "0x1",
            blockNumber: "0x10",
            logs: [
              {
                address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                topics: [
                  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                  "0x000000000000000000000000" + "0".repeat(40),
                  "0x" + "0".repeat(24) + "b0d9e5d93c1fecfa78479f23d283eaa652ee3755",
                ],
                // 2 USDC instead of 1 USDC.
                data: "0x" + "0".repeat(58) + "1e8480",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: "0x11" }) });

    vi.stubGlobal("fetch", fakeFetch);

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-amount",
      txHash: EVM_TX,
    });

    vi.unstubAllGlobals();

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("TRANSFER_NOT_FOUND");
    expect(
      await claimRecordFor(env.CREDIT_OP_COORDINATOR, "base", EVM_TX)
    ).toBeUndefined();
  });

  it("WRONG DESTINATION: rejected with no uniqueness binding established", async () => {
    const { env, coordinator } = buildEnv();
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: "0x2105" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            status: "0x1",
            blockNumber: "0x10",
            logs: [
              {
                address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                topics: [
                  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                  "0x000000000000000000000000" + "0".repeat(40),
                  // Transfer to some OTHER address, not the settlement wallet.
                  "0x" + "0".repeat(24) + "c0ffee0000000000000000000000000000000001",
                ],
                data: "0x" + "0".repeat(59) + "f4240",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: "0x11" }) });

    vi.stubGlobal("fetch", fakeFetch);

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-dest",
      txHash: EVM_TX,
    });

    vi.unstubAllGlobals();

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("TRANSFER_NOT_FOUND");
    expect(
      await claimRecordFor(env.CREDIT_OP_COORDINATOR, "base", EVM_TX)
    ).toBeUndefined();
  });

  it("WRONG PAYER / SOURCE OWNER: rejected with no uniqueness binding established", async () => {
    const { env, coordinator } = buildEnv();
    mockSolanaTransaction(
      successfulSolanaTransaction("DifferentPayerAcc111111111111111111111111111111")
    );
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-payer",
      transactionId: SOLANA_TX,
    });

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("PAYER_MISMATCH");
    expect(
      await claimRecordFor(env.CREDIT_OP_COORDINATOR, "solana", SOLANA_TX)
    ).toBeUndefined();
  });

  it("FAILED TRANSACTION (meta.err): rejected with no uniqueness binding established", async () => {
    const { env, coordinator } = buildEnv();
    mockSolanaTransaction(failedSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-failed",
      transactionId: SOLANA_TX,
    });

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("TX_FAILED");
    expect(
      await claimRecordFor(env.CREDIT_OP_COORDINATOR, "solana", SOLANA_TX)
    ).toBeUndefined();
  });

  it("FAIL-CLOSED: missing CREDIT_OP_COORDINATOR binding rejects with 503 and persists nothing", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");
    delete (env as Record<string, unknown>).CREDIT_OP_COORDINATOR;

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-nocoord",
      transactionId: SOLANA_TX,
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("PAYMENT_TX_UNIQUENESS_UNAVAILABLE");
    expect(await env.VERIFIED_PAYMENTS.get("verified-payment:intent-a:ev-nocoord")).toBeNull();
  });

  it("DO op: payment-tx-claim is atomic per transaction — same paymentIntentId replays, other paymentIntentId conflicts", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();

    const claimOnce = async (paymentIntentId: string) => {
      const name = await paymentTxCoordinatorName("solana", SOLANA_TX);
      const stub = coordinator.get(coordinator.idFromName(name));
      return stub.fetch(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "payment-tx-claim",
            network: "solana",
            transactionId: SOLANA_TX,
            paymentIntentId,
            evidenceId: `ev-${paymentIntentId}`,
            creatorIdentityId: CREATOR_IDENTITY_ID,
            claimedAt: Date.now(),
          }),
        })
      );
    };

    const first = await claimOnce("intent-a");
    expect(first.status).toBe(200);
    expect(((await first.json()) as { outcome: string }).outcome).toBe("CLAIMED");

    const replay = await claimOnce("intent-a");
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { outcome: string }).outcome).toBe("ALREADY_CLAIMED");

    const conflict = await claimOnce("intent-b");
    expect(conflict.status).toBe(409);
    const conflictData = (await conflict.json()) as {
      outcome: string;
      claim?: { paymentIntentId: string };
    };
    expect(conflictData.outcome).toBe("ALREADY_CLAIMED_OTHER_PAYMENT");
    expect(conflictData.claim?.paymentIntentId).toBe("intent-a");
  });
});
