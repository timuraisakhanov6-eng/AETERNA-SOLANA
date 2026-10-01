/**
 * AETERNA — Stage 4.1: container publication claim RACE SAFETY
 *
 * Proves the required property for two concurrent conflicting container
 * claims:
 *
 *   A) exactly one may establish the authoritative container claim
 *   B) the other receives a DETERMINISTIC conflict
 *   C) both never return success
 *   D) exact replay of the winning claim stays idempotent
 *   E) cross-capsule txId reuse stays TX_ALREADY_CLAIMED
 *
 * How concurrency is exercised
 * ----------------------------
 * The real Cloudflare Durable Object delivers one request at a time to a
 * given instance, and the shared harness (`createFakeCreditCoordinatorBinding`)
 * emulates exactly that with a per-instance promise QUEUE. Two `Promise.all`
 * invocations against the same instance therefore interleave everywhere
 * EXCEPT inside the DO request, which is the production semantics under test.
 *
 * There are NO sleeps anywhere in this file: the outcome is decided by the
 * primitive's own serialization, not by timing.
 *
 * Two layers are tested:
 *   1. the PRIMITIVE  (claimContainerPublication -> the DO op), which is
 *      deterministic and isolates the atomic transition; and
 *   2. the ENDPOINT   (/api/publication/claim), which additionally covers
 *      the KV projection and the response contract.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
} from "./harness";
import {
  claimContainerPublication,
  CONTAINER_PUBLICATION_COORDINATOR_NAME,
} from "../lib/containerPublicationClaim";

const ORIGIN = "https://aeternacapsule.com";
const NODE_URL = "https://uploader.irys.xyz";
const NOW = 1_800_000_000_000;

const IDENTITY_ID = "f".repeat(32);
const WALLET_ACCOUNT = "B".repeat(44);
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const IRYS_DESTINATION = "IrysDestinationAccount333333333333333333333";

const CAPSULE_A = "a".repeat(64);
const CAPSULE_B = "b".repeat(64);
const LIFECYCLE_A = "lifecycle-a";
const LIFECYCLE_B = "lifecycle-b";
const PAYMENT_A = "storage-pay-a";
const PAYMENT_B = "storage-pay-b";

const CONTAINER_TX = "K".repeat(43);
const C1 = "1".repeat(64);
const C2 = "2".repeat(64);
const C3 = "3".repeat(64);
const DIGEST = "9".repeat(64);
const DIGEST_OTHER = "8".repeat(64);

function buildEnv() {
  return {
    CREATOR_CREDITS: createFakeKV(),
    PREPARED_PROJECTIONS: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    CHUNK_POINTER_REGISTRY: createFakeKV(),
    CREDIT_OP_COORDINATOR: createFakeCreditCoordinatorBinding(),
  };
}

type Env = ReturnType<typeof buildEnv>;

function seedAuthority(env: Env) {
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    [LIFECYCLE_A, CAPSULE_A, PAYMENT_A],
    [LIFECYCLE_B, CAPSULE_B, PAYMENT_B],
  ];

  for (const [lifecycleId, capsuleId, paymentId] of pairs) {
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${IDENTITY_ID}:${lifecycleId}`,
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: IDENTITY_ID,
        capsuleId,
        lifecycleId,
      })
    );

    env.STORAGE_PAYMENTS.put(
      `storage-payment:${paymentId}`,
      JSON.stringify({
        storagePaymentId: paymentId,
        state: "PAYMENT_VERIFIED",
        transactionSignature: "S".repeat(88),
        payer: WALLET_ACCOUNT,
        quote: {
          storagePaymentId: paymentId,
          preparedProjectionId: "prep-1",
          creatorIdentityId: IDENTITY_ID,
          lifecycleId,
          capsuleId,
          expectedAmountAtomic: "1000000",
          irysDestination: IRYS_DESTINATION,
          tokenMint: TOKEN_MINT,
        },
      })
    );
  }
}

function stubNode() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(NODE_URL) && url.includes("/tx/")) {
        return new Response(JSON.stringify({ id: CONTAINER_TX }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    })
  );
}

/* ---------------- primitive-level helpers ---------------- */

const TX_KEY = `container-publication-tx:${CONTAINER_TX}`;

function claimKey(capsuleId: string): string {
  return `container-publication-claim:${capsuleId}`;
}

function coordinatorStorage(env: Env) {
  return env.CREDIT_OP_COORDINATOR.storages.get(
    CONTAINER_PUBLICATION_COORDINATOR_NAME
  );
}

function storedClaimKeys(env: Env): string[] {
  const storage = coordinatorStorage(env);
  if (!storage) return [];
  return [...storage.data.keys()].filter((key) =>
    key.startsWith("container-publication-claim:")
  );
}

function storedClaim(env: Env, capsuleId: string) {
  return coordinatorStorage(env)?.data.get(claimKey(capsuleId)) as
    | {
        capsuleId: string;
        lifecycleId: string;
        creatorIdentityId: string;
        containerTxId: string;
        layoutDigest: string;
        chunkIds: string[];
      }
    | undefined;
}

function storedTxBinding(env: Env) {
  return coordinatorStorage(env)?.data.get(TX_KEY) as
    | { capsuleId: string; lifecycleId: string }
    | undefined;
}

function primitiveInput(overrides: Record<string, unknown> = {}) {
  return {
    capsuleId: CAPSULE_A,
    lifecycleId: LIFECYCLE_A,
    creatorIdentityId: IDENTITY_ID,
    containerTxId: CONTAINER_TX,
    layoutDigest: DIGEST,
    chunkIds: [C1, C2, C3],
    ...overrides,
  };
}

/* ---------------- endpoint-level helpers ---------------- */

function containerBody(
  capsuleId: string,
  lifecycleId: string,
  storagePaymentId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    creatorIdentityId: IDENTITY_ID,
    lifecycleId,
    capsuleId,
    storagePaymentId,
    txId: CONTAINER_TX,
    kind: "container",
    chunkIds: [C1, C2, C3],
    layoutDigest: DIGEST,
    ...overrides,
  };
}

async function post(env: Env, body: Record<string, unknown>): Promise<Response> {
  const { onRequestPost } = await import("./../api/publication/claim");
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body,
  });
  return onRequestPost(makeEventContext({ request, env: env as never }));
}

/** Resolves responses into a stable { status, json } shape exactly once. */
async function settle(responses: Response[]) {
  return Promise.all(
    responses.map(async (response) => ({
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    }))
  );
}

function kvContainerRecord(env: Env, capsuleId: string): unknown {
  const raw = env.PUBLICATION_VERIFICATIONS.data.get(
    `container-publication:${capsuleId}`
  );
  return raw === undefined ? undefined : JSON.parse(raw);
}

describe("Stage 4.1 — container claim race safety (atomic primitive)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("1. concurrent same-tx claims, DIFFERENT capsules → one CLAIMED, one TX_ALREADY_CLAIMED", async () => {
    const env = buildEnv();

    const [a, b] = await Promise.all([
      claimContainerPublication(
        env,
        primitiveInput({ capsuleId: CAPSULE_A, lifecycleId: LIFECYCLE_A })
      ),
      claimContainerPublication(
        env,
        primitiveInput({ capsuleId: CAPSULE_B, lifecycleId: LIFECYCLE_B })
      ),
    ]);

    const results = [a, b];
    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);

    // A + C: exactly one may establish the claim; both never succeed.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]).toEqual({ ok: true, outcome: "CLAIMED" });

    // B: the other receives a DETERMINISTIC conflict.
    expect(losers[0]).toEqual({ ok: false, reason: "TX_ALREADY_CLAIMED" });

    // 4 + 5: exactly one authoritative claim record and one tx binding,
    // and the tx binding points at the winner.
    const claimKeys = storedClaimKeys(env);
    expect(claimKeys).toHaveLength(1);

    const winnerCapsuleId =
      claimKeys[0] === claimKey(CAPSULE_A) ? CAPSULE_A : CAPSULE_B;
    expect(storedTxBinding(env)).toEqual({
      capsuleId: winnerCapsuleId,
      lifecycleId:
        winnerCapsuleId === CAPSULE_A ? LIFECYCLE_A : LIFECYCLE_B,
    });
    expect(storedClaim(env, winnerCapsuleId)?.containerTxId).toBe(CONTAINER_TX);
  });

  it("2. concurrent conflicting claims, SAME capsule, same tx → one CLAIMED, one CONTAINER_ALREADY_PUBLISHED", async () => {
    const env = buildEnv();

    const [a, b] = await Promise.all([
      claimContainerPublication(env, primitiveInput()),
      claimContainerPublication(
        env,
        primitiveInput({ chunkIds: [C1, C2], layoutDigest: DIGEST_OTHER })
      ),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.ok === false)).toEqual([
      { ok: false, reason: "CONTAINER_ALREADY_PUBLISHED" },
    ]);

    // Exactly ONE stored record survives, and it is the winner's payload.
    expect(storedClaimKeys(env)).toEqual([claimKey(CAPSULE_A)]);
    const stored = storedClaim(env, CAPSULE_A)!;
    const winnerPayloads = [
      { chunkIds: [C1, C2, C3], layoutDigest: DIGEST },
      { chunkIds: [C1, C2], layoutDigest: DIGEST_OTHER },
    ];
    expect(winnerPayloads).toContainEqual({
      chunkIds: stored.chunkIds,
      layoutDigest: stored.layoutDigest,
    });

    // One tx binding, agreeing with the single record.
    expect(storedTxBinding(env)).toEqual({
      capsuleId: CAPSULE_A,
      lifecycleId: LIFECYCLE_A,
    });
  });

  it("3. concurrent EXACT replays → both resolve idempotently, exactly one record", async () => {
    const env = buildEnv();

    const [a, b] = await Promise.all([
      claimContainerPublication(env, primitiveInput()),
      claimContainerPublication(env, primitiveInput()),
    ]);

    // Both succeed, but only ONE is the establishing transition.
    expect([a, b].filter((r) => r.ok === true)).toHaveLength(2);
    expect([a, b].filter((r) => r.ok === true && r.outcome === "CLAIMED")).toHaveLength(1);
    expect(
      [a, b].filter((r) => r.ok === true && r.outcome === "ALREADY_CLAIMED")
    ).toHaveLength(1);

    // No duplicate / conflicting record may appear.
    expect(storedClaimKeys(env)).toEqual([claimKey(CAPSULE_A)]);
    expect(storedClaim(env, CAPSULE_A)).toEqual({
      capsuleId: CAPSULE_A,
      lifecycleId: LIFECYCLE_A,
      creatorIdentityId: IDENTITY_ID,
      containerTxId: CONTAINER_TX,
      layoutDigest: DIGEST,
      chunkIds: [C1, C2, C3],
    });
    expect(storedTxBinding(env)).toEqual({
      capsuleId: CAPSULE_A,
      lifecycleId: LIFECYCLE_A,
    });
  });

  it("4. after the race, a later replay is idempotent and a conflicting one still conflicts", async () => {
    const env = buildEnv();

    await Promise.all([
      claimContainerPublication(env, primitiveInput()),
      claimContainerPublication(env, primitiveInput()),
    ]);

    // D: exact replay of the winning claim remains idempotent.
    expect(await claimContainerPublication(env, primitiveInput())).toEqual({
      ok: true,
      outcome: "ALREADY_CLAIMED",
    });

    // Conflicting claim for the same capsule stays deterministic.
    expect(
      await claimContainerPublication(
        env,
        primitiveInput({ chunkIds: [C1, C2] })
      )
    ).toEqual({ ok: false, reason: "CONTAINER_ALREADY_PUBLISHED" });

    // E: cross-capsule txId reuse stays TX_ALREADY_CLAIMED.
    expect(
      await claimContainerPublication(
        env,
        primitiveInput({ capsuleId: CAPSULE_B, lifecycleId: LIFECYCLE_B })
      )
    ).toEqual({ ok: false, reason: "TX_ALREADY_CLAIMED" });

    expect(storedClaimKeys(env)).toEqual([claimKey(CAPSULE_A)]);
  });

  it("5. coordination unavailable → fails closed, no authority written", async () => {
    const env = buildEnv();

    // Binding absent.
    expect(
      await claimContainerPublication(
        { ...env, CREDIT_OP_COORDINATOR: undefined },
        primitiveInput()
      )
    ).toEqual({ ok: false, reason: "UNAVAILABLE" });

    // Binding present but the coordinator call throws.
    const throwingEnv = {
      ...env,
      CREDIT_OP_COORDINATOR: {
        idFromName: (name: string) => ({ id: name }),
        get: () => ({
          fetch: async () => {
            throw new Error("coordinator unavailable");
          },
        }),
      },
    };
    expect(
      await claimContainerPublication(throwingEnv, primitiveInput())
    ).toEqual({ ok: false, reason: "UNAVAILABLE" });

    expect(storedClaimKeys(env)).toHaveLength(0);
    expect(storedTxBinding(env)).toBeUndefined();
  });
});

describe("Stage 4.1 — container claim race safety (endpoint)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    stubNode();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("6. concurrent same-tx claims, different capsules → one 200, one 409 TX_ALREADY_CLAIMED", async () => {
    const env = buildEnv();
    seedAuthority(env);

    const settled = await settle(
      await Promise.all([
        post(env, containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A)),
        post(env, containerBody(CAPSULE_B, LIFECYCLE_B, PAYMENT_B)),
      ])
    );

    expect(settled.map((s) => s.status).sort()).toEqual([200, 409]);
    expect(
      settled.filter((s) => s.json.error === "TX_ALREADY_CLAIMED")
    ).toHaveLength(1);

    // Exactly one authoritative claim and one tx binding exist.
    expect(storedClaimKeys(env)).toHaveLength(1);
    const winnerCapsuleId = storedClaimKeys(env)[0] === claimKey(CAPSULE_A)
      ? CAPSULE_A
      : CAPSULE_B;
    expect(storedTxBinding(env)?.capsuleId).toBe(winnerCapsuleId);

    // The winner has a well-formed KV projection; the loser has NONE.
    const loserCapsuleId =
      winnerCapsuleId === CAPSULE_A ? CAPSULE_B : CAPSULE_A;
    const winnerRecord = kvContainerRecord(env, winnerCapsuleId) as Record<string, unknown>;
    expect(winnerRecord.kind).toBe("container");
    expect(winnerRecord.containerTxId).toBe(CONTAINER_TX);
    expect(winnerRecord.chunkIds).toEqual([C1, C2, C3]);
    expect(kvContainerRecord(env, loserCapsuleId)).toBeUndefined();

    // Exactly one tx index entry, pointing at the winner.
    expect(env.PUBLICATION_VERIFICATIONS.data.get(`publication-tx:${CONTAINER_TX}`)).toBeDefined();
    const txIndex = JSON.parse(
      env.PUBLICATION_VERIFICATIONS.data.get(`publication-tx:${CONTAINER_TX}`)!
    ) as Record<string, unknown>;
    expect(txIndex.capsuleId).toBe(winnerCapsuleId);
  });

  it("7. concurrent conflicting claims, SAME capsule → one 200, one 409 CONTAINER_ALREADY_PUBLISHED", async () => {
    const env = buildEnv();
    seedAuthority(env);

    const settled = await settle(
      await Promise.all([
        post(env, containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A)),
        post(
          env,
          containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A, {
            chunkIds: [C1, C2],
            layoutDigest: DIGEST_OTHER,
          })
        ),
      ])
    );

    expect(settled.map((s) => s.status).sort()).toEqual([200, 409]);
    expect(
      settled.filter((s) => s.json.error === "CONTAINER_ALREADY_PUBLISHED")
    ).toHaveLength(1);

    // Exactly one stored claim and exactly one KV projection for the capsule.
    expect(storedClaimKeys(env)).toEqual([claimKey(CAPSULE_A)]);
    const record = kvContainerRecord(env, CAPSULE_A) as Record<string, unknown>;
    expect(record.containerTxId).toBe(CONTAINER_TX);

    // The projection must equal the authoritative record (no divergence).
    const authoritative = storedClaim(env, CAPSULE_A)!;
    expect(record.chunkIds).toEqual(authoritative.chunkIds);
    expect(record.layoutDigest).toBe(authoritative.layoutDigest);
  });

  it("8. concurrent exact replays → both 200, exactly one stored record, no duplicate", async () => {
    const env = buildEnv();
    seedAuthority(env);

    const settled = await settle(
      await Promise.all([
        post(env, containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A)),
        post(env, containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A)),
      ])
    );

    expect(settled.map((s) => s.status)).toEqual([200, 200]);
    for (const s of settled) {
      expect(s.json.claimed).toBe(true);
      expect(s.json.state).toBe("PENDING");
    }

    // Exactly ONE authoritative record, ONE tx binding, ONE KV projection.
    expect(storedClaimKeys(env)).toEqual([claimKey(CAPSULE_A)]);
    expect(
      [...env.PUBLICATION_VERIFICATIONS.data.keys()].filter((k) =>
        k.startsWith("container-publication:")
      )
    ).toEqual([`container-publication:${CAPSULE_A}`]);
    expect(
      [...env.PUBLICATION_VERIFICATIONS.data.keys()].filter((k) =>
        k.startsWith(`publication-tx:`)
      )
    ).toEqual([`publication-tx:${CONTAINER_TX}`]);
  });

  it("9. no partial container publication is ever returned as success", async () => {
    const env = buildEnv();
    seedAuthority(env);

    const settled = await settle(
      await Promise.all([
        post(env, containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A)),
        post(env, containerBody(CAPSULE_B, LIFECYCLE_B, PAYMENT_B)),
        post(env, containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A, { chunkIds: [C3] })),
      ])
    );

    for (const s of settled) {
      const capsuleId = s.json.capsuleId as string | undefined;

      if (s.status === 200) {
        // A success response implies the authoritative claim AND a complete,
        // well-formed projection exist for that capsule.
        expect(typeof capsuleId).toBe("string");
        const stored = storedClaim(env, capsuleId!);
        expect(stored).toBeDefined();

        const record = kvContainerRecord(env, capsuleId!) as Record<string, unknown>;
        expect(record).toBeDefined();
        expect(record.kind).toBe("container");
        expect(record.state).toBe("PENDING");
        expect(record.containerTxId).toBe(stored!.containerTxId);
        expect(record.chunkIds).toEqual(stored!.chunkIds);
        expect(record.layoutDigest).toBe(stored!.layoutDigest);
        expect((record.chunkIds as string[]).length).toBeGreaterThan(0);
      } else {
        // A failure must never have written authority for its capsule.
        if (capsuleId) {
          const isWinner = storedClaim(env, capsuleId) !== undefined;
          if (!isWinner) {
            expect(kvContainerRecord(env, capsuleId)).toBeUndefined();
          }
        }
      }
    }

    // At the end of the race: exactly one claim, one binding, one projection.
    expect(storedClaimKeys(env)).toHaveLength(1);
    expect(storedTxBinding(env)).toBeDefined();
    expect(
      [...env.PUBLICATION_VERIFICATIONS.data.keys()].filter((k) =>
        k.startsWith("container-publication:")
      )
    ).toHaveLength(1);
  });

  it("10. missing coordinator binding → endpoint fails closed, writes no authority", async () => {
    const env = buildEnv();
    seedAuthority(env);
    const envWithoutCoordinator = {
      ...env,
      CREDIT_OP_COORDINATOR: undefined,
    };

    const res = await post(
      envWithoutCoordinator as Env,
      containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A)
    );

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("CONTAINER_CLAIM_UNAVAILABLE");
    expect(kvContainerRecord(env, CAPSULE_A)).toBeUndefined();
    expect(env.PUBLICATION_VERIFICATIONS.data.get(`publication-tx:${CONTAINER_TX}`)).toBeUndefined();
    expect(storedClaimKeys(env)).toHaveLength(0);
  });

  it("11. coordinator unavailable → endpoint fails closed, writes no authority", async () => {
    const env = buildEnv();
    seedAuthority(env);
    const envWithThrowingCoordinator = {
      ...env,
      CREDIT_OP_COORDINATOR: {
        idFromName: (name: string) => ({ id: name }),
        get: () => ({
          fetch: async () => {
            throw new Error("coordinator unavailable");
          },
        }),
      },
    };

    const res = await post(
      envWithThrowingCoordinator as unknown as Env,
      containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A)
    );

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("CONTAINER_CLAIM_UNAVAILABLE");
    expect(kvContainerRecord(env, CAPSULE_A)).toBeUndefined();
    expect(env.PUBLICATION_VERIFICATIONS.data.get(`publication-tx:${CONTAINER_TX}`)).toBeUndefined();
    expect(storedClaimKeys(env)).toHaveLength(0);
  });

  it("12. a container claim never writes N per-chunk pointers or a vault record", async () => {
    const env = buildEnv();
    seedAuthority(env);

    const res = await post(env, containerBody(CAPSULE_A, LIFECYCLE_A, PAYMENT_A));
    expect(res.status).toBe(200);

    for (const chunkId of [C1, C2, C3]) {
      expect(
        env.CHUNK_POINTER_REGISTRY.data.get(
          `chunk-pointer-entry:${CAPSULE_A}:${chunkId}`
        )
      ).toBeUndefined();
    }
    expect(
      env.PUBLICATION_VERIFICATIONS.data.get(`creator:publication:${LIFECYCLE_A}`)
    ).toBeUndefined();
  });
});
