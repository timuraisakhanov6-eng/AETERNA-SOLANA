import { describe, expect, it } from "vitest";
import type { CreditRecord, OpResult } from "../do/creditOperationCoordinator";
import { CONTAINER_CLAIM_INSTANCE, CreditOperationCoordinator } from "../do/creditOperationCoordinator";
import { CONTAINER_PUBLICATION_COORDINATOR_NAME } from "../lib/containerPublicationClaim";
import { createFakeCreditCoordinatorBinding } from "./harness";

interface FakeStorage {
  data: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

function createFakeStorage(): FakeStorage {
  return {
    data: new Map(),
    async get(key) {
      return this.data.get(key) as T | undefined;
    },
    async put(key, value) {
      this.data.set(key, value);
    },
    async delete(key) {
      this.data.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix ?? "";
      const out = new Map<string, T>();
      for (const [key, value] of this.data) {
        if (key.startsWith(prefix)) out.set(key, value as T);
      }
      return out;
    },
  };
}

interface TestEnv {
  CREATOR_CREDITS: FakeStorage;
  PUBLICATION_VERIFICATIONS: FakeStorage;
  SEAL_VERIFICATIONS: FakeStorage;
  /**
   * Self-binding to the coordinator namespace. The per-credit instance uses
   * it to read the AUTHORITATIVE container-publication claim from the
   * instance that owns it (finding F1) — the claim is stored in the
   * dedicated `CONTAINER_CLAIM_INSTANCE`, not in this object.
   *
   * Optional exactly like production (`CoordinatorEnv`), so the fail-closed
   * tests can omit it and assert a missing binding refuses the decision.
   */
  CREDIT_OP_COORDINATOR?: ReturnType<typeof createFakeCreditCoordinatorBinding>;
}

function createEnv(): TestEnv {
  return {
    CREATOR_CREDITS: createFakeStorage(),
    PUBLICATION_VERIFICATIONS: createFakeStorage(),
    SEAL_VERIFICATIONS: createFakeStorage(),
    CREDIT_OP_COORDINATOR: createFakeCreditCoordinatorBinding(),
  };
}

function creditRecord(partial: Partial<CreditRecord> = {}): CreditRecord {
  return {
    id: partial.id ?? "credit-1",
    creatorIdentityId: partial.creatorIdentityId ?? "identity-1",
    status: partial.status ?? "AVAILABLE",
    capsuleId: partial.capsuleId ?? "capsule-1",
    lifecycleId: partial.lifecycleId ?? null,
    ...(partial.publicationProtocol !== undefined
      ? { publicationProtocol: partial.publicationProtocol }
      : {}),
    revision: partial.revision ?? 1,
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

/** The trusted protocol marker value, as the issuance path writes it. */
const PROTOCOL_MARKER = "vault-claim-v1";

/**
 * Drive the TRUSTED ISSUANCE path (the coordinator `grant` op) exactly as
 * /api/creator/grant-credit does: it writes the KV credit projection WITH the
 * protocol marker and the quote-keyed credit index, and stores no DO record.
 *
 * NOTE: `handleGrant` validates the injected id against
 * `/^[a-z0-9]{8,64}$/`, so the id must have that exact shape (no dashes).
 */
async function issueCredit(
  coordinator: CreditOperationCoordinator,
  input: {
    creatorIdentityId?: string;
    quoteId?: string;
    paymentIntentId?: string;
    creatorCreditId?: string;
  } = {}
) {
  return post(coordinator, {
    op: "grant",
    creatorIdentityId: input.creatorIdentityId ?? "identity-1",
    quoteId: input.quoteId ?? "quote-1",
    paymentIntentId: input.paymentIntentId ?? "intent-1",
    transactionId: "tx-1",
    evidenceId: "ev-1",
    creatorCreditId: input.creatorCreditId ?? "creditissued01",
  });
}

/**
 * Seed the KV projection exactly as the TRUSTED ISSUANCE path writes it
 * (`repairCreditArtifacts`): credit record + quote-keyed credit index.
 *
 * `marked` reproduces a right minted under the vault-publication-claim
 * protocol; the default (false) reproduces a LEGACY right, whose record has
 * no marker at all.
 */
function seedIssuedProjection(
  env: TestEnv,
  creditId: string,
  options: { marked?: boolean; quoteId?: string; state?: FakeStorage } = {}
) {
  const quoteId = options.quoteId ?? `intent-${creditId}`;
  const record = {
    id: creditId,
    creatorIdentityId: "identity-1",
    status: "AVAILABLE",
    quoteId,
    createdAt: 1,
    updatedAt: 1,
    ...(options.marked ? { publicationProtocol: PROTOCOL_MARKER } : {}),
  };
  env.CREATOR_CREDITS.data.set(`creator:credit:${creditId}`, JSON.stringify(record));
  env.CREATOR_CREDITS.data.set(
    `creator:credit:index:identity-1:${quoteId}`,
    creditId
  );

  /**
   * AUTHORITATIVE PROVENANCE lives in the PER-CREDIT DO (`issue-protocol:<id>`),
   * written by the real grant path. A marked projection alone is now
   * (correctly) not enough: KV is a projection of the marker, never its
   * definition.
   */
  if (options.marked) {
    if (!options.state) {
      throw new Error(
        "seedIssuedProjection: `state` is required when seeding a marked right"
      );
    }
    options.state.data.set(`issue-protocol:${creditId}`, {
      creatorCreditId: creditId,
      creatorIdentityId: "identity-1",
      quoteId,
      publicationProtocol: PROTOCOL_MARKER,
      recordedAt: 1,
    });
  }

  return record;
}

function createCoordinator(env: TestEnv, existingCredit?: CreditRecord) {
  const state = createFakeStorage();
  if (existingCredit) {
    state.data.set(`credit:${existingCredit.id}`, existingCredit);
  }

  const durableState = {
    storage: state,
  };

  const coordinator = new CreditOperationCoordinator(durableState, env);

  /**
   * PRODUCTION TOPOLOGY IN THE HARNESS.
   *
   * The `grant` op runs in the `${creatorIdentityId}:${quoteId}` instance and
   * records protocol provenance in the PER-CREDIT instance
   * (`idFromName(creatorCreditId)`) — the very instance that later decides
   * reserve/recover/rebind. A test owns exactly one credit, so that
   * per-credit instance IS `coordinator`; the self-binding therefore routes
   * every non-container id back to it. Container ids keep going to the shared
   * fake binding, which owns the container publication instance.
   */
  const shared = env.CREDIT_OP_COORDINATOR;
  if (shared) {
    env.CREDIT_OP_COORDINATOR = {
      idFromName: (name: string) => ({ id: name }),
      get: (target: { id: string }) =>
        target.id === CONTAINER_CLAIM_INSTANCE
          ? shared.get(target)
          : { fetch: (request: Request) => coordinator.fetch(request) },
      storages: shared.storages,
    };
  }

  return { coordinator, state };
}

async function post(coordinator: CreditOperationCoordinator, payload: unknown): Promise<{ ok: boolean; outcome: string; status: string; creatorCreditId: string; lifecycleId: string | null; revision: number }> {
  const response = await coordinator.fetch(
    new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
  const json = (await response.json()) as Record<string, unknown>;
  return {
    ok: Boolean(json.ok),
    outcome: String(json.outcome),
    status: String(json.status),
    creatorCreditId: String(json.creatorCreditId),
    lifecycleId: (json.lifecycleId as string | null) ?? null,
    revision: Number(json.revision),
  };
}

describe("CreditOperationCoordinator", () => {
  it("reserves an available credit and rejects a second different lifecycle", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord());
    const result1 = await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    expect(result1).toEqual({
      ok: true,
      outcome: "RESERVED",
      status: "CONSUMING",
      creatorCreditId: "credit-1",
      lifecycleId: "lifecycle-1",
      revision: 2,
    });

    const result2 = await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-2", capsuleId: "capsule-1" });
    expect(result2.ok).toBe(false);
    expect(result2.outcome).toBe("ALREADY_CONSUMING");
    expect(result2.status).toBe("CONSUMING");
  });

  it("is idempotent for the same lifecycle reservation", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord());
    const first = await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    const second = await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    expect(second).toEqual(first);
  });

  it("finalizes only after publication and seal verification", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const result = await post(coordinator, { op: "finalize", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationVerified: true, sealVerified: true });
    expect(result).toEqual({
      ok: true,
      outcome: "CONSUMED",
      status: "CONSUMED",
      creatorCreditId: "credit-1",
      lifecycleId: null,
      revision: 2,
    });
  });

  it("rejects finalize without publication verification", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const result = await post(coordinator, { op: "finalize", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationVerified: false, sealVerified: true });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("PUBLICATION_NOT_VERIFIED");
    expect(result.status).toBe("CONSUMING");
  });

  it("recovers an interrupted credit when publication and seal are not verified", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result).toEqual({
      ok: true,
      outcome: "ABORT_AND_RESTORE_AVAILABLE",
      status: "AVAILABLE",
      creatorCreditId: "credit-1",
      lifecycleId: null,
      revision: 2,
    });
  });

  it("returns existing when recovering a CONSUMED credit", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMED", lifecycleId: null }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("RETURN_EXISTING");
    expect(result.status).toBe("CONSUMED");
  });

  it("does not restore CONSUMED credit on recovery with verified publication and seal", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMED", lifecycleId: null }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "VERIFIED", sealState: "VERIFIED" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("RETURN_EXISTING");
    expect(result.status).toBe("CONSUMED");
  });

  it("rejects recovery with identity mismatch", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-2", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("RETURN_EXISTING");
    expect(result.status).toBe("CONSUMING");
  });

  it("does not restore a credit whose publication is VERIFIED even when the request claims NOT_VERIFIED", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    env.PUBLICATION_VERIFICATIONS.data.set(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "VERIFIED" })
    );

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("PUBLICATION_VERIFIED_AWAITING_FINALIZATION");
    expect(result.status).toBe("CONSUMING");
  });

  it("does not restore a credit whose seal is VERIFIED", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    env.SEAL_VERIFICATIONS.data.set(
      "creator:seal:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "VERIFIED" })
    );

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("SEAL_VERIFIED_AWAITING_FINALIZATION");
    expect(result.status).toBe("CONSUMING");
  });

  it("keeps an in-flight publication claim blocking recovery while publication is PENDING", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    await post(coordinator, { op: "vault-publication-claim", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    env.PUBLICATION_VERIFICATIONS.data.set(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "PENDING" })
    );

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("PUBLICATION_CLAIM_IN_FLIGHT");
    expect(result.status).toBe("CONSUMING");
  });

  it("restores the credit after an authorized explicit publication failure despite an open claim", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    await post(coordinator, { op: "vault-publication-claim", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const failure = await post(coordinator, { op: "vault-publication-claim", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", outcome: "PUBLICATION_EXPLICIT_FAILURE" });
    expect(failure.ok).toBe(false);
    expect(failure.outcome).toBe("VAULT_PUBLICATION_EXPLICIT_FAILURE");

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("ABORT_AND_RESTORE_AVAILABLE");
    expect(result.status).toBe("AVAILABLE");
  });

  it("keeps a claimed credit recoverable once publication reaches VERIFIED (no permanent claim dead-end)", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    await post(coordinator, { op: "vault-publication-claim", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    // Publication completes AFTER the claim was taken.
    env.PUBLICATION_VERIFICATIONS.data.set(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "VERIFIED" })
    );

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("PUBLICATION_VERIFIED_AWAITING_FINALIZATION");
    expect(result.status).toBe("CONSUMING");
  });

  it("treats corrupt verification records as NOT_VERIFIED and still blocks restore on an in-flight claim", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    await post(coordinator, { op: "vault-publication-claim", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    env.PUBLICATION_VERIFICATIONS.data.set("creator:publication:lifecycle-1", "not-json");

    const result = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "VERIFIED", sealState: "VERIFIED" });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("PUBLICATION_CLAIM_IN_FLIGHT");
  });

  it("does not mark an explicit publication failure without passing binding checks", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1" }));
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });

    const result = await post(coordinator, { op: "vault-publication-claim", creatorCreditId: "credit-1", creatorIdentityId: "identity-2", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", outcome: "PUBLICATION_EXPLICIT_FAILURE" });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("LIFECYCLE_NOT_FOUND");
  });
});

/**
 * `op: "read"` — the authoritative, strongly consistent credit projection
 * consumed by the upload-token gate instead of the eventually-consistent KV
 * lifecycle key.
 */
describe("CreditOperationCoordinator — authoritative read", () => {
  async function readRaw(coordinator: CreditOperationCoordinator, creatorCreditId: string) {
    const response = await coordinator.fetch(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "read", creatorCreditId }),
      })
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it("returns the full authoritative record for a reserved credit", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord());
    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      paymentIntentId: "intent-1",
    });

    const json = await readRaw(coordinator, "credit-1");
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe("FOUND");
    expect(json.status).toBe("CONSUMING");
    expect(json.creatorCreditId).toBe("credit-1");
    expect(json.creatorIdentityId).toBe("identity-1");
    expect(json.capsuleId).toBe("capsule-1");
    expect(json.lifecycleId).toBe("lifecycle-1");
    expect(json.paymentIntentId).toBe("intent-1");
    expect(json.revision).toBe(2);
  });

  it("carries paymentIntentId as null when the reserve supplied none", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env, creditRecord());
    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });

    const json = await readRaw(coordinator, "credit-1");
    expect(json.outcome).toBe("FOUND");
    expect(json.paymentIntentId).toBeNull();
  });

  it("reports NOT_FOUND for an unknown credit and never fabricates a binding", async () => {
    const env = createEnv();
    const { coordinator } = createCoordinator(env);

    const json = await readRaw(coordinator, "credit-absent");
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe("NOT_FOUND");
    expect(json.status).toBe("AVAILABLE");
    expect(json.creatorIdentityId).toBe("");
    expect(json.capsuleId).toBe("");
    expect(json.lifecycleId).toBeNull();
    expect(json.paymentIntentId).toBeNull();
    expect(json.revision).toBe(0);
  });

  it("is strictly read-only: repeated reads do not mutate DO storage", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env, creditRecord());
    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });

    const before = new Map(state.data);
    await readRaw(coordinator, "credit-1");
    await readRaw(coordinator, "credit-1");
    await readRaw(coordinator, "credit-absent");

    expect([...state.data.keys()].sort()).toEqual([...before.keys()].sort());
    expect(state.data.get("credit:credit-1")).toEqual(before.get("credit:credit-1"));
  });
});

/* ================= RESTORED RIGHT REBINDING ================= */

/**
 * The observed Production shape of a stranded restored right:
 *
 *   status AVAILABLE, lifecycleId null, the PREVIOUS attempt's capsuleId
 *   still attached, revision 3 — plus the Durable Object's own record of
 *   the attempt that bound that capsule (a successful reserve at
 *   revision 2), and no lifecycle index (recover deletes it).
 */
function seedStrandedReleasedCredit(
  env: TestEnv,
  state: FakeStorage,
  options: {
    capsuleId?: string;
    releasedLifecycleId?: string;
    reserveRevisions?: number[];
    publicationState?: string;
    sealState?: string;
    /** Verbatim stored value (e.g. malformed JSON) for one record. */
    publicationRaw?: string;
    sealRaw?: string;
    /** Custom record object (schema-invalid fields / foreign binding). */
    publicationRecord?: Record<string, unknown>;
    sealRecord?: Record<string, unknown>;
    claim?: boolean;
    /** Override the stored claim outcome (e.g. an explicit failure). */
    claimOutcome?: string;
    /** Verbatim stored claim value (e.g. a malformed record). */
    claimRaw?: string;
    /**
     * PROTOCOL PROVENANCE: when true the credit is seeded as a right issued
     * under the vault-publication-claim protocol (marker present). Default
     * false = a LEGACY right, which must never be automatically rebound.
     */
    marked?: boolean;
  } = {}
) {
  const capsuleId = options.capsuleId ?? "capsule-old";
  const releasedLifecycleId = options.releasedLifecycleId ?? "lifecycle-old";
  const revisions = options.reserveRevisions ?? [2];

  for (const [index, revision] of revisions.entries()) {
    const lifecycleId =
      revisions.length > 1 ? `${releasedLifecycleId}-${index}` : releasedLifecycleId;
    state.data.set(`op:credit-1:reserve:${lifecycleId}`, {
      ok: true,
      outcome: "RESERVED",
      status: "CONSUMING",
      creatorCreditId: "credit-1",
      lifecycleId,
      revision,
    });
  }

  const record = creditRecord({
    status: "AVAILABLE",
    lifecycleId: null,
    capsuleId,
    revision: 3,
    publicationProtocol: options.marked ? PROTOCOL_MARKER : undefined,
  });
  state.data.set("credit:credit-1", record);

  env.CREATOR_CREDITS.data.set(`creator:credit:${record.id}`, JSON.stringify(record));
  env.CREATOR_CREDITS.data.set(
    `creator:credit:index:identity-1:${capsuleId}`,
    record.id
  );

  /**
   * Records are written SCHEMA-COMPLETE, exactly as the writers persist
   * them (`api/publication/verify.ts`, `api/publication/claim.ts`,
   * `api/seal/verify.ts`), so a refusal is decided by the STATE under
   * test rather than by a missing field.
   */
  const publicationRecord = options.publicationRecord ?? {
    lifecycleId: releasedLifecycleId,
    capsuleId,
    creatorIdentityId: "identity-1",
    state: options.publicationState,
    expectedTxId: "tx-old",
    expectedVaultSha256: null,
    evidenceIds: ["tx-old"],
    createdAt: 1,
    updatedAt: 1,
  };
  if (options.publicationRaw !== undefined) {
    env.PUBLICATION_VERIFICATIONS.data.set(
      `creator:publication:${releasedLifecycleId}`,
      options.publicationRaw
    );
  } else if (
    options.publicationState !== undefined ||
    options.publicationRecord !== undefined
  ) {
    env.PUBLICATION_VERIFICATIONS.data.set(
      `creator:publication:${releasedLifecycleId}`,
      JSON.stringify(publicationRecord)
    );
  }

  const sealRecord = options.sealRecord ?? {
    lifecycleId: releasedLifecycleId,
    capsuleId,
    creatorIdentityId: "identity-1",
    manifestHash: "manifest:00000000",
    state: options.sealState,
    verifiedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  if (options.sealRaw !== undefined) {
    env.SEAL_VERIFICATIONS.data.set(
      `creator:seal:${releasedLifecycleId}`,
      options.sealRaw
    );
  } else if (options.sealState !== undefined || options.sealRecord !== undefined) {
    env.SEAL_VERIFICATIONS.data.set(
      `creator:seal:${releasedLifecycleId}`,
      JSON.stringify(sealRecord)
    );
  }
  if (options.claimRaw !== undefined) {
    state.data.set(
      `op:credit-1:vault-publication-claim:${releasedLifecycleId}`,
      options.claimRaw
    );
  } else if (options.claim || options.claimOutcome) {
    state.data.set(`op:credit-1:vault-publication-claim:${releasedLifecycleId}`, {
      ok: true,
      outcome: options.claimOutcome ?? "VAULT_PUBLICATION_CLAIMED",
      status: "CONSUMING",
      creatorCreditId: "credit-1",
      lifecycleId: releasedLifecycleId,
      revision: 2,
    });
  }

  return { record, capsuleId, releasedLifecycleId };
}

/** The rebind attempt used by the evidence-classification tests. */
function tryRebind(coordinator: CreditOperationCoordinator) {
  return post(coordinator, {
    op: "reserve",
    creatorCreditId: "credit-1",
    creatorIdentityId: "identity-1",
    lifecycleId: "lifecycle-new",
    capsuleId: "capsule-new",
  });
}

/** A refused rebind must consume nothing and leave every index intact. */
function expectRebindRefusedWithoutMutation(
  result: { outcome: string },
  env: TestEnv,
  state: FakeStorage
) {
  expect(result.outcome).toBe("CAPSULE_MISMATCH");
  expect(state.data.get("credit:credit-1")).toEqual(
    expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
  );
  expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:capsule-old")).toBe("credit-1");
  expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-new")).toBe(false);
  expect(env.CREATOR_CREDITS.data.has("creator:credit:lifecycle:identity-1:lifecycle-new")).toBe(false);
}

describe("CreditOperationCoordinator — restored right rebinding", () => {
  it("releases the capsule binding of the recovered attempt (case A)", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);

    const reserved = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    expect(reserved.outcome).toBe("RESERVED");
    expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:capsule-1")).toBe("credit-1");

    const recovered = await post(coordinator, {
      op: "recover",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationState: "NOT_VERIFIED",
      sealState: "NOT_VERIFIED",
    });
    expect(recovered).toEqual({
      ok: true,
      outcome: "ABORT_AND_RESTORE_AVAILABLE",
      status: "AVAILABLE",
      creatorCreditId: "credit-1",
      lifecycleId: null,
      revision: 3,
    });

    // The binding belonged to the abandoned attempt: it is released too.
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", lifecycleId: null, capsuleId: "" })
    );
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-1")).toBe(false);
    expect(env.CREATOR_CREDITS.data.has("creator:credit:lifecycle:identity-1:lifecycle-1")).toBe(false);
  });

  it("reserves a recovered right for a new capsule without a new grant (case A)", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);

    // TRUSTED ISSUANCE: a right minted under the claim protocol carries the
    // marker in BOTH the KV projection and the authoritative per-credit DO.
    seedIssuedProjection(env, "credit-1", { marked: true, state });

    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    // handleReserve copies — never invents — the issued marker.
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ publicationProtocol: PROTOCOL_MARKER })
    );
    await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    // … and it survives the release.
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", publicationProtocol: PROTOCOL_MARKER })
    );

    const rebind = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-2",
      capsuleId: "capsule-2",
    });
    expect(rebind).toEqual({
      ok: true,
      outcome: "RESERVED",
      status: "CONSUMING",
      creatorCreditId: "credit-1",
      lifecycleId: "lifecycle-2",
      revision: 4,
    });

    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "CONSUMING", lifecycleId: "lifecycle-2", capsuleId: "capsule-2" })
    );
    // Exactly ONE credit exists: a rebind never mints a second right.
    const creditKeys = [...env.CREATOR_CREDITS.data.keys()].filter(
      (key) =>
        key.startsWith("creator:credit:") &&
        !key.startsWith("creator:credit:index:") &&
        !key.startsWith("creator:credit:lifecycle:")
    );
    expect(creditKeys).toEqual(["creator:credit:credit-1"]);
    // The released binding is gone; the new one is recorded exactly once.
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-1")).toBe(false);
    expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:capsule-2")).toBe("credit-1");
    expect(env.CREATOR_CREDITS.data.get("creator:credit:lifecycle:identity-1:lifecycle-2")).toBeTruthy();
  });

  it("rebinds the already-stranded AVAILABLE shape to a new capsule (case B)", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { marked: true });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result).toEqual({
      ok: true,
      outcome: "RESERVED",
      status: "CONSUMING",
      creatorCreditId: "credit-1",
      lifecycleId: "lifecycle-new",
      revision: 4,
    });
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-old")).toBe(false);
    expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:capsule-new")).toBe("credit-1");
    expect(env.CREATOR_CREDITS.data.get("creator:credit:lifecycle:identity-1:lifecycle-new")).toBeTruthy();
  });

  it("refuses to rebind when the released attempt has a VERIFIED publication", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { publicationState: "VERIFIED" });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(result.status).toBe("AVAILABLE");
    expect(result.revision).toBe(3);
    // Nothing moved: the old binding is intact and no new index appeared.
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
    expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:capsule-old")).toBe("credit-1");
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-new")).toBe(false);
    expect(env.CREATOR_CREDITS.data.has("creator:credit:lifecycle:identity-1:lifecycle-new")).toBe(false);
  });

  it("refuses to rebind when the released attempt has a VERIFIED seal", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { sealState: "VERIFIED" });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
  });

  it("refuses to rebind while the released attempt's publication is PENDING", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { publicationState: "PENDING" });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
  });

  it("refuses to rebind when the released attempt's reservation history is ambiguous", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { reserveRevisions: [2, 2] });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-new")).toBe(false);
  });

  it("refuses to rebind when no reservation history exists for the credit", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { reserveRevisions: [] });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
  });

  it("refuses to rebind while a vault publication claim is in flight", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { claim: true });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
  });

  it("never lets another capsule steal a CONSUMING credit", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(
      env,
      creditRecord({ status: "CONSUMING", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", revision: 2 })
    );

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-other",
      capsuleId: "capsule-other",
    });

    expect(result.outcome).toBe("ALREADY_CONSUMING");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "CONSUMING", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", revision: 2 })
    );
  });

  it("never lets another capsule steal a CONSUMED credit", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(
      env,
      creditRecord({ status: "CONSUMED", lifecycleId: null, capsuleId: "capsule-1", revision: 3 })
    );

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-other",
      capsuleId: "capsule-other",
    });

    expect(result.outcome).toBe("ALREADY_CONSUMED");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "CONSUMED", revision: 3 })
    );
  });

  it("does not rebind a released credit to another identity", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state);

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-2",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("IDENTITY_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-new")).toBe(false);
  });

  it("is idempotent for repeated recovery and repeated rebinding reservation", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);

    seedIssuedProjection(env, "credit-1", { marked: true, state });
    await post(coordinator, { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" });
    const firstRecover = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    const secondRecover = await post(coordinator, { op: "recover", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationState: "NOT_VERIFIED", sealState: "NOT_VERIFIED" });
    // The replay returns the stored release unchanged: no second restore,
    // no additional revision. (The replayed response echoes the request's
    // lifecycleId — pre-existing behaviour of the idempotency path — so
    // the decision fields are asserted, not the echo.)
    expect(secondRecover.outcome).toBe(firstRecover.outcome);
    expect(secondRecover.status).toBe(firstRecover.status);
    expect(secondRecover.revision).toBe(firstRecover.revision);
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", revision: 3 })
    );

    const rebind = { op: "reserve", creatorCreditId: "credit-1", creatorIdentityId: "identity-1", lifecycleId: "lifecycle-2", capsuleId: "capsule-2" };
    const firstRebind = await post(coordinator, rebind);
    const secondRebind = await post(coordinator, rebind);
    expect(firstRebind.revision).toBe(4);
    expect(secondRebind).toEqual(firstRebind);
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "CONSUMING", lifecycleId: "lifecycle-2", capsuleId: "capsule-2", revision: 4 })
    );
  });

  it("keeps a refused rebind from consuming the right or wedging it", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { publicationState: "PENDING" });

    const blocked = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });
    expect(blocked.outcome).toBe("CAPSULE_MISMATCH");
    // Nothing was consumed, rebound or indexed by the refusal.
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
    expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:capsule-old")).toBe("credit-1");
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-new")).toBe(false);
    expect(env.CREATOR_CREDITS.data.has("creator:credit:lifecycle:identity-1:lifecycle-new")).toBe(false);

    // The right is still usable: it can be bound to ITS OWN capsule for a
    // new attempt (a refused rebind consumes nothing).
    const own = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-resume",
      capsuleId: "capsule-old",
    });
    expect(own.outcome).toBe("RESERVED");
    expect(own.revision).toBe(4);
    expect(own.lifecycleId).toBe("lifecycle-resume");
  });

  it("accepts ABSENT verification records as a positive negative (durable-record invariant)", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { marked: true });

    // No publication and no seal record exist for the released attempt —
    // and those namespaces have no TTL and no delete path, so absence is
    // a positive "never reached that state", not an unknown.
    expect(env.PUBLICATION_VERIFICATIONS.data.size).toBe(0);
    expect(env.SEAL_VERIFICATIONS.data.size).toBe(0);

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result).toEqual({
      ok: true,
      outcome: "RESERVED",
      status: "CONSUMING",
      creatorCreditId: "credit-1",
      lifecycleId: "lifecycle-new",
      revision: 4,
    });
  });

  it("accepts explicitly recognized negative states (REJECTED / NOT_VERIFIED)", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, {
      marked: true,
      publicationState: "REJECTED",
      sealState: "NOT_VERIFIED",
    });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("RESERVED");
    expect(result.revision).toBe(4);
  });

  it("refuses when BOTH the publication and the seal are VERIFIED", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, {
      publicationState: "VERIFIED",
      sealState: "VERIFIED",
    });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
  });

  it("refuses a PENDING seal even when the publication is REJECTED", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, {
      publicationState: "REJECTED",
      sealState: "PENDING",
    });

    const result = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-new",
      capsuleId: "capsule-new",
    });

    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "capsule-old", revision: 3 })
    );
  });

  it("refuses malformed JSON in the publication record", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { publicationRaw: "{not-json" });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("refuses malformed JSON in the seal record", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { sealRaw: "not-json" });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("refuses an unknown publication state", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, {
      publicationState: "PARTIALLY_VERIFIED",
    });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("refuses an unknown seal state", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { sealState: "sealed" });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("refuses a publication record with missing or wrongly typed required fields", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    // Bound to the right lifecycle, but the fields every writer persists
    // are absent: the record is not trustworthy evidence of anything.
    seedStrandedReleasedCredit(env, state, {
      publicationRecord: {
        lifecycleId: "lifecycle-old",
        capsuleId: "capsule-old",
        creatorIdentityId: "identity-1",
        state: "REJECTED",
      },
    });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });


  it("refuses a publication record bound to a different lifecycle", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, {
      publicationRecord: {
        lifecycleId: "lifecycle-someone-else",
        capsuleId: "capsule-old",
        creatorIdentityId: "identity-1",
        state: "REJECTED",
        expectedTxId: "tx-old",
        expectedVaultSha256: null,
        evidenceIds: ["tx-old"],
        createdAt: 1,
        updatedAt: 1,
      },
    });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("refuses a publication record bound to a different capsule", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, {
      publicationRecord: {
        lifecycleId: "lifecycle-old",
        capsuleId: "capsule-someone-else",
        creatorIdentityId: "identity-1",
        state: "REJECTED",
        expectedTxId: "tx-old",
        expectedVaultSha256: null,
        evidenceIds: ["tx-old"],
        createdAt: 1,
        updatedAt: 1,
      },
    });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("fails closed when the publication store read throws", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state);
    (env.PUBLICATION_VERIFICATIONS as unknown as { get: () => Promise<never> }).get =
      async () => {
        throw new Error("publication store unavailable");
      };

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("fails closed when the seal store read throws", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state);
    (env.SEAL_VERIFICATIONS as unknown as { get: () => Promise<never> }).get =
      async () => {
        throw new Error("seal store unavailable");
      };

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  /**
   * PROTOCOL PROVENANCE — issuance stamps, reserve copies, nothing infers.
   */
  it("stamps the protocol marker at trusted issuance and copies it on reserve", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);

    const issued = await issueCredit(coordinator, { creatorCreditId: "creditissued01" });
    expect(issued.outcome).toBe("GRANTED");
    expect(
      (
        JSON.parse(env.CREATOR_CREDITS.data.get("creator:credit:creditissued01")!) as {
          publicationProtocol?: string;
        }
      ).publicationProtocol
    ).toBe(PROTOCOL_MARKER);
    // Issuance deliberately writes no Durable Object record.
    expect(state.data.has("credit:creditissued01")).toBe(false);

    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "creditissued01",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    expect(state.data.get("credit:creditissued01")).toEqual(
      expect.objectContaining({
        status: "CONSUMING",
        publicationProtocol: PROTOCOL_MARKER,
      })
    );
  });

  it("never automatically rebinds a legacy right that has no protocol marker", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state); // LEGACY: no marker

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
    expect(
      (state.data.get("credit:credit-1") as { publicationProtocol?: string })
        .publicationProtocol
    ).toBeUndefined();
  });

  it("does not mark a legacy credit merely because reserve imports it", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedIssuedProjection(env, "credit-1"); // LEGACY projection: no marker

    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    expect(
      (state.data.get("credit:credit-1") as { publicationProtocol?: string })
        .publicationProtocol
    ).toBeUndefined();

    // Its release therefore stays non-rebindable.
    await post(coordinator, {
      op: "recover",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationState: "NOT_VERIFIED",
      sealState: "NOT_VERIFIED",
    });
    const blocked = await tryRebind(coordinator);
    expect(blocked.outcome).toBe("CAPSULE_MISMATCH");
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-new")).toBe(false);
  });

  it("does not promote a legacy credit when its grant claim is merely replayed", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedIssuedProjection(env, "creditissued01"); // LEGACY projection: no marker
    // The historical grant claim already exists in this instance.
    state.data.set("credit-grant:identity-1:quote-1", {
      creatorIdentityId: "identity-1",
      quoteId: "quote-1",
      creatorCreditId: "creditissued01",
      createdAt: 1,
    });

    const replay = await issueCredit(coordinator, { creatorCreditId: "creditissued01" });
    expect(replay.outcome).toBe("ALREADY_GRANTED");
    expect(
      (
        JSON.parse(env.CREATOR_CREDITS.data.get("creator:credit:creditissued01")!) as {
          publicationProtocol?: string;
        }
      ).publicationProtocol
    ).toBeUndefined();
  });

  it("ignores a caller-supplied protocol marker", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedIssuedProjection(env, "credit-1"); // LEGACY projection: no marker

    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      // A hostile/naive caller assertion — must never become provenance.
      publicationProtocol: PROTOCOL_MARKER,
    });

    expect(
      (state.data.get("credit:credit-1") as { publicationProtocol?: string })
        .publicationProtocol
    ).toBeUndefined();
  });

  it("refuses to rebind when any publication claim is recorded, even an explicit failure", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, {
      marked: true,
      claimOutcome: "VAULT_PUBLICATION_EXPLICIT_FAILURE",
    });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("refuses to rebind on a malformed claim record", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { marked: true, claimRaw: "not-an-object" });

    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("preserves the protocol marker through recovery and finalization", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedIssuedProjection(env, "credit-1", { marked: true, state });

    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    await post(coordinator, {
      op: "recover",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationState: "NOT_VERIFIED",
      sealState: "NOT_VERIFIED",
    });
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({
        status: "AVAILABLE",
        publicationProtocol: PROTOCOL_MARKER,
      })
    );

    // Rebind onto a new capsule, then finalize: the SAME right, consumed.
    await post(coordinator, {
      op: "reserve",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-2",
      capsuleId: "capsule-2",
    });
    await post(coordinator, {
      op: "finalize",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-2",
      capsuleId: "capsule-2",
      publicationVerified: true,
      sealVerified: true,
    });
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({
        status: "CONSUMED",
        publicationProtocol: PROTOCOL_MARKER,
      })
    );
  });
});

/* ================= CONTAINER PUBLICATION CLAIM (FINDING F1) ================= */

/**
 * Drive the REAL container-publication instance exactly like
 * /api/publication/claim does: the claim is addressed by NAME to the
 * dedicated instance and is stored there, never in the per-credit object.
 */
async function claimContainer(
  env: TestEnv,
  input: {
    capsuleId?: string;
    lifecycleId?: string;
    creatorIdentityId?: string;
    containerTxId?: string;
  } = {}
) {
  const binding = env.CREDIT_OP_COORDINATOR;
  if (!binding) throw new Error("test env has no coordinator binding");
  const stub = binding.get(binding.idFromName(CONTAINER_CLAIM_INSTANCE));
  const response = await stub.fetch(
    new Request("http://container", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "container-publication-claim",
        capsuleId: input.capsuleId ?? "capsule-old",
        lifecycleId: input.lifecycleId ?? "lifecycle-old",
        creatorIdentityId: input.creatorIdentityId ?? "identity-1",
        containerTxId: input.containerTxId ?? "container-tx-1",
        layoutDigest: "digest-1",
        chunkIds: ["chunk-1"],
      }),
    })
  );
  return (await response.json()) as { ok: boolean; outcome: string };
}

/** Ask the instance that OWNS container claims what it knows. */
async function containerClaimStatus(
  env: TestEnv,
  lifecycleId: string,
  capsuleId?: string
) {
  const binding = env.CREDIT_OP_COORDINATOR;
  if (!binding) throw new Error("test env has no coordinator binding");
  const stub = binding.get(binding.idFromName(CONTAINER_CLAIM_INSTANCE));
  const response = await stub.fetch(
    new Request("http://container", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "container-publication-claim-status",
        lifecycleId,
        ...(capsuleId ? { capsuleId } : {}),
      }),
    })
  );
  return (await response.json()) as {
    ok: boolean;
    claimed: boolean;
    capsuleId?: string | null;
    containerTxId?: string | null;
  };
}

function recoverPayload() {
  return {
    op: "recover",
    creatorCreditId: "credit-1",
    creatorIdentityId: "identity-1",
    lifecycleId: "lifecycle-1",
    capsuleId: "capsule-1",
    publicationState: "NOT_VERIFIED",
    sealState: "NOT_VERIFIED",
  };
}


describe("CreditOperationCoordinator — container claims are authoritative (F1)", () => {
  it("exposes the container claim by capsule AND by lifecycle", async () => {
    const env = createEnv();
    expect(await claimContainer(env)).toEqual(
      expect.objectContaining({ ok: true, outcome: "CONTAINER_PUBLICATION_CLAIMED" })
    );

    expect(await containerClaimStatus(env, "lifecycle-old", "capsule-old")).toEqual(
      expect.objectContaining({
        ok: true,
        claimed: true,
        capsuleId: "capsule-old",
        containerTxId: "container-tx-1",
      })
    );
    // The lifecycle alone must answer: after a recover it is the ONLY
    // identifier that still names the released attempt.
    expect(await containerClaimStatus(env, "lifecycle-old")).toEqual(
      expect.objectContaining({ ok: true, claimed: true, capsuleId: "capsule-old" })
    );
    // Anything never claimed is a POSITIVE negative, not "unknown".
    expect(await containerClaimStatus(env, "lifecycle-never")).toEqual(
      expect.objectContaining({ ok: true, claimed: false })
    );
  });

  it("blocks rebinding a marked right whose attempt published a container, with no vault/seal KV records", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { marked: true });
    await claimContainer(env, { capsuleId: "capsule-old", lifecycleId: "lifecycle-old" });

    const before = new Map(env.CREATOR_CREDITS.data);
    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
    // A refusal mints no right and rewrites no KV projection.
    expect(env.CREATOR_CREDITS.data).toEqual(before);
    expect(
      [...env.CREATOR_CREDITS.data.keys()].filter((key) => key === "creator:credit:credit-1")
    ).toHaveLength(1);
  });

  it("blocks rebinding once the binding was cleared and only the lifecycle association remains", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { marked: true, capsuleId: "" });
    await claimContainer(env, { capsuleId: "capsule-old", lifecycleId: "lifecycle-old" });

    const result = await tryRebind(coordinator);
    expect(result.outcome).toBe("CAPSULE_MISMATCH");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "AVAILABLE", capsuleId: "", revision: 3 })
    );
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-new")).toBe(false);
    expect(env.CREATOR_CREDITS.data.has("creator:credit:lifecycle:identity-1:lifecycle-new")).toBe(
      false
    );
  });

  it("still rebinds a marked right whose attempt has no claim of either kind", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state, { marked: true });

    const result = await tryRebind(coordinator);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("RESERVED");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "CONSUMING", capsuleId: "capsule-new", revision: 4 })
    );
    expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:capsule-new")).toBe(
      "credit-1"
    );
    expect(env.CREATOR_CREDITS.data.has("creator:credit:index:identity-1:capsule-old")).toBe(false);
  });

  it("keeps a legacy right ineligible when the container authority reports no claim", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    seedStrandedReleasedCredit(env, state); // LEGACY: no protocol marker

    expect(await containerClaimStatus(env, "lifecycle-old")).toEqual(
      expect.objectContaining({ claimed: false })
    );
    expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
  });

  it("refuses recovery while a container claim exists", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(
      env,
      creditRecord({
        status: "CONSUMING",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        revision: 2,
      })
    );
    await claimContainer(env, { capsuleId: "capsule-1", lifecycleId: "lifecycle-1" });

    const blocked = await post(coordinator, recoverPayload());
    expect(blocked.ok).toBe(false);
    expect(blocked.outcome).toBe("PUBLICATION_CLAIM_IN_FLIGHT");
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "CONSUMING", capsuleId: "capsule-1", revision: 2 })
    );
  });

  it("keeps container and vault claims independent for the same lifecycle", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(
      env,
      creditRecord({
        status: "CONSUMING",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        revision: 2,
      })
    );

    await claimContainer(env, { capsuleId: "capsule-1", lifecycleId: "lifecycle-1" });
    const vault = await post(coordinator, {
      op: "vault-publication-claim",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    expect(vault).toEqual(
      expect.objectContaining({ ok: true, outcome: "VAULT_PUBLICATION_CLAIMED" })
    );

    // Neither authority replaced the other's record.
    expect(state.data.get("op:credit-1:vault-publication-claim:lifecycle-1")).toEqual(
      expect.objectContaining({ outcome: "VAULT_PUBLICATION_CLAIMED" })
    );
    expect(await containerClaimStatus(env, "lifecycle-1", "capsule-1")).toEqual(
      expect.objectContaining({ claimed: true, containerTxId: "container-tx-1" })
    );

    // Replaying the container claim stays idempotent and leaves the vault claim alone.
    expect(
      await claimContainer(env, { capsuleId: "capsule-1", lifecycleId: "lifecycle-1" })
    ).toEqual(expect.objectContaining({ outcome: "CONTAINER_PUBLICATION_ALREADY_CLAIMED" }));
    expect(state.data.get("op:credit-1:vault-publication-claim:lifecycle-1")).toEqual(
      expect.objectContaining({ outcome: "VAULT_PUBLICATION_CLAIMED" })
    );
  });

  it("fails closed for rebind when the container authority is missing or throwing", async () => {
    for (const mode of ["missing", "throws"] as const) {
      const env = createEnv();
      const { coordinator, state } = createCoordinator(env);
      seedStrandedReleasedCredit(env, state, { marked: true });

      if (mode === "missing") {
        env.CREDIT_OP_COORDINATOR = undefined;
      } else {
        env.CREDIT_OP_COORDINATOR = {
          idFromName: (name: string) => ({ id: name }),
          get: () => ({
            fetch: async () => {
              throw new Error("container authority unreachable");
            },
          }),
        } as unknown as ReturnType<typeof createFakeCreditCoordinatorBinding>;
      }

      expectRebindRefusedWithoutMutation(await tryRebind(coordinator), env, state);
    }
  });

  it("does not turn a transient container lookup failure into a permanent recovery refusal", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(
      env,
      creditRecord({
        status: "CONSUMING",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        revision: 2,
      })
    );
    env.CREDIT_OP_COORDINATOR = undefined;

    const blocked = await post(coordinator, recoverPayload());
    expect(blocked.ok).toBe(false);
    expect(blocked.outcome).toBe("CONTAINER_CLAIM_UNVERIFIED");
    // Unverifiable is TRANSIENT: nothing is recorded, so a retry re-evaluates.
    expect(state.data.has("op:credit-1:recover:lifecycle-1")).toBe(false);
    expect(state.data.get("credit:credit-1")).toEqual(
      expect.objectContaining({ status: "CONSUMING", revision: 2 })
    );

    env.CREDIT_OP_COORDINATOR = createFakeCreditCoordinatorBinding();
    const retried = await post(coordinator, recoverPayload());
    expect(retried.ok).toBe(true);
    expect(retried.outcome).toBe("ABORT_AND_RESTORE_AVAILABLE");
  });

  it("keeps the DO's container instance name identical to the lib constant", () => {
    expect(CONTAINER_CLAIM_INSTANCE).toBe(CONTAINER_PUBLICATION_COORDINATOR_NAME);
  });
});

/* ================= AUTHORITATIVE ISSUANCE PROVENANCE ================= */

/**
 * The protocol marker is no longer a KV assertion: the grant path writes it
 * into the PER-CREDIT Durable Object, i.e. the instance that later decides
 * reserve/recover/rebind, and only acknowledges the right once that write is
 * confirmed.
 */
describe("CreditOperationCoordinator — authoritative issuance provenance", () => {
  it("records the marker in the per-credit instance before acknowledging the grant", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);

    const granted = await issueCredit(coordinator, { creatorCreditId: "creditissued01" });
    expect(granted.outcome).toBe("GRANTED");

    // AUTHORITATIVE record, in the same storage that holds the credit.
    expect(state.data.get("issue-protocol:creditissued01")).toEqual(
      expect.objectContaining({
        creatorCreditId: "creditissued01",
        creatorIdentityId: "identity-1",
        quoteId: "quote-1",
        publicationProtocol: PROTOCOL_MARKER,
      })
    );
    // The KV projection carries it too — but only as a projection.
    expect(
      JSON.parse(String(env.CREATOR_CREDITS.data.get("creator:credit:creditissued01")))
        .publicationProtocol
    ).toBe(PROTOCOL_MARKER);
    // No credit record exists yet: reserve still binds the first capsule.
    expect(state.data.has("credit:creditissued01")).toBe(false);
  });

  it("reserves with the marker even when the KV projection is stale or missing", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    await issueCredit(coordinator, { creatorCreditId: "creditissued01" });

    // Eventual consistency: the KV projection is not (yet) visible.
    env.CREATOR_CREDITS.data.delete("creator:credit:creditissued01");

    const reserved = await post(coordinator, {
      op: "reserve",
      creatorCreditId: "creditissued01",
      creatorIdentityId: "identity-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    expect(reserved.outcome).toBe("RESERVED");

    expect(state.data.get("credit:creditissued01")).toEqual(
      expect.objectContaining({
        status: "CONSUMING",
        publicationProtocol: PROTOCOL_MARKER,
      })
    );
  });

  it("fails closed when provenance cannot be confirmed, then converges on retry", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    const shared = env.CREDIT_OP_COORDINATOR!;

    let failing = true;
    env.CREDIT_OP_COORDINATOR = {
      idFromName: (name: string) => ({ id: name }),
      get: (target: { id: string }) => {
        if (target.id === CONTAINER_CLAIM_INSTANCE) return shared.get(target);
        if (failing) {
          return {
            fetch: async () => {
              throw new Error("provenance write unavailable");
            },
          };
        }
        return { fetch: (request: Request) => coordinator.fetch(request) };
      },
      storages: shared.storages,
    };

    const blocked = await issueCredit(coordinator, { creatorCreditId: "creditissued01" });
    expect(blocked.ok).toBe(false);
    expect(blocked.outcome).toBe("PROTOCOL_PROVENANCE_UNVERIFIED");
    expect(state.data.has("issue-protocol:creditissued01")).toBe(false);
    // Nothing was projected either: no half-issued right is discoverable.
    expect(env.CREATOR_CREDITS.data.has("creator:credit:creditissued01")).toBe(false);

    // The claim (with its intent and id) is durable: the retry completes the
    // SAME issuance and mints nothing new.
    failing = false;
    const retried = await issueCredit(coordinator, { creatorCreditId: "creditissued01" });
    expect(retried.outcome).toBe("ALREADY_GRANTED");
    expect(retried.creatorCreditId).toBe("creditissued01");
    expect(state.data.get("issue-protocol:creditissued01")).toEqual(
      expect.objectContaining({ publicationProtocol: PROTOCOL_MARKER })
    );
    expect(
      [...state.data.keys()].filter((key) => key.startsWith("credit-grant:"))
    ).toEqual(["credit-grant:identity-1:quote-1"]);
    expect(env.CREATOR_CREDITS.data.get("creator:credit:index:identity-1:quote-1")).toBe(
      "creditissued01"
    );
  });

  it("ignores client-supplied marker values in the grant payload", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);

    await post(coordinator, {
      op: "grant",
      creatorIdentityId: "identity-1",
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      transactionId: "tx-1",
      evidenceId: "ev-1",
      creatorCreditId: "creditissued01",
      // Hostile / stale client fields: never honoured.
      publicationProtocol: "client-forged",
      protocolIssuance: false,
    });

    expect(state.data.get("issue-protocol:creditissued01")).toEqual(
      expect.objectContaining({ publicationProtocol: PROTOCOL_MARKER })
    );
    expect(
      state.data.get("credit-grant:identity-1:quote-1")
    ).toEqual(expect.objectContaining({ protocolIssuance: true }));
  });

  it("never backfills the marker on a legacy claim replay", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    // A historical claim: stored WITHOUT issuance intent.
    state.data.set("credit-grant:identity-1:quote-1", {
      creatorIdentityId: "identity-1",
      quoteId: "quote-1",
      creatorCreditId: "creditlegacy001",
      createdAt: 1,
    });

    const replay = await issueCredit(coordinator, { creatorCreditId: "creditlegacy001" });
    expect(replay.outcome).toBe("ALREADY_GRANTED");
    expect(replay.creatorCreditId).toBe("creditlegacy001");

    expect(state.data.has("issue-protocol:creditlegacy001")).toBe(false);
    expect(
      JSON.parse(String(env.CREATOR_CREDITS.data.get("creator:credit:creditlegacy001")))
        .publicationProtocol
    ).toBeUndefined();
  });

  it("heals a credit record created before the provenance write, without a revision bump", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    // The reserve raced the provenance write: the record exists, unmarked.
    state.data.set(
      "credit:creditissued01",
      creditRecord({
        id: "creditissued01",
        status: "AVAILABLE",
        capsuleId: "",
        revision: 3,
      })
    );

    const recorded = await post(coordinator, {
      op: "record-issuance-protocol",
      creatorCreditId: "creditissued01",
      creatorIdentityId: "identity-1",
      quoteId: "quote-1",
    });
    expect(recorded.ok).toBe(true);
    expect(recorded.outcome).toBe("RECORDED");
    expect(state.data.get("credit:creditissued01")).toEqual(
      expect.objectContaining({ publicationProtocol: PROTOCOL_MARKER, revision: 3 })
    );
  });

  it("refuses provenance that disagrees with the recorded issuance", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    await post(coordinator, {
      op: "record-issuance-protocol",
      creatorCreditId: "creditissued01",
      creatorIdentityId: "identity-1",
      quoteId: "quote-1",
    });

    const conflict = await post(coordinator, {
      op: "record-issuance-protocol",
      creatorCreditId: "creditissued01",
      creatorIdentityId: "identity-1",
      quoteId: "quote-2",
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.outcome).toBe("ISSUANCE_MISMATCH");
    // The original provenance is never re-pointed.
    expect(state.data.get("issue-protocol:creditissued01")).toEqual(
      expect.objectContaining({ quoteId: "quote-1" })
    );
  });

  it("keeps the marker through reserve, recover, rebind and finalize", async () => {
    const env = createEnv();
    const { coordinator, state } = createCoordinator(env);
    await issueCredit(coordinator, { creatorCreditId: "creditissued01" });

    expect(
      (
        await post(coordinator, {
          op: "reserve",
          creatorCreditId: "creditissued01",
          creatorIdentityId: "identity-1",
          lifecycleId: "lifecycle-1",
          capsuleId: "capsule-1",
        })
      ).outcome
    ).toBe("RESERVED");

    expect(
      (
        await post(coordinator, {
          op: "recover",
          creatorCreditId: "creditissued01",
          creatorIdentityId: "identity-1",
          lifecycleId: "lifecycle-1",
          capsuleId: "capsule-1",
          publicationState: "NOT_VERIFIED",
          sealState: "NOT_VERIFIED",
        })
      ).outcome
    ).toBe("ABORT_AND_RESTORE_AVAILABLE");
    expect(state.data.get("credit:creditissued01")).toEqual(
      expect.objectContaining({
        status: "AVAILABLE",
        publicationProtocol: PROTOCOL_MARKER,
      })
    );

    expect(
      (
        await post(coordinator, {
          op: "reserve",
          creatorCreditId: "creditissued01",
          creatorIdentityId: "identity-1",
          lifecycleId: "lifecycle-2",
          capsuleId: "capsule-2",
        })
      ).outcome
    ).toBe("RESERVED");

    expect(
      (
        await post(coordinator, {
          op: "finalize",
          creatorCreditId: "creditissued01",
          creatorIdentityId: "identity-1",
          lifecycleId: "lifecycle-2",
          capsuleId: "capsule-2",
          publicationVerified: true,
          sealVerified: true,
        })
      ).outcome
    ).toBe("CONSUMED");
    expect(state.data.get("credit:creditissued01")).toEqual(
      expect.objectContaining({
        status: "CONSUMED",
        publicationProtocol: PROTOCOL_MARKER,
      })
    );
  });
});
