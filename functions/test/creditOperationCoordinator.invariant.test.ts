import { describe, expect, it } from "vitest";
import type { CreditRecord, OpResult } from "../do/creditOperationCoordinator";
import { CreditOperationCoordinator } from "../do/creditOperationCoordinator";

interface FakeStorage {
  data: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
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
  };
}

interface TestEnv {
  CREATOR_CREDITS: FakeStorage;
  PUBLICATION_VERIFICATIONS: FakeStorage;
  SEAL_VERIFICATIONS: FakeStorage;
}

function createEnv(): TestEnv {
  return {
    CREATOR_CREDITS: createFakeStorage(),
    PUBLICATION_VERIFICATIONS: createFakeStorage(),
    SEAL_VERIFICATIONS: createFakeStorage(),
  };
}

function creditRecord(partial: Partial<CreditRecord> = {}): CreditRecord {
  return {
    id: partial.id ?? "credit-1",
    creatorIdentityId: partial.creatorIdentityId ?? "identity-1",
    status: partial.status ?? "AVAILABLE",
    capsuleId: partial.capsuleId ?? "capsule-1",
    lifecycleId: partial.lifecycleId ?? null,
    revision: partial.revision ?? 1,
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

function createCoordinator(env: TestEnv, existingCredit?: CreditRecord) {
  const state = createFakeStorage();
  if (existingCredit) {
    state.data.set(`credit:${existingCredit.id}`, existingCredit);
  }

  const durableState = {
    storage: state,
  };

  return { coordinator: new CreditOperationCoordinator(durableState, env), state };
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
