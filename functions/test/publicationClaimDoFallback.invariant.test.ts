/**
 * R9-A92 F1 — publication claim authoritative Durable Object fallback.
 *
 * THE PRODUCTION DEFECT THIS PINS (R9-A91 / R9-A91.1)
 * ---------------------------------------------------
 * `reserve-lifecycle` returned 200, `upload-token` verified the same
 * lifecycle through the Durable Object, and `POST /api/publication/claim`
 * returned 409 LIFECYCLE_NOT_RESERVED — the KV lifecycle projection
 * (an eventually-consistent projection, negative lookups cached) was
 * null at the claim's edge while the DO held the reservation.
 *
 * THE FIX UNDER TEST
 * ------------------
 * When the KV lifecycle lookup returns null AND the request carries a
 * `creatorCreditId` ADDRESS, the claim consults the EXISTING `op:"read"`
 * coordinator operation and proceeds only when the authoritative record
 * independently confirms this exact reservation (CONSUMING + same
 * identity/capsule/lifecycle). Every failure shape fails closed with
 * the SAME codes the KV path produces. The KV-present path is unchanged.
 *
 * The stale KV double below reproduces the observed Cloudflare failure
 * mode deterministically: a negative lookup stays cached even after a
 * later write, so every write-immediately-visible Map assertion gap is
 * closed here. The coordinator is the REAL CreditOperationCoordinator
 * over in-memory storage with a serialized input gate — not a stub.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
  type FakeKV,
} from "./harness";
import { CONTAINER_PUBLICATION_COORDINATOR_NAME } from "../lib/containerPublicationClaim";

const ORIGIN = "https://aeternacapsule.com";
const NODE_URL = "https://uploader.irys.xyz";
const NOW = 1_800_000_000_000;

const IDENTITY_ID = "f".repeat(32);
const OTHER_IDENTITY_ID = "e".repeat(32);
const WALLET_ACCOUNT = "B".repeat(44);
const LIFECYCLE_ID = "lifecycle-1";
const CAPSULE_ID = "a".repeat(64);
const STORAGE_PAYMENT_ID = "storage-pay-1";
const CHUNK_TX = "C".repeat(43);
const OTHER_TX = "D".repeat(43);
const CHUNK_ID = "c".repeat(64);
const LAYOUT_DIGEST = "9".repeat(64);
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const IRYS_DESTINATION = "IrysDestinationAccount333333333333333333333";
const CREDIT_ID = "credit-1";

/**
 * Deterministic stale-negative KV double: the FIRST read of an absent
 * key is cached as a miss and keeps answering null even after a later
 * write — exactly the Cloudflare behaviour that produced the incident.
 * `expireNegativeCache()` models the cache window elapsing.
 */
function createStaleNegativeKV() {
  const inner: FakeKV = createFakeKV();
  const negativeCache = new Set<string>();

  const kv = {
    async get(key: string) {
      if (negativeCache.has(key)) return null;
      const value = await inner.get(key);
      if (value === null) negativeCache.add(key);
      return value;
    },
    put(key: string, value: string, options?: { expirationTtl?: number }) {
      // A write does NOT invalidate the cached negative entry.
      return inner.put(key, value, options);
    },
    delete(key: string) {
      return inner.delete(key);
    },
    list(options: { prefix?: string }) {
      return inner.list(options);
    },
    expireNegativeCache() {
      negativeCache.clear();
    },
    data: inner.data,
  };

  return kv;
}

type StaleKV = ReturnType<typeof createStaleNegativeKV>;

let nodeStatus = 200;
let nodeBody: Record<string, unknown> = { id: CHUNK_TX };

function stubNode() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(NODE_URL) && url.includes("/tx/")) {
        if (nodeStatus === 200) {
          return new Response(JSON.stringify(nodeBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("node", { status: nodeStatus });
      }
      return new Response("unexpected", { status: 500 });
    })
  );
}

interface BuildOptions {
  kv?: StaleKV;
  withCoordinator?: boolean;
  coordinatorFetch?: (request: Request) => Promise<Response>;
}

function buildEnv(options: BuildOptions = {}) {
  const kv = options.kv ?? createStaleNegativeKV();
  const env: Record<string, unknown> = {
    CREATOR_CREDITS: kv,
    PREPARED_PROJECTIONS: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
  };
  if (options.withCoordinator !== false) {
    env.CREDIT_OP_COORDINATOR =
      options.coordinatorFetch !== undefined
        ? {
            idFromName(name: string) {
              return { id: name };
            },
            get(target: { id: string }) {
              return {
                fetch: (request: Request) => options.coordinatorFetch!(request),
              };
            },
          }
        : createFakeCreditCoordinatorBinding({ creatorCredits: kv as unknown as FakeKV });
  }
  return { env, kv };
}

/** Seeds the PAYMENT_VERIFIED storage payment bound to this attempt. */
function seedVerifiedPayment(env: Record<string, unknown>) {
  (env.STORAGE_PAYMENTS as FakeKV).put(
    `storage-payment:${STORAGE_PAYMENT_ID}`,
    JSON.stringify({
      storagePaymentId: STORAGE_PAYMENT_ID,
      state: "PAYMENT_VERIFIED",
      transactionSignature: "S".repeat(88),
      payer: WALLET_ACCOUNT,
      quote: {
        storagePaymentId: STORAGE_PAYMENT_ID,
        preparedProjectionId: "prep-1",
        creatorIdentityId: IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
        expectedAmountAtomic: "312",
        irysDestination: IRYS_DESTINATION,
        tokenMint: TOKEN_MINT,
      },
    })
  );
}

/**
 * Reproduces the incident's reservation timeline against the REAL DO:
 * a pre-reserve read seeds the negative cache, then the coordinator's
 * own `reserve` writes the authoritative record AND the (invisible)
 * KV projection.
 */
async function reserveThroughCoordinator(
  binding: ReturnType<typeof createFakeCreditCoordinatorBinding>,
  kv: StaleKV,
  overrides: {
    creatorIdentityId?: string;
    lifecycleId?: string;
    capsuleId?: string;
    creatorCreditId?: string;
  } = {}
) {
  // The negative-cache seed — reserve-lifecycle.ts:174 reads this exact
  // key (and expects null) BEFORE the DO writes the reservation.
  await kv.get(
    `creator:credit:lifecycle:${overrides.creatorIdentityId ?? IDENTITY_ID}:${overrides.lifecycleId ?? LIFECYCLE_ID}`
  );

  const response = await binding
    .get(binding.idFromName(overrides.creatorCreditId ?? CREDIT_ID))
    .fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "reserve",
          creatorCreditId: overrides.creatorCreditId ?? CREDIT_ID,
          creatorIdentityId: overrides.creatorIdentityId ?? IDENTITY_ID,
          lifecycleId: overrides.lifecycleId ?? LIFECYCLE_ID,
          capsuleId: overrides.capsuleId ?? CAPSULE_ID,
          paymentIntentId: null,
        }),
      })
    );

  return response;
}

/** Reserved for the pre-reserve negative read; assigned by the test env. */
let staleKvRef: StaleKV | null = null;

async function claim(
  env: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  const { onRequestPost } = await import("./../api/publication/claim");
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: {
      creatorIdentityId: IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      storagePaymentId: STORAGE_PAYMENT_ID,
      txId: CHUNK_TX,
      kind: "container",
      chunkIds: [CHUNK_ID],
      layoutDigest: LAYOUT_DIGEST,
      creatorCreditId: CREDIT_ID,
      ...overrides,
    },
  });
  return onRequestPost(makeEventContext({ request, env: env as never }));
}

describe("R9-A92 F1 — publication claim authoritative DO fallback", () => {
  beforeEach(() => {
    nodeStatus = 200;
    nodeBody = { id: CHUNK_TX };
    staleKvRef = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    stubNode();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("1. KV projection present: the original successful path is unchanged", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    await reserveThroughCoordinator(
      env.CREDIT_OP_COORDINATOR as ReturnType<typeof createFakeCreditCoordinatorBinding>,
      kv
    );
    kv.expireNegativeCache(); // projection visible again — the classic path

    const res = await claim(env);
    expect(res.status, JSON.stringify(await res.clone().json().catch(() => null))).toBe(200);

    const body = (await res.json()) as { ok?: boolean; claimed?: boolean };
    expect(body.ok).toBe(true);
    expect(body.claimed).toBe(true);
  });

  it("2. KV null, DO confirms the exact reservation: the legitimate claim SUCCEEDS", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv);

    // The projection exists in KV storage but the cached negative entry
    // still answers null — the exact incident state.
    expect(await kv.get(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`)).toBeNull();
    expect(kv.data.has(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`)).toBe(true);

    const res = await claim(env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok?: boolean;
      claimed?: boolean;
      state?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.claimed).toBe(true);

    // The claim's authority records were written exactly as on the KV path.
    const containerRecord = JSON.parse(
      (await (env.PUBLICATION_VERIFICATIONS as FakeKV).get(
        `container-publication:${CAPSULE_ID}`
      ))!
    );
    expect(containerRecord.containerTxId).toBe(CHUNK_TX);
    expect(containerRecord.state).toBe("PENDING");
  });

  it("2b. the DO fallback creates and reserves NOTHING (read-only)", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv);
    const creditKey = `credit:${CREDIT_ID}`;
    const snapshot = () =>
      JSON.stringify(
        Object.fromEntries(
          [...binding.storages.get(CREDIT_ID)!.data.entries()].sort(
            (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
          )
        )
      );
    const storageBefore = snapshot();

    await claim(env);

    const storageAfter = snapshot();
    // The container claim itself is expected to write its claim records;
    // what must NOT change is the CREDIT record (status/revision).
    const keysAfter = Object.keys(JSON.parse(storageAfter)).sort();
    if (!keysAfter.includes(creditKey)) {
      throw new Error(
        `credit record missing after claim; DO keys after: [${keysAfter.join(",")}]`
      );
    }
    const before = JSON.parse(storageBefore)[creditKey];
    const after = JSON.parse(storageAfter)[creditKey];
    expect(after).toEqual(before);
    expect(after.status).toBe("CONSUMING");
    expect(after.lifecycleId).toBe(LIFECYCLE_ID);
  });

  it("3. KV null, DO has no such credit: reject LIFECYCLE_NOT_RESERVED", async () => {
    const { env } = buildEnv();
    seedVerifiedPayment(env);

    const res = await claim(env, { creatorCreditId: "credit-missing" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "LIFECYCLE_NOT_RESERVED"
    );
  });

  it("4. KV null, DO reservation bound to a DIFFERENT lifecycle: reject", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv, { lifecycleId: "lifecycle-OTHER" });

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "LIFECYCLE_NOT_RESERVED"
    );
  });

  it("5. KV null, DO reservation bound to a DIFFERENT capsule: reject CAPSULE_MISMATCH", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv, { capsuleId: "b".repeat(64) });

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "CAPSULE_MISMATCH"
    );
  });

  it("6. KV null, DO record owned by a DIFFERENT creator identity: reject IDENTITY_MISMATCH", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv, {
      creatorIdentityId: OTHER_IDENTITY_ID,
    });

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "IDENTITY_MISMATCH"
    );
  });

  it("7. KV null, request addresses ANOTHER creator's credit: reject IDENTITY_MISMATCH", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    // Someone else's credit, addressed by id — its identity cannot match.
    await reserveThroughCoordinator(binding, kv, {
      creatorIdentityId: OTHER_IDENTITY_ID,
      creatorCreditId: "credit-other",
    });

    const res = await claim(env, { creatorCreditId: "credit-other" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "IDENTITY_MISMATCH"
    );
  });

  it("7b. R9-A92.1 — a FOREIGN credit never discloses its state (identity compared first)", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    // Another creator's credit, in the AVAILABLE state. With the state
    // check first this answered CREDIT_NOT_CONSUMING — a state-disclosure
    // oracle. Identity is now compared BEFORE any state is revealed.
    binding.get(binding.idFromName("credit-other"));
    binding.storages.get("credit-other")!.data.set("credit:credit-other", {
      id: "credit-other",
      creatorIdentityId: OTHER_IDENTITY_ID,
      status: "AVAILABLE",
      capsuleId: "",
      lifecycleId: null,
      revision: 1,
      updatedAt: 1,
    });

    const res = await claim(env, { creatorCreditId: "credit-other" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "IDENTITY_MISMATCH"
    );
  });

  it("8. KV null, DO credit not consumable (AVAILABLE): reject CREDIT_NOT_CONSUMING", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    // Direct authoritative seed: an AVAILABLE credit, never reserved.
    binding.get(binding.idFromName(CREDIT_ID));
    binding.storages.get(CREDIT_ID)!.data.set(`credit:${CREDIT_ID}`, {
      id: CREDIT_ID,
      creatorIdentityId: IDENTITY_ID,
      status: "AVAILABLE",
      capsuleId: CAPSULE_ID,
      lifecycleId: null,
      revision: 1,
      updatedAt: 1,
    });

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "CREDIT_NOT_CONSUMING"
    );
  });

  it("9. KV null and NO coordinator binding: fail closed 503", async () => {
    const { env } = buildEnv({ withCoordinator: false });
    seedVerifiedPayment(env);

    const res = await claim(env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "CREDIT_COORDINATOR_UNAVAILABLE"
    );
  });

  it("9b. KV null and the DO transport throws: fail closed 503", async () => {
    const { env } = buildEnv({
      coordinatorFetch: async () => {
        throw new Error("connection reset");
      },
    });
    seedVerifiedPayment(env);

    const res = await claim(env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "CREDIT_COORDINATOR_UNAVAILABLE"
    );
  });

  it("10. KV null and the DO answers an UNVERIFIABLE body: fail closed", async () => {
    const { env } = buildEnv({
      coordinatorFetch: async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    seedVerifiedPayment(env);

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "LIFECYCLE_NOT_RESERVED"
    );
  });

  it("10b. KV null and the DO answers ok:false: fail closed", async () => {
    const { env } = buildEnv({
      coordinatorFetch: async () =>
        new Response(JSON.stringify({ ok: false, outcome: "NOT_FOUND" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    seedVerifiedPayment(env);

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "LIFECYCLE_NOT_RESERVED"
    );
  });

  it("11. already-published behavior is unchanged through the fallback (byte-equal replay → 200)", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv);

    const first = await claim(env);
    expect(first.status).toBe(200);
    const second = await claim(env);
    expect(second.status).toBe(200);
  });

  it("12. a DIFFERENT container transaction for the same capsule remains rejected (CONTAINER_ALREADY_PUBLISHED)", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv);

    expect((await claim(env)).status).toBe(200);

    // The second attempt publishes a DIFFERENT DataItem: the node confirms
    // THAT tx before the container authority refuses it.
    nodeBody = { id: OTHER_TX };
    const conflicting = await claim(env, { txId: OTHER_TX });
    const conflictBody = (await conflicting.json()) as { error?: string };
    expect(conflicting.status).toBe(409);
    expect(conflictBody.error).toBe("CONTAINER_ALREADY_PUBLISHED");
  });

  it("13. the same txId with a DIFFERENT layout digest remains rejected", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv);

    expect((await claim(env)).status).toBe(200);

    const conflicting = await claim(env, {
      layoutDigest: "8".repeat(64),
    });
    const digestConflictBody = (await conflicting.json()) as { error?: string };
    expect(conflicting.status).toBe(409);
    expect(digestConflictBody.error).toBe("CONTAINER_ALREADY_PUBLISHED");
  });

  it("14. claim idempotency survives the fallback: the KV window closing changes nothing", async () => {
    const { env, kv } = buildEnv();
    seedVerifiedPayment(env);
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    await reserveThroughCoordinator(binding, kv);

    expect((await claim(env)).status).toBe(200);

    kv.expireNegativeCache(); // projection becomes visible
    const replay = await claim(env);
    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { ok?: boolean; claimed?: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("R9-A92 F1 — idempotent reserve replay is READ-ONLY (R9-A92.1)", () => {
  beforeEach(() => {
    staleKvRef = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function reserveRequest(overrides: Record<string, unknown> = {}): Request {
    return new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "reserve",
        creatorCreditId: CREDIT_ID,
        creatorIdentityId: IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
        paymentIntentId: null,
        ...overrides,
      }),
    });
  }

  it("R1. only the FIRST reserve writes the projection; a replay never re-projects", async () => {
    const { env, kv } = buildEnv();
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    const instance = binding.get(binding.idFromName(CREDIT_ID));

    await instance.fetch(reserveRequest());
    kv.expireNegativeCache();
    // The normal initial reservation still writes the projection.
    const first = JSON.parse(
      (await kv.get(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`))!
    );
    expect(first.status).toBe("CONSUMING");
    expect(first.capsuleId).toBe(CAPSULE_ID);
    expect(first.id).toBe(CREDIT_ID);

    // Simulate a projection that is not readable (lost / never visible).
    kv.data.delete(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`);
    kv.expireNegativeCache();
    expect(
      await kv.get(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`)
    ).toBeNull();

    const replay = await instance.fetch(reserveRequest());
    expect(replay.status).toBe(200);

    // R9-A92.1 — the replay performs NO KV write, so it cannot resurrect
    // an index the authoritative state may have moved on from.
    kv.expireNegativeCache();
    expect(
      await kv.get(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`)
    ).toBeNull();
  });

  it("R2. a replay after the credit moved on (CONSUMED) does NOT resurrect the projection", async () => {
    const { env, kv } = buildEnv();
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    const instance = binding.get(binding.idFromName(CREDIT_ID));

    await instance.fetch(reserveRequest());
    kv.data.delete(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`);

    // The credit moved on: it is now CONSUMED (authoritative state,
    // written the same way the coordinator itself writes it).
    const consumedRecord = binding.storages.get(CREDIT_ID)!.data.get(
      `credit:${CREDIT_ID}`
    ) as { status: string };
    consumedRecord.status = "CONSUMED";

    await instance.fetch(reserveRequest());

    kv.expireNegativeCache();
    expect(
      await kv.get(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`)
    ).toBeNull();
  });

  it("R3. a replay whose record no longer matches the request does NOT rewrite it", async () => {
    const { env, kv } = buildEnv();
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    const instance = binding.get(binding.idFromName(CREDIT_ID));

    await instance.fetch(reserveRequest());
    kv.data.delete(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`);

    // The binding moved to another capsule (post-recovery rebind shape).
    const record = binding.storages.get(CREDIT_ID)!.data.get(
      `credit:${CREDIT_ID}`
    ) as { capsuleId: string };
    record.capsuleId = "b".repeat(64);

    await instance.fetch(reserveRequest());

    kv.expireNegativeCache();
    expect(
      await kv.get(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`)
    ).toBeNull();
  });

  it("R4. a replay after RECOVER (AVAILABLE, lifecycle cleared) writes no projection", async () => {
    const { env, kv } = buildEnv();
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    staleKvRef = kv;
    const instance = binding.get(binding.idFromName(CREDIT_ID));

    await instance.fetch(reserveRequest());
    kv.data.delete(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`);

    // ABORT_AND_RESTORE_AVAILABLE shape: the right is AVAILABLE again and
    // the lifecycle/capsule binding is cleared (and its index deleted).
    const record = binding.storages.get(CREDIT_ID)!.data.get(
      `credit:${CREDIT_ID}`
    ) as { status: string; lifecycleId: string | null; capsuleId: string };
    record.status = "AVAILABLE";
    record.lifecycleId = null;
    record.capsuleId = "";

    const replay = await instance.fetch(reserveRequest());
    expect(replay.status).toBe(200);

    kv.expireNegativeCache();
    expect(
      await kv.get(`creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`)
    ).toBeNull();
  });
});

/**
 * Guards the wiring the fallback depends on: the claim must target the
 * SAME coordinator name the container-claim authority owns.
 */
describe("R9-A92 F1 — coordinator wiring invariants", () => {
  it("the container claim instance name is unchanged", () => {
    expect(CONTAINER_PUBLICATION_COORDINATOR_NAME).toBe(
      "aeterna:container-publication:v1"
    );
  });
});
