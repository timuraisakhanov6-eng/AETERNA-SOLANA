/**
 * AETERNA — creator authorization session invariants
 *
 * A session is a short-lived bearer capability minted by a successful
 * identity verification (verify-proof) so the two AUTHORIZATION-ONLY
 * endpoints — `POST /api/creator/credit-status` and
 * `POST /api/service-payment/create-quote` — need no fresh challenge +
 * wallet signature.
 *
 * These invariants pin the security properties that make that substitution
 * safe:
 *
 *   1. the server stores only the SHA-256 digest of the token, never the
 *      bearer token;
 *   2. the token is bound to identity + network + account and every use
 *      re-checks all three (a token for another wallet/identity authorizes
 *      nothing);
 *   3. the TTL is enforced;
 *   4. sessions are bounded per identity, expired ones are pruned, and the
 *      oldest are evicted first;
 *   5. several sessions of one identity coexist — one tab/device can not
 *      invalidate another, and revoking one leaves the others valid;
 *   6. issuance is BEST-EFFORT: an unavailable Durable Object yields no
 *      token (never an invalid one) and never fails a completed identity
 *      verification;
 *   7. a session authorizes ONLY the two endpoints and does NOT weaken the
 *      purchase guard — a second independent $1 is still refused;
 *   8. a client-supplied identity is never trusted: the identity is
 *      resolved server-side from the session record.
 */

import { describe, expect, it } from "vitest";
import {
  createFakeCreditCoordinatorBinding,
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import {
  CREATOR_SESSION_MAX_PER_IDENTITY,
  CREATOR_SESSION_TTL_MS,
  digestCreatorSessionToken,
  generateCreatorSessionToken,
  issueCreatorSession,
  parseCreatorSessionToken,
  revokeCreatorSession,
  validateCreatorSession,
} from "../lib/creatorSession";
import { onRequestPost as creditStatusPost } from "../api/creator/credit-status";
import { onRequestPost as createQuotePost } from "../api/service-payment/create-quote";
import { onRequestPost as verifyProofPost } from "../api/creator/verify-proof";

const ORIGIN = "https://aeternacapsule.com";
const IDENTITY = "creator-session-identity";
const OTHER_IDENTITY = "creator-session-other";
const NETWORK = "solana";
const ACCOUNT = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const OTHER_ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

type FakeBinding = ReturnType<typeof createFakeCreditCoordinatorBinding>;

function sessionEnv(binding: FakeBinding) {
  return { CREDIT_OP_COORDINATOR: binding };
}

/**
 * A binding whose Durable Object transport always throws — models the DO
 * being temporarily unavailable during session issuance/validation.
 */
function failingBinding(): FakeBinding {
  return {
    idFromName: (name: string) => ({ id: name }),
    get: () => ({
      async fetch(): Promise<Response> {
        throw new Error("DO_UNAVAILABLE");
      },
    }),
    storages: new Map(),
  } as unknown as FakeBinding;
}

function storedSessions(binding: FakeBinding, identity: string): unknown {
  return binding.storages.get(`identity:${identity}`)?.data.get(`sessions:${identity}`);
}

async function post(
  handler: (context: never) => Promise<Response>,
  env: unknown,
  body: unknown,
  origin = ORIGIN
) {
  return handler(
    makeEventContext({
      request: createFakeRequest({
        headers: { origin, "content-type": "application/json" },
        body,
      }),
      env,
    }) as never
  );
}

const creditStatus = (env: unknown, body: Record<string, unknown>) =>
  post(creditStatusPost as never, env, body);

const createQuote = (env: unknown, body: Record<string, unknown>) =>
  post(createQuotePost as never, env, body);

/* ═══════════════ 1. ISSUANCE + USAGE ═══════════════ */

describe("creator session — issuance and usage", () => {
  it("issues a token that validates for its identity, network and account", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = 1_000_000;

    const issued = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.expiresAt).toBe(now + CREATOR_SESSION_TTL_MS);

    const validated = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: issued.token, network: NETWORK, account: ACCOUNT },
      now + 1
    );
    expect(validated).toEqual({
      ok: true,
      creatorIdentityId: IDENTITY,
      network: NETWORK,
      account: ACCOUNT,
    });
  });

  it("token carries a well-formed identity prefix and 32 random bytes", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const issued = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      1_000
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    expect(parseCreatorSessionToken(issued.token)).toEqual({
      creatorIdentityId: IDENTITY,
    });

    const secret = issued.token.slice(issued.token.lastIndexOf(".") + 1);
    // base64url of 32 bytes === 43 characters, unguessable.
    expect(secret.length).toBeGreaterThanOrEqual(43);

    const second = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      1_000
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Two issuances never collide.
    expect(second.token).not.toBe(issued.token);
  });
});

/* ═══════════════ 2. SERVER STORES ONLY THE DIGEST ═══════════════ */

describe("creator session — server stores only the digest", () => {
  it("persists the SHA-256 digest and never the bearer token", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const issued = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      2_000
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const raw = JSON.stringify(storedSessions(binding, IDENTITY));
    expect(raw).not.toContain(issued.token);

    const records = storedSessions(binding, IDENTITY) as Array<{
      digest: string;
      creatorIdentityId: string;
      network: string;
      account: string;
      issuedAt: number;
      expiresAt: number;
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.digest).toBe(await digestCreatorSessionToken(issued.token));
    expect(records[0]!.creatorIdentityId).toBe(IDENTITY);
    expect(records[0]!.network).toBe(NETWORK);
    expect(records[0]!.account).toBe(ACCOUNT);
  });
});

/* ═══════════════ 3. TTL ═══════════════ */

describe("creator session — TTL", () => {
  it("accepts within TTL and refuses after expiry with SESSION_EXPIRED", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = 10_000;
    const issued = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const before = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: issued.token, network: NETWORK, account: ACCOUNT },
      now + CREATOR_SESSION_TTL_MS - 1
    );
    expect(before.ok).toBe(true);

    const after = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: issued.token, network: NETWORK, account: ACCOUNT },
      now + CREATOR_SESSION_TTL_MS + 1
    );
    expect(after).toEqual({ ok: false, status: 401, error: "SESSION_EXPIRED" });
  });
});

/* ═══════════════ 4. BINDING MISMATCHES ═══════════════ */

describe("creator session — identity/network/account binding", () => {
  async function issuedFor(binding: FakeBinding, now = 5_000) {
    const issued = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now
    );
    if (!issued.ok) throw new Error("issue failed");
    return issued.token;
  }

  it("refuses a wrong account", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const token = await issuedFor(binding);
    const result = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: token, network: NETWORK, account: OTHER_ACCOUNT },
      5_001
    );
    expect(result).toEqual({ ok: false, status: 401, error: "SESSION_INVALID" });
  });

  it("refuses a wrong network", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const token = await issuedFor(binding);
    const result = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: token, network: "eip155:8453", account: ACCOUNT },
      5_001
    );
    expect(result).toEqual({ ok: false, status: 401, error: "SESSION_INVALID" });
  });

  it("refuses a token whose identity prefix does not own it", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    await issuedFor(binding);
    const foreign = generateCreatorSessionToken(OTHER_IDENTITY);
    const result = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: foreign, network: NETWORK, account: ACCOUNT },
      5_001
    );
    expect(result).toEqual({ ok: false, status: 401, error: "SESSION_INVALID" });
  });
});

/* ═══════════════ 5. MALFORMED / RANDOM / TAMPERED TOKENS ═══════════════ */

describe("creator session — invalid token shapes", () => {
  it.each([
    ["empty", ""],
    ["garbage", "not-a-token"],
    ["missing secret", "aets.creator-session-identity."],
    ["missing identity", "aets..abcdef"],
    ["wrong prefix", "xxxx.creator-session-identity.abcdef"],
  ])("refuses a %s token", async (_label, token) => {
    const binding = createFakeCreditCoordinatorBinding();
    const result = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: token, network: NETWORK, account: ACCOUNT },
      1
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.error).toBe("SESSION_INVALID");
  });

  it("refuses a tampered token whose digest no longer matches", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const issued = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      7_000
    );
    if (!issued.ok) throw new Error("issue failed");

    const tampered =
      issued.token.slice(0, -1) + (issued.token.endsWith("A") ? "B" : "A");
    const result = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: tampered, network: NETWORK, account: ACCOUNT },
      7_001
    );
    expect(result).toEqual({ ok: false, status: 401, error: "SESSION_INVALID" });
  });
});

/* ═══════════════ 6. REVOCATION IS PER-TOKEN ═══════════════ */

describe("creator session — revocation", () => {
  it("revokes exactly one session and leaves the others valid", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = 20_000;
    const a = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now
    );
    const b = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now + 1
    );
    if (!a.ok || !b.ok) throw new Error("issue failed");

    const revoked = await revokeCreatorSession(sessionEnv(binding), {
      sessionToken: a.token,
    });
    expect(revoked).toEqual({ ok: true, revoked: true });

    const afterA = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: a.token, network: NETWORK, account: ACCOUNT },
      now + 2
    );
    expect(afterA.ok).toBe(false);

    const afterB = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: b.token, network: NETWORK, account: ACCOUNT },
      now + 2
    );
    expect(afterB.ok).toBe(true);
  });
});

/* ═══════════════ 7. MULTI-TAB + CAP + CLEANUP ═══════════════ */

describe("creator session — several concurrent sessions per identity", () => {
  it("keeps independent sessions for multiple tabs alive at once", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = 30_000;
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const issued = await issueCreatorSession(
        sessionEnv(binding),
        { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
        now + i
      );
      if (!issued.ok) throw new Error("issue failed");
      tokens.push(issued.token);
    }

    for (const token of tokens) {
      const result = await validateCreatorSession(
        sessionEnv(binding),
        { sessionToken: token, network: NETWORK, account: ACCOUNT },
        now + 10
      );
      expect(result.ok).toBe(true);
    }
  });

  it("enforces the per-identity cap by evicting the OLDEST session", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = 40_000;
    const tokens: string[] = [];
    for (let i = 0; i < CREATOR_SESSION_MAX_PER_IDENTITY + 2; i++) {
      const issued = await issueCreatorSession(
        sessionEnv(binding),
        { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
        now + i
      );
      if (!issued.ok) throw new Error("issue failed");
      tokens.push(issued.token);
    }

    const records = storedSessions(binding, IDENTITY) as unknown[];
    expect(records).toHaveLength(CREATOR_SESSION_MAX_PER_IDENTITY);

    const oldest = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: tokens[0]!, network: NETWORK, account: ACCOUNT },
      now + 10
    );
    expect(oldest.ok).toBe(false);

    const newest = await validateCreatorSession(
      sessionEnv(binding),
      {
        sessionToken: tokens[tokens.length - 1]!,
        network: NETWORK,
        account: ACCOUNT,
      },
      now + 10
    );
    expect(newest.ok).toBe(true);
  });

  it("prunes expired records on the next issuance", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = 50_000;
    const first = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now
    );
    expect(first.ok).toBe(true);

    // Issue a second session AFTER the first has expired.
    const later = now + CREATOR_SESSION_TTL_MS + 1;
    const second = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      later
    );
    expect(second.ok).toBe(true);

    const records = storedSessions(binding, IDENTITY) as unknown[];
    expect(records).toHaveLength(1);
  });

  it("preserves every concurrent issuance (atomic read-modify-write)", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = 60_000;
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        issueCreatorSession(
          sessionEnv(binding),
          { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
          now + i
        )
      )
    );
    const tokens = results
      .filter((r): r is { ok: true; token: string; expiresAt: number } => r.ok)
      .map((r) => r.token);
    expect(tokens).toHaveLength(5);

    const records = storedSessions(binding, IDENTITY) as unknown[];
    expect(records).toHaveLength(5);

    for (const token of tokens) {
      const result = await validateCreatorSession(
        sessionEnv(binding),
        { sessionToken: token, network: NETWORK, account: ACCOUNT },
        now + 100
      );
      expect(result.ok).toBe(true);
    }
  });
});

/* ═══════════════ 8. BEST-EFFORT ISSUANCE / UNAVAILABILITY ═══════════════ */

describe("creator session — issuance is best-effort and availability is distinct", () => {
  it("returns no token (never an invalid one) when the binding is missing", async () => {
    const result = await issueCreatorSession({}, {
      creatorIdentityId: IDENTITY,
      network: NETWORK,
      account: ACCOUNT,
    }, 1);
    expect(result).toEqual({ ok: false });
  });

  it("returns no token when the Durable Object transport throws", async () => {
    const result = await issueCreatorSession(
      sessionEnv(failingBinding()),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      1
    );
    expect(result).toEqual({ ok: false });
  });

  it("reports SESSION_UNAVAILABLE (503) — not INVALID — when the DO is unreachable", async () => {
    const token = generateCreatorSessionToken(IDENTITY);
    const result = await validateCreatorSession(
      sessionEnv(failingBinding()),
      { sessionToken: token, network: NETWORK, account: ACCOUNT },
      1
    );
    expect(result).toEqual({ ok: false, status: 503, error: "SESSION_UNAVAILABLE" });
  });

  it("omits the session token from verify-proof when issuance is unavailable, still 200", async () => {
    const createFakeKVEnv = createFakeKV();
    // Real EIP-191 signature over "AETERNA identity challenge:challenge-valid".
    await createFakeKVEnv.put(
      "creator:challenge:challenge-valid",
      JSON.stringify({
        id: "challenge-valid",
        network: "eip155:8453",
        challenge: "challenge-valid",
        expiresAt: Date.now() + 600_000,
      })
    );

    const res = await post(
      verifyProofPost as never,
      {
        CREATOR_IDENTITIES: createFakeKVEnv,
        CREDIT_OP_COORDINATOR: failingBinding(),
      },
      {
        challengeId: "challenge-valid",
        network: "eip155:8453",
        account: "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f",
        signature:
          "0x57cf9db5baf4181da98d503ef389e277ac810d417c93ba45d2f380092b67a18a3f8c194f8ea5dd75530914a77c89d0e55afee9161805f2f7116c659750c5c75e1c",
      }
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.creatorIdentityId).toEqual(expect.any(String));
    expect(payload.sessionToken).toBeUndefined();
  });
});

/* ═══════════════ 9. ENDPOINT AUTHORIZATION ═══════════════ */

describe("creator session — authorizes credit-status and create-quote only", () => {
  async function issued(binding: FakeBinding, now = Date.now()) {
    const result = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now
    );
    if (!result.ok) throw new Error("issue failed");
    return result.token;
  }

  it("credit-status accepts a valid session and resolves the identity server-side", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const token = await issued(binding);
    const env = {
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: binding,
    };

    const res = await creditStatus(env, {
      sessionToken: token,
      network: NETWORK,
      account: ACCOUNT,
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.creatorIdentityId).toBe(IDENTITY);
  });

  it("credit-status refuses an expired session with 401 SESSION_EXPIRED", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const token = await issued(binding, 100);
    const env = {
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: binding,
    };

    // The endpoint reads trusted time; the record is already expired there,
    // so a validate against the same DO reports SESSION_EXPIRED.
    const stale = await validateCreatorSession(
      sessionEnv(binding),
      { sessionToken: token, network: NETWORK, account: ACCOUNT },
      100 + CREATOR_SESSION_TTL_MS + 1
    );
    expect(stale).toEqual({ ok: false, status: 401, error: "SESSION_EXPIRED" });
  });

  it("credit-status refuses an invalid session with 401 SESSION_INVALID", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const env = {
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: binding,
    };

    const res = await creditStatus(env, {
      sessionToken: generateCreatorSessionToken(IDENTITY),
      network: NETWORK,
      account: ACCOUNT,
    });

    expect(res.status).toBe(401);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.error).toBe("SESSION_INVALID");
  });

  it("credit-status reports 503 SESSION_UNAVAILABLE when the DO is unreachable", async () => {
    const env = {
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: failingBinding(),
    };

    const res = await creditStatus(env, {
      sessionToken: generateCreatorSessionToken(IDENTITY),
      network: NETWORK,
      account: ACCOUNT,
    });

    expect(res.status).toBe(503);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.error).toBe("SESSION_UNAVAILABLE");
  });

  it("create-quote accepts a valid session", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const token = await issued(binding);
    const env = {
      BUSINESS_QUOTES: createFakeKV(),
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: binding,
    };

    const res = await createQuote(env, {
      sessionToken: token,
      network: NETWORK,
      account: ACCOUNT,
      paymentIntentId: "pi-session-1",
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.paymentIntentId).toBe("pi-session-1");
  });

  it("create-quote refuses an invalid session with 401 SESSION_INVALID", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const env = {
      BUSINESS_QUOTES: createFakeKV(),
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: binding,
    };

    const res = await createQuote(env, {
      sessionToken: generateCreatorSessionToken(IDENTITY),
      network: NETWORK,
      account: ACCOUNT,
      paymentIntentId: "pi-session-2",
    });

    expect(res.status).toBe(401);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.error).toBe("SESSION_INVALID");
  });

  it("create-quote with a malformed session does NOT fall through to an unauthenticated quote", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const env = {
      BUSINESS_QUOTES: createFakeKV(),
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: binding,
    };

    const res = await createQuote(env, {
      sessionToken: "aets..nope",
      network: NETWORK,
      account: ACCOUNT,
      paymentIntentId: "pi-session-3",
    });

    expect(res.status).toBe(401);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.error).toBe("SESSION_INVALID");
  });
});

/* ═══════════════ 10. THE SESSION DOES NOT WEAKEN THE PURCHASE GUARD ═══════════════ */

describe("creator session — financial guard is unchanged", () => {
  it("still refuses a SECOND independent purchase for the same identity", async () => {
    const binding = createFakeCreditCoordinatorBinding();
    const now = Date.now();
    const issued = await issueCreatorSession(
      sessionEnv(binding),
      { creatorIdentityId: IDENTITY, network: NETWORK, account: ACCOUNT },
      now
    );
    if (!issued.ok) throw new Error("issue failed");

    const env = {
      BUSINESS_QUOTES: createFakeKV(),
      CREATOR_IDENTITIES: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      CREDIT_OP_COORDINATOR: binding,
    };

    const first = await createQuote(env, {
      sessionToken: issued.token,
      network: NETWORK,
      account: ACCOUNT,
      paymentIntentId: "pi-guard-1",
    });
    expect(first.status).toBe(200);

    // A SECOND intent for the same identity must NOT mint a second $1:
    // the authoritative attempt state resumes the FIRST one.
    const second = await createQuote(env, {
      sessionToken: issued.token,
      network: NETWORK,
      account: ACCOUNT,
      paymentIntentId: "pi-guard-2",
    });
    expect(second.status).toBe(200);
    const payload = (await second.json()) as Record<string, unknown>;
    expect(payload.continued).toBe(true);
    expect(payload.paymentIntentId).toBe("pi-guard-1");
  });
});
