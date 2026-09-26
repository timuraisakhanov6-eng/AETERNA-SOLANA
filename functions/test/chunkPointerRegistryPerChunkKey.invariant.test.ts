/**
 * AETERNA — Chunk Pointer Registry: per-chunk key model (C=2 prerequisite).
 *
 * The Registry previously persisted the WHOLE capsule map under ONE KV
 * key (`chunk-pointer-registry:<capsuleId>`) and updated it with a
 * read-modify-write. Under concurrent chunk claims that is a proven
 * lost-update race: both claims read the same blob, each mutates a
 * private copy, and the second `put` silently drops the first
 * pointer. KV has no CAS and no transactions.
 *
 * The registry prerequisite replaces the shared blob with ONE KV key
 * PER CHUNK:
 *
 *   chunk-pointer-entry:<capsuleId>:<chunkId>
 *
 * Concurrent claims for DIFFERENT chunkIds then write DIFFERENT keys
 * and cannot lose each other. These tests prove:
 *
 *   A. concurrent claims for two different chunks → both survive
 *      (with a forced interleave that the OLD shared-key model would
 *      fail — demonstrated against a faithful reimplementation of the
 *      old algorithm in the same file);
 *   B. same chunkId + same txId → idempotent 200;
 *   C. same chunkId + different txId → 409 CHUNK_ALREADY_BOUND;
 *   D. same txId + different chunkId → 409 TX_ALREADY_CLAIMED
 *      (mechanism unchanged: `publication-tx:<txId>` index);
 *   E. cross-capsule isolation → no leakage in either direction;
 *   F. read path with >1000 entries → pagination returns every entry;
 *   G. simulated `list` propagation lag → bounded retry succeeds;
 *   H. malformed / unreadable entry → fail closed (existing semantics);
 *   I. no shared capsule-level registry key is ever written.
 *
 * This file does NOT cover the C=2 client upload path (not
 * implemented yet) and does NOT touch `uploadPreparedChunks.ts`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";

import {
  chunkPointerEntryKey,
  chunkPointerEntryPrefix,
  getChunkPointerEntry,
  getChunkPointerMap,
  putChunkPointerEntry,
} from "../lib/storage/chunkPointerRegistryStore";

const ORIGIN = "https://aeternacapsule.com";
const NODE_URL = "https://uploader.irys.xyz";
const LEGACY_NODE_URL = "https://node1.irys.xyz";
const NOW = 1_800_000_000_000;

const IDENTITY_ID = "f".repeat(32);
const WALLET_ACCOUNT = "B".repeat(44);
const LIFECYCLE_ID = "lifecycle-1";
const CAPSULE_ID = "a".repeat(64);
const OTHER_CAPSULE_ID = "d".repeat(64);
const STORAGE_PAYMENT_ID = "storage-pay-1";
const CHUNK_ID = "c".repeat(64);
const CHUNK_TX = "C".repeat(43);
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const IRYS_DESTINATION = "IrysDestinationAccount333333333333333333333";

const POINTER_A = "A".repeat(43);
const POINTER_B = "B".repeat(43);

/**
 * Must mirror `REGISTRY_READ_RETRY_DELAY_MS` in the read endpoint. The
 * endpoint's retry budget is deliberately tiny and finite (3 attempts,
 * 100 ms apart); the tests advance fake timers by a comfortable
 * multiple so they do not depend on the exact value.
 */
const REGISTRY_READ_RETRY_DELAY_MS = 100;
const REGISTRY_READ_MAX_ATTEMPTS = 3;

function chunkId(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/* ================= FIXTURES ================= */

function buildEnv() {
  return {
    CREATOR_CREDITS: createFakeKV(),
    PREPARED_PROJECTIONS: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    CHUNK_POINTER_REGISTRY: createFakeKV(),
  };
}

function seedReservedLifecycle(
  env: ReturnType<typeof buildEnv>,
  capsuleId = CAPSULE_ID
) {
  env.CREATOR_CREDITS.put(
    `creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`,
    JSON.stringify({
      id: "credit-1",
      status: "CONSUMING",
      creatorIdentityId: IDENTITY_ID,
      capsuleId,
      lifecycleId: LIFECYCLE_ID,
    })
  );
}

function seedVerifiedPayment(
  env: ReturnType<typeof buildEnv>,
  capsuleId = CAPSULE_ID
) {
  env.STORAGE_PAYMENTS.put(
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
        capsuleId,
        expectedAmountAtomic: "1000000",
        irysDestination: IRYS_DESTINATION,
        tokenMint: TOKEN_MINT,
      },
    })
  );
}

function stubNode() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(LEGACY_NODE_URL)) {
        // Legacy Arweave bundler: never a valid active rail.
        return new Response("unexpected legacy bundler", { status: 500 });
      }
      if (url.startsWith(NODE_URL) && url.includes("/tx/")) {
        const txId = url.split("/tx/")[1];
        return new Response(JSON.stringify({ id: txId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    })
  );
}

async function claim(
  env: ReturnType<typeof buildEnv>,
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
      kind: "chunk",
      chunkId: CHUNK_ID,
      txId: CHUNK_TX,
      ...overrides,
    },
  });
  return onRequestPost(makeEventContext({ request, env: env as never }));
}

/**
 * Build an EventContext for the read endpoint. `makeEventContext` only
 * forwards `request`/`env`, so `params.capsuleId` is added explicitly —
 * the endpoint resolves the capsule from the route param.
 */
function readContext(
  env: ReturnType<typeof buildEnv>,
  capsuleId: string = CAPSULE_ID
) {
  const request = createFakeRequest({ headers: { origin: ORIGIN } });
  return {
    ...makeEventContext({ request, env: env as never }),
    params: { capsuleId },
  } as never;
}

/**
 * Faithful reimplementation of the OLD shared-key read-modify-write
 * algorithm, used ONLY to prove the interleaving below actually
 * destroys a pointer under that model. It is not production code and
 * is never imported by production.
 */
async function legacySharedKeyClaim(
  kv: ReturnType<typeof createFakeKV>,
  capsuleId: string,
  chunkIdValue: string,
  txIdValue: string
) {
  const key = `chunk-pointer-registry:${capsuleId}`;
  const raw = await kv.get(key);
  const map: Record<string, string> =
    raw === null || raw === undefined ? {} : JSON.parse(raw);
  map[chunkIdValue] = txIdValue;
  await kv.put(key, JSON.stringify(map));
  return map;
}

describe("Chunk Pointer Registry — per-chunk key model", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /* ============== A. LOST-UPDATE IS GONE ============== */

  it("A. concurrent claims for two different chunks → both entries survive", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const chunk1 = chunkId(1);
    const chunk2 = chunkId(2);
    const tx1 = "1".repeat(43);
    const tx2 = "2".repeat(43);

    // Force the SAME interleaving that destroys the shared-key model:
    // both handlers must complete their read before either writes.
    const kv = env.CHUNK_POINTER_REGISTRY;
    const realGet = kv.get.bind(kv);
    let reads = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    kv.get = async (key: string) => {
      const value = await realGet(key);
      if (key.startsWith("chunk-pointer-entry:")) {
        reads += 1;
        if (reads === 2) releaseGate!();
        await gate;
      }
      return value;
    };

    const [res1, res2] = await Promise.all([
      claim(env, { chunkId: chunk1, txId: tx1 }),
      claim(env, { chunkId: chunk2, txId: tx2 }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    kv.get = realGet;

    // Both pointers must be present. Under the old shared-key model
    // this assertion fails: the second `put` overwrites the first map.
    const map = await getChunkPointerMap(env as never, CAPSULE_ID);
    expect(map[chunk1]).toBe(tx1);
    expect(map[chunk2]).toBe(tx2);
  });

  it("A2. control: the interleave above DOES lose an update under the old shared-key model", async () => {
    const kv = createFakeKV();

    // Same interleaving, applied to a faithful copy of the OLD
    // algorithm: both read the same (empty) blob before either writes.
    const realGet = kv.get.bind(kv);
    let reads = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    kv.get = async (key: string) => {
      const value = await realGet(key);
      if (key.startsWith("chunk-pointer-registry:")) {
        reads += 1;
        if (reads === 2) releaseGate!();
        await gate;
      }
      return value;
    };

    await Promise.all([
      legacySharedKeyClaim(kv, CAPSULE_ID, chunkId(1), "1".repeat(43)),
      legacySharedKeyClaim(kv, CAPSULE_ID, chunkId(2), "2".repeat(43)),
    ]);

    const raw = await realGet(`chunk-pointer-registry:${CAPSULE_ID}`);
    const legacyMap = JSON.parse(raw!) as Record<string, string>;

    // PROOF: exactly ONE pointer survived. This is the lost update the
    // per-chunk model eliminates.
    expect(Object.keys(legacyMap)).toHaveLength(1);
  });

  /* ============== B. IDEMPOTENCY ============== */

  it("B. same chunkId + same txId → idempotent 200", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const first = await claim(env);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.chunkId).toBe(CHUNK_ID);
    expect(firstBody.txId).toBe(CHUNK_TX);

    // Replay. The tx-index gate runs BEFORE the chunk branch, so a
    // same-tx replay short-circuits with the canonical idempotent
    // response shape; either way it must be 200 and must not error.
    const second = await claim(env);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.ok).toBe(true);
    expect(body.claimed ?? true).toBeTruthy();

    // The pointer is unchanged — no substitution on replay.
    expect(
      await env.CHUNK_POINTER_REGISTRY.get(
        chunkPointerEntryKey(CAPSULE_ID, CHUNK_ID)
      )
    ).toBe(CHUNK_TX);
  });

  /* ============== C. CHUNK_ALREADY_BOUND ============== */

  it("C. same chunkId + different txId → 409 CHUNK_ALREADY_BOUND", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const first = await claim(env);
    expect(first.status).toBe(200);

    const otherTx = "9".repeat(43);
    const second = await claim(env, { txId: otherTx });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("CHUNK_ALREADY_BOUND");

    // The original binding is untouched — no pointer substitution.
    expect(
      await env.CHUNK_POINTER_REGISTRY.get(
        chunkPointerEntryKey(CAPSULE_ID, CHUNK_ID)
      )
    ).toBe(CHUNK_TX);
  });

  /* ============== D. TX_ALREADY_CLAIMED (unchanged mechanism) ============== */

  it("D. same txId claimed by a different lifecycle → 409 TX_ALREADY_CLAIMED", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const first = await claim(env);
    expect(first.status).toBe(200);

    // A DIFFERENT lifecycle claiming the SAME tx must be rejected by
    // the `publication-tx:<txId>` secondary index. The index lives in
    // PUBLICATION_VERIFICATIONS and is untouched by the per-chunk
    // registry change — this test pins that it still fires.
    const LIFECYCLE_2 = "lifecycle-2";
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_2}`,
      JSON.stringify({
        id: "credit-2",
        status: "CONSUMING",
        creatorIdentityId: IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFECYCLE_2,
      })
    );
    env.STORAGE_PAYMENTS.put(
      `storage-payment:storage-pay-2`,
      JSON.stringify({
        storagePaymentId: "storage-pay-2",
        state: "PAYMENT_VERIFIED",
        quote: {
          creatorIdentityId: IDENTITY_ID,
          lifecycleId: LIFECYCLE_2,
          capsuleId: CAPSULE_ID,
        },
      })
    );

    const second = await claim(env, {
      lifecycleId: LIFECYCLE_2,
      storagePaymentId: "storage-pay-2",
      chunkId: chunkId(7),
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("TX_ALREADY_CLAIMED");

    // No entry was created for the second chunkId.
    expect(
      await getChunkPointerEntry(env as never, CAPSULE_ID, chunkId(7) as never)
    ).toBeNull();
  });

  /* ============== E. CROSS-CAPSULE ISOLATION ============== */

  it("E. cross-capsule isolation → same chunkId in two capsules stays independent", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    // Capsule A writes chunkId(1) -> txA.
    const txA = "a".repeat(43);
    await putChunkPointerEntry(
      env as never,
      CAPSULE_ID as never,
      chunkId(1) as never,
      txA as never
    );

    // Capsule B writes the SAME chunkId -> txB (different key space).
    const txB = "b".repeat(43);
    await putChunkPointerEntry(
      env as never,
      OTHER_CAPSULE_ID as never,
      chunkId(1) as never,
      txB as never
    );

    const mapA = await getChunkPointerMap(env as never, CAPSULE_ID as never);
    const mapB = await getChunkPointerMap(
      env as never,
      OTHER_CAPSULE_ID as never
    );

    expect(mapA[chunkId(1)]).toBe(txA);
    expect(mapB[chunkId(1)]).toBe(txB);

    // Prefix scoping: capsule A's prefix must not match capsule B's keys.
    expect(chunkPointerEntryPrefix(CAPSULE_ID).length).toBe(
      chunkPointerEntryPrefix(OTHER_CAPSULE_ID).length
    );
    const allKeys = [...env.CHUNK_POINTER_REGISTRY.data.keys()];
    expect(
      allKeys.filter((k) => k.startsWith(chunkPointerEntryPrefix(CAPSULE_ID)))
        .length
    ).toBe(1);
  });

  /* ============== F. PAGINATION ============== */

  it("F. read path with >1000 entries → pagination returns every entry", async () => {
    const env = buildEnv();
    const kv = env.CHUNK_POINTER_REGISTRY;

    // Simulate real KV `list()`: max 1,000 keys per page, explicit
    // list_complete + cursor. A `list_complete:false` page may even
    // return an empty keys array (tombstones) — keys.length is NEVER a
    // termination signal.
    const PAGE = 1000;
    let listCalls = 0;
    kv.list = async (options: { prefix?: string; cursor?: string }) => {
      listCalls += 1;
      const prefix = options.prefix ?? "";
      const offset = options.cursor ? Number(options.cursor) : 0;
      const all = [...kv.data.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort();
      const slice = all.slice(offset, offset + PAGE);
      const next = offset + PAGE;
      const complete = next >= all.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : String(next),
      };
    };

    const TOTAL = 1500;
    for (let i = 0; i < TOTAL; i += 1) {
      await putChunkPointerEntry(
        env as never,
        CAPSULE_ID as never,
        chunkId(i) as never,
        `p${i}`.padEnd(43, "x") as never
      );
    }

    const map = await getChunkPointerMap(env as never, CAPSULE_ID as never);

    expect(Object.keys(map)).toHaveLength(TOTAL);
    expect(map[chunkId(0)]).toBe("p0".padEnd(43, "x"));
    expect(map[chunkId(TOTAL - 1)]).toBe(`p${TOTAL - 1}`.padEnd(43, "x"));

    // More than one page was actually required.
    expect(listCalls).toBeGreaterThan(1);
  });

  it("F2. pagination tolerates an empty non-terminal page (list_complete:false)", async () => {
    const env = buildEnv();
    const kv = env.CHUNK_POINTER_REGISTRY;

    await putChunkPointerEntry(
      env as never,
      CAPSULE_ID as never,
      chunkId(1) as never,
      POINTER_A as never
    );
    await putChunkPointerEntry(
      env as never,
      CAPSULE_ID as never,
      chunkId(2) as never,
      POINTER_B as never
    );

    // Page 1: list_complete:false, EMPTY keys (tombstone-only page).
    // Page 2: the real entries. A reader that stops on keys.length===0
    // would return an empty map here.
    let call = 0;
    kv.list = async (options: { prefix?: string }) => {
      call += 1;
      const prefix = options.prefix ?? "";
      if (call === 1) {
        return { keys: [], list_complete: false, cursor: "next" };
      }
      return {
        keys: [...kv.data.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: undefined,
      };
    };

    const map = await getChunkPointerMap(env as never, CAPSULE_ID as never);
    expect(map[chunkId(1)]).toBe(POINTER_A);
    expect(map[chunkId(2)]).toBe(POINTER_B);
    expect(call).toBe(2);
  });

  /* ============== G. BOUNDED RETRY ON PROPAGATION LAG ============== */

  it("G. simulated propagation lag → bounded retry succeeds", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    // Write the entry through the real claim path.
    const res = await claim(env);
    expect(res.status).toBe(200);

    // Simulate KV propagation lag on the READ side: the first registry
    // read rejects (entry not yet visible from this location), the
    // second sees the entry. The bounded retry must convert this into
    // a correct 200 instead of a spurious 503.
    const kv = env.CHUNK_POINTER_REGISTRY;
    const realList = kv.list.bind(kv);
    let calls = 0;
    kv.list = async (options: { prefix?: string; cursor?: string }) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("kv list propagation lag");
      }
      return realList(options);
    };

    const { onRequestGet } = await import(
      "./../api/capsule/[capsuleId]/chunk-pointers"
    );

    // The retry sleeps between attempts; advance fake timers so the
    // bounded backoff does not deadlock the test.
    const pending = onRequestGet(readContext(env));
    await vi.advanceTimersByTimeAsync(REGISTRY_READ_RETRY_DELAY_MS * 4);
    const response = await pending;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.capsuleId).toBe(CAPSULE_ID);
    expect(body.chunkPointers[CHUNK_ID]).toBe(CHUNK_TX);

    // Bounded: the first attempt failed, the second succeeded.
    expect(calls).toBe(2);
  });

  it("G2. retry is finite → persistent failure still fails closed with 503", async () => {
    const env = buildEnv();

    const kv = env.CHUNK_POINTER_REGISTRY;
    let calls = 0;
    kv.list = async () => {
      calls += 1;
      throw new Error("kv unavailable");
    };

    const { onRequestGet } = await import(
      "./../api/capsule/[capsuleId]/chunk-pointers"
    );

    const pending = onRequestGet(readContext(env));
    await vi.advanceTimersByTimeAsync(REGISTRY_READ_RETRY_DELAY_MS * 8);
    const response = await pending;

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("STORAGE_ERROR");

    // Finite: bounded by REGISTRY_READ_MAX_ATTEMPTS, never unbounded.
    expect(calls).toBe(REGISTRY_READ_MAX_ATTEMPTS);
  });

  /* ============== H. FAIL CLOSED ON MALFORMED / UNREADABLE ============== */

  it("H. malformed entry key → fail closed", async () => {
    const env = buildEnv();
    const kv = env.CHUNK_POINTER_REGISTRY;

    // A key under this capsule's prefix with no chunkId remainder.
    kv.data.set(chunkPointerEntryPrefix(CAPSULE_ID), "orphan-pointer");

    await expect(
      getChunkPointerMap(env as never, CAPSULE_ID as never)
    ).rejects.toThrow(/malformed/);
  });

  it("H2. unreadable (empty) entry value → fail closed", async () => {
    const env = buildEnv();
    const kv = env.CHUNK_POINTER_REGISTRY;

    // List returns the key, but its value is empty → corruption.
    kv.data.set(chunkPointerEntryKey(CAPSULE_ID, CHUNK_ID), "");
    const realList = kv.list.bind(kv);
    kv.list = async (options: { prefix?: string }) => {
      void realList;
      void options;
      return {
        keys: [{ name: chunkPointerEntryKey(CAPSULE_ID, CHUNK_ID) }],
        list_complete: true,
        cursor: undefined,
      };
    };

    await expect(
      getChunkPointerMap(env as never, CAPSULE_ID as never)
    ).rejects.toThrow(/unreadable/);
  });

  it("H3. malformed pointer surfaces as REGISTRY_INVALID from the endpoint", async () => {
    const env = buildEnv();
    const kv = env.CHUNK_POINTER_REGISTRY;

    // Structurally unreadable-ok but failing StoragePointer validation.
    await kv.put(chunkPointerEntryKey(CAPSULE_ID, CHUNK_ID), "not-a-pointer");

    const { onRequestGet } = await import(
      "./../api/capsule/[capsuleId]/chunk-pointers"
    );
    const response = await onRequestGet(readContext(env));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("REGISTRY_INVALID");
  });

  /* ============== I. NO SHARED CAPSULE-LEVEL KEY ============== */

  it("I. chunk claim never writes the shared capsule-level registry key", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(200);

    expect(
      await env.CHUNK_POINTER_REGISTRY.get(
        `chunk-pointer-registry:${CAPSULE_ID}`
      )
    ).toBeNull();

    const keys = [...env.CHUNK_POINTER_REGISTRY.data.keys()];
    expect(keys).toEqual([
      chunkPointerEntryKey(CAPSULE_ID, CHUNK_ID),
    ]);
  });

  /* ============== J. EMPTY REGISTRY IS NOT AN ERROR ============== */

  it("J. capsule with no chunks → empty map, endpoint 200 with empty chunkPointers", async () => {
    const env = buildEnv();

    const map = await getChunkPointerMap(env as never, CAPSULE_ID as never);
    expect(map).toEqual({});

    const { onRequestGet } = await import(
      "./../api/capsule/[capsuleId]/chunk-pointers"
    );
    const response = await onRequestGet(readContext(env));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      capsuleId: CAPSULE_ID,
      chunkPointers: {},
    });
  });
});
