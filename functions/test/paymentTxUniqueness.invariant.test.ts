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
import { createFakeKV, createFakeRequest, makeEventContext, createFakeCreditCoordinatorBinding, createFakeDurableObjectStorage } from "./harness";
import { CreditOperationCoordinator } from "../do/creditOperationCoordinator";
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

/**
 * KV-wired CREDIT_OP_COORDINATOR binding.
 *
 * Mirrors the harness binding's Durable Object semantics — one instance per
 * idFromName, plus a per-instance fetch queue emulating the DO input gate —
 * but wires the Durable Object's CREATOR_CREDITS env to the SAME fake KV the
 * endpoint under test uses. That makes the grant op's KV credit-record and
 * quote-index writes observable, exactly as they are in production.
 */
function createKvWiredCreditCoordinatorBinding(
  creditsKv: ReturnType<typeof createFakeKV>
) {
  const instances = new Map<string, CreditOperationCoordinator>();
  const queues = new Map<string, Promise<unknown>>();
  const storages = new Map<string, ReturnType<typeof createFakeDurableObjectStorage>>();

  function instanceFor(id: string): CreditOperationCoordinator {
    let instance = instances.get(id);
    if (!instance) {
      const storage = createFakeDurableObjectStorage();
      storages.set(id, storage);
      instance = new CreditOperationCoordinator(
        { storage } as never,
        {
          CREATOR_CREDITS: {
            get: (key: string) => creditsKv.get(key),
            put: (key: string, value: string) => creditsKv.put(key, value),
            delete: (key: string) => creditsKv.delete(key),
          },
          PUBLICATION_VERIFICATIONS: { get: async () => null },
          SEAL_VERIFICATIONS: { get: async () => null },
        } as never
      );
      instances.set(id, instance);
    }
    return instance;
  }

  return {
    idFromName(name: string) {
      return { id: name };
    },
    get(binding: { id: string }) {
      const id = binding.id;
      instanceFor(id);
      return {
        async fetch(request: Request): Promise<Response> {
          const tail = queues.get(id) ?? Promise.resolve();
          const run = tail.then(() => instances.get(id)!.fetch(request));
          queues.set(
            id,
            run.then(
              () => undefined,
              () => undefined
            )
          );
          return run;
        },
      };
    },
    /** Direct access to per-instance DO storage for assertions. */
    storages,
  };
}

function buildEnv() {
  const creditsKv = createFakeKV();
  const coordinator = createKvWiredCreditCoordinatorBinding(creditsKv);
  const env = {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_IDENTITIES: createFakeCreatorIdentityKV(),
    CREATOR_CREDITS: creditsKv,
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
      currency: "USDC",
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

  it("FROZEN RAIL: EVM/Base transaction is rejected before amount evaluation (no uniqueness binding)", async () => {
    const { env } = buildEnv();
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const fakeFetch = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-amount",
      txHash: EVM_TX,
    });

    vi.unstubAllGlobals();

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("UNSUPPORTED_RAIL");
    // No Base RPC provider was queried, and no uniqueness binding was established.
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(
      await claimRecordFor(env.CREDIT_OP_COORDINATOR, "base", EVM_TX)
    ).toBeUndefined();
  });

  it("FROZEN RAIL: EVM/Base transaction is rejected before destination evaluation (no uniqueness binding)", async () => {
    const { env } = buildEnv();
    await seedQuote(env.BUSINESS_QUOTES, "intent-a");

    const fakeFetch = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);

    const res = await verifyPayment(env, {
      paymentIntentId: "intent-a",
      evidenceId: "ev-dest",
      txHash: EVM_TX,
    });

    vi.unstubAllGlobals();

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("UNSUPPORTED_RAIL");
    // No Base RPC provider was queried, and no uniqueness binding was established.
    expect(fakeFetch).not.toHaveBeenCalled();
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

  it("GAP 3: a verified payment still grants a Credit after the Business Quote is gone", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-gap3");

    const verifyRes = await verifyPayment(env, {
      paymentIntentId: "intent-gap3",
      evidenceId: "ev-gap3",
      transactionId: SOLANA_TX,
    });
    expect(verifyRes.status).toBe(200);
    expect(((await verifyRes.json()) as { status: string }).status).toBe("VERIFIED");

    // Simulate the 30-minute Business Quote TTL elapsing AFTER verification.
    await env.BUSINESS_QUOTES.delete("quote:intent-gap3");

    const grantRes = await grantCredit(env, {
      paymentIntentId: "intent-gap3",
      evidenceId: "ev-gap3",
      transactionId: SOLANA_TX,
    });

    expect(grantRes.status).toBe(200);
    const grantData = (await grantRes.json()) as { ok: boolean; creatorCreditId: string };
    expect(grantData.ok).toBe(true);
    expect(creditRecordIds(env.CREATOR_CREDITS)).toEqual([grantData.creatorCreditId]);
  });

  it("GAP 3: an UNVERIFIED expired Business Quote is still rejected at verification, granting no Credit", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());

    await createBusinessQuote(
      { BUSINESS_QUOTES: env.BUSINESS_QUOTES },
      {
        paymentIntentId: "intent-expired",
        expectedAmount: 1,
        currency: "USDC",
        createdAt: Date.now() - 60_000,
        expiresAt: Date.now() - 1_000,
      }
    );

    const verifyRes = await verifyPayment(env, {
      paymentIntentId: "intent-expired",
      evidenceId: "ev-expired",
      transactionId: SOLANA_TX,
    });

    expect(verifyRes.status).toBe(402);
    expect(((await verifyRes.json()) as { error: string }).error).toBe("QUOTE_EXPIRED");
    expect(creditRecordIds(env.CREATOR_CREDITS)).toEqual([]);
  });

  it("client reload after verification: grant stays recoverable while the VerifiedPayment record is valid", async () => {
    const { env } = buildEnv();
    mockSolanaTransaction(successfulSolanaTransaction());
    await seedQuote(env.BUSINESS_QUOTES, "intent-reload");

    const verifyRes = await verifyPayment(env, {
      paymentIntentId: "intent-reload",
      evidenceId: "ev-reload",
      transactionId: SOLANA_TX,
    });
    expect(verifyRes.status).toBe(200);

    // Original page load mints the Credit.
    const first = await grantCredit(env, {
      paymentIntentId: "intent-reload",
      evidenceId: "ev-reload",
      transactionId: SOLANA_TX,
    });
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { creatorCreditId: string }).creatorCreditId;

    // Client reloads: a fresh grant request reuses the same VerifiedPayment
    // and must converge on the SAME Creator Credit — never a second one.
    const afterReload = await grantCredit(env, {
      paymentIntentId: "intent-reload",
      evidenceId: "ev-reload",
      transactionId: SOLANA_TX,
    });
    expect(afterReload.status).toBe(200);
    const reloadId = ((await afterReload.json()) as { creatorCreditId: string }).creatorCreditId;

    expect(reloadId).toBe(firstId);
    expect(creditRecordIds(env.CREATOR_CREDITS)).toEqual([firstId]);
  });
});
