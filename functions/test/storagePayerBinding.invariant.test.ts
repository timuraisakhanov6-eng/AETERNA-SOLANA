/**
 * Storage payment payer binding — creator wallet authority regression.
 *
 * Canonical chain under test:
 *   creatorIdentityId (random internal id)
 *   → server-side CreatorIdentityRecord resolution
 *   → identity.account (Solana wallet address, server-derived)
 *   → projection.walletAccount → quote.walletAccount
 *   → verify-payment expectedPayer → on-chain payer comparison.
 *
 * creatorIdentityId must NEVER be used as an on-chain payer address,
 * and walletAccount must NEVER be client-supplied.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";
import { sha256 } from "../lib/sha256";

const ORIGIN = "https://aeternacapsule.com";
const NODE_URL = "https://node1.irys.xyz";
const RPC_URL = "https://api.mainnet-beta.solana.com";
const NOW = 1_800_000_000_000;

const IDENTITY_ID = "f".repeat(32); // internal random id — NOT a wallet address
const WALLET_ACCOUNT = "CreatorWalletAccount111111111111111111111111";
const OTHER_WALLET = "OtherWalletAccount222222222222222222222222222";
const IRYS_DESTINATION = "IrysDestinationAccount333333333333333333333";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CAPSULE_ID = "a".repeat(64);
const LIFECYCLE_ID = "lifecycle-1";
const AMOUNT_ATOMIC = "1000000"; // 1 USDC

function buildEnv() {
  return {
    CREATOR_IDENTITIES: createFakeKV(),
    PREPARED_PROJECTIONS: createFakeKV(),
    STORAGE_QUOTES: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    CREATOR_CREDITS: createFakeKV(),
    SOLANA_MAINNET_RPC_URL: RPC_URL,
  };
}

function seedIdentity(env: ReturnType<typeof buildEnv>) {
  env.CREATOR_IDENTITIES.put(
    `creator:identity:solana:${WALLET_ACCOUNT}`,
    JSON.stringify({ id: IDENTITY_ID, network: "solana", account: WALLET_ACCOUNT, firstVerifiedAt: NOW, lastVerifiedAt: NOW })
  );
  env.CREATOR_IDENTITIES.put(
    `creator:identity:id:${IDENTITY_ID}`,
    `solana:${WALLET_ACCOUNT}`
  );
}

function seedReservedLifecycle(env: ReturnType<typeof buildEnv>) {
  env.CREATOR_CREDITS.put(
    `creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`,
    JSON.stringify({
      id: "credit-1",
      status: "CONSUMING",
      creatorIdentityId: IDENTITY_ID,
      capsuleId: CAPSULE_ID,
      lifecycleId: LIFECYCLE_ID,
    })
  );
}

function fakeContext(env: Record<string, unknown>, body: unknown) {
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body,
  });
  return makeEventContext({ request, env: env as never });
}

/**
 * Routes stubbed fetch:
 *  - node1.irys.xyz /info and /price → Irys node responses;
 *  - RPC_URL POST → JSON-RPC getTransaction result (rpcTx);
 *  - anything else → 500.
 */
function stubFetch(node: { infoAddress?: string; priceAtomic?: string; reject?: Error }) {
  const routing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(NODE_URL)) {
      if (node.reject) throw node.reject;
      if (url.includes("/info")) {
        return new Response(
          JSON.stringify({ addresses: { "usdc-solana": node.infoAddress ?? IRYS_DESTINATION } }),
          { status: 200 }
        );
      }
      if (url.includes("/price/")) {
        return new Response(node.priceAtomic ?? AMOUNT_ATOMIC, { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }
    if (url === RPC_URL) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: rpcTx }), { status: 200 });
    }
    if (url.endsWith("/api/time") || url.includes("/api/time")) {
      return new Response(JSON.stringify({ ok: true, nowUtc: NOW, now: NOW / 1000 }), { status: 200 });
    }
    return new Response("unexpected fetch", { status: 500 });
  });
  vi.stubGlobal("fetch", routing);
}

let rpcTx: Record<string, unknown> | null = null;

function solanaTx(payer: string, preAtomic: string, postPayerAtomic: string, postDestAtomic: string) {
  return {
    slot: 123,
    blockTime: NOW / 1000,
    result: {
      err: null,
      transaction: { message: { accountKeys: [payer, IRYS_DESTINATION] } },
      meta: {
        preTokenBalances: [
          { owner: payer, mint: TOKEN_MINT, uiTokenAmount: { amount: preAtomic } },
        ],
        postTokenBalances: [
          { owner: payer, mint: TOKEN_MINT, uiTokenAmount: { amount: postPayerAtomic } },
          { owner: IRYS_DESTINATION, mint: TOKEN_MINT, uiTokenAmount: { amount: postDestAtomic } },
        ],
      },
    },
  };
}

async function submitPrepared(env: ReturnType<typeof buildEnv>, identityId = IDENTITY_ID) {
  const { onRequestPost } = await import("./../api/capsule/prepared");
  const chunk = { chunkId: await sha256(new Uint8Array([1])), mediaId: "m1", index: 0, size: 16 };
  return onRequestPost(
    fakeContext(env, {
      creatorIdentityId: identityId,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      encryptedSizeBytes: 16,
      vaultSha256: "a".repeat(64),
      saltBase: "b".repeat(32),
      encryptedVaultPointer: "c".repeat(43),
      chunkMetadata: [chunk],
    })
  );
}

/** Submits the projection, obtains the canonical quote, returns it. */
async function prepareAndQuote(env: ReturnType<typeof buildEnv>) {
  const preparedRes = await submitPrepared(env);
  expect(preparedRes.status).toBe(200);
  const preparedData = (await preparedRes.json()) as {
    preparedProjection: { preparedProjectionId: string };
  };
  stubFetch({});
  const { onRequestPost } = await import("./../api/storage/quote");
  const quoteRes = await onRequestPost(
    fakeContext(env, {
      creatorIdentityId: IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      preparedProjectionId: preparedData.preparedProjection.preparedProjectionId,
    })
  );
  expect(quoteRes.status).toBe(200);
  const q = (await quoteRes.json()) as {
    storagePaymentId: string;
    walletAccount: string;
    displayAmountUSDC: string;
  };
  process.stdout.write(`DBG_Q[${q.storagePaymentId.slice(-6)}] ${quoteRes.status} wallet=${q.walletAccount ? "set" : "missing"} err=${(q as Record<string, unknown>)["error"] ?? "-"}
`);
  return q;
}

async function verifyPayment(env: ReturnType<typeof buildEnv>, storagePaymentId: string) {
  const { onRequestPost } = await import("./../api/storage/verify-payment");
  const res = await onRequestPost(
    fakeContext(env, {
      storagePaymentId,
      transactionSignature: "S".repeat(88),
    })
  );
  return res;
}

describe("Storage payment payer binding (creator wallet authority)", () => {
  beforeEach(() => {
    rpcTx = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A. prepared rejects an unknown creatorIdentityId with IDENTITY_NOT_FOUND", async () => {
    const env = buildEnv();
    stubFetch({});
    const res = await submitPrepared(env, "e".repeat(32));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("IDENTITY_NOT_FOUND");
  });

  it("B. prepared persists a server-derived walletAccount (not client-supplied)", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    const res = await submitPrepared(env);
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { walletAccount: string; creatorIdentityId: string };
    expect(stored.walletAccount).toBe(WALLET_ACCOUNT);
    expect(stored.creatorIdentityId).toBe(IDENTITY_ID);
    expect(stored.walletAccount).not.toBe(IDENTITY_ID);
  });

  it("C. quote copies walletAccount exclusively from the persisted projection", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    const quote = await prepareAndQuote(env);
    expect(quote.walletAccount).toBe(WALLET_ACCOUNT);
    expect(quote.walletAccount).not.toBe(IDENTITY_ID);
  });

  it("D. verify-payment accepts the creator wallet as on-chain payer", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    rpcTx = solanaTx(WALLET_ACCOUNT, "2000000", "1000000", AMOUNT_ATOMIC);
    const quote = await prepareAndQuote(env);

    process.stdout.write(`DBG_D quote=${JSON.stringify(quote)}
`);
    const res = await verifyPayment(env, quote.storagePaymentId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.payer).toBe(WALLET_ACCOUNT);
  });

  it("E. verify-payment rejects a different on-chain payer with PAYER_MISMATCH", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    rpcTx = solanaTx(OTHER_WALLET, "2000000", "1000000", AMOUNT_ATOMIC);
    const quote = await prepareAndQuote(env);

    const res = await verifyPayment(env, quote.storagePaymentId);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.state).toBe("FAILED");
    expect(json.reason).toBe("PAYER_MISMATCH");
  });

  it("F. creatorIdentityId is never accepted as an on-chain payer", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    rpcTx = solanaTx(IDENTITY_ID, "2000000", "1000000", AMOUNT_ATOMIC);
    const quote = await prepareAndQuote(env);

    const res = await verifyPayment(env, quote.storagePaymentId);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.state).toBe("FAILED");
    expect(json.reason).toBe("PAYER_MISMATCH");
  });

  it("G. already PAYMENT_VERIFIED payment replays idempotently", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    rpcTx = solanaTx(WALLET_ACCOUNT, "2000000", "1000000", AMOUNT_ATOMIC);
    const quote = await prepareAndQuote(env);

    const first = await verifyPayment(env, quote.storagePaymentId);
    expect(first.status).toBe(200);

    const second = await verifyPayment(env, quote.storagePaymentId);
    expect(second.status).toBe(200);
    const json = (await second.json()) as Record<string, unknown>;
    expect(json.state ?? "PAYMENT_VERIFIED").toBe("PAYMENT_VERIFIED");
  });

  it("H. exact amount equality is required (overpayment fails closed)", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    rpcTx = solanaTx(WALLET_ACCOUNT, "3000000", "1000000", "2000000");
    const quote = await prepareAndQuote(env);

    const res = await verifyPayment(env, quote.storagePaymentId);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.state).toBe("FAILED");
    expect(json.reason).toBe("AMOUNT_MISMATCH");
  });
});
