/**
 * AETERNA — Creator Credit grant hardening invariants
 *
 * Proves the GAP 1 guarantees added to the CREDIT_OP_COORDINATOR:
 *
 *   ONE verified AETERNA service payment (creatorIdentityId + quoteId)
 *   -> EXACTLY ONE Creator Credit
 *
 * and the repair-on-replay behaviour that makes the two-store write
 * (Durable Object claim + KV record/index) converge on the same
 * externally visible state.
 */

import { describe, expect, it } from "vitest";
import { CreditOperationCoordinator } from "../do/creditOperationCoordinator";

interface FakeStorage {
  data: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

function createFakeStorage(): FakeStorage {
  return {
    data: new Map<string, unknown>(),
    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      this.data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      this.data.delete(key);
    },
  };
}

interface TestEnv {
  CREATOR_CREDITS: FakeStorage;
  PUBLICATION_VERIFICATIONS: FakeStorage;
  SEAL_VERIFICATIONS: FakeStorage;
  /**
   * Self-binding, exactly as in the deployed coordinator worker: the grant
   * op (addressed per identity+quote) records the AUTHORITATIVE issuance
   * provenance in the per-credit instance `idFromName(creatorCreditId)`.
   */
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(target: { id: string }): { fetch(request: Request): Promise<Response> };
  };
}

function createEnv(): TestEnv {
  return {
    CREATOR_CREDITS: createFakeStorage(),
    PUBLICATION_VERIFICATIONS: createFakeStorage(),
    SEAL_VERIFICATIONS: createFakeStorage(),
  };
}

const IDENTITY = "identity-1";
const QUOTE_ID = "quote-1";

function grantPayload(overrides: Record<string, unknown> = {}) {
  return {
    op: "grant",
    creatorIdentityId: IDENTITY,
    quoteId: QUOTE_ID,
    paymentIntentId: QUOTE_ID,
    transactionId: "tx-1",
    evidenceId: "ev-1",
    ...overrides,
  };
}

/**
 * Build a coordinator whose fetch is QUEUED, emulating the Durable Object
 * input gate (single-threaded request processing). Without this, calling
 * fetch concurrently in-process would interleave the await inside
 * handleGrant and no real serialization would be exercised.
 */
function createCoordinator(env: TestEnv) {
  const state = createFakeStorage();
  const durableState = { storage: state };
  const instance = new CreditOperationCoordinator(durableState as never, env as never);

  /**
   * SELF-BINDING (production topology): the grant op runs in the
   * `identity:quote` instance and records protocol provenance in the
   * PER-CREDIT instance `idFromName(creatorCreditId)`. These tests own one
   * credit, so every id routes back to this instance — through the UNGATED
   * fetch, because the inner call is a separate logical request and must not
   * queue behind the outer one.
   */
  env.CREDIT_OP_COORDINATOR = {
    idFromName: (name: string) => ({ id: name }),
    get: () => ({ fetch: (request: Request) => instance.fetch(request) }),
  };

  let tail: Promise<unknown> = Promise.resolve();

  const gated = {
    async fetch(request: Request): Promise<Response> {
      const run = tail.then(() => instance.fetch(request));
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };

  return { coordinator: gated as unknown as CreditOperationCoordinator, state };
}

async function post(
  coordinator: CreditOperationCoordinator,
  payload: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await coordinator.fetch(
    new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** All KV records under creator:credit:<id> (excludes index/lifecycle keys). */
function creditRecordIds(env: TestEnv): string[] {
  const ids: string[] = [];
  for (const key of env.CREATOR_CREDITS.data.keys()) {
    if (!key.startsWith("creator:credit:")) continue;
    const rest = key.slice("creator:credit:".length);
    if (rest.startsWith("index:") || rest.startsWith("lifecycle:")) continue;
    ids.push(rest);
  }
  return ids.sort();
}

const indexKey = `creator:credit:index:${IDENTITY}:${QUOTE_ID}`;

describe("Creator Credit grant hardening — one verified payment, one Credit", () => {
  it("grants exactly one Credit and writes the KV record plus the quote-keyed index", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const { status, json } = await post(coordinator, grantPayload());

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe("GRANTED");
    expect(json.status).toBe("AVAILABLE");

    const creditId = String(json.creatorCreditId);
    expect(creditId).toHaveLength(32);

    expect(creditRecordIds(env)).toEqual([creditId]);
    expect(env.CREATOR_CREDITS.data.get(indexKey)).toBe(creditId);
  });

  it("sequential replay returns the SAME creatorCreditId and never mints a second Credit", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const first = await post(coordinator, grantPayload());
    const second = await post(coordinator, grantPayload({ evidenceId: "ev-2" }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.outcome).toBe("ALREADY_GRANTED");
    expect(second.json.creatorCreditId).toBe(first.json.creatorCreditId);

    expect(creditRecordIds(env)).toHaveLength(1);
  });

  it("concurrent grants return the SAME creatorCreditId and create exactly ONE Credit", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const results = await Promise.all([
      post(coordinator, grantPayload()),
      post(coordinator, grantPayload()),
      post(coordinator, grantPayload()),
    ]);

    for (const r of results) expect(r.status).toBe(200);

    const ids = new Set(results.map((r) => String(r.json.creatorCreditId)));
    expect(ids.size).toBe(1);
    expect(creditRecordIds(env)).toHaveLength(1);
  });

  it("repair-on-replay: DO claim exists but the KV record is missing -> record is recreated with the SAME id", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const first = await post(coordinator, grantPayload());
    const creditId = String(first.json.creatorCreditId);

    // Simulate a cross-store partial failure: the KV record is lost.
    env.CREATOR_CREDITS.data.delete(`creator:credit:${creditId}`);
    expect(creditRecordIds(env)).toEqual([]);

    const replay = await post(coordinator, grantPayload());

    expect(replay.status).toBe(200);
    expect(replay.json.creatorCreditId).toBe(creditId);
    expect(creditRecordIds(env)).toEqual([creditId]);
  });

  it("repair-on-replay: KV record exists but the index is missing -> index is recreated", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const first = await post(coordinator, grantPayload());
    const creditId = String(first.json.creatorCreditId);

    // Simulate the index write failing after the record write succeeded.
    env.CREATOR_CREDITS.data.delete(indexKey);
    expect(env.CREATOR_CREDITS.data.get(indexKey)).toBeUndefined();

    const replay = await post(coordinator, grantPayload());

    expect(replay.status).toBe(200);
    expect(replay.json.creatorCreditId).toBe(creditId);
    expect(env.CREATOR_CREDITS.data.get(indexKey)).toBe(creditId);
    expect(creditRecordIds(env)).toEqual([creditId]);
  });

  it("repair-on-replay: record present but index missing on the FIRST repair pass, then a second replay still yields one Credit", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const first = await post(coordinator, grantPayload());
    const creditId = String(first.json.creatorCreditId);

    env.CREATOR_CREDITS.data.delete(indexKey);
    await post(coordinator, grantPayload());
    await post(coordinator, grantPayload());

    expect(creditRecordIds(env)).toEqual([creditId]);
    expect(env.CREATOR_CREDITS.data.get(indexKey)).toBe(creditId);
  });

  it("rejects an invalid grant payload without writing anything", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const { status } = await post(coordinator, grantPayload({ quoteId: "" }));

    expect(status).toBe(400);
    expect(creditRecordIds(env)).toEqual([]);
    expect(env.CREATOR_CREDITS.data.get(indexKey)).toBeUndefined();
  });

  it("a different quoteId mints an independent Credit (one Credit per verified payment)", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const a = await post(coordinator, grantPayload());
    const b = await post(coordinator, grantPayload({ quoteId: "quote-2", paymentIntentId: "quote-2" }));

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json.creatorCreditId).not.toBe(a.json.creatorCreditId);
    expect(creditRecordIds(env)).toHaveLength(2);
  });
});

/**
 * PROTOCOL PROVENANCE AT ISSUANCE.
 *
 * The marker is recorded in the PER-CREDIT Durable Object before the grant is
 * acknowledged, so provenance never depends on an eventually consistent KV
 * read. A grant that cannot be proven is NOT acknowledged, and the retry of
 * the same verified payment completes that same issuance.
 */
describe("Creator Credit grant hardening — authoritative issuance provenance", () => {
  const MARKER = "vault-claim-v1";

  it("does not acknowledge a grant it cannot prove, and converges on retry", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    const working = env.CREDIT_OP_COORDINATOR!;

    env.CREDIT_OP_COORDINATOR = {
      idFromName: (name: string) => ({ id: name }),
      get: () => ({
        fetch: async () => {
          throw new Error("provenance unavailable");
        },
      }),
    };

    const blocked = await post(coordinator, grantPayload());
    expect(blocked.status).toBe(503);
    expect(blocked.json["error"]).toBe("PROTOCOL_PROVENANCE_UNVERIFIED");
    // Nothing is acknowledged, minted or projected.
    expect(creditRecordIds(env)).toEqual([]);
    expect(env.CREATOR_CREDITS.data.has(indexKey)).toBe(false);

    // The authority returns: the SAME issuance completes, exactly once.
    env.CREDIT_OP_COORDINATOR = working;
    const retried = await post(coordinator, grantPayload());
    expect(retried.status).toBe(200);
    const creditId = retried.json["creatorCreditId"] as string;

    expect(creditRecordIds(env)).toEqual([creditId]);
    expect(state.data.get(`issue-protocol:${creditId}`)).toEqual(
      expect.objectContaining({ publicationProtocol: MARKER })
    );
    expect(
      JSON.parse(env.CREATOR_CREDITS.data.get(`creator:credit:${creditId}`) as string)
        .publicationProtocol
    ).toBe(MARKER);

    // A replay mints nothing new and keeps the same provenance.
    const replay = await post(coordinator, grantPayload());
    expect(replay.status).toBe(200);
    expect(replay.json["creatorCreditId"]).toBe(creditId);
    expect(creditRecordIds(env)).toEqual([creditId]);
  });

  it("ignores a client-supplied protocol value on the grant payload", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);

    const { status, json } = await post(
      coordinator,
      grantPayload({ publicationProtocol: "client-forged", protocolIssuance: false })
    );
    expect(status).toBe(200);

    const creditId = json["creatorCreditId"] as string;
    expect(state.data.get(`issue-protocol:${creditId}`)).toEqual(
      expect.objectContaining({ publicationProtocol: MARKER })
    );
    expect(
      JSON.parse(env.CREATOR_CREDITS.data.get(`creator:credit:${creditId}`) as string)
        .publicationProtocol
    ).toBe(MARKER);
  });

  it("never marks a legacy claim that is merely replayed", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    // A historical claim, stored without issuance intent.
    state.data.set("credit-grant:identity-1:quote-1", {
      creatorIdentityId: "identity-1",
      quoteId: "quote-1",
      creatorCreditId: "creditlegacy0001",
      createdAt: 1,
    });

    const replay = await post(coordinator, grantPayload());
    expect(replay.status).toBe(200);
    expect(replay.json["outcome"]).toBe("ALREADY_GRANTED");
    expect(replay.json["creatorCreditId"]).toBe("creditlegacy0001");

    expect(state.data.has("issue-protocol:creditlegacy0001")).toBe(false);
    expect(
      JSON.parse(env.CREATOR_CREDITS.data.get("creator:credit:creditlegacy0001") as string)
        .publicationProtocol
    ).toBeUndefined();
  });
});
