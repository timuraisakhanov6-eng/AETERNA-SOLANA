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
      JSON.stringify({
        id: CREATOR_CREDIT_ID,
        creatorIdentityId: CREATOR_IDENTITY_ID,
        status,
        capsuleId: "capsule-1",
        lifecycleId: record.lifecycleId,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
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

  it("CONSUMING + lifecycle index bound to foreign credit → 403", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "CONSUMING");
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${CREATOR_IDENTITY_ID}:${LIFE_CYCLE_ID}`,
      JSON.stringify({
        id: "credit-other",
        creatorIdentityId: CREATOR_IDENTITY_ID,
        status: "CONSUMING",
        capsuleId: "capsule-1",
        lifecycleId: LIFE_CYCLE_ID,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const res = await postCreditStatus(env, validRealSignaturePayload({ lifecycleId: LIFE_CYCLE_ID }));

    expect(res.status).toBe(403);
    expect(res.payload.error).toBe("LIFECYCLE_MISMATCH");
  });

  it("CONSUMING + corrupt lifecycle index payload → 403", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);
    seedIdentity(env, CREATOR_IDENTITY_ID, "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f");
    seedCredit(env, "CONSUMING");
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${CREATOR_IDENTITY_ID}:${LIFE_CYCLE_ID}`,
      "not-json"
    );

    const res = await postCreditStatus(env, validRealSignaturePayload({ lifecycleId: LIFE_CYCLE_ID }));

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

  /* ================= PATCH-2: Solana + discovery ================= */

  // Real Ed25519 keypair/signatures (Node WebCrypto) — no mocks.
  const SOLANA_WALLET = {
    publicKeyBase58: "",
    privateKey: null as CryptoKey | null,
  };

  async function solanaKeypair(): Promise<{
    publicKeyBase58: string;
    privateKey: CryptoKey;
  }> {
    const kp = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    return { publicKeyBase58: base58Encode(raw), privateKey: kp.privateKey };
  }

  function base58Encode(bytes: Uint8Array): string {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const digits: number[] = [];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) {
        carry += digits[i]! << 8;
        digits[i] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let out = "";
    for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
    for (const byte of bytes) {
      if (byte !== 0) break;
      out = "1" + out;
    }
    return out;
  }

  async function seedSolanaIdentityAndChallenge(
    env: CreditStatusEnv,
    challengeId: string,
    publicKeyBase58: string
  ) {
    const challenge = "a".repeat(64);
    const record = {
      id: challengeId,
      network: "solana",
      challenge,
      publicKey: publicKeyBase58,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
      consumed: false,
    };
    env.CREATOR_IDENTITIES.put(
      `creator:challenge:${challengeId}`,
      JSON.stringify(record)
    );
    env.CREATOR_IDENTITIES.put(
      `creator:identity:solana:${publicKeyBase58}`,
      JSON.stringify({
        id: CREATOR_IDENTITY_ID,
        network: "solana",
        account: publicKeyBase58,
      })
    );
    return record;
  }

  async function signSolanaChallenge(
    privateKey: CryptoKey,
    record: Record<string, unknown>
  ): Promise<string> {
    const { buildSolanaMessage } = await import("./../lib/solanaIdentityProof");
    // Sign EXACTLY the message the endpoint builds from the stored
    // challenge record (including its raw field set).
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      new TextEncoder().encode(
        buildSolanaMessage(record as unknown as Parameters<typeof buildSolanaMessage>[0])
      )
    );
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  function solanaPayload(
    publicKeyBase58: string,
    signature: string,
    overrides: Record<string, unknown> = {}
  ) {
    return {
      challengeId: "challenge-solana",
      network: "solana",
      account: publicKeyBase58,
      signature,
      ...overrides,
    };
  }

  async function signFor(env: CreditStatusEnv, challengeId: string) {
    const recordRaw = await env.CREATOR_IDENTITIES.get(`creator:challenge:${challengeId}`);
    const record = JSON.parse(recordRaw!) as {
      network: string;
      challenge: string;
      publicKey: string;
      createdAt: number;
      expiresAt: number;
      id: string;
    };
    return signSolanaChallenge(SOLANA_WALLET.privateKey!, {
      ...record,
      });
  }

  function seedSolanaCredit(
    env: CreditStatusEnv,
    creditId: string,
    status: string,
    overrides: Record<string, unknown> = {}
  ) {
    const record = {
      id: creditId,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      status,
      quoteId: PAYMENT_INTENT_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
    env.CREATOR_CREDITS.put(`creator:credit:${creditId}`, JSON.stringify(record));
    // grant-credit's write-once index (the discovery source)
    env.CREATOR_CREDITS.put(
      `creator:credit:index:${CREATOR_IDENTITY_ID}:${record.quoteId}`,
      creditId
    );
    return record;
  }

  it("A: Solana valid proof + supplied creatorCreditId + AVAILABLE → available", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    SOLANA_WALLET.publicKeyBase58 = publicKeyBase58;
    SOLANA_WALLET.privateKey = privateKey;
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    seedSolanaCredit(env, CREATOR_CREDIT_ID, "AVAILABLE");

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(
      env,
      solanaPayload(publicKeyBase58, signature, { creatorCreditId: CREATOR_CREDIT_ID })
    );

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({
        ok: true,
        status: "available",
        creatorCreditId: CREATOR_CREDIT_ID,
        creatorIdentityId: CREATOR_IDENTITY_ID,
      })
    );
  });

  it("B: Solana valid proof + CONSUMING + matching lifecycleId → consuming", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    const credit = seedSolanaCredit(env, CREATOR_CREDIT_ID, "CONSUMING", { lifecycleId: LIFE_CYCLE_ID });
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${CREATOR_IDENTITY_ID}:${LIFE_CYCLE_ID}`,
      JSON.stringify({ id: credit.id, creatorIdentityId: CREATOR_IDENTITY_ID })
    );

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(
      env,
      solanaPayload(publicKeyBase58, signature, {
        creatorCreditId: CREATOR_CREDIT_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, status: "consuming", lifecycleId: LIFE_CYCLE_ID })
    );
  });

  it("C: Solana valid proof + CONSUMED → none", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    seedSolanaCredit(env, CREATOR_CREDIT_ID, "CONSUMED");

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(
      env,
      solanaPayload(publicKeyBase58, signature, { creatorCreditId: CREATOR_CREDIT_ID })
    );

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({ ok: true, status: "none" }));
  });

  it("D: Solana valid proof + NO creatorCreditId → discovers the AVAILABLE Credit", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    seedSolanaCredit(env, CREATOR_CREDIT_ID, "AVAILABLE");

    const before = JSON.stringify([...env.CREATOR_CREDITS.data.entries()].sort());

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({
        ok: true,
        status: "available",
        creatorCreditId: CREATOR_CREDIT_ID,
        creatorIdentityId: CREATOR_IDENTITY_ID,
      })
    );

    // M: discovery performs NO KV writes
    const after = JSON.stringify([...env.CREATOR_CREDITS.data.entries()].sort());
    expect(after).toBe(before);
  });

  it("D2 (production regression): canonical identity discovers credit 74a61dd1473459166d2f72c0d0bc6a9e", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);

    // Production-shaped fixture (mocked; no production access).
    const PRODUCTION_IDENTITY = "a17b729fcc842fbccdc2286806f0de37";
    const PRODUCTION_CREDIT = "74a61dd1473459166d2f72c0d0bc6a9e";
    const PRODUCTION_QUOTE = "b2c15007-071b-4712-85be-a2f35b3313e0";
    const PRODUCTION_WALLET = "V37Sg8C8M585WLZG1CCgc22PxRRdvy3vEbAKWKEu3KN";

    env.CREATOR_IDENTITIES.put(
      `creator:identity:solana:${PRODUCTION_WALLET}`,
      JSON.stringify({
        id: PRODUCTION_IDENTITY,
        network: "solana",
        account: PRODUCTION_WALLET,
        firstVerifiedAt: 1788427861020,
        lastVerifiedAt: 1788980629424,
      })
    );
    env.CREATOR_CREDITS.put(
      `creator:credit:${PRODUCTION_CREDIT}`,
      JSON.stringify({
        id: PRODUCTION_CREDIT,
        creatorIdentityId: PRODUCTION_IDENTITY,
        status: "AVAILABLE",
        quoteId: PRODUCTION_QUOTE,
        createdAt: 1788980504893,
        updatedAt: 1788980504893,
      })
    );
    env.CREATOR_CREDITS.put(
      `creator:credit:index:${PRODUCTION_IDENTITY}:${PRODUCTION_QUOTE}`,
      PRODUCTION_CREDIT
    );

    // Sign as the canonical wallet identity (fixture keypair bound to
    // the seeded identity record for that wallet).
    env.CREATOR_IDENTITIES.put(
      `creator:identity:solana:${publicKeyBase58}`,
      JSON.stringify({
        id: PRODUCTION_IDENTITY,
        network: "solana",
        account: publicKeyBase58,
      })
    );

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({
        ok: true,
        status: "available",
        creatorCreditId: PRODUCTION_CREDIT,
        creatorIdentityId: PRODUCTION_IDENTITY,
      })
    );
  });

  it("D3: multiple AVAILABLE credits → deterministic earliest-granted rule", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);

    const newer = seedSolanaCredit(env, "credit-newer", "AVAILABLE", { createdAt: Date.now() + 5000 });
    const older = seedSolanaCredit(env, "credit-older", "AVAILABLE", { createdAt: Date.now() - 5000 });
    expect(newer).toBeDefined();
    expect(older).toBeDefined();

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, status: "available", creatorCreditId: "credit-older" })
    );
  });

  it("E: Solana valid proof + no credits → none with null credit id", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({
        ok: true,
        status: "none",
        creatorCreditId: null,
        creatorIdentityId: CREATOR_IDENTITY_ID,
      })
    );
  });

  it("F: Solana valid proof + only CONSUMED credits → none", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    seedSolanaCredit(env, CREATOR_CREDIT_ID, "CONSUMED");

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({ ok: true, status: "none" }));
  });

  it("G: Solana proof from a DIFFERENT wallet account → 401 (account binding)", async () => {
    const env = buildEnv();
    const { publicKeyBase58 } = await solanaKeypair();
    await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    seedSolanaCredit(env, CREATOR_CREDIT_ID, "AVAILABLE");

    // Different keypair signs, but claims the first wallet's account.
    const impostor = await solanaKeypair();
    const recordRaw = await env.CREATOR_IDENTITIES.get("creator:challenge:challenge-solana");
    const record = JSON.parse(recordRaw!) as {
      network: string;
      challenge: string;
      publicKey: string;
      createdAt: number;
      expiresAt: number;
      id: string;
    };
    const signature = await signSolanaChallenge(impostor.privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(401);
    expect(res.payload.error).toBe("INVALID_SIGNATURE");
  });

  it("H: Solana proof against wrong-network challenge → 401", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    // Challenge issued for a different network.
    env.CREATOR_IDENTITIES.put(
      "creator:challenge:challenge-solana",
      JSON.stringify({ ...record, network: "eip155:8453" })
    );

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(401);
    expect(res.payload.error).toBe("NETWORK_MISMATCH");
  });

  it("I: Solana invalid signature (wrong bytes) → 401", async () => {
    const env = buildEnv();
    const { publicKeyBase58 } = await solanaKeypair();
    await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);

    const badSignature = btoa(String.fromCharCode(...new Uint8Array(64).fill(7)));
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, badSignature));

    expect(res.status).toBe(401);
    expect(res.payload.error).toBe("INVALID_SIGNATURE");
  });

  it("J: Solana expired challenge → 401", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    env.CREATOR_IDENTITIES.put(
      "creator:challenge:challenge-solana",
      JSON.stringify({ ...record, expiresAt: Date.now() - 1000 })
    );

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(env, solanaPayload(publicKeyBase58, signature));

    expect(res.status).toBe(401);
    expect(res.payload.error).toBe("CHALLENGE_EXPIRED");
  });

  it("J2: Solana unknown challenge → 401", async () => {
    const env = buildEnv();
    const { publicKeyBase58 } = await solanaKeypair();

    const res = await postCreditStatus(
      env,
      solanaPayload(publicKeyBase58, btoa(String.fromCharCode(...new Uint8Array(64))))
    );

    expect(res.status).toBe(401);
    expect(res.payload.error).toBe("CHALLENGE_NOT_FOUND");
  });

  it("K: Solana supplied FOREIGN creatorCreditId → 403", async () => {
    const env = buildEnv();
    const { publicKeyBase58, privateKey } = await solanaKeypair();
    const record = await seedSolanaIdentityAndChallenge(env, "challenge-solana", publicKeyBase58);
    seedSolanaCredit(env, CREATOR_CREDIT_ID, "AVAILABLE");
    env.CREATOR_CREDITS.put(
      `creator:credit:credit-foreign`,
      JSON.stringify({
        id: "credit-foreign",
        creatorIdentityId: "creator-2",
        status: "AVAILABLE",
        quoteId: PAYMENT_INTENT_ID,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const signature = await signSolanaChallenge(privateKey, {
      ...record,
      });
    const res = await postCreditStatus(
      env,
      solanaPayload(publicKeyBase58, signature, { creatorCreditId: "credit-foreign" })
    );

    expect(res.status).toBe(403);
    expect(res.payload.error).toBe("CREATOR_MISMATCH");
  });

  it("K2: Solana malformed account (not base58 / wrong length) → 400", async () => {
    const env = buildEnv();

    const res1 = await postCreditStatus(
      env,
      solanaPayload("not-base58!!", btoa(String.fromCharCode(...new Uint8Array(64))))
    );
    expect(res1.status).toBe(400);
    expect(res1.payload.error).toBe("INVALID_ACCOUNT");

    const shortKey = base58Encode(new Uint8Array(16).fill(1));
    const res2 = await postCreditStatus(
      env,
      solanaPayload(shortKey, btoa(String.fromCharCode(...new Uint8Array(64))))
    );
    expect(res2.status).toBe(400);
    expect(res2.payload.error).toBe("INVALID_ACCOUNT");
  });
});
