/**
 * AETERNA — resumeFinalization planner (Phase 3BM-R4) — pure unit tests.
 *
 * Node environment (no DOM): every rule of the fail-closed resume decision
 * is pinned, including the reason taxonomy the gate surfaces. No network,
 * no wallet, no storage side effects.
 */

import { describe, expect, it } from "vitest";

import {
  PREPARED_CAPSULE_SESSION_KEY,
  isValidResumeSessionCapsuleData,
  planResumeFinalization,
} from "./resumeFinalization";

const CAPSULE_ID = "a".repeat(64);
const OTHER_CAPSULE_ID = "b".repeat(64);
const LIFECYCLE_ID = "lifecycle-1";
const CREDIT_ID = "credit-1";
const IDENTITY_ID = "creator-1";
const STORAGE_PAYMENT_ID = "storage-payment-1";

const SERVER_RECORD = {
  creatorCreditId: CREDIT_ID,
  lifecycleId: LIFECYCLE_ID,
  capsuleId: CAPSULE_ID,
};

const OWNER_HINT = {
  creatorIdentityId: IDENTITY_ID,
  lifecycleId: LIFECYCLE_ID,
};

function validPrepared(capsuleId: string = CAPSULE_ID): Record<string, unknown> {
  return {
    billableSizeBytes: 1024,
    expectedAmount: 1,
    openAt: 1_900_000_000_000,
    itemIds: ["item-1"],
    creatorAuthority: "d".repeat(64),
    capsuleId,
    encryptedVaultPointer: `aeterna-local-vault:${capsuleId}`,
    encryptedSizeBytes: 4096,
    vaultSha256: "a".repeat(64),
    saltBase: "a".repeat(32),
    recipientSecret: "c".repeat(64),
    chunkMetadata: [],
    storagePaymentId: STORAGE_PAYMENT_ID,
  };
}

function plan(overrides?: {
  record?: Partial<typeof SERVER_RECORD>;
  localHint?: { creatorIdentityId: string; lifecycleId: string } | null;
  creatorIdentityId?: string | null;
  preparedRaw?: string | null;
}) {
  return planResumeFinalization({
    record: { ...SERVER_RECORD, ...(overrides?.record ?? {}) },
    localHint:
      overrides?.localHint !== undefined
        ? overrides.localHint
        : OWNER_HINT,
    creatorIdentityId:
      overrides?.creatorIdentityId !== undefined
        ? overrides.creatorIdentityId
        : IDENTITY_ID,
    preparedRaw:
      overrides?.preparedRaw !== undefined
        ? overrides.preparedRaw
        : JSON.stringify(validPrepared()),
  });
}

describe("planResumeFinalization — ready path", () => {
  it("builds the full CapsuleHoldState with the server-bound identity", () => {
    const result = plan();
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;

    expect(result.storagePaymentId).toBe(STORAGE_PAYMENT_ID);
    expect(result.holdState.prepared.capsuleId).toBe(CAPSULE_ID);
    expect(result.holdState.prepared.encryptedVaultPointer).toBe(
      `aeterna-local-vault:${CAPSULE_ID}`
    );
    expect(result.holdState.prepared.vaultSha256).toBe("a".repeat(64));
    expect(result.holdState.prepared.saltBase).toBe("a".repeat(32));
    expect(result.holdState.prepared.recipientSecret).toBe("c".repeat(64));
    expect(result.holdState.prepared.creatorAuthority).toBe("d".repeat(64));
    expect(result.holdState.prepared.encryptedSizeBytes).toBe(4096);
    expect(result.holdState.prepared.chunkMetadata).toEqual([]);
    expect(result.holdState.billableSizeBytes).toBe(1024);
    expect(result.holdState.expectedAmount).toBe(1);
    expect(result.holdState.openAt).toBe(1_900_000_000_000);
    expect(result.holdState.itemIds).toEqual(["item-1"]);
    expect(result.holdState.creatorAuthority).toBe("d".repeat(64));
  });

  it("keeps an optional description only when it is a string", () => {
    const withDescription = plan({
      preparedRaw: JSON.stringify({
        ...validPrepared(),
        description: "hello",
      }),
    });
    expect(withDescription.kind).toBe("ready");
    if (withDescription.kind === "ready") {
      expect(withDescription.holdState.description).toBe("hello");
    }

    const withoutDescription = plan({
      preparedRaw: JSON.stringify({
        ...validPrepared(),
        description: 42,
      }),
    });
    expect(withoutDescription.kind).toBe("ready");
    if (withoutDescription.kind === "ready") {
      expect(withoutDescription.holdState.description).toBeUndefined();
    }
  });
});

describe("planResumeFinalization — fail-closed reasons", () => {
  it("missing server identifiers", () => {
    expect(
      plan({ record: { lifecycleId: null } })
    ).toMatchObject({ kind: "unavailable", reason: "missing-identifiers" });
    expect(
      plan({ record: { capsuleId: "" } })
    ).toMatchObject({ kind: "unavailable", reason: "missing-identifiers" });
    expect(
      plan({ record: { creatorCreditId: undefined } })
    ).toMatchObject({ kind: "unavailable", reason: "missing-identifiers" });
  });

  it("identity mismatch (no hint / other owner / absent active identity)", () => {
    expect(
      plan({ localHint: null })
    ).toMatchObject({ kind: "unavailable", reason: "identity-mismatch" });

    expect(
      plan({
        localHint: {
          creatorIdentityId: "creator-someone-else",
          lifecycleId: LIFECYCLE_ID,
        },
      })
    ).toMatchObject({ kind: "unavailable", reason: "identity-mismatch" });

    expect(
      plan({ creatorIdentityId: null })
    ).toMatchObject({ kind: "unavailable", reason: "identity-mismatch" });

    // A hint for a DIFFERENT lifecycle is not the owner marker.
    expect(
      plan({
        localHint: {
          creatorIdentityId: IDENTITY_ID,
          lifecycleId: "lifecycle-other",
        },
      })
    ).toMatchObject({ kind: "unavailable", reason: "identity-mismatch" });
  });

  it("missing prepared record", () => {
    expect(
      plan({ preparedRaw: null })
    ).toMatchObject({ kind: "unavailable", reason: "missing-prepared-record" });
    expect(
      plan({ preparedRaw: "" })
    ).toMatchObject({ kind: "unavailable", reason: "missing-prepared-record" });
  });

  it("malformed prepared state (bad JSON / wrong shape)", () => {
    expect(
      plan({ preparedRaw: "{not-json" })
    ).toMatchObject({
      kind: "unavailable",
      reason: "malformed-prepared-state",
    });
    expect(
      plan({ preparedRaw: "[]" })
    ).toMatchObject({
      kind: "unavailable",
      reason: "malformed-prepared-state",
    });
    expect(
      plan({ preparedRaw: JSON.stringify({ capsuleId: CAPSULE_ID }) })
    ).toMatchObject({
      kind: "unavailable",
      reason: "malformed-prepared-state",
    });
  });

  it("capsule mismatch is reported separately from a shape failure", () => {
    expect(
      plan({ preparedRaw: JSON.stringify(validPrepared(OTHER_CAPSULE_ID)) })
    ).toMatchObject({ kind: "unavailable", reason: "capsule-mismatch" });

    // The server record differing from the prepared capsule is the same rule.
    expect(
      plan({
        record: { capsuleId: OTHER_CAPSULE_ID },
        preparedRaw: JSON.stringify(validPrepared()),
      })
    ).toMatchObject({ kind: "unavailable", reason: "capsule-mismatch" });
  });

  it("missing storagePaymentId", () => {
    const prepared = validPrepared();
    delete prepared.storagePaymentId;
    expect(
      plan({ preparedRaw: JSON.stringify(prepared) })
    ).toMatchObject({
      kind: "unavailable",
      reason: "missing-storage-payment",
    });
    expect(
      plan({
        preparedRaw: JSON.stringify({ ...validPrepared(), storagePaymentId: "" }),
      })
    ).toMatchObject({
      kind: "unavailable",
      reason: "missing-storage-payment",
    });
  });
});

describe("isValidResumeSessionCapsuleData — canonical mirror", () => {
  it("accepts a fully valid record bound to the expected capsule", () => {
    expect(
      isValidResumeSessionCapsuleData(validPrepared(), CAPSULE_ID)
    ).toBe(true);
  });

  it("rejects a record bound to another capsule (F-5)", () => {
    expect(
      isValidResumeSessionCapsuleData(validPrepared(), OTHER_CAPSULE_ID)
    ).toBe(false);
  });

  it("rejects non-canonical field values", () => {
    const badSha = validPrepared();
    badSha.vaultSha256 = "z".repeat(64);
    expect(isValidResumeSessionCapsuleData(badSha, CAPSULE_ID)).toBe(false);

    const badSize = validPrepared();
    badSize.billableSizeBytes = 0;
    expect(isValidResumeSessionCapsuleData(badSize, CAPSULE_ID)).toBe(false);

    const badExpectedAmount = validPrepared();
    delete badExpectedAmount.expectedAmount;
    expect(
      isValidResumeSessionCapsuleData(badExpectedAmount, CAPSULE_ID)
    ).toBe(false);
  });
});

describe("module surface", () => {
  it("keeps the canonical sessionStorage key", () => {
    expect(PREPARED_CAPSULE_SESSION_KEY).toBe("aeterna-prepared-capsule");
  });
});
