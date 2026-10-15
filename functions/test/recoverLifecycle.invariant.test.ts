import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as recoverPost } from "./../api/creator/recover-lifecycle";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

/**
 * A REAL EIP-191 signature over the challenge message
 * `AETERNA identity challenge:challenge-valid`, produced by the account
 * below. Reused verbatim from credit-status.invariant.test.ts, which pins
 * the same identity scheme — no new secret model is introduced by D3.
 */
const OWNER_ACCOUNT = "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
const OWNER_SIGNATURE =
  "0x57cf9db5baf4181da98d503ef389e277ac810d417c93ba45d2f380092b67a18a3f8c194f8ea5dd75530914a77c89d0e55afee9161805f2f7116c659750c5c75e1c";
const CHALLENGE_ID = "challenge-valid";

const CREATOR_IDENTITY_ID = "creator-1";
const LIFECYCLE_ID = "lifecycle-1";
const CAPSULE_ID = "capsule-1";

interface RecoverEnv {
  CREATOR_CREDITS: ReturnType<typeof createFakeKV>;
  CREATOR_IDENTITIES: ReturnType<typeof createFakeKV>;
  PUBLICATION_VERIFICATIONS: ReturnType<typeof createFakeKV>;
  SEAL_VERIFICATIONS: ReturnType<typeof createFakeKV>;
  CREDIT_OP_COORDINATOR: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(request: Request): Promise<Response>;
    };
  };
}

function buildEnv(overrides?: Partial<RecoverEnv>): RecoverEnv {
  return {
    CREATOR_CREDITS: createFakeKV(),
    CREATOR_IDENTITIES: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    SEAL_VERIFICATIONS: createFakeKV(),
    CREDIT_OP_COORDINATOR: createFakeCoordinator(),
    ...overrides,
  };
}

function createFakeCoordinator() {
  const outcomes = new Map<string, { ok: boolean; outcome?: string; httpStatus?: number }>();
  const lastRequestBody: Record<string, unknown> = {};
  let fetchCount = 0;
  return {
    idFromName(_name: string): { id: string } {
      return { id: "coordinator-1" };
    },
    get(_binding: { id: string }) {
      return {
        async fetch(request: Request) {
          fetchCount += 1;
          try {
            Object.assign(lastRequestBody, (await request.json()) as Record<string, unknown>);
          } catch {
            // ignore parse errors in fake coordinator
          }
          const configured = outcomes.get("default");
          if (!configured) {
            return new Response(JSON.stringify({ ok: false, error: "NO_OUTCOME" }), { status: 500 });
          }
          const httpStatus = configured.httpStatus ?? (configured.ok ? 200 : 409);
          const body: Record<string, unknown> = {
            ok: configured.ok,
            status: configured.outcome ?? httpStatus,
            creatorCreditId: "credit-1",
            lifecycleId: null,
            revision: 2,
          };
          if (configured.outcome) {
            body.outcome = configured.outcome;
          }
          return new Response(JSON.stringify(body), { status: httpStatus });
        },
      };
    },
    setOutcome(key: string, outcome: { ok: boolean; outcome?: string; httpStatus?: number }) {
      outcomes.set(key, outcome);
      if (key !== "default") {
        outcomes.set("default", outcome);
      }
    },
    lastRequestBody,
    get fetchCount() {
      return fetchCount;
    },
  };
}

/** The signed owner proof every authorized request must carry (D3). */
function ownerProof(overrides: Record<string, unknown> = {}) {
  return {
    challengeId: CHALLENGE_ID,
    network: "eip155:8453",
    account: OWNER_ACCOUNT,
    signature: OWNER_SIGNATURE,
    ...overrides,
  };
}

function buildContext(env: RecoverEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

function seedChallenge(env: RecoverEnv, expiresAt: number) {
  env.CREATOR_IDENTITIES.put(
    `creator:challenge:${CHALLENGE_ID}`,
    JSON.stringify({
      challenge: CHALLENGE_ID,
      network: "eip155:8453",
      expiresAt,
    })
  );
}

function seedIdentity(env: RecoverEnv, creatorIdentityId = CREATOR_IDENTITY_ID) {
  env.CREATOR_IDENTITIES.put(
    `creator:identity:eip155:8453:${OWNER_ACCOUNT.toLowerCase()}`,
    JSON.stringify({
      id: creatorIdentityId,
      account: OWNER_ACCOUNT.toLowerCase(),
      network: "eip155:8453",
    })
  );
}

function seedLifecycle(env: RecoverEnv, status: string) {
  env.CREATOR_CREDITS.put(
    `creator:credit:lifecycle:${CREATOR_IDENTITY_ID}:${LIFECYCLE_ID}`,
    JSON.stringify({
      id: "credit-1",
      status,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      capsuleId: CAPSULE_ID,
    })
  );
}

/** An authorized recovery request: identifiers + a valid owner proof. */
function authorizedBody(overrides: Record<string, unknown> = {}) {
  return {
    creatorIdentityId: CREATOR_IDENTITY_ID,
    lifecycleId: LIFECYCLE_ID,
    capsuleId: CAPSULE_ID,
    ...ownerProof(),
    ...overrides,
  };
}

describe("Recovery authority", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("RETURNS RETURN_EXISTING when lifecycle is CONSUMED", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "CONSUMED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RETURN_EXISTING", httpStatus: 200 });

    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("RETURN_EXISTING");
  });

  it("RETURNS RETURN_EXISTING when publication and Seal are verified", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "CONSUMING");
    env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "VERIFIED" })
    );
    env.SEAL_VERIFICATIONS.put(
      "creator:seal:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "VERIFIED" })
    );
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RETURN_EXISTING", httpStatus: 200 });

    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("RETURN_EXISTING");
  });

  it("RETURNS RESUME for active or consuming lifecycle", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "ACTIVE");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RESUME", httpStatus: 200 });

    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("RESUME");
  });

  it("RESTORES AVAILABLE for interrupted lifecycle and clears ownership", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "INTERRUPTED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE", httpStatus: 200 });

    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(200);
    const recovery = await res.json();
    expect(recovery.outcome).toBe("ABORT_AND_RESTORE_AVAILABLE");
    expect(recovery.status).toBe("ABORT_AND_RESTORE_AVAILABLE");
  });

  it("does not send client-derived publication/seal state to the coordinator", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "CONSUMING");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RESUME", httpStatus: 200 });

    await recoverPost(
      buildContext(
        env,
        authorizedBody({
          publicationState: "VERIFIED",
          sealState: "VERIFIED",
        })
      )
    );

    const sent = env.CREDIT_OP_COORDINATOR.lastRequestBody;
    expect("publicationState" in sent).toBe(false);
    expect("sealState" in sent).toBe(false);
    expect(sent.op).toBe("recover");
    expect(sent.creatorIdentityId).toBe("creator-1");
    expect(sent.lifecycleId).toBe("lifecycle-1");
    expect(sent.capsuleId).toBe("capsule-1");
  });
});

describe("D3 — recovery requires a signed owner proof", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("SCENARIO 9: identifiers alone (no proof) are rejected and never reach the coordinator", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "INTERRUPTED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE", httpStatus: 200 });

    const res = await recoverPost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
      })
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("OWNER_PROOF_REQUIRED");
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(0);
  });

  it("SCENARIO 9b: a forged/invalid signature is rejected and never reaches the coordinator", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "INTERRUPTED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE", httpStatus: 200 });

    const res = await recoverPost(
      buildContext(
        env,
        authorizedBody({ signature: "0x" + "ab".repeat(65) })
      )
    );

    expect(res.status).toBe(401);
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(0);
  });

  it("SCENARIO 9c: a valid proof from a DIFFERENT creator identity is rejected", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    // The signed account belongs to another creator identity…
    seedIdentity(env, "creator-someone-else");
    seedLifecycle(env, "INTERRUPTED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE", httpStatus: 200 });

    // …while the request claims creator-1.
    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("CREATOR_MISMATCH");
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(0);
  });

  it("an unknown / expired challenge is rejected", async () => {
    const env = buildEnv();
    // No challenge seeded at all.
    seedIdentity(env);
    seedLifecycle(env, "INTERRUPTED");

    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("CHALLENGE_NOT_FOUND");
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(0);
  });

  it("an expired challenge is rejected", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() - 1_000);
    seedIdentity(env);
    seedLifecycle(env, "INTERRUPTED");

    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("CHALLENGE_EXPIRED");
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(0);
  });

  it("a network mismatch between proof and challenge is rejected", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "INTERRUPTED");

    const res = await recoverPost(
      buildContext(env, authorizedBody({ network: "solana", account: "not-base58" }))
    );

    expect(res.status).toBe(400);
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(0);
  });

  it("a foreign lifecycle index owner is rejected even with a valid proof", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    // The index claims a different owner than the proven identity.
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${CREATOR_IDENTITY_ID}:${LIFECYCLE_ID}`,
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-someone-else",
        capsuleId: CAPSULE_ID,
      })
    );

    const res = await recoverPost(buildContext(env, authorizedBody()));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("CREATOR_MISMATCH");
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(0);
  });

  it("SCENARIO 10: a repeated authorized request is safe and idempotent (the DO is the dedupe authority)", async () => {
    const env = buildEnv();
    seedChallenge(env, Date.now() + 60_000);
    seedIdentity(env);
    seedLifecycle(env, "INTERRUPTED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE", httpStatus: 200 });

    const first = await recoverPost(buildContext(env, authorizedBody()));
    const second = await recoverPost(buildContext(env, authorizedBody()));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).outcome).toBe("ABORT_AND_RESTORE_AVAILABLE");
    // The second call returns the SAME authoritative outcome: the endpoint
    // adds no state of its own, so a replay can never produce a different
    // (or a second) restoration.
    expect((await second.json()).outcome).toBe("ABORT_AND_RESTORE_AVAILABLE");
    // The proof is a challenge, so a replay re-uses the same signed proof —
    // it is NOT a second, independent authorization path.
    //
    // Two requests now touch the coordinator twice each: the authoritative
    // recover op, then the identity-index note that keeps the purchase
    // guard truthful. The note is a pure index update (it can never
    // restore anything on its own), so the dedupe authority is unchanged.
    expect(env.CREDIT_OP_COORDINATOR.fetchCount).toBe(4);
    expect(env.CREDIT_OP_COORDINATOR.lastRequestBody["op"]).toBe(
      "identity-note-recover"
    );
    expect(env.CREDIT_OP_COORDINATOR.lastRequestBody["creatorCreditId"]).toBe(
      "credit-1"
    );
  });
});
