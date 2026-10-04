/**
 * Upload token — AUTHORITATIVE Creator Credit read (Durable Object).
 *
 * Regression guard for the production 403 LIFECYCLE_CREDIT_NOT_FOUND.
 *
 * Mechanism it pins:
 *   reserve-lifecycle -> the Durable Object writes the lifecycle credit
 *   upload-token      -> the SAME key was read from Cloudflare KV moments
 *                        later, and KV returned a stale NEGATIVE result
 *                        (KV reads are eventually consistent, default read
 *                        cacheTtl 60s, and negative lookups are cached),
 *                        so the gate failed closed with
 *                        LIFECYCLE_CREDIT_NOT_FOUND even though the
 *                        record existed.
 *
 * The authoritative path reads the credit from the Durable Object — the
 * strongly consistent store that AUTHORED the reserve — and does NOT read
 * the lifecycle key from KV at all. The KV path is retained unchanged as a
 * backward-compatible fallback when the client sends no creatorCreditId.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  createFakeCreditCoordinatorBinding,
  makeEventContext,
  type FakeKV,
} from "./harness";
import { onRequestPost as uploadTokenPost } from "./../api/upload-token";

const ORIGIN = "https://aeternacapsule.com";
const NOW = 1_800_000_000_000;

const IDENTITY_ID = "creator-1";
const LIFECYCLE_ID = "lifecycle-1";
const CAPSULE_ID = "a".repeat(64);
const CREDIT_ID = "credit-1";
const WALLET_ACCOUNT = "B".repeat(44);
const IRYS_DESTINATION = "C".repeat(44);
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STORAGE_PAYMENT_ID = "storage-pay-1";

const LIFECYCLE_KEY = `creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`;

type Coordinator = ReturnType<typeof createFakeCreditCoordinatorBinding>;

interface TestEnv {
  CREATOR_CREDITS: FakeKV;
  UPLOAD_TOKENS: FakeKV;
  STORAGE_PAYMENTS: FakeKV;
  STORAGE_QUOTES: FakeKV;
  CREDIT_OP_COORDINATOR?: unknown;
}

function buildEnv(coordinator?: unknown): TestEnv {
  const env: TestEnv = {
    CREATOR_CREDITS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    STORAGE_QUOTES: createFakeKV(),
  };
  if (coordinator !== undefined) env.CREDIT_OP_COORDINATOR = coordinator;
  return env;
}

/* ── KV lifecycle projection (legacy fallback only) ── */

function seedLegacyCredit(env: TestEnv, overrides: Record<string, unknown> = {}) {
  void env.CREATOR_CREDITS.put(
    LIFECYCLE_KEY,
    JSON.stringify({
      id: CREDIT_ID,
      status: "CONSUMING",
      creatorIdentityId: IDENTITY_ID,
      capsuleId: CAPSULE_ID,
      paymentIntentId: "intent-1",
      lifecycleId: LIFECYCLE_ID,
      revision: 2,
      updatedAt: NOW,
      ...overrides,
    })
  );
}

/* ── Durable Object storage: the authoritative record ── */

/** Directly seed the DO's own storage (bypasses reserve for negative cases). */
async function seedDoCredit(coordinator: Coordinator, overrides: Record<string, unknown> = {}) {
  coordinator.get(coordinator.idFromName(CREDIT_ID));
  const storage = coordinator.storages.get(CREDIT_ID)!;
  await storage.put(`credit:${CREDIT_ID}`, {
    id: CREDIT_ID,
    creatorIdentityId: IDENTITY_ID,
    status: "CONSUMING",
    capsuleId: CAPSULE_ID,
    lifecycleId: LIFECYCLE_ID,
    paymentIntentId: "intent-1",
    revision: 2,
    updatedAt: NOW,
    ...overrides,
  });
}

/** Drive the REAL reserve op so the DO storage holds the exact post-reserve state. */
async function reserveThroughDo(coordinator: Coordinator) {
  const stub = coordinator.get(coordinator.idFromName(CREDIT_ID));
  return stub.fetch(
    new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "reserve",
        creatorCreditId: CREDIT_ID,
        creatorIdentityId: IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
        paymentIntentId: "intent-1",
      }),
    })
  );
}

/* ── Storage gate fixtures (unchanged contract) ── */

function seedStoragePayment(env: TestEnv, opts: { state?: string } = {}) {
  env.STORAGE_QUOTES.put(
    `storage-quote:${IDENTITY_ID}:${LIFECYCLE_ID}:${CAPSULE_ID}`,
    JSON.stringify({
      storagePaymentId: STORAGE_PAYMENT_ID,
      creatorIdentityId: IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      expectedAmountAtomic: "1000000",
      irysDestination: IRYS_DESTINATION,
      tokenMint: TOKEN_MINT,
      state: "CREATED",
      createdAt: NOW,
      expiresAt: NOW + 300_000,
    })
  );
  env.STORAGE_PAYMENTS.put(
    `storage-payment:${STORAGE_PAYMENT_ID}`,
    JSON.stringify({
      storagePaymentId: STORAGE_PAYMENT_ID,
      state: opts.state ?? "PAYMENT_VERIFIED",
      transactionSignature: "S".repeat(88),
      payer: WALLET_ACCOUNT,
      quote: {
        storagePaymentId: STORAGE_PAYMENT_ID,
        creatorIdentityId: IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
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

async function post(env: TestEnv, payload: Record<string, unknown>) {
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: payload,
  });
  const ctx = makeEventContext({ request, env: env as never });
  const res = await uploadTokenPost(ctx);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function lifecycleReads(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c) => String((c as unknown[])[0]))
    .filter((k) => k.startsWith("creator:credit:lifecycle:"));
}

describe("Upload token — authoritative Creator Credit read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("1. DO FOUND + valid CONSUMING credit -> 200", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.uploadToken).toBe("string");
  });

  it("2. REGRESSION: KV lifecycle key MISSING + DO valid -> still 200", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);
    seedStoragePayment(env);

    // The exact production condition: the KV lifecycle projection is not
    // observable (stale negative), while the authoritative record exists.
    expect(await env.CREATOR_CREDITS.get(LIFECYCLE_KEY)).toBeNull();

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  it("3. authoritative path performs NO KV lifecycle read", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);
    seedStoragePayment(env);

    const getSpy = vi.spyOn(env.CREATOR_CREDITS, "get");

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(200);
    expect(lifecycleReads(getSpy)).toHaveLength(0);
  });

  it("4. real reserve op -> read path issues a token without any KV credit read", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    seedStoragePayment(env);

    const reserveRes = await reserveThroughDo(coordinator);
    expect(reserveRes.status).toBe(200);

    const getSpy = vi.spyOn(env.CREATOR_CREDITS, "get");

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(lifecycleReads(getSpy)).toHaveLength(0);
  });

  it("5. DO NOT_FOUND -> 403 LIFECYCLE_CREDIT_NOT_FOUND", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("LIFECYCLE_CREDIT_NOT_FOUND");
    expect(res.json.uploadToken).toBeUndefined();
  });

  it("6. status AVAILABLE -> 403 CREDIT_NOT_CONSUMING", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator, { status: "AVAILABLE", lifecycleId: null });
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("CREDIT_NOT_CONSUMING");
  });

  it("7. status CONSUMED -> 403 CREDIT_NOT_CONSUMING", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator, { status: "CONSUMED" });
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("CREDIT_NOT_CONSUMING");
  });

  it("8. identity mismatch -> 403 CREDIT_IDENTITY_MISMATCH", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator, { creatorIdentityId: "creator-other" });
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("CREDIT_IDENTITY_MISMATCH");
  });

  it("9. lifecycle mismatch -> 403 LIFECYCLE_CREDIT_NOT_FOUND", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator, { lifecycleId: "lifecycle-other" });
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("LIFECYCLE_CREDIT_NOT_FOUND");
  });

  it("10. DO fetch failure -> 503, no token", async () => {
    const env = buildEnv({
      idFromName: (name: string) => ({ id: name }),
      get: () => ({
        fetch: async () => {
          throw new Error("DO unavailable");
        },
      }),
    });
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(503);
    expect(res.json.uploadToken).toBeUndefined();
  });

  it("11. DO non-OK response -> 503, no token", async () => {
    const env = buildEnv({
      idFromName: (name: string) => ({ id: name }),
      get: () => ({
        fetch: async () => new Response("boom", { status: 500 }),
      }),
    });
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(503);
    expect(res.json.uploadToken).toBeUndefined();
  });

  it("12. missing coordinator binding on the authoritative path -> 503", async () => {
    const env = buildEnv();
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(503);
    expect(res.json.uploadToken).toBeUndefined();
  });

  it("13. empty/non-string creatorCreditId -> 400", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);
    seedStoragePayment(env);

    const empty = await post(env, body({ creatorCreditId: "   " }));
    expect(empty.status).toBe(400);

    const wrongType = await post(env, body({ creatorCreditId: 42 }));
    expect(wrongType.status).toBe(400);
  });

  /* ── legacy KV fallback (creatorCreditId absent) ── */

  it("14. no creatorCreditId -> unchanged KV path issues the token", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    seedLegacyCredit(env);
    seedStoragePayment(env);

    const res = await post(env, body());
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  it("15. no creatorCreditId + KV miss -> 403 (legacy behaviour preserved)", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    seedStoragePayment(env);

    const res = await post(env, body());
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("LIFECYCLE_CREDIT_NOT_FOUND");
  });

  it("16. no creatorCreditId -> the Durable Object is never contacted", async () => {
    const getStub = vi.fn(() => ({
      fetch: async () => {
        throw new Error("must not be called");
      },
    }));
    const coordinator = { idFromName: (name: string) => ({ id: name }), get: getStub };
    const env = buildEnv(coordinator);
    seedLegacyCredit(env);
    seedStoragePayment(env);

    const res = await post(env, body());
    expect(res.status).toBe(200);
    expect(getStub).not.toHaveBeenCalled();
  });

  /* ── preserved contracts ── */

  it("17. paymentIntent validation is preserved on the authoritative path", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);
    seedStoragePayment(env);

    const ok = await post(env, body({ creatorCreditId: CREDIT_ID, paymentIntentId: "intent-1" }));
    expect(ok.status).toBe(200);

    const bad = await post(env, body({ creatorCreditId: CREDIT_ID, paymentIntentId: "intent-other" }));
    expect(bad.status).toBe(403);
    expect(bad.json.error).toBe("PAYMENT_INTENT_MISMATCH");
  });

  it("18. server-derived paymentIntentId is what is persisted on the token", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.UPLOAD_TOKENS.get(res.json.uploadToken as string))!
    );
    expect(stored.paymentIntentId).toBe("intent-1");
    expect(stored.canonicalLifecycleId).toBe(LIFECYCLE_ID);
    expect(stored.creatorIdentityId).toBe(IDENTITY_ID);
  });

  it("19. storage gate is unchanged on the authoritative path", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);

    // no storage payment at all
    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
  });

  it("20. capsuleId for the storage gate comes from the authoritative record", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator, { capsuleId: "b".repeat(64) });
    // quote is seeded for CAPSULE_ID, the DO record says otherwise
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
  });

  it("21. a forged creatorCreditId cannot authorize another creator's credit", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator, { creatorIdentityId: "victim" });
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).toBe(403);
    expect(res.json.uploadToken).toBeUndefined();
  });

  it("22. creatorCreditId is an accepted body field (no 400 from the whitelist)", async () => {
    const coordinator = createFakeCreditCoordinatorBinding();
    const env = buildEnv(coordinator);
    await seedDoCredit(coordinator);
    seedStoragePayment(env);

    const res = await post(env, body({ creatorCreditId: CREDIT_ID }));
    expect(res.status).not.toBe(400);
  });
});
