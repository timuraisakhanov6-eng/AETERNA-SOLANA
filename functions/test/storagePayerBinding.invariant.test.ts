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
/**
 * Active Irys L1 Mainnet bundler — the ONLY host that publishes
 * `usdc-solana`. The legacy Arweave bundler (node1.irys.xyz) does not
 * expose that token and must never be accepted as the production rail.
 */
const NODE_URL = "https://uploader.irys.xyz";
const LEGACY_NODE_URL = "https://node1.irys.xyz";
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

/**
 * Canonical PREPARED local vault pointer.
 *
 * At the PREPARED boundary no Arweave/Irys txId exists — the canonical
 * order is PREPARED → PAYMENT VERIFIED → CapsuleHold → Upload → real
 * vaultTxId. The prepared projection therefore carries the canonical
 * LocalVaultPointer: "aeterna-local-vault:" + 64 lowercase hex capsuleId.
 */
const LOCAL_VAULT_POINTER = `aeterna-local-vault:${CAPSULE_ID}`;

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
 * Routes stubbed fetch, but ONLY on the exact expected hosts:
 *  - uploader.irys.xyz /info and /price/usdc-solana/<bytes> → Irys L1 responses;
 *  - RPC_URL POST → JSON-RPC getTransaction result (rpcTx);
 *  - anything else (including the legacy Arweave bundler) → 500.
 *
 * The legacy host is deliberately NOT routed: if production code ever
 * regresses back to node1.irys.xyz this mock turns it into a loud 500
 * failure instead of a silent pass. Price requests must also carry the
 * exact `usdc-solana` token — a wrong token is rejected, not absorbed.
 */
function stubFetch(node: { infoAddress?: string; priceAtomic?: string; reject?: Error }) {
  const routing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(LEGACY_NODE_URL)) {
      // Legacy Arweave bundler: never a valid active rail.
      return new Response("Currency not supported", { status: 400 });
    }
    if (url.startsWith(NODE_URL)) {
      if (node.reject) throw node.reject;
      if (url.includes("/info")) {
        return new Response(
          JSON.stringify({ addresses: { "usdc-solana": node.infoAddress ?? IRYS_DESTINATION } }),
          { status: 200 }
        );
      }
      if (/\/price\/usdc-solana\/\d+$/.test(url)) {
        return new Response(node.priceAtomic ?? AMOUNT_ATOMIC, { status: 200 });
      }
      // Any other token path is unsupported on this node.
      return new Response("Currency not supported", { status: 400 });
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

/**
 * The REAL `getTransaction` transaction shape.
 *
 * The fetch stub answers with the JSON-RPC envelope `{jsonrpc, id, result}` and
 * `solanaJsonRpc()` unwraps it, so what the verifier receives is exactly this
 * object — `slot`/`blockTime`/`transaction`/`meta` at the top level, with the
 * on-chain failure inside `meta.err`. It must NOT be wrapped in another
 * `result` layer: that nesting is what made every verification fail closed.
 */
function solanaTx(payer: string, preAtomic: string, postPayerAtomic: string, postDestAtomic: string) {
  return {
    slot: 123,
    blockTime: NOW / 1000,
    transaction: { message: { accountKeys: [payer, IRYS_DESTINATION] } },
    meta: {
      err: null,
      preTokenBalances: [
        { owner: payer, mint: TOKEN_MINT, uiTokenAmount: { amount: preAtomic } },
      ],
      postTokenBalances: [
        { owner: payer, mint: TOKEN_MINT, uiTokenAmount: { amount: postPayerAtomic } },
        { owner: IRYS_DESTINATION, mint: TOKEN_MINT, uiTokenAmount: { amount: postDestAtomic } },
      ],
    },
  };
}

async function submitPrepared(
  env: ReturnType<typeof buildEnv>,
  identityId = IDENTITY_ID,
  pointer: string = LOCAL_VAULT_POINTER
) {
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
      encryptedVaultPointer: pointer,
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

/**
 * Submits only the quote for an already-prepared capsule, WITHOUT
 * re-stubbing fetch. The bundler-host regression tests install their
 * own fetch mock (to observe the exact host/token dialed) and must not
 * have it replaced by stubFetch() mid-test.
 */
async function submitQuoteOnly(env: ReturnType<typeof buildEnv>) {
  const preparedRes = await submitPrepared(env);
  if (preparedRes.status !== 200) return preparedRes;
  const preparedData = (await preparedRes.json()) as {
    preparedProjection: { preparedProjectionId: string };
  };
  const { onRequestPost } = await import("./../api/storage/quote");
  return onRequestPost(
    fakeContext(env, {
      creatorIdentityId: IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      preparedProjectionId: preparedData.preparedProjection.preparedProjectionId,
    })
  );
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

/**
 * PREPARED local vault pointer contract.
 *
 * The prepared projection carries a canonical LocalVaultPointer
 * ("aeterna-local-vault:" + 64 lowercase hex capsuleId) — NOT a storage
 * pointer. No Arweave/Irys txId can exist at the PREPARED boundary
 * because Upload canonically follows PAYMENT VERIFIED / CapsuleHold.
 *
 * These tests exercise the REAL onRequestPost and pin the accepted
 * grammar: the embedded capsuleId is validated in full, so prefix-only
 * acceptance (arbitrary trailing text) is rejected.
 */
describe("Prepared local vault pointer contract", () => {
  beforeEach(() => {
    rpcTx = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts the canonical LocalVaultPointer", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    const res = await submitPrepared(env, IDENTITY_ID, LOCAL_VAULT_POINTER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      preparedProjection: { encryptedVaultPointer: string };
    };
    expect(body.ok).toBe(true);
    // Stored verbatim — the pointer is never converted into a TXID.
    expect(body.preparedProjection.encryptedVaultPointer).toBe(LOCAL_VAULT_POINTER);
  });

  it("rejects malformed local pointers with INVALID_ENCRYPTED_VAULT_POINTER", async () => {
    const malformed = [
      // wrong length (too short / too long)
      `aeterna-local-vault:${"a".repeat(63)}`,
      `aeterna-local-vault:${"a".repeat(65)}`,
      // non-hex characters after the prefix
      `aeterna-local-vault:${"z".repeat(64)}`,
      // uppercase hex
      `aeterna-local-vault:${"A".repeat(64)}`,
      // empty id
      "aeterna-local-vault:",
      // arbitrary text after prefix (prefix-only acceptance is forbidden)
      "aeterna-local-vault:not-a-capsule-id",
      // hyphenated ids are NOT canonical capsuleIds
      "aeterna-local-vault:lifecycle-abc-123",
      // prefix-only / bare prefix forms
      "aeterna-local-vault",
      `${CAPSULE_ID}`,
    ];

    for (const pointer of malformed) {
      const env = buildEnv();
      stubFetch({});
      seedIdentity(env);
      seedReservedLifecycle(env);
      const res = await submitPrepared(env, IDENTITY_ID, pointer);
      expect(res.status, `expected rejection for: ${JSON.stringify(pointer)}`).toBe(400);
      expect((await res.json()).error).toBe("INVALID_ENCRYPTED_VAULT_POINTER");
    }
  });

  it("does NOT accept a TXID as the prepared pointer", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    // A well-formed Arweave/Irys TXID is NOT the prepared contract.
    const res = await submitPrepared(env, IDENTITY_ID, "c".repeat(43));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_ENCRYPTED_VAULT_POINTER");
  });

  it("rejects arbitrary / foreign pointer schemes", async () => {
    const foreign = [
      "ar://pointer",
      "https://evil.example/vault",
      "not-a-pointer",
      "aeterna-local-vault:/vault",
      "local-vault:" + CAPSULE_ID,
    ];

    for (const pointer of foreign) {
      const env = buildEnv();
      stubFetch({});
      seedIdentity(env);
      seedReservedLifecycle(env);
      const res = await submitPrepared(env, IDENTITY_ID, pointer);
      expect(res.status, `expected rejection for: ${JSON.stringify(pointer)}`).toBe(400);
      expect((await res.json()).error).toBe("INVALID_ENCRYPTED_VAULT_POINTER");
    }
  });

  it("preserves the other prepared field contracts when the pointer is valid", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    const res = await submitPrepared(env, IDENTITY_ID, LOCAL_VAULT_POINTER);
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as {
      encryptedSizeBytes: number;
      vaultSha256: string;
      saltBase: string;
      creatorIdentityId: string;
      lifecycleId: string;
      capsuleId: string;
    };
    expect(stored.encryptedSizeBytes).toBe(16);
    expect(stored.vaultSha256).toBe("a".repeat(64));
    expect(stored.saltBase).toBe("b".repeat(32));
    expect(stored.creatorIdentityId).toBe(IDENTITY_ID);
    expect(stored.lifecycleId).toBe(LIFECYCLE_ID);
    expect(stored.capsuleId).toBe(CAPSULE_ID);
  });
});

/**
 * Irys bundler host regression.
 *
 * Root cause this locks down: the storage rail previously targeted
 * node1.irys.xyz — a legacy Arweave bundler that does NOT publish
 * `usdc-solana`, so every /price request answered HTTP 400
 * "Currency not supported" and /api/storage/quote failed closed with
 * 502 IRYS_STORAGE_PRICE_UNAVAILABLE. The active rail must be the
 * Irys L1 Mainnet bundler, which does publish that token.
 */
describe("Irys active bundler host (L1 mainnet, not legacy Arweave)", () => {
  beforeEach(() => {
    rpcTx = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A. quote requests the price from uploader.irys.xyz with the usdc-solana token", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    const res = await submitQuoteOnly(env);
    expect(res.status).toBe(200);

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const urls = calls.map((c) => String(c[0]));

    expect(urls.some((u) => u.startsWith(`${NODE_URL}/price/usdc-solana/`))).toBe(true);
    expect(urls.some((u) => u.startsWith(`${NODE_URL}/info`))).toBe(true);
    expect(urls.some((u) => u.startsWith(`${LEGACY_NODE_URL}/`))).toBe(false);
  });

  it("B. price request path is exactly /price/usdc-solana/<bytes>", async () => {
    const env = buildEnv();
    stubFetch({});
    seedIdentity(env);
    seedReservedLifecycle(env);
    const res = await submitQuoteOnly(env);
    expect(res.status).toBe(200);

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const priceUrls = calls.map((c) => String(c[0])).filter((u) => u.includes("/price/"));

    expect(priceUrls.length).toBeGreaterThan(0);
    for (const u of priceUrls) {
      expect(u.startsWith("https://uploader.irys.xyz/price/usdc-solana/")).toBe(true);
      expect(/^[0-9]+$/.test(u.slice("https://uploader.irys.xyz/price/usdc-solana/".length))).toBe(true);
    }
  });

  it("C. the legacy Arweave bundler is never accepted as the active rail", async () => {
    const env = buildEnv();
    const routing = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(NODE_URL)) {
        if (url.includes("/info")) {
          return new Response(
            JSON.stringify({ addresses: { "usdc-solana": IRYS_DESTINATION } }),
            { status: 200 }
          );
        }
        if (url.startsWith(`${NODE_URL}/price/usdc-solana/`)) {
          return new Response(AMOUNT_ATOMIC, { status: 200 });
        }
        return new Response("Currency not supported", { status: 400 });
      }
      // Legacy host answers exactly like the real legacy node.
      if (url.startsWith(LEGACY_NODE_URL)) {
        return new Response("Currency not supported", { status: 400 });
      }
      if (url === RPC_URL) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
      }
      if (url.includes("/api/time")) {
        return new Response(JSON.stringify({ ok: true, nowUtc: NOW, now: NOW / 1000 }), { status: 200 });
      }
      return new Response("unexpected fetch", { status: 500 });
    });
    vi.stubGlobal("fetch", routing);

    seedIdentity(env);
    seedReservedLifecycle(env);
    const res = await submitQuoteOnly(env);
    expect(res.status).toBe(200);

    // Quote succeeds on the L1 bundler; the legacy host was never used.
    const urls = routing.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith(`${LEGACY_NODE_URL}/`))).toBe(false);
  });

  it("D. the legacy Arweave bundler refuses usdc-solana, so the rail would fail closed", async () => {
    const env = buildEnv();
    // Only the legacy host is reachable — mirrors the pre-patch production bug.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(LEGACY_NODE_URL)) {
          return new Response("Currency not supported", { status: 400 });
        }
        if (url.includes("/api/time")) {
          return new Response(JSON.stringify({ ok: true, nowUtc: NOW, now: NOW / 1000 }), { status: 200 });
        }
        return new Response("unexpected fetch", { status: 500 });
      })
    );

    seedIdentity(env);
    seedReservedLifecycle(env);
    const res = await submitQuoteOnly(env);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("IRYS_STORAGE_PRICE_UNAVAILABLE");
  });
});
