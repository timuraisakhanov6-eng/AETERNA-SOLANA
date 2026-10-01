/**
 * Stage 4.5 — `/api/service-payment/verify` ATOMIC AMOUNT invariant.
 *
 * Root cause this file locks down:
 *
 *   The verifier previously compared `uiTokenAmount.uiAmount` — a FLOAT in
 *   human units — against the integer literal `1`. IEEE-754 makes that
 *   deterministic-but-wrong: `1.009 - 0.009 === 0.9999999999999999`, so a
 *   CORRECT $1 payment onto a settlement balance of `0.009` was rejected with
 *   `AMOUNT_MISMATCH` (observed in the first real E2E).
 *
 * The verifier now uses the RAW ATOMIC integer string `uiTokenAmount.amount`
 * (`1_000_000n` = 1 USDC) via BigInt — the same pattern already used by
 * `functions/lib/storage/solanaUsdcVerifier.ts`.
 *
 * `uiAmount` is deliberately NOT read on the authorization path: these tests
 * prove that a present-but-INEXACT `uiAmount` cannot change the outcome, and
 * that a malformed/missing raw `amount` fails CLOSED rather than becoming 0.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
} from "./harness";
import { onRequestPost as servicePaymentVerifyPost } from "./../api/service-payment/verify";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

const PAYMENT_INTENT_ID = "intent-atomic-1";
const CREATOR_IDENTITY_ID = "creator-atomic-1";
const CREATOR_IDENTITY_NETWORK = "solana";
const CREATOR_IDENTITY_ACCOUNT = "123456789ABCDEF";

const SETTLEMENT = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TX_HASH = "Base58SignatureForSolanaTransaction1234567890ABCDEF1234567890ABCDEF";

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

interface BalanceEntry {
  owner: string;
  mint: string;
  uiTokenAmount: Record<string, unknown>;
}

interface Case {
  /** Destination (settlement) post-balance entry. */
  destinationPost: BalanceEntry;
  /** Destination pre-balance entry; omit for "account did not exist". */
  destinationPre?: BalanceEntry;
  /** Source (payer) post-balance entry. */
  sourcePost: BalanceEntry;
  /** Source pre-balance entry; omit for "account did not exist". */
  sourcePre?: BalanceEntry;
}

const entry = (
  owner: string,
  uiTokenAmount: Record<string, unknown>,
  mint = USDC_MINT
): BalanceEntry => ({ owner, mint, uiTokenAmount });

/** Settlement +1 USDC, payer -1 USDC — the canonical VALID payment. */
function validCase(
  destinationPreAtomic = "0",
  destinationPostAtomic = "1000000",
  sourcePreAtomic = "1000000",
  sourcePostAtomic = "0"
): Case {
  return {
    destinationPre: entry(SETTLEMENT, { amount: destinationPreAtomic, decimals: 6 }),
    destinationPost: entry(SETTLEMENT, { amount: destinationPostAtomic, decimals: 6 }),
    sourcePre: entry(CREATOR_IDENTITY_ACCOUNT, { amount: sourcePreAtomic, decimals: 6 }),
    sourcePost: entry(CREATOR_IDENTITY_ACCOUNT, { amount: sourcePostAtomic, decimals: 6 }),
  };
}

async function runVerify(testCase: Case): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = {
    BUSINESS_QUOTES: {
      get: async () =>
        JSON.stringify({
          paymentIntentId: PAYMENT_INTENT_ID,
          expectedAmount: 1,
          currency: "USDC",
          expiresAt: Date.now() + 60_000,
        }),
    },
    CREATOR_IDENTITIES: createFakeCreatorIdentityKV(),
    VERIFIED_PAYMENTS: { get: async () => null, put: async () => {} },
    SOLANA_MAINNET_RPC_URL: "https://solana-rpc.example.com",
    CREDIT_OP_COORDINATOR: createFakeCreditCoordinatorBinding(),
  };

  const original = await import("./../lib/solana/rpc");
  Object.defineProperty(original, "getSolanaTransaction", {
    value: vi.fn().mockResolvedValue({
      slot: 123,
      blockTime: 1_800_000_000,
      transaction: {
        message: { accountKeys: [{ pubkey: CREATOR_IDENTITY_ACCOUNT, signer: true }] },
      },
      meta: {
        err: null,
        postTokenBalances: [
          testCase.destinationPost,
          ...(testCase.sourcePost ? [testCase.sourcePost] : []),
        ],
        preTokenBalances: [
          ...(testCase.destinationPre ? [testCase.destinationPre] : []),
          ...(testCase.sourcePre ? [testCase.sourcePre] : []),
        ],
      },
    }),
    writable: true,
    configurable: true,
  });

  const request = createFakeRequest({
    headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    body: {
      paymentIntentId: PAYMENT_INTENT_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      evidenceId: "ev-atomic",
      transactionId: TX_HASH,
    },
  });

  const res = await servicePaymentVerifyPost(makeEventContext({ request, env }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== *
 * PASS — the exact cases the float implementation got wrong
 * ================================================================== */

describe("service-payment/verify — ATOMIC amount: PASS cases", () => {
  it("PASSES 0.009 -> 1.009 (float delta 0.9999999999999999)", async () => {
    // The precise real-E2E precondition: settlement held 9000 atomic (0.009)
    // and a correct $1 payment takes it to 1009000 atomic (1.009).
    const r = await runVerify(
      validCase("9000", "1009000", "1009000", "9000")
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("VERIFIED");
  });

  it("PASSES 0.9 -> 1.9 (float delta 0.9999999999999999)", async () => {
    const r = await runVerify(validCase("900000", "1900000", "1900000", "900000"));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("VERIFIED");
  });

  it("PASSES 0 -> 1 USDC", async () => {
    const r = await runVerify(validCase("0", "1000000", "1000000", "0"));
    expect(r.status).toBe(200);
  });

  it("PASSES a large pre-balance (2.009525 -> 3.009525)", async () => {
    const r = await runVerify(
      validCase("2009525", "3009525", "3009525", "2009525")
    );
    expect(r.status).toBe(200);
  });

  it("PASSES when the destination PRE entry is absent (account did not exist)", async () => {
    const c = validCase();
    delete (c as { destinationPre?: BalanceEntry }).destinationPre;
    const r = await runVerify(c);
    expect(r.status).toBe(200);
  });

  it("PASSES when uiAmount is INEXACT — the raw amount is authoritative", async () => {
    const r = await runVerify({
      destinationPre: entry(SETTLEMENT, { amount: "9000", uiAmount: 0.009, decimals: 6 }),
      destinationPost: entry(SETTLEMENT, { amount: "1009000", uiAmount: 1.009, decimals: 6 }),
      sourcePre: entry(CREATOR_IDENTITY_ACCOUNT, { amount: "1009000", uiAmount: 1.009, decimals: 6 }),
      sourcePost: entry(CREATOR_IDENTITY_ACCOUNT, { amount: "9000", uiAmount: 0.009, decimals: 6 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("VERIFIED");
  });

  it("PASSES when uiAmount is NULL — it is never read on the auth path", async () => {
    const r = await runVerify({
      destinationPre: entry(SETTLEMENT, { amount: "9000", uiAmount: null, decimals: 6 }),
      destinationPost: entry(SETTLEMENT, { amount: "1009000", uiAmount: null, decimals: 6 }),
      sourcePre: entry(CREATOR_IDENTITY_ACCOUNT, { amount: "1009000", uiAmount: null, decimals: 6 }),
      sourcePost: entry(CREATOR_IDENTITY_ACCOUNT, { amount: "9000", uiAmount: null, decimals: 6 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("VERIFIED");
  });
});

/* ================================================================== *
 * FAIL — amount
 * ================================================================== */

describe("service-payment/verify — ATOMIC amount: FAIL cases", () => {
  it("REJECTS 0 -> 2 USDC with AMOUNT_MISMATCH", async () => {
    const r = await runVerify(validCase("0", "2000000", "2000000", "0"));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("AMOUNT_MISMATCH");
  });

  it("REJECTS a one-base-unit short amount (999999)", async () => {
    const r = await runVerify(validCase("0", "999999", "999999", "0"));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("AMOUNT_MISMATCH");
  });

  it("REJECTS a wrong raw destination amount even when uiAmount looks right", async () => {
    const r = await runVerify({
      destinationPost: entry(SETTLEMENT, { amount: "3000000", uiAmount: 1, decimals: 6 }),
      sourcePost: entry(CREATOR_IDENTITY_ACCOUNT, { amount: "0", uiAmount: 1, decimals: 6 }),
      sourcePre: entry(CREATOR_IDENTITY_ACCOUNT, { amount: "1000000", uiAmount: 1, decimals: 6 }),
    });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("AMOUNT_MISMATCH");
  });

  it("REJECTS a MALFORMED destination raw amount (fail closed, no 0 coercion)", async () => {
    for (const bad of [undefined, null, "", "1.5", "-1000000", "abc", 1000000]) {
      const c = validCase();
      c.destinationPost = entry(SETTLEMENT, {
        amount: bad as unknown as string,
        uiAmount: 1,
        decimals: 6,
      });
      const r = await runVerify(c);
      expect(r.status, `amount=${String(bad)}`).toBe(402);
      expect(r.body.error, `amount=${String(bad)}`).toBe("AMOUNT_MISMATCH");
    }
  });

  it("REJECTS a malformed SOURCE raw amount with SOURCE_AMOUNT_MISMATCH", async () => {
    const c = validCase();
    c.sourcePost = entry(CREATOR_IDENTITY_ACCOUNT, { amount: "nope", uiAmount: 0, decimals: 6 });
    const r = await runVerify(c);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("SOURCE_AMOUNT_MISMATCH");
  });

  it("REJECTS a wrong SOURCE amount with SOURCE_AMOUNT_MISMATCH", async () => {
    const r = await runVerify(validCase("0", "1000000", "5000000", "3000000"));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("SOURCE_AMOUNT_MISMATCH");
  });
});

/* ================================================================== *
 * FAIL — identity (unchanged checks preserved)
 * ================================================================== */

describe("service-payment/verify — identity checks preserved", () => {
  it("REJECTS a wrong MINT with DESTINATION_NOT_FOUND", async () => {
    const c = validCase();
    c.destinationPost = entry(SETTLEMENT, { amount: "1000000", decimals: 6 }, "So11111111111111111111111111111111111111112");
    const r = await runVerify(c);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("DESTINATION_NOT_FOUND");
  });

  it("REJECTS a wrong DESTINATION owner with DESTINATION_NOT_FOUND", async () => {
    const c = validCase();
    c.destinationPost = entry("AwCJWRPbZQLAfyCVD9GcMMA2cERmGfvUSog1Bv8pqdHv", {
      amount: "1000000",
      decimals: 6,
    });
    const r = await runVerify(c);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("DESTINATION_NOT_FOUND");
  });

  it("REJECTS a missing SOURCE account with SOURCE_ACCOUNT_NOT_FOUND", async () => {
    const c = validCase();
    c.sourcePost = entry("SomeOtherOwner111111111111111111111111111111", {
      amount: "0",
      decimals: 6,
    });
    const r = await runVerify(c);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("SOURCE_ACCOUNT_NOT_FOUND");
  });
});
