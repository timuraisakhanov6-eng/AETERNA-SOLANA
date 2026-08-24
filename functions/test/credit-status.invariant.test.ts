import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface CreditStatusEnv {
  CREATOR_CREDITS: ReturnType<typeof createFakeKV>;
  CREATOR_IDENTITIES: ReturnType<typeof createFakeKV>;
}

function buildEnv(overrides?: Partial<CreditStatusEnv>): CreditStatusEnv {
  return {
    CREATOR_CREDITS: createFakeKV(),
    CREATOR_IDENTITIES: createFakeKV(),
    ...overrides,
  };
}

function buildContext(env: CreditStatusEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

const CREATOR_IDENTITY_ID = "creator-1";
const CREATOR_CREDIT_ID = "credit-1";
const LIFE_CYCLE_ID = "lifecycle-1";
const PAYMENT_INTENT_ID = "intent-1";
const ACCOUNT = "0x0000000000000000000000000000000000000000";

function seedChallenge(env: CreditStatusEnv, challenge: string, expiresAt: number, network = "eip155:8453") {
  env.CREATOR_IDENTITIES.put(
    `creator:challenge:${challenge}`,
    JSON.stringify({ challenge, network, expiresAt })
  );
}

function seedIdentity(env: CreditStatusEnv, creatorIdentityId = CREATOR_IDENTITY_ID, account = ACCOUNT) {
  env.CREATOR_IDENTITIES.put(
    `creator:identity:eip155:8453:${account.toLowerCase()}`,
    JSON.stringify({ id: creatorIdentityId, account: account.toLowerCase(), network: "eip155:8453" })
  );
}

function seedCredit(
  env: CreditStatusEnv,
  status: string,
  overrides: Record<string, unknown> = {}
) {
  const record = {
    id: CREATOR_CREDIT_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    status,
    quoteId: PAYMENT_INTENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lifecycleId: status === "CONSUMING" ? LIFE_CYCLE_ID : null,
    ...overrides,
  };

  env.CREATOR_CREDITS.put(
    `creator:credit:${CREATOR_CREDIT_ID}`,
    JSON.stringify(record)
  );

  if (record.lifecycleId) {
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${CREATOR_IDENTITY_ID}:${record.lifecycleId}`,
      CREATOR_CREDIT_ID
    );
  }
}

describe("POST /api/creator/credit-status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function postCreditStatus(env: CreditStatusEnv, input: Record<string, unknown>) {
    const creditStatusModule = await import("./../api/creator/credit-status");
    const res = await creditStatusModule.onRequestPost(buildContext(env, input));
    return { status: res.status, payload: await res.json() };
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      challengeId: "challenge-valid",
      network: "eip155:8453",
      account: ACCOUNT,
      signature: "0x" + "ab".repeat(65),
      creatorCreditId: CREATOR_CREDIT_ID,
      ...overrides,
    };
  }

  function validRealSignaturePayload(overrides: Record<string, unknown> = {}) {
    return {
      challengeId: "challenge-valid",
      network: "eip155:8453",
      account: "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f",
      signature: "0x57cf9db5baf4181da98d503ef389e277ac810d417c93ba45d2f380092b67a18a3f8c194f8ea5dd75530914a77c89d0e55afee9161805f2f7116c659750c5c75e1c",
      creatorCreditId: CREATOR_CREDIT_ID,
      ...overrides,
    };
  }

  it("valid real EIP-191 signature + AVAILABLE → available", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "AVAILABLE");

    const res = await postCreditStatus(env, validRealSignaturePayload());

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, status: "available", creatorCreditId: CREATOR_CREDIT_ID })
    );
  });

  it("valid real EIP-191 signature + CONSUMING + matching lifecycleId → consuming", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "CONSUMING");

    const res = await postCreditStatus(env, validRealSignaturePayload({ lifecycleId: LIFE_CYCLE_ID }));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, status: "consuming", lifecycleId: LIFE_CYCLE_ID })
    );
  });

  it("CONSUMING + wrong lifecycleId with valid signature → 403", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "CONSUMING");

    const res = await postCreditStatus(env, validRealSignaturePayload({ lifecycleId: "wrong-lifecycle" }));

    expect(res.status).toBe(403);
    expect(res.payload.error).toBe("LIFECYCLE_MISMATCH");
  });

  it("valid real EIP-191 signature + CONSUMED → none", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "CONSUMED");

    const res = await postCreditStatus(env, validRealSignaturePayload());

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, status: "none" })
    );
  });

  it("valid real EIP-191 signature + wrong creator identity → 403", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, "other-creator", "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "AVAILABLE");

    const res = await postCreditStatus(env, validRealSignaturePayload());

    expect(res.status).toBe(403);
    expect(res.payload.error).toBe("CREATOR_MISMATCH");
  });

  it("cross-creator access with valid signature → 403", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");

    const otherCreditId = "credit-other";
    env.CREATOR_CREDITS.put(
      `creator:credit:${otherCreditId}`,
      JSON.stringify({
        id: otherCreditId,
        creatorIdentityId: "creator-2",
        status: "AVAILABLE",
        quoteId: PAYMENT_INTENT_ID,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const res = await postCreditStatus(env, validRealSignaturePayload({ creatorCreditId: otherCreditId }));

    expect(res.status).toBe(403);
    expect(res.payload.error).toBe("CREATOR_MISMATCH");
  });

  it("forged creatorCreditId with valid signature → none", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "AVAILABLE");

    const res = await postCreditStatus(env, validRealSignaturePayload({ creatorCreditId: "forged-credit" }));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, status: "none", creatorCreditId: "forged-credit" })
    );
  });

  it("valid real signature + paymentIntentId absent → still works", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "AVAILABLE");

    const res = await postCreditStatus(env, validRealSignaturePayload());

    expect(res.status).toBe(200);
    expect(res.payload.status).toBe("available");
  });

  it("valid real signature + BusinessQuote absent → still works", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "AVAILABLE");

    const res = await postCreditStatus(env, validRealSignaturePayload());

    expect(res.status).toBe(200);
    expect(res.payload.status).toBe("available");
  });

  it("fake signature → 401", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env);
    seedCredit(env, "AVAILABLE");

    const res = await postCreditStatus(env, validPayload());

    expect(res.status).toBe(401);
    expect(res.payload.error).toBe("INVALID_SIGNATURE");
  });
});
