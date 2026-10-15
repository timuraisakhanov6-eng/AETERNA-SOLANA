/**
 * AETERNA — unfinishedLifecycle unit tests (node environment).
 *
 * The recovery HINT store contract (D2):
 *   - MULTI-RECORD: several unfinished attempts are tracked independently;
 *     a new attempt never overwrites another's hint;
 *   - removing one hint leaves the others intact;
 *   - strict shape validation (fail-closed: garbage ⇒ "no record"), with
 *     malformed entries dropped individually so one corrupt record cannot
 *     hide the others;
 *   - both storage generations are readable (v1 single object + v2 array);
 *   - fail-safe storage: a throwing / absent localStorage never crashes and
 *     never fabricates a record;
 *   - the pure response mapping keeps the server as the sole authority.
 *
 * No DOM, no network, no payment.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  MAX_UNFINISHED_LIFECYCLES,
  UNFINISHED_LIFECYCLES_KEY,
  UNFINISHED_LIFECYCLE_KEY,
  describeRecoveryResponse,
  isUnfinishedLifecycleRecord,
  readUnfinishedLifecycles,
  removeUnfinishedLifecycle,
  upsertUnfinishedLifecycle,
  type UnfinishedLifecycleRecord,
} from "@/lib/access/unfinishedLifecycle";

const CAPSULE_ID = "a".repeat(64);
const CAPSULE_ID_2 = "b".repeat(64);
const CAPSULE_ID_3 = "c".repeat(64);

const RECORD_A: UnfinishedLifecycleRecord = {
  creatorIdentityId: "creator-identity-1",
  creatorCreditId: "creator-credit-1",
  lifecycleId: "lifecycle-1",
  capsuleId: CAPSULE_ID,
};

const RECORD_B: UnfinishedLifecycleRecord = {
  creatorIdentityId: "creator-identity-1",
  creatorCreditId: "creator-credit-2",
  lifecycleId: "lifecycle-2",
  capsuleId: CAPSULE_ID_2,
};

const RECORD_C: UnfinishedLifecycleRecord = {
  creatorIdentityId: "creator-identity-1",
  creatorCreditId: "creator-credit-3",
  lifecycleId: "lifecycle-3",
  capsuleId: CAPSULE_ID_3,
};

/* Minimal localStorage stand-in (node env ships none). */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const globalWithStorage = globalThis as unknown as { localStorage?: Storage };

let installed: MemoryStorage | null = null;

beforeEach(() => {
  installed = new MemoryStorage();
  globalWithStorage.localStorage = installed as unknown as Storage;
});

afterEach(() => {
  delete globalWithStorage.localStorage;
  installed = null;
});

describe("isUnfinishedLifecycleRecord", () => {
  it("accepts a well-formed record", () => {
    expect(isUnfinishedLifecycleRecord(RECORD_A)).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isUnfinishedLifecycleRecord(null)).toBe(false);
    expect(isUnfinishedLifecycleRecord(undefined)).toBe(false);
    expect(isUnfinishedLifecycleRecord("record")).toBe(false);
    expect(isUnfinishedLifecycleRecord(42)).toBe(false);
    expect(isUnfinishedLifecycleRecord([])).toBe(false);
  });

  it("rejects a missing or empty required field", () => {
    const { creatorIdentityId: _drop, ...withoutIdentity } = RECORD_A;
    expect(isUnfinishedLifecycleRecord(withoutIdentity)).toBe(false);
    expect(
      isUnfinishedLifecycleRecord({ ...RECORD_A, creatorCreditId: "" })
    ).toBe(false);
    expect(
      isUnfinishedLifecycleRecord({ ...RECORD_A, lifecycleId: "" })
    ).toBe(false);
  });

  it("rejects a capsuleId that fails the canonical regex", () => {
    expect(
      isUnfinishedLifecycleRecord({ ...RECORD_A, capsuleId: "short" })
    ).toBe(false);
    expect(
      isUnfinishedLifecycleRecord({ ...RECORD_A, capsuleId: "A".repeat(64) })
    ).toBe(false);
    expect(
      isUnfinishedLifecycleRecord({ ...RECORD_A, capsuleId: "z".repeat(64) })
    ).toBe(false);
  });

  it("rejects non-string fields", () => {
    expect(
      isUnfinishedLifecycleRecord({ ...RECORD_A, creatorIdentityId: 7 })
    ).toBe(false);
    expect(
      isUnfinishedLifecycleRecord({ ...RECORD_A, capsuleId: 64 })
    ).toBe(false);
  });
});

describe("multi-record storage", () => {
  it("round-trips a single record", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    expect(readUnfinishedLifecycles()).toEqual([RECORD_A]);
  });

  it("SCENARIO 5: two unfinished attempts keep BOTH hints (no overwrite)", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    upsertUnfinishedLifecycle(RECORD_B);

    const records = readUnfinishedLifecycles();
    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([RECORD_A, RECORD_B]));
  });

  it("SCENARIO 5b: a third attempt keeps all three, each bound to its own credit", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    upsertUnfinishedLifecycle(RECORD_B);
    upsertUnfinishedLifecycle(RECORD_C);

    const records = readUnfinishedLifecycles();
    expect(records).toHaveLength(3);
    const byLifecycle = new Map(records.map((r) => [r.lifecycleId, r]));
    expect(byLifecycle.get("lifecycle-1")?.creatorCreditId).toBe("creator-credit-1");
    expect(byLifecycle.get("lifecycle-2")?.creatorCreditId).toBe("creator-credit-2");
    expect(byLifecycle.get("lifecycle-3")?.creatorCreditId).toBe("creator-credit-3");
    // Capsule identity stays bound to its own record.
    expect(byLifecycle.get("lifecycle-2")?.capsuleId).toBe(CAPSULE_ID_2);
  });

  it("re-upserting the same lifecycleId replaces only that record", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    upsertUnfinishedLifecycle(RECORD_B);

    upsertUnfinishedLifecycle({ ...RECORD_A, creatorCreditId: "creator-credit-1b" });

    const records = readUnfinishedLifecycles();
    expect(records).toHaveLength(2);
    expect(
      records.find((r) => r.lifecycleId === "lifecycle-1")?.creatorCreditId
    ).toBe("creator-credit-1b");
    expect(
      records.find((r) => r.lifecycleId === "lifecycle-2")?.creatorCreditId
    ).toBe("creator-credit-2");
  });

  it("SCENARIO 6: removing one hint leaves the others intact", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    upsertUnfinishedLifecycle(RECORD_B);
    upsertUnfinishedLifecycle(RECORD_C);

    removeUnfinishedLifecycle("lifecycle-2");

    const records = readUnfinishedLifecycles();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.lifecycleId).sort()).toEqual([
      "lifecycle-1",
      "lifecycle-3",
    ]);
    expect(records.some((r) => r.lifecycleId === "lifecycle-2")).toBe(false);
  });

  it("removing the last hint clears the collection", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    removeUnfinishedLifecycle("lifecycle-1");
    expect(readUnfinishedLifecycles()).toEqual([]);
    expect(installed?.getItem(UNFINISHED_LIFECYCLES_KEY)).toBeNull();
  });

  it("removing an unknown lifecycleId is a no-op", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    removeUnfinishedLifecycle("lifecycle-does-not-exist");
    expect(readUnfinishedLifecycles()).toEqual([RECORD_A]);
  });

  it("an explicit reset (no lifecycleId) clears everything", () => {
    upsertUnfinishedLifecycle(RECORD_A);
    upsertUnfinishedLifecycle(RECORD_B);
    removeUnfinishedLifecycle();
    expect(readUnfinishedLifecycles()).toEqual([]);
  });

  it("ignores an invalid record (fail-closed)", () => {
    upsertUnfinishedLifecycle({ ...RECORD_A, capsuleId: "nope" });
    expect(readUnfinishedLifecycles()).toEqual([]);
  });

  it("bounds the store to MAX_UNFINISHED_LIFECYCLES entries", () => {
    for (let i = 0; i < MAX_UNFINISHED_LIFECYCLES + 5; i += 1) {
      upsertUnfinishedLifecycle({
        creatorIdentityId: "creator-identity-1",
        creatorCreditId: `creator-credit-${i}`,
        lifecycleId: `lifecycle-${i}`,
        capsuleId: CAPSULE_ID,
      });
    }
    expect(readUnfinishedLifecycles().length).toBe(MAX_UNFINISHED_LIFECYCLES);
  });
});

describe("legacy + corrupt storage tolerance", () => {
  it("reads the v1 single-record format", () => {
    installed?.setItem(UNFINISHED_LIFECYCLE_KEY, JSON.stringify(RECORD_A));
    expect(readUnfinishedLifecycles()).toEqual([RECORD_A]);
  });

  it("merges the v1 record with the v2 collection without duplicating", () => {
    installed?.setItem(UNFINISHED_LIFECYCLE_KEY, JSON.stringify(RECORD_A));
    upsertUnfinishedLifecycle(RECORD_B);
    upsertUnfinishedLifecycle(RECORD_A); // same lifecycle, v2 copy

    expect(readUnfinishedLifecycles()).toHaveLength(2);
  });

  it("the first write migrates away from the legacy key", () => {
    installed?.setItem(UNFINISHED_LIFECYCLE_KEY, JSON.stringify(RECORD_A));
    upsertUnfinishedLifecycle(RECORD_B);
    expect(installed?.getItem(UNFINISHED_LIFECYCLE_KEY)).toBeNull();
    expect(readUnfinishedLifecycles()).toHaveLength(2);
  });

  it("drops only the malformed entries of a corrupt collection", () => {
    installed?.setItem(
      UNFINISHED_LIFECYCLES_KEY,
      JSON.stringify([RECORD_A, { creatorIdentityId: "x" }, "garbage", RECORD_B])
    );
    expect(readUnfinishedLifecycles()).toEqual([RECORD_A, RECORD_B]);
  });

  it("treats unparseable JSON as absent", () => {
    installed?.setItem(UNFINISHED_LIFECYCLES_KEY, "{not json");
    expect(readUnfinishedLifecycles()).toEqual([]);
  });

  it("treats a non-array collection as absent", () => {
    installed?.setItem(UNFINISHED_LIFECYCLES_KEY, JSON.stringify(RECORD_A));
    expect(readUnfinishedLifecycles()).toEqual([]);
  });

  it("read survives a throwing storage (private mode)", () => {
    const hostile = {
      getItem(): string | null {
        throw new Error("storage disabled");
      },
      setItem(): void {
        throw new Error("storage disabled");
      },
      removeItem(): void {
        throw new Error("storage disabled");
      },
    };
    globalWithStorage.localStorage = hostile as unknown as Storage;
    expect(readUnfinishedLifecycles()).toEqual([]);
    expect(() => upsertUnfinishedLifecycle(RECORD_A)).not.toThrow();
    expect(() => removeUnfinishedLifecycle("lifecycle-1")).not.toThrow();
  });

  it("all accessors are no-ops when localStorage is absent", () => {
    delete globalWithStorage.localStorage;
    expect(readUnfinishedLifecycles()).toEqual([]);
    expect(() => upsertUnfinishedLifecycle(RECORD_A)).not.toThrow();
    expect(() => removeUnfinishedLifecycle()).not.toThrow();
  });
});

describe("describeRecoveryResponse (pure response mapping)", () => {
  it("ABORT_AND_RESTORE_AVAILABLE ⇒ restored", () => {
    const outcome = describeRecoveryResponse(200, {
      ok: true,
      outcome: "ABORT_AND_RESTORE_AVAILABLE",
    });
    expect(outcome.kind).toBe("restored");
    expect(outcome.message).toContain("restored");
  });

  it("RETURN_EXISTING ⇒ resolved", () => {
    const outcome = describeRecoveryResponse(200, {
      ok: true,
      outcome: "RETURN_EXISTING",
    });
    expect(outcome.kind).toBe("resolved");
  });

  it("verified publication / seal / in-flight claim ⇒ blocked", () => {
    for (const blocked of [
      "RESUME",
      "PUBLICATION_VERIFIED_AWAITING_FINALIZATION",
      "SEAL_VERIFIED_AWAITING_FINALIZATION",
      "PUBLICATION_CLAIM_IN_FLIGHT",
    ]) {
      const outcome = describeRecoveryResponse(200, {
        ok: true,
        outcome: blocked,
      });
      expect(outcome.kind).toBe("blocked");
      expect(outcome.message).toContain("cannot be undone");
    }
  });

  it("SCENARIO 9: owner-proof rejection ⇒ unauthorized (never 'resolved')", () => {
    for (const error of [
      "OWNER_PROOF_REQUIRED",
      "INVALID_SIGNATURE",
      "CHALLENGE_NOT_FOUND",
      "CHALLENGE_EXPIRED",
      "CHALLENGE_CORRUPT",
      "NETWORK_MISMATCH",
      "ACCOUNT_MISMATCH",
      "INVALID_ACCOUNT",
      "CREATOR_IDENTITY_NOT_FOUND",
      "CREATOR_MISMATCH",
    ]) {
      expect(describeRecoveryResponse(403, { ok: false, error }).kind).toBe(
        "unauthorized"
      );
    }
    // A bare 401/403 with no recognisable code is still an auth failure.
    expect(describeRecoveryResponse(401, {}).kind).toBe("unauthorized");
    expect(describeRecoveryResponse(403, null).kind).toBe("unauthorized");
    // …and never "resolved", which would silently drop the hint.
    expect(
      describeRecoveryResponse(403, { ok: false, error: "INVALID_SIGNATURE" }).kind
    ).not.toBe("resolved");
  });

  it("LIFECYCLE_NOT_FOUND (stale hint, endpoint-level 409) ⇒ resolved", () => {
    const outcome = describeRecoveryResponse(409, {
      error: "LIFECYCLE_NOT_FOUND",
    });
    expect(outcome.kind).toBe("resolved");
  });

  it("an unparseable body ⇒ unknown (retryable)", () => {
    expect(describeRecoveryResponse(500, null).kind).toBe("unknown");
    expect(describeRecoveryResponse(500, "not json").kind).toBe("unknown");
    expect(describeRecoveryResponse(500, {}).kind).toBe("unknown");
    expect(
      describeRecoveryResponse(200, { outcome: "SOMETHING_NEW" }).kind
    ).toBe("unknown");
  });

  it("every kind carries a non-empty English user message", () => {
    const outcomes = [
      describeRecoveryResponse(200, { outcome: "ABORT_AND_RESTORE_AVAILABLE" }),
      describeRecoveryResponse(200, { outcome: "RETURN_EXISTING" }),
      describeRecoveryResponse(200, { outcome: "RESUME" }),
      describeRecoveryResponse(403, { error: "INVALID_SIGNATURE" }),
      describeRecoveryResponse(500, null),
    ];
    for (const outcome of outcomes) {
      expect(outcome.message.length).toBeGreaterThan(10);
      expect(outcome.message).not.toContain("undefined");
    }
  });
});
