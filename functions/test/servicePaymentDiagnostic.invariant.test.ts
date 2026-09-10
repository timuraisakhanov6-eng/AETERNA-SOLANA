import { describe, expect, it, vi, afterEach } from "vitest";
import { createFakeRequest, makeEventContext, createFakeCreditCoordinatorBinding, type CreateQuoteEnv } from "./harness";
import { onRequestPost as servicePaymentVerifyPost } from "./../api/service-payment/verify";
import * as solanaRpc from "./../lib/solana/rpc";

/*
 * TEMPORARY DIAGNOSTIC invariants.
 *
 * When a Solana transaction is found, finalized, and carries meta.err != null,
 * the 402 TX_FAILED response must carry a SAFE, server-generated diagnostic:
 *   - TX_FAILED includes the sanitized diagnostic
 *   - successful verifications are byte-shape-identical to before (no diagnostic)
 *   - no sensitive material is exposed (no keys, secrets, signatures, raw tx)
 */

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

const PAYMENT_INTENT_ID = "intent-diag";
const CREATOR_IDENTITY_ID = "creator-diag";
const CREATOR_IDENTITY_NETWORK = "solana";
const CREATOR_IDENTITY_ACCOUNT = "123456789ABCDEF";
const SOLANA_TX_SIGNATURE =
  "Base58SignatureForSolanaTransaction1234567890ABCDEF1234567890ABCDEF";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SETTLEMENT_ADDRESS = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";

const DIAGNOSTIC_ALLOWLIST = new Set(["hasMetaErr", "metaErr", "slot", "balances"]);
const BALANCES_ALLOWLIST = new Set([
  "payerUsdcDelta",
  "destinationUsdcDelta",
  "payerSOLDelta",
]);

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
  };
}

function buildEnv() {
  return {
    BUSINESS_QUOTES: {
      get: async () =>
        JSON.stringify({
          paymentIntentId: PAYMENT_INTENT_ID,
          expectedAmount: 1,
          currency: "USD",
          expiresAt: Date.now() + 60_000,
        }),
    },
    CREATOR_IDENTITIES: createFakeCreatorIdentityKV(),
    VERIFIED_PAYMENTS: { get: async () => null, put: async () => {} },
    SOLANA_MAINNET_RPC_URL: "https://solana-rpc.example.com",
    CREDIT_OP_COORDINATOR: createFakeCreditCoordinatorBinding(),
  };
}

function buildContext(body: Record<string, unknown>) {
  const request = createFakeRequest({
    headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    body,
  });
  /* Harness FakeKV typing is wider than the KV surface verify.ts consumes. */
  const env = buildEnv() as unknown as CreateQuoteEnv;
  return makeEventContext({ request, env });
}

const originalGetSolanaTransaction = Object.getOwnPropertyDescriptor(
  solanaRpc,
  "getSolanaTransaction"
)!.value;

function mockFetchedTransaction(transaction: unknown) {
  Object.defineProperty(solanaRpc, "getSolanaTransaction", {
    value: vi.fn().mockResolvedValue(transaction),
    writable: true,
    configurable: true,
  });
}

async function requestVerifyWithSolanaSignature() {
  return servicePaymentVerifyPost(
    buildContext({
      paymentIntentId: PAYMENT_INTENT_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      evidenceId: "ev-diag",
      transactionId: SOLANA_TX_SIGNATURE,
    })
  );
}

afterEach(() => {
  Object.defineProperty(solanaRpc, "getSolanaTransaction", {
    value: originalGetSolanaTransaction,
    writable: true,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("Service payment TX_FAILED diagnostic invariants", () => {
  it("TX_FAILED: 402 includes sanitized diagnostic from finalized transaction", async () => {
    mockFetchedTransaction({
      slot: 123456,
      blockTime: 1_700_000_000,
      transaction: {
        message: {
          accountKeys: [{ pubkey: CREATOR_IDENTITY_ACCOUNT, signer: true }],
        },
      },
      meta: {
        err: { InstructionError: [0, { Custom: 1 }] },
        preBalances: [100_000, 50_000],
        postBalances: [95_000, 50_000],
        preTokenBalances: [
          {
            owner: CREATOR_IDENTITY_ACCOUNT,
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
            owner: CREATOR_IDENTITY_ACCOUNT,
            mint: USDC_MINT,
            uiTokenAmount: { uiAmount: 1, decimals: 6 },
          },
          {
            owner: SETTLEMENT_ADDRESS,
            mint: USDC_MINT,
            uiTokenAmount: { uiAmount: 5, decimals: 6 },
          },
        ],
      },
    });

    const res = await requestVerifyWithSolanaSignature();

    expect(res.status).toBe(402);
    const payload = (await res.json()) as Record<string, any>;
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("TX_FAILED");
    expect(payload.diagnostic).toBeDefined();
    expect(payload.diagnostic.hasMetaErr).toBe(true);
    expect(payload.diagnostic.metaErr).toEqual({
      InstructionError: [0, { Custom: 1 }],
    });
    expect(payload.diagnostic.slot).toBe(123456);
    expect(payload.diagnostic.balances).toEqual({
      payerUsdcDelta: 0,
      destinationUsdcDelta: 0,
      payerSOLDelta: -5000,
    });
  });

  it("SUCCESS: successful verification response is unchanged (no diagnostic field)", async () => {
    mockFetchedTransaction({
      slot: 123457,
      blockTime: 1_700_000_000,
      transaction: {
        message: {
          accountKeys: [{ pubkey: CREATOR_IDENTITY_ACCOUNT, signer: true }],
        },
      },
      meta: {
        preTokenBalances: [
          {
            owner: CREATOR_IDENTITY_ACCOUNT,
            mint: USDC_MINT,
            uiTokenAmount: { uiAmount: 1, decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            owner: SETTLEMENT_ADDRESS,
            mint: USDC_MINT,
            uiTokenAmount: { uiAmount: 1, decimals: 6 },
          },
          {
            owner: CREATOR_IDENTITY_ACCOUNT,
            mint: USDC_MINT,
            uiTokenAmount: { uiAmount: 0, decimals: 6 },
          },
        ],
      },
    });

    const res = await requestVerifyWithSolanaSignature();

    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("VERIFIED");
    expect("diagnostic" in payload).toBe(false);
  });

  it("SAFETY: diagnostic exposes only allowlisted, non-sensitive fields", async () => {
    mockFetchedTransaction({
      slot: 123458,
      blockTime: 1_700_000_000,
      transaction: {
        message: {
          accountKeys: [{ pubkey: CREATOR_IDENTITY_ACCOUNT, signer: true }],
        },
      },
      meta: {
        err: "InsufficientFundsForFee",
        preBalances: [100_000],
        postBalances: [95_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
    });

    const res = await requestVerifyWithSolanaSignature();

    expect(res.status).toBe(402);
    const payload = (await res.json()) as Record<string, any>;
    expect(payload.error).toBe("TX_FAILED");
    expect(payload.diagnostic.hasMetaErr).toBe(true);
    expect(payload.diagnostic.metaErr).toBe("InsufficientFundsForFee");

    for (const key of Object.keys(payload.diagnostic)) {
      expect(DIAGNOSTIC_ALLOWLIST.has(key)).toBe(true);
    }
    for (const key of Object.keys(payload.diagnostic.balances)) {
      expect(BALANCES_ALLOWLIST.has(key)).toBe(true);
    }

    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      "accountKeys",
      "instructions",
      "logMessages",
      "signatures",
      "privateKey",
      "secret",
      "recipientSecret",
      "creatorAuthority",
      "challenge",
      "feePayer",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
