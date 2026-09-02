import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface VerifyProofEnv {
  CREATOR_IDENTITIES: ReturnType<typeof createFakeKV>;
}

function buildEnv(overrides?: Partial<VerifyProofEnv>): VerifyProofEnv {
  return {
    CREATOR_IDENTITIES: createFakeKV(),
    ...overrides,
  };
}

function buildContext(env: VerifyProofEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

const ACCOUNT = "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
const SIGNATURE =
  "0x57cf9db5baf4181da98d503ef389e277ac810d417c93ba45d2f380092b67a18a3f8c194f8ea5dd75530914a77c89d0e55afee9161805f2f7116c659750c5c75e1c";

function seedChallenge(env: VerifyProofEnv, id: string, expiresAt: number, network = "eip155:8453") {
  env.CREATOR_IDENTITIES.put(
    `creator:challenge:${id}`,
    JSON.stringify({ id, network, challenge: id, expiresAt })
  );
}

describe("POST /api/creator/verify-proof", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function postVerifyProof(env: VerifyProofEnv, input: Record<string, unknown>) {
    const module = await import("./../api/creator/verify-proof");
    const res = await module.onRequestPost(buildContext(env, input));
    return { status: res.status, payload: await res.json() };
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      challengeId: "challenge-valid",
      network: "eip155:8453",
      account: ACCOUNT,
      signature: SIGNATURE,
      ...overrides,
    };
  }

  it("valid real EIP-191 signature → creates identity", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);

    const res = await postVerifyProof(env, validPayload());

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, creatorIdentityId: expect.any(String), account: ACCOUNT.toLowerCase() })
    );
  });

  it("missing challenge → 401", async () => {
    const env = buildEnv();

    const res = await postVerifyProof(env, validPayload({ challengeId: "missing" }));

    expect(res.status).toBe(401);
    expect(res.payload.error).toBe("CHALLENGE_NOT_FOUND");
  });

  it("expired challenge → 400", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() - 1000);

    const res = await postVerifyProof(env, validPayload());

    expect(res.status).toBe(400);
    expect(res.payload.error).toBe("CHALLENGE_EXPIRED");
  });

  it("network mismatch → 400", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000, "eip155:1");

    const res = await postVerifyProof(env, validPayload());

    expect(res.status).toBe(400);
    expect(res.payload.error).toBe("NETWORK_MISMATCH");
  });

  it("invalid signature → 400", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);

    const res = await postVerifyProof(env, validPayload({ signature: "0x" + "ab".repeat(65) }));

    expect(res.status).toBe(400);
    expect(res.payload.error).toBe("INVALID_SIGNATURE");
  });

  it("account mismatch → 400", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);

    const res = await postVerifyProof(env, validPayload({ account: "0x" + "cd".repeat(20) }));

    expect(res.status).toBe(400);
    expect(res.payload.error).toBe("ACCOUNT_MISMATCH");
  });

  it("replayed challenge after successful verification → 400", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);

    const first = await postVerifyProof(env, validPayload());
    expect(first.status).toBe(200);

    const second = await postVerifyProof(env, validPayload());
    expect(second.status).toBe(401);
    expect(second.payload.error).toBe("CHALLENGE_NOT_FOUND");
  });

  it("valid EVM account persists lowercase normalization", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);

    const mixedCaseAccount = "0xD5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
    const res = await postVerifyProof(env, validPayload({ account: mixedCaseAccount }));

    expect(res.status).toBe(200);
    expect(res.payload).toEqual(
      expect.objectContaining({ ok: true, account: mixedCaseAccount.toLowerCase() })
    );

    const stored = env.CREATOR_IDENTITIES.data.get(
      `creator:identity:eip155:8453:${mixedCaseAccount.toLowerCase()}`
    );
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored as string) as Record<string, unknown>;
    expect(parsed.account).toBe(mixedCaseAccount.toLowerCase());
  });

  it("invalid EVM account is rejected", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid", Date.now() + 60_000);

    const res = await postVerifyProof(env, validPayload({ account: "0x" + "ab".repeat(19) + "zz" }));

    expect(res.status).toBe(400);
    expect(res.payload.error).toBe("INVALID_ACCOUNT");
  });

  it("invalid Solana account is rejected before persistence", async () => {
    const env = buildEnv();
    seedChallenge(env, "challenge-valid-solana", Date.now() + 60_000, "solana");

    const res = await postVerifyProof(env, {
      challengeId: "challenge-valid-solana",
      network: "solana",
      account: "not-valid-base58",
      signature: "0x" + "ab".repeat(32),
    });

    expect(res.status).toBe(400);
    expect(res.payload.error).toBe("INVALID_ACCOUNT");
  });
});
