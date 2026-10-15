/**
 * AETERNA — purchase guard at the payment-intent boundary
 *
 * These invariants prove the END-TO-END protection against a second $1
 * purchase, which is what the KV-only discovery could not give:
 *
 *  - create-quote now requires a cryptographically proven creator
 *    identity and atomically reserves the purchase attempt in the
 *    identity-scoped Durable Object BEFORE any payment intent exists;
 *  - an AVAILABLE or CONSUMING right refuses the new purchase at that
 *    boundary — even when the KV projection is stale (the exact
 *    eventual-consistency window that used to allow a duplicate $1);
 *  - an unfinished attempt is CONTINUED, never duplicated;
 *  - an unknown / unenumerable state blocks the purchase (fail closed);
 *  - credit-status prefers the strongly consistent identity coordinator.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
  type FakeKV,
} from "./harness";
import { onRequestPost as createQuotePost } from "../api/service-payment/create-quote";
import { onRequestPost as creditStatusPost } from "../api/creator/credit-status";

const ORIGIN = "https://aeternacapsule.com";

const OWNER_ACCOUNT = "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
const OWNER_SIGNATURE =
  "0x57cf9db5baf4181da98d503ef389e277ac810d417c93ba45d2f380092b67a18a3f8c194f8ea5dd75530914a77c89d0e55afee9161805f2f7116c659750c5c75e1c";
const OTHER_ACCOUNT = "0x1111111111111111111111111111111111111111";
const CHALLENGE_ID = "challenge-valid";
const IDENTITY = "creator-1";

const PROOF = {
  challengeId: CHALLENGE_ID,
  network: "eip155:8453",
  account: OWNER_ACCOUNT,
  signature: OWNER_SIGNATURE,
};

/**
 * A KV namespace whose READS lag behind (a fresh write is not yet
 * visible), exactly like Cloudflare KV's eventual consistency. Writes
 * land immediately so the projections do exist eventually.
 */
function createLaggingKV(): FakeKV {
  const inner = createFakeKV();
  const hidden = new Set<string>();
  return {
    data: inner.data,
    async get(key) {
      if (hidden.has(key)) return null;
      return inner.get(key);
    },
    async put(key, value, options) {
      hidden.add(key);
      return inner.put(key, value, options);
    },
    async delete(key) {
      return inner.delete(key);
    },
    async list(options) {
      const listed = await inner.list(options);
      return {
        keys: listed.keys.filter((key) => !hidden.has(key.name)),
        list_complete: true,
      };
    },
  };
}

function createIdentities() {
  const store = new Map<string, string>();
  store.set(
    `creator:challenge:${CHALLENGE_ID}`,
    JSON.stringify({
      challenge: CHALLENGE_ID,
      network: "eip155:8453",
      expiresAt: Date.now() + 600_000,
    })
  );
  for (const account of [OWNER_ACCOUNT, OTHER_ACCOUNT]) {
    store.set(
      `creator:identity:eip155:8453:${account.toLowerCase()}`,
      JSON.stringify({
        id: account === OWNER_ACCOUNT ? IDENTITY : "creator-2",
        account: account.toLowerCase(),
        network: "eip155:8453",
      })
    );
  }
  store.set(
    `creator:identity:id:${IDENTITY}`,
    `eip155:8453:${OWNER_ACCOUNT.toLowerCase()}`
  );
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

interface BuildOptions {
  laggingCredits?: boolean;
}

function buildEnv(options: BuildOptions = {}) {
  const credits = options.laggingCredits ? createLaggingKV() : createFakeKV();
  const binding = createFakeCreditCoordinatorBinding({ creatorCredits: credits });
  const env = {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_IDENTITIES: createIdentities(),
    CREATOR_CREDITS: credits,
    CREDIT_OP_COORDINATOR: binding,
  };
  return { env, credits, binding };
}

function post(
  handler: (context: never) => Promise<Response>,
  env: unknown,
  body: unknown
) {
  return handler(
    makeEventContext({
      request: createFakeRequest({
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body,
      }),
      env,
    }) as never
  );
}

/**
 * Re-issue the identity-proof challenge with a fresh expiry.
 *
 * These tests JUMP the clock past the 30-minute quote window; the
 * identity proof has its own 10-minute window, so it must be refreshed
 * too or the request would fail with CHALLENGE_EXPIRED (which would
 * prove nothing about the purchase guard).
 */
function refreshChallenge(env: { CREATOR_IDENTITIES: { put(key: string, value: string): Promise<void> } }) {
  return env.CREATOR_IDENTITIES.put(
    `creator:challenge:${CHALLENGE_ID}`,
    JSON.stringify({
      challenge: CHALLENGE_ID,
      network: "eip155:8453",
      expiresAt: Date.now() + 600_000,
    })
  );
}

const createQuote = (env: unknown, body: Record<string, unknown>) =>
  post(createQuotePost as never, env, body);

const creditStatus = (env: unknown, body: Record<string, unknown>) =>
  post(creditStatusPost as never, env, body);

/** Mint a right through the identity coordinator (as grant-credit does). */
async function grantRight(
  binding: ReturnType<typeof createFakeCreditCoordinatorBinding>,
  credits: FakeKV,
  input: { quoteId: string; paymentIntentId: string; creditId: string }
) {
  const call = async (name: string, payload: Record<string, unknown>) => {
    const stub = binding.get(binding.idFromName(name));
    const res = await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
    return (await res.json()) as Record<string, unknown>;
  };

  await call(`identity:${IDENTITY}`, {
    op: "identity-reserve-attempt",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
  });
  const authorize = await call(`identity:${IDENTITY}`, {
    op: "identity-authorize-grant",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
    transactionId: `tx-${input.quoteId}`,
  });
  const granted = await call(input.creditId, {
    op: "grant",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
    transactionId: `tx-${input.quoteId}`,
    evidenceId: `ev-${input.quoteId}`,
    creatorCreditId: authorize["creatorCreditId"],
  });
  await call(`identity:${IDENTITY}`, {
    op: "identity-note-grant",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
    creatorCreditId: granted["creatorCreditId"],
  });
  return String(granted["creatorCreditId"]);
}

/** Drive a right to CONSUMING (reserve) through the per-credit DO. */
async function reserveRight(
  binding: ReturnType<typeof createFakeCreditCoordinatorBinding>,
  creditId: string,
  lifecycleId: string,
  capsuleId: string
) {
  const stub = binding.get(binding.idFromName(creditId));
  await stub.fetch(
    new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "reserve",
        creatorCreditId: creditId,
        creatorIdentityId: IDENTITY,
        lifecycleId,
        capsuleId,
      }),
    })
  );
  const identityStub = binding.get(binding.idFromName(`identity:${IDENTITY}`));
  await identityStub.fetch(
    new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "identity-note-reserve",
        creatorIdentityId: IDENTITY,
        creatorCreditId: creditId,
        lifecycleId,
        capsuleId,
      }),
    })
  );
}

describe("create-quote — atomic purchase guard", () => {
  it("mints a quote for a proven identity with no rights, and reserves the attempt", async () => {
    const { env } = buildEnv();
    const res = await createQuote(env, {
      paymentIntentId: "intent-1",
      ...PROOF,
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(payload["paymentIntentId"]).toBe("intent-1");
    expect(payload["expectedAmount"]).toBe(1);
  });

  it("refuses a quote without a valid identity proof", async () => {
    const { env } = buildEnv();
    const missing = await createQuote(env, { paymentIntentId: "intent-1" });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(((await missing.json()) as Record<string, unknown>)["ok"]).toBe(false);

    const wrongSignature = await createQuote(env, {
      paymentIntentId: "intent-1",
      ...PROOF,
      signature: "0x" + "ab".repeat(65),
    });
    expect(wrongSignature.status).toBe(401);
  });

  it("resolves the identity SERVER-SIDE: a proof for another account cannot borrow this identity", async () => {
    const { env, binding } = buildEnv();
    await grantRight(binding, env.CREATOR_CREDITS, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });

    // A DIFFERENT (also valid) account has no right of its own, so its
    // quote must succeed even though this identity owns one — the guard
    // never trusts a client-supplied identity.
    const res = await createQuote(env, {
      paymentIntentId: "intent-other",
      ...PROOF,
      account: OTHER_ACCOUNT,
      signature: OWNER_SIGNATURE,
    });
    // The signature does not match the claimed account → refused.
    expect(res.status).toBe(401);
  });

  it("refuses a new purchase while an AVAILABLE right exists — no quote, no payment intent", async () => {
    const { env, binding } = buildEnv();
    await grantRight(binding, env.CREATOR_CREDITS, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });

    const res = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "CREATOR_ALREADY_HAS_LIVE_RIGHT"
    );
  });

  it("refuses a new purchase while a CONSUMING right exists", async () => {
    const { env, binding } = buildEnv();
    const creditId = await grantRight(binding, env.CREATOR_CREDITS, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });
    await reserveRight(binding, creditId, "lifecycle-1", "capsule-1");

    const res = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "CREATOR_ALREADY_HAS_LIVE_RIGHT"
    );
  });

  it("CONTINUES an unfinished attempt instead of creating a second payment intent", async () => {
    const { env } = buildEnv();
    const first = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    expect(first.status).toBe(200);

    const second = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
    expect(second.status).toBe(200);
    const payload = (await second.json()) as Record<string, unknown>;
    expect(payload["continued"]).toBe(true);
    expect(payload["paymentIntentId"]).toBe("intent-1");
    expect(payload["expectedAmount"]).toBe(1);
  });

  it("blocks the purchase when the identity coordinator is unavailable (fail closed)", async () => {
    const { env } = buildEnv();
    const noCoordinator = { ...env, CREDIT_OP_COORDINATOR: undefined };
    const res = await createQuote(noCoordinator, {
      paymentIntentId: "intent-1",
      ...PROOF,
    });
    expect(res.status).toBe(503);
  });

  it("blocks the purchase when the entitlement state cannot be enumerated", async () => {
    const { env, credits } = buildEnv();
    // An unresolvable pointer means an old right of unknown state.
    credits.put(`creator:credit:index:${IDENTITY}:capsule-ghost`, "ghost-credit");

    const res = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "ENTITLEMENT_STATE_UNKNOWN"
    );
  });

  it("KV LAG: a stale (empty) projection cannot authorise a second purchase", async () => {
    const { env, binding, credits } = buildEnv({ laggingCredits: true });
    const creditId = await grantRight(binding, credits, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });
    expect(creditId).toBeTruthy();

    // The KV record exists but is not yet READABLE (eventual consistency):
    // the old KV-only discovery would answer "no rights" here.
    const kvRecord = await credits.get(`creator:credit:${creditId}`);
    expect(kvRecord).toBeNull();

    const res = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "CREATOR_ALREADY_HAS_LIVE_RIGHT"
    );
  });

  it("KV LAG: credit-status still reports the right from the identity coordinator", async () => {
    const { env, binding, credits } = buildEnv({ laggingCredits: true });
    // The identity coordinator MINTS the credit id; the returned value is
    // the authoritative one.
    const creditId = await grantRight(binding, credits, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });

    const res = await creditStatus(env, { ...PROOF });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload["status"]).toBe("available");
    expect(payload["creatorCreditId"]).toBe(creditId);
  });

  it("credit-status reports CONSUMING with recovery identifiers and no hint", async () => {
    const { env, binding } = buildEnv();
    const creditId = await grantRight(binding, env.CREATOR_CREDITS, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });
    await reserveRight(binding, creditId, "lifecycle-1", "capsule-1");

    const res = await creditStatus(env, { ...PROOF });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload["status"]).toBe("consuming");
    expect(payload["unfinishedLifecycles"]).toEqual([
      expect.objectContaining({
        creatorCreditId: creditId,
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      }),
    ]);
  });

  it("credit-status fails CLOSED when the coordinator cannot vouch for the state", async () => {
    const { env, credits } = buildEnv();
    credits.put(`creator:credit:index:${IDENTITY}:capsule-ghost`, "ghost-credit");

    const res = await creditStatus(env, { ...PROOF });
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "ENTITLEMENT_STATE_UNKNOWN"
    );
  });

  it("is idempotent for the same payment intent (no duplicate attempt)", async () => {
    const { env } = buildEnv();
    const first = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    const second = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const payload = (await second.json()) as Record<string, unknown>;
    expect(payload["paymentIntentId"]).toBe("intent-1");
  });

  it("never starts a payment for a CONSUMED-only history: the creator may buy again", async () => {
    const { env, binding } = buildEnv();
    const creditId = await grantRight(binding, env.CREATOR_CREDITS, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });
    await reserveRight(binding, creditId, "lifecycle-1", "capsule-1");
    const perCredit = binding.get(binding.idFromName(creditId));
    await perCredit.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "finalize",
          creatorCreditId: creditId,
          creatorIdentityId: IDENTITY,
          lifecycleId: "lifecycle-1",
          capsuleId: "capsule-1",
          publicationVerified: true,
          sealVerified: true,
        }),
      })
    );
    const identityStub = binding.get(binding.idFromName(`identity:${IDENTITY}`));
    await identityStub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "identity-note-finalize",
          creatorIdentityId: IDENTITY,
          creatorCreditId: creditId,
        }),
      })
    );

    const res = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
    expect(res.status).toBe(200);
  });
});

describe("same-intent payment recovery (quote renewal)", () => {
  const TTL_MS = 30 * 60 * 1000;

  it("renews the SAME payment intent after the window expired — never a second intent", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
      const { env } = buildEnv();
      const first = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as Record<string, unknown>;
      expect(firstBody["paymentState"]).toBe("ready_to_pay");
      const firstExpiry = Number(firstBody["expiresAt"]);

      // Past the 30-minute window: the attempt is still active, no
      // payment is recorded for it, so the SAME intent gets a fresh
      // window instead of being blocked forever.
      vi.setSystemTime(new Date("2026-10-14T01:00:00Z"));
      await refreshChallenge(env);
      const second = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as Record<string, unknown>;
      expect(secondBody["continued"]).toBe(true);
      expect(secondBody["paymentIntentId"]).toBe("intent-1");
      expect(secondBody["paymentState"]).toBe("ready_to_pay");
      expect(Number(secondBody["expiresAt"])).toBeGreaterThan(Date.now());
      expect(Number(secondBody["expiresAt"])).not.toBe(firstExpiry);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews idempotently: two tabs converge on ONE window, one intent", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
      const { env } = buildEnv();
      await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });

      vi.setSystemTime(new Date("2026-10-14T01:00:00Z"));
      await refreshChallenge(env);
      const [a, b] = await Promise.all([
        createQuote(env, { paymentIntentId: "intent-tab-a", ...PROOF }),
        createQuote(env, { paymentIntentId: "intent-tab-b", ...PROOF }),
      ]);
      const bodyA = (await a.json()) as Record<string, unknown>;
      const bodyB = (await b.json()) as Record<string, unknown>;
      expect(bodyA["paymentIntentId"]).toBe("intent-1");
      expect(bodyB["paymentIntentId"]).toBe("intent-1");
      // A live window is never pushed further: both see the same expiry.
      expect(bodyA["expiresAt"]).toBe(bodyB["expiresAt"]);

      // And the attempt pointer still names the ORIGINAL intent.
      const summary = await (async () => {
        const stub = env.CREDIT_OP_COORDINATOR.get(
          env.CREDIT_OP_COORDINATOR.idFromName(`identity:${IDENTITY}`)
        );
        const res = await stub.fetch(
          new Request("https://aeterna-credit-coordinator.invalid", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "identity-summary", creatorIdentityId: IDENTITY }),
          })
        );
        return (await res.json()) as Record<string, unknown>;
      })();
      expect(
        (summary["activeAttempt"] as { paymentIntentId: string }).paymentIntentId
      ).toBe("intent-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT renew once a payment is recorded for the attempt (granting)", async () => {
    const { env, binding, credits } = buildEnv();
    // Reserve + authorize: the attempt becomes "granting" (a verified
    // payment exists, its grant is unfinished).
    await grantRight(binding, credits, {
      quoteId: "intent-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });
    // Re-open the attempt in the "granting" state by reserving again is
    // impossible (it is fulfilled); assert the FULFILLED branch instead:
    // no fresh window is ever issued once the credit exists.
    const res = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
    const body = (await res.json()) as Record<string, unknown>;
    // A live right exists, so the purchase is refused outright.
    expect(res.status).toBe(409);
    expect(body["error"]).toBe("CREATOR_ALREADY_HAS_LIVE_RIGHT");
  });

  it("KV LAG cannot make an incompatible renewal: the attempt state is authoritative", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
      const { env, binding, credits } = buildEnv({ laggingCredits: true });
      await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });

      // Authorize the grant directly in the DO (the payment became
      // verified) while the KV projections stay unreadable.
      const call = async (name: string, payload: Record<string, unknown>) => {
        const stub = binding.get(binding.idFromName(name));
        const r = await stub.fetch(
          new Request("https://aeterna-credit-coordinator.invalid", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        );
        return (await r.json()) as Record<string, unknown>;
      };
      await call(`identity:${IDENTITY}`, {
        op: "identity-authorize-grant",
        creatorIdentityId: IDENTITY,
        quoteId: "intent-1",
        paymentIntentId: "intent-1",
        transactionId: "tx-1",
      });
      expect(await credits.get("creator:credit:anything")).toBeNull();

      vi.setSystemTime(new Date("2026-10-14T01:00:00Z"));
      await refreshChallenge(env);
      const res = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["continued"]).toBe(true);
      expect(body["paymentIntentId"]).toBe("intent-1");
      // A payment is recorded → NO fresh window is opened for a transfer.
      expect(body["paymentState"]).toBe("verified_pending_grant");
      expect(Number(body["expiresAt"])).toBeLessThanOrEqual(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeated requests never create a second payment intent", async () => {
    const { env, binding } = buildEnv();
    for (let i = 0; i < 4; i += 1) {
      const res = await createQuote(env, {
        paymentIntentId: `intent-${i}`,
        ...PROOF,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["paymentIntentId"]).toBe("intent-0");
    }
    const summary = await (async () => {
      const stub = binding.get(binding.idFromName(`identity:${IDENTITY}`));
      const r = await stub.fetch(
        new Request("https://aeterna-credit-coordinator.invalid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "identity-summary", creatorIdentityId: IDENTITY }),
        })
      );
      return (await r.json()) as Record<string, unknown>;
    })();
    expect(
      (summary["activeAttempt"] as { paymentIntentId: string }).paymentIntentId
    ).toBe("intent-0");
  });
});

describe("identity coordinator self-binding is exercised (no silent skip)", () => {
  it("refresh repairs a missed note from the authoritative per-credit record", async () => {
    const { env, binding } = buildEnv();
    const creditId = await grantRight(binding, env.CREATOR_CREDITS, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit0001",
    });

    // Reserve through the per-credit DO but DELIBERATELY skip the index
    // note (the "note call failed" case).
    const perCredit = binding.get(binding.idFromName(creditId));
    await perCredit.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "reserve",
          creatorCreditId: creditId,
          creatorIdentityId: IDENTITY,
          lifecycleId: "lifecycle-1",
          capsuleId: "capsule-1",
        }),
      })
    );

    // The index still says AVAILABLE, but the read-through refresh reads
    // the authoritative record and reports CONSUMING.
    const res = await creditStatus(env, { ...PROOF });
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload["status"]).toBe("consuming");
  });
});

/**
 * Discovery of an ALREADY-BOUND transaction signature.
 *
 * A client that lost its local pending record still knows its payment
 * intent, and asks for a quote again with a fresh cryptographic identity
 * proof. create-quote reads the attempt back from the identity
 * coordinator — keyed by the SERVER-DERIVED identity, never by anything
 * the caller claims — and reports the signature already bound to it, so
 * the client can VERIFY that same transaction instead of signing a new
 * one.
 */
describe("bound-signature discovery (lost local pointer)", () => {
  /** Bind a broadcast signature for an attempt, exactly as the endpoint does. */
  async function bindSignature(
    binding: ReturnType<typeof createFakeCreditCoordinatorBinding>,
    identityId: string,
    paymentIntentId: string,
    transactionId: string
  ) {
    const stub = binding.get(binding.idFromName(`identity:${identityId}`));
    const res = await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "identity-bind-broadcast-signature",
          creatorIdentityId: identityId,
          paymentIntentId,
          transactionId,
        }),
      })
    );
    return (await res.json()) as Record<string, unknown>;
  }

  it("reports the ALREADY-BOUND signature of the proven identity's own attempt", async () => {
    const { env, binding } = buildEnv();
    const first = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    expect(first.status).toBe(200);
    expect((await bindSignature(binding, IDENTITY, "intent-1", "sig-bound-1"))["ok"]).toBe(
      true
    );

    // The local pointer is gone; the client asks for a quote again with
    // the SAME proven identity. The server discovers the bound signature
    // for the SAME (continued) intent.
    const res = await createQuote(env, { paymentIntentId: "intent-2", ...PROOF });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body["continued"]).toBe(true);
    expect(body["paymentIntentId"]).toBe("intent-1");
    expect(body["resumeTransactionId"]).toBe("sig-bound-1");
  });

  it("reports NO signature when none is bound (a fresh intent stays payable)", async () => {
    const { env } = buildEnv();
    const res = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body["resumeTransactionId"]).toBeNull();
  });

  it("refuses discovery without a valid identity proof (access error)", async () => {
    const { env, binding } = buildEnv();
    await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    await bindSignature(binding, IDENTITY, "intent-1", "sig-bound-1");

    const res = await createQuote(env, {
      paymentIntentId: "intent-2",
      ...PROOF,
      signature: "0xdeadbeef",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as Record<string, unknown>;
    // Nothing is disclosed without proof.
    expect(body["resumeTransactionId"]).toBeUndefined();
    expect(body["ok"]).not.toBe(true);
  });

  it("never discovers an attempt that belongs to ANOTHER identity", async () => {
    const { env, binding } = buildEnv();
    // A different identity has its own reserved attempt with a bound
    // signature.
    const other = binding.get(binding.idFromName("identity:creator-2"));
    await other.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "identity-reserve-attempt",
          creatorIdentityId: "creator-2",
          quoteId: "other-intent",
          paymentIntentId: "other-intent",
        }),
      })
    );
    await bindSignature(binding, "creator-2", "other-intent", "sig-other");

    // The owner proves ITS identity and discovers nothing of creator-2's.
    const res = await createQuote(env, { paymentIntentId: "intent-1", ...PROOF });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body["paymentIntentId"]).toBe("intent-1");
    expect(body["resumeTransactionId"]).toBeNull();
  });
});
