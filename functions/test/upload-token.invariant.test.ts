/**
 * Upload token boundary — Phase D1 storage payment gate.
 *
 * Canonical authorization chain:
 *   $1 service payment → Creator Credit CONSUMING
 *   + creator storage payment PAYMENT_VERIFIED
 *     (bound to the same identity/lifecycle/capsule, wallet
 *      server-derived per ed76080)
 *   + upload permissions
 *   → upload token issued.
 *
 * Executor balance is NO LONGER part of the authorization contract.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";
import { onRequestPost as uploadTokenPost } from "./../api/upload-token";

const ORIGIN = "https://aeternacapsule.com";
const NOW = 1_800_000_000_000;

const IDENTITY_ID = "creator-1";
const LIFECYCLE_ID = "lifecycle-1";
const CAPSULE_ID = "a".repeat(64);
const WALLET_ACCOUNT = "B".repeat(44);
const IRYS_DESTINATION = "C".repeat(44);
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STORAGE_PAYMENT_ID = "storage-pay-1";

function buildEnv() {
  return {
    CREATOR_CREDITS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    STORAGE_QUOTES: createFakeKV(),
  };
}

function seedCredit(
  env: ReturnType<typeof buildEnv>,
  overrides: Record<string, unknown> = {}
) {
  env.CREATOR_CREDITS.put(
    `creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`,
    JSON.stringify({
      id: "credit-1",
      status: "CONSUMING",
      creatorIdentityId: IDENTITY_ID,
      capsuleId: CAPSULE_ID,
      paymentIntentId: "intent-1",
      lifecycleId: LIFECYCLE_ID,
      ...overrides,
    })
  );
}

function seedStoragePayment(
  env: ReturnType<typeof buildEnv>,
  opts: {
    state?: string;
    identity?: string;
    lifecycle?: string;
    capsule?: string;
    id?: string;
  } = {}
) {
  const id = opts.id ?? STORAGE_PAYMENT_ID;
  const identity = opts.identity ?? IDENTITY_ID;
  const lifecycle = opts.lifecycle ?? LIFECYCLE_ID;
  const capsule = opts.capsule ?? CAPSULE_ID;
  env.STORAGE_QUOTES.put(
    `storage-quote:${identity}:${lifecycle}:${capsule}`,
    JSON.stringify({
      storagePaymentId: id,
      creatorIdentityId: identity,
      lifecycleId: lifecycle,
      capsuleId: capsule,
      expectedAmountAtomic: "1000000",
      irysDestination: IRYS_DESTINATION,
      tokenMint: TOKEN_MINT,
      state: "CREATED",
      createdAt: NOW,
      expiresAt: NOW + 300_000,
    })
  );
  env.STORAGE_PAYMENTS.put(
    `storage-payment:${id}`,
    JSON.stringify({
      storagePaymentId: id,
      state: opts.state ?? "PAYMENT_VERIFIED",
      transactionSignature: "S".repeat(88),
      payer: WALLET_ACCOUNT,
      quote: {
        storagePaymentId: id,
        creatorIdentityId: identity,
        lifecycleId: lifecycle,
        capsuleId: capsule,
        expectedAmountAtomic: "1000000",
        irysDestination: IRYS_DESTINATION,
        tokenMint: TOKEN_MINT,
      },
    })
  );
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: IDENTITY_ID,
    ...overrides,
  };
}

async function post(env: ReturnType<typeof buildEnv>, payload: Record<string, unknown>) {
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: payload,
  });
  const ctx = makeEventContext({ request, env: env as never });
  const res = await uploadTokenPost(ctx);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("Upload token boundary (Phase D1 storage gate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A. issues token with verified service credit + PAYMENT_VERIFIED storage payment", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env);

    const res = await post(env, body());
    process.stdout.write(`DBG_A ${res.status} ${JSON.stringify(res.json)}\n`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.uploadToken).toBe("string");
  });

  it("B. fails closed without any storage payment", async () => {
    const env = buildEnv();
    seedCredit(env);

    const res = await post(env, body());
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
    expect(res.json.uploadToken).toBeUndefined();
  });

  it("C. fails closed when storage payment state is not PAYMENT_VERIFIED", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env, { state: "FAILED" });

    const res = await post(env, body());
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
  });

  it("D. fails closed when storage payment belongs to another lifecycle", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env, { lifecycle: "lifecycle-other" });

    const res = await post(env, body());
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
  });

  it("E. fails closed when storage payment belongs to another capsule", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env, { capsule: "b".repeat(64) });

    const res = await post(env, body());
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
  });

  it("F. fails closed when storage payment belongs to another creator identity", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env, { identity: "creator-other" });

    const res = await post(env, body());
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
  });

  it("G. issues token with NO executor bindings present (executor gate removed)", async () => {
    const env = buildEnv(); // no EXECUTOR_* bindings/mocks at all
    seedCredit(env);
    seedStoragePayment(env);

    const res = await post(env, body());
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  it("H. client-forged storage payment state cannot authorize", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env);

    // Client sends body fields pretending verification/state — the
    // endpoint only reads server-persisted STORAGE_PAYMENTS; unknown
    // body fields are rejected by the ALLOWED_BODY_FIELDS guard.
    const res = await post(env, {
      ...body(),
      storagePaymentState: "PAYMENT_VERIFIED",
      walletAccount: WALLET_ACCOUNT,
      expectedAmountAtomic: "1",
      irysDestination: IRYS_DESTINATION,
    });
    expect(res.status).toBe(400);
    expect(res.json.uploadToken).toBeUndefined();
  });

  it("I. upload permissions still enforced (existing contract)", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env);

    const res = await post(env, body());
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      (await env.UPLOAD_TOKENS.get(res.json.uploadToken as string))!
    );
    expect(stored.permissions).toEqual({ uploadChunks: true, uploadVault: true });
    expect(stored.canonicalLifecycleId).toBe(LIFECYCLE_ID);
    expect(stored.creatorIdentityId).toBe(IDENTITY_ID);
  });

  it("J. replay: repeated token requests are independently authorized (no consumption)", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedStoragePayment(env);

    const first = await post(env, body());
    const second = await post(env, body());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("REJECTS when lifecycle credit is missing", async () => {
    const env = buildEnv();
    const res = await post(env, body());
    expect(res.status).toBe(403);
  });

  it("REJECTS when credit is not CONSUMING", async () => {
    const env = buildEnv();
    seedCredit(env, { status: "AVAILABLE" });
    const res = await post(env, body());
    expect(res.status).toBe(403);
  });

  it("REJECTS wrong creator identity", async () => {
    const env = buildEnv();
    seedCredit(env, { creatorIdentityId: "creator-other" });
    const res = await post(env, body());
    expect(res.status).toBe(403);
  });

  it("REJECTS mismatched paymentIntentId when supplied", async () => {
    const env = buildEnv();
    seedCredit(env);
    const res = await post(env, { ...body(), paymentIntentId: "intent-other" });
    expect(res.status).toBe(403);
  });

  it("REJECTS unknown origin", async () => {
    const env = buildEnv();
    const request = createFakeRequest({
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: body(),
    });
    const ctx = makeEventContext({ request, env: env as never });
    const res = await uploadTokenPost(ctx);
    expect(res.status).toBe(403);
  });
});
