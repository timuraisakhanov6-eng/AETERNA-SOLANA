/**
 * AETERNA — Payment-evidence seam: REAL writer -> REAL reader
 *
 * Canonical invariant under test (F-SEALKEY):
 *
 *   the server that WRITES the payment evidence
 *     (/api/service-payment/verify)
 *   and the server that READS it
 *     (/api/capsule/seal)
 *   MUST agree on ONE canonical intent -> evidence key/path.
 *
 * Why this test exists:
 *   The previous defect was a writer/reader DRIFT: verify.ts wrote
 *   `payment-intent:<id>` while seal.ts read `payment-intent:<id>:latest`
 *   (with a different value shape). Unit tests that seed the KV themselves
 *   cannot catch such drift, because they encode the reader's assumption
 *   instead of the writer's output. This test drives BOTH real handlers in
 *   sequence over one shared KV, so any future key/shape drift fails here.
 *
 * Mocks only: Solana RPC, Durable Object binding, gateway fetch.
 * No network, no blockchain transaction, no production KV mutation.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
  createFakeDurableObjectStorage,
} from "./harness";
import { CreditOperationCoordinator } from "./../do/creditOperationCoordinator";
import { createBusinessQuote } from "./../lib/business/businessQuoteStore";
import { onRequestPost as servicePaymentVerifyPost } from "./../api/service-payment/verify";
import { onRequestPost as sealPost } from "./../api/capsule/seal";
import { onRequestPost as reserveLifecyclePost } from "./../api/creator/reserve-lifecycle";
import { onRequestPost as uploadTokenPost } from "./../api/upload-token";
import * as solanaRpc from "./../lib/solana/rpc";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

const CREATOR_IDENTITY_ID = "creator-1";
const CREATOR_IDENTITY_NETWORK = "solana";
const CREATOR_IDENTITY_ACCOUNT = "123456789ABCDEF";

const SOLANA_TX =
  "Base58SignatureForSolanaTransaction1234567890ABCDEF1234567890ABCDEF";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SETTLEMENT_ADDRESS = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";

const PAYMENT_INTENT_ID = "intent-seam-1";
const EVIDENCE_ID = "evidence-seam-1";
const LIFECYCLE_ID = "lifecycle-seam-1";
const CAPSULE_ID = "a".repeat(64);
const VAULT_TX_ID = "a".repeat(43);
const UPLOAD_TOKEN = "a".repeat(32);
const CREATOR_AUTHORITY_FRAGMENT = "a".repeat(64);

/* ───────────────── fixtures ───────────────── */

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
  return {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_IDENTITIES: createFakeCreatorIdentityKV(),
    CREATOR_CREDITS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    CAPSULE_MANIFESTS: createFakeKV(),
    AUTHORITY_TOKENS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    SEAL_VERIFICATIONS: createFakeKV(),
    STORAGE_QUOTES: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    SOLANA_MAINNET_RPC_URL: "https://solana-rpc.example.com",
    CREDIT_OP_COORDINATOR: createFakeCreditCoordinatorBinding(),
  };
}

type Env = ReturnType<typeof buildEnv>;

/* ───────────────── KV-wired DO (for the reserve -> token chain) ───────────────── */

/**
 * Mirrors the harness DO binding (one instance per idFromName, per-instance
 * fetch queue emulating the DO input gate) but wires the DO's CREATOR_CREDITS
 * env to the SAME fake KV the endpoints use. That makes the reserve op's
 * credit-record and lifecycle-index writes observable, exactly as in
 * production — which is what lets the upload token derive the payment intent
 * server-side.
 */
function createKvWiredCreditCoordinatorBinding(
  creditsKv: ReturnType<typeof createFakeKV>
) {
  const instances = new Map<string, CreditOperationCoordinator>();
  const queues = new Map<string, Promise<unknown>>();

  function instanceFor(id: string): CreditOperationCoordinator {
    let instance = instances.get(id);
    if (!instance) {
      const storage = createFakeDurableObjectStorage();
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
  };
}

const CREDIT_ID = "b".repeat(32);

/** Env whose DO writes into the same CREATOR_CREDITS KV the endpoints read. */
function buildChainedEnv(): Env {
  const creditsKv = createFakeKV();
  return {
    ...buildEnv(),
    CREATOR_CREDITS: creditsKv,
    CREDIT_OP_COORDINATOR: createKvWiredCreditCoordinatorBinding(
      creditsKv
    ) as unknown as Env["CREDIT_OP_COORDINATOR"],
  };
}

/** Seeds the grant-shape credit record (carries the quote/payment binding). */
function seedGrantCreditRecord(env: Env) {
  env.CREATOR_CREDITS.put(
    `creator:credit:${CREDIT_ID}`,
    JSON.stringify({
      id: CREDIT_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      status: "AVAILABLE",
      quoteId: PAYMENT_INTENT_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
}

/** Seeds a PAYMENT_VERIFIED storage payment bound to identity/lifecycle/capsule. */
function seedStoragePayment(env: Env) {
  const storagePaymentId = "storage-payment-seam-1";
  env.STORAGE_QUOTES.put(
    `storage-quote:${CREATOR_IDENTITY_ID}:${LIFECYCLE_ID}:${CAPSULE_ID}`,
    JSON.stringify({
      storagePaymentId,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      expectedAmountAtomic: "1000000",
      irysDestination: "11111111111111111111111111111111",
      tokenMint: USDC_MINT,
      state: "CREATED",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    })
  );
  env.STORAGE_PAYMENTS.put(
    `storage-payment:${storagePaymentId}`,
    JSON.stringify({
      storagePaymentId,
      state: "PAYMENT_VERIFIED",
      transactionSignature: "S".repeat(88),
      payer: CREATOR_IDENTITY_ACCOUNT,
      quote: {
        storagePaymentId,
        creatorIdentityId: CREATOR_IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
        expectedAmountAtomic: "1000000",
        irysDestination: "11111111111111111111111111111111",
        tokenMint: USDC_MINT,
      },
    })
  );
  return storagePaymentId;
}

function context(env: Env, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });
  return makeEventContext({ request, env: env as never });
}

function successfulSolanaTransaction() {
  return {
    slot: 123,
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
          owner: CREATOR_IDENTITY_ACCOUNT,
          mint: USDC_MINT,
          uiTokenAmount: { uiAmount: 0, decimals: 6 },
        },
      ],
    },
  };
}

function validManifest() {
  const sealedAt = Date.now();
  return {
    version: 1,
    capsuleId: CAPSULE_ID,
    saltBase: "a".repeat(32),
    vaultTxId: VAULT_TX_ID,
    openAt: sealedAt + 1000,
    sealedAt,
    encryptedSizeBytes: 1024,
    heartbeatInterval: 86400000,
    ext: { vaultSha256: "a".repeat(64) },
  };
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

/** Seeds the post-verification state that /api/capsule/seal reads. */
function seedSealInputs(env: Env, manifest: ReturnType<typeof validManifest>) {
  env.PUBLICATION_VERIFICATIONS.put(
    `creator:publication:${LIFECYCLE_ID}`,
    JSON.stringify({
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      state: "VERIFIED",
      expectedTxId: VAULT_TX_ID,
      expectedVaultSha256: manifest.ext.vaultSha256,
      evidenceIds: [VAULT_TX_ID],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      verifiedAt: Date.now(),
    })
  );

  env.UPLOAD_TOKENS.put(
    UPLOAD_TOKEN,
    JSON.stringify({
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      permissions: { uploadVault: true },
    })
  );
}

async function runVerify(env: Env): Promise<Response> {
  await createBusinessQuote(
    { BUSINESS_QUOTES: env.BUSINESS_QUOTES },
    {
      paymentIntentId: PAYMENT_INTENT_ID,
      expectedAmount: 1,
      currency: "USDC",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
  );

  return servicePaymentVerifyPost(
    context(env, {
      paymentIntentId: PAYMENT_INTENT_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      evidenceId: EVIDENCE_ID,
      transactionId: SOLANA_TX,
    }) as never
  );
}

async function runSeal(
  env: Env,
  manifest: ReturnType<typeof validManifest>
): Promise<Response> {
  return sealPost(
    context(env, {
      uploadToken: UPLOAD_TOKEN,
      manifest,
      creatorAuthorityFragment: CREATOR_AUTHORITY_FRAGMENT,
    }) as never
  );
}

/* ───────────────── tests ───────────────── */

describe("payment-evidence seam: real writer -> real reader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "content-length": "1024" },
        })
      )
    );
    mockSolanaTransaction(successfulSolanaTransaction());
  });

  afterEach(() => {
    Object.defineProperty(solanaRpc, "getSolanaTransaction", {
      value: originalGetSolanaTransaction,
      writable: true,
      configurable: true,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("writer and reader agree on ONE canonical intent->evidence path", async () => {
    const env = buildEnv();
    const manifest = validManifest();

    // 1. REAL writer: /api/service-payment/verify.
    const verifyRes = await runVerify(env);
    expect(verifyRes.status).toBe(200);
    const verifyJson = (await verifyRes.json()) as { status?: string };
    expect(verifyJson.status).toBe("VERIFIED");

    // The writer must have produced the canonical pointer with the evidence
    // id as its value — NOT a JSON summary, NOT a `:latest` suffixed key.
    expect(
      await env.VERIFIED_PAYMENTS.get(`payment-intent:${PAYMENT_INTENT_ID}`)
    ).toBe(EVIDENCE_ID);
    expect(
      await env.VERIFIED_PAYMENTS.get(
        `verified-payment:${PAYMENT_INTENT_ID}:${EVIDENCE_ID}`
      )
    ).toBeTruthy();

    // No orphan `:latest` key may exist anywhere in the payment evidence.
    const orphanKeys = [...env.VERIFIED_PAYMENTS.data.keys()].filter((key) =>
      key.endsWith(":latest")
    );
    expect(orphanKeys).toEqual([]);

    // 2. REAL reader: /api/capsule/seal, over the SAME KV the writer filled.
    seedSealInputs(env, manifest);
    const sealRes = await runSeal(env, manifest);

    expect(sealRes.status).toBe(200);
    expect(await env.CAPSULE_MANIFESTS.get(CAPSULE_ID)).toBeTruthy();
  });

  it("reader fails closed when the writer's pointer is absent", async () => {
    const env = buildEnv();
    const manifest = validManifest();

    const verifyRes = await runVerify(env);
    expect(verifyRes.status).toBe(200);

    // Simulate the historical drift: the pointer the reader needs is missing.
    await env.VERIFIED_PAYMENTS.delete(`payment-intent:${PAYMENT_INTENT_ID}`);

    seedSealInputs(env, manifest);
    const sealRes = await runSeal(env, manifest);

    expect(sealRes.status).toBe(402);
    expect(await env.CAPSULE_MANIFESTS.get(CAPSULE_ID)).toBeNull();
  });

  it("server-derived intent flows reserve -> upload-token (never trusted from the client)", async () => {
    const env = buildChainedEnv();

    // Grant-shape credit record: carries the quote/payment binding.
    seedGrantCreditRecord(env);

    // 1. REAL reserve-lifecycle derives the intent SERVER-SIDE from the
    //    persisted credit record's quote binding and persists it on the
    //    Credit Record via the Durable Object.
    const reserveRes = await reserveLifecyclePost(
      context(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        creatorCreditId: CREDIT_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFECYCLE_ID,
      }) as never
    );
    expect(reserveRes.status).toBe(200);

    const lifecycleRaw = await env.CREATOR_CREDITS.get(
      `creator:credit:lifecycle:${CREATOR_IDENTITY_ID}:${LIFECYCLE_ID}`
    );
    expect(lifecycleRaw).toBeTruthy();
    const lifecycleRecord = JSON.parse(String(lifecycleRaw)) as {
      status?: string;
      paymentIntentId?: string | null;
    };
    expect(lifecycleRecord.status).toBe("CONSUMING");
    expect(lifecycleRecord.paymentIntentId).toBe(PAYMENT_INTENT_ID);

    // 2. REAL upload-token resolves the SAME server value onto the token.
    seedStoragePayment(env);
    const tokenRes = await uploadTokenPost(
      context(env, {
        canonicalLifecycleId: LIFECYCLE_ID,
        creatorIdentityId: CREATOR_IDENTITY_ID,
      }) as never
    );
    expect(tokenRes.status).toBe(200);
    const tokenJson = (await tokenRes.json()) as { uploadToken?: string };
    const issuedToken = String(tokenJson.uploadToken);
    const tokenRaw = await env.UPLOAD_TOKENS.get(issuedToken);
    expect(tokenRaw).toBeTruthy();
    const tokenRecord = JSON.parse(String(tokenRaw)) as {
      paymentIntentId?: string | null;
    };
    expect(tokenRecord.paymentIntentId).toBe(PAYMENT_INTENT_ID);

    // 3. A client-supplied intent that does not match the server value is
    //    rejected — the client can never inject payment authority.
    const mismatchRes = await uploadTokenPost(
      context(env, {
        canonicalLifecycleId: LIFECYCLE_ID,
        creatorIdentityId: CREATOR_IDENTITY_ID,
        paymentIntentId: "intent-attacker",
      }) as never
    );
    expect(mismatchRes.status).toBe(403);
  });
});
