/**
 * AETERNA — identity-scoped entitlement coordinator invariants
 *
 * The identity coordinator is the atomic purchase guard: it owns the
 * strongly consistent index of every Creator Credit and payment attempt
 * of ONE creator identity, and it is the only place where "no live
 * right" may be concluded.
 *
 * These invariants pin the guarantees the KV projection can NOT give:
 *
 *  1. at most ONE purchase attempt per identity, decided atomically
 *     (two tabs / two devices can never both reserve);
 *  2. a new purchase is refused while an AVAILABLE or CONSUMING right
 *     exists — a lost localStorage hint cannot resurrect a second $1;
 *  3. a credit is recorded in the index only AFTER it was minted, and a
 *     grant without a reserved attempt is refused;
 *  4. the index follows reserve / finalize / recover;
 *  5. the one-time backfill of PRE-EXISTING credits dedupes by
 *     creatorCreditId, re-validates ownership, and leaves the guard
 *     FAIL-CLOSED whenever the enumeration cannot be completed.
 */

import { describe, expect, it } from "vitest";
import {
  createFakeCreditCoordinatorBinding,
  createFakeKV,
  createFakeDurableObjectStorage,
} from "./harness";
import { CreditOperationCoordinator } from "../do/creditOperationCoordinator";

const IDENTITY = "creator-identity-1";

interface Harness {
  env: {
    CREATOR_CREDITS: ReturnType<typeof createFakeKV>;
    PUBLICATION_VERIFICATIONS: { get(key: string): Promise<string | null> };
    SEAL_VERIFICATIONS: { get(key: string): Promise<string | null> };
    CREDIT_OP_COORDINATOR: ReturnType<typeof createFakeCreditCoordinatorBinding>;
  };
  /** The identity coordinator instance. */
  identity: (payload: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;
  /** A per-credit coordinator instance. */
  perCredit: (id: string, payload: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;
  /** KV projections used to seed PRE-EXISTING credits. */
  kv: ReturnType<typeof createFakeKV>;
  /** Per-instance DO storages, for direct assertions. */
  storages: Map<string, ReturnType<typeof createFakeDurableObjectStorage>>;
}

function createHarness(options: { listComplete?: boolean } = {}): Harness {
  const kv = createFakeKV();
  if (options.listComplete === false) {
    // Emulate an incomplete KV listing (more pages exist).
    (kv as unknown as { list: unknown }).list = async () => ({
      keys: [],
      list_complete: false,
    });
  }
  const binding = createFakeCreditCoordinatorBinding({ creatorCredits: kv });
  const env = {
    CREATOR_CREDITS: kv,
    PUBLICATION_VERIFICATIONS: { get: async () => null },
    SEAL_VERIFICATIONS: { get: async () => null },
    CREDIT_OP_COORDINATOR: binding,
  };

  const call = async (name: string, payload: Record<string, unknown>) => {
    const stub = binding.get(binding.idFromName(name));
    const res = await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  return {
    env,
    kv,
    storages: binding.storages,
    identity: (payload) => call(`identity:${IDENTITY}`, payload),
    perCredit: (id, payload) => call(id, payload),
  };
}

/** The full happy path: reserve an attempt, authorize, mint, record. */
async function reserveAndGrant(
  h: Harness,
  input: { quoteId: string; paymentIntentId: string; creditId: string }
) {
  const attempt = await h.identity({
    op: "identity-reserve-attempt",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
  });
  const authorize = await h.identity({
    op: "identity-authorize-grant",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
    transactionId: `tx-${input.quoteId}`,
  });
  const granted = await h.perCredit(input.creditId, {
    op: "grant",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
    transactionId: `tx-${input.quoteId}`,
    evidenceId: `ev-${input.quoteId}`,
    creatorCreditId: authorize.json["creatorCreditId"],
  });
  const note = await h.identity({
    op: "identity-note-grant",
    creatorIdentityId: IDENTITY,
    quoteId: input.quoteId,
    paymentIntentId: input.paymentIntentId,
    creatorCreditId: granted.json["creatorCreditId"],
  });
  return { attempt, authorize, granted, note };
}

/** Seed a PRE-EXISTING credit the way the legacy flow did (KV only). */
function seedLegacyCredit(
  kv: ReturnType<typeof createFakeKV>,
  creditId: string,
  status: string,
  options: { creatorIdentityId?: string; capsuleId?: string } = {}
) {
  kv.put(
    `creator:credit:${creditId}`,
    JSON.stringify({
      id: creditId,
      creatorIdentityId: options.creatorIdentityId ?? IDENTITY,
      status,
      quoteId: `intent-${creditId}`,
      capsuleId: options.capsuleId ?? `capsule-${creditId}`,
      lifecycleId: status === "CONSUMING" ? `lifecycle-${creditId}` : null,
      revision: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    })
  );
  kv.put(
    `creator:credit:index:${IDENTITY}:${options.capsuleId ?? `capsule-${creditId}`}`,
    creditId
  );
}

describe("identity coordinator — atomic purchase guard", () => {
  it("reserves exactly one attempt for an identity with no rights", async () => {
    const h = createHarness();
    const res = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
    });
    expect(res.status).toBe(200);
    expect(res.json["state"]).toBe("reserved");

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.status).toBe(200);
    expect(summary.json["activeAttempt"]).toEqual(
      expect.objectContaining({ paymentIntentId: "intent-1", state: "reserved" })
    );
    expect(summary.json["summary"]).toEqual(
      expect.objectContaining({ availableCount: 0, consumingCount: 0 })
    );
  });

  it("serializes CONCURRENT reservations: a second tab can never reserve its own purchase", async () => {
    const h = createHarness();
    const [first, second] = await Promise.all([
      h.identity({
        op: "identity-reserve-attempt",
        creatorIdentityId: IDENTITY,
        quoteId: "quote-tab-1",
        paymentIntentId: "intent-tab-1",
      }),
      h.identity({
        op: "identity-reserve-attempt",
        creatorIdentityId: IDENTITY,
        quoteId: "quote-tab-2",
        paymentIntentId: "intent-tab-2",
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.json["error"]).toBe("PAYMENT_ATTEMPT_ACTIVE");
    // The loser is told WHICH attempt to continue instead of being
    // allowed to create a second one.
    expect(
      (loser.json["activeAttempt"] as { paymentIntentId: string }).paymentIntentId
    ).toBe(first.status === 200 ? "intent-tab-1" : "intent-tab-2");
  });

  it("refuses a new purchase while an AVAILABLE right exists (no localStorage hint needed)", async () => {
    const h = createHarness();
    const { granted } = await reserveAndGrant(h, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit-1",
    });
    expect(granted.status).toBe(200);

    const second = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-2",
      paymentIntentId: "intent-2",
    });
    expect(second.status).toBe(409);
    expect(second.json["error"]).toBe("CREATOR_ALREADY_HAS_LIVE_RIGHT");

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.json["summary"]).toEqual(
      expect.objectContaining({ availableCount: 1 })
    );
  });

  it("refuses a new purchase while a CONSUMING right exists, and reports the lifecycle for recovery", async () => {
    const h = createHarness();
    const { granted } = await reserveAndGrant(h, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit-1",
    });
    const creditId = String(granted.json["creatorCreditId"]);

    const reserved = await h.perCredit(creditId, {
      op: "reserve",
      creatorCreditId: creditId,
      creatorIdentityId: IDENTITY,
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    expect(reserved.status).toBe(200);
    await h.identity({
      op: "identity-note-reserve",
      creatorIdentityId: IDENTITY,
      creatorCreditId: creditId,
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });

    const blocked = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-2",
      paymentIntentId: "intent-2",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json["error"]).toBe("CREATOR_ALREADY_HAS_LIVE_RIGHT");

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.json["consuming"]).toEqual([
      expect.objectContaining({
        creatorCreditId: creditId,
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      }),
    ]);
  });

  it("refuses a grant that was never reserved (scenario 10)", async () => {
    const h = createHarness();
    const authorize = await h.identity({
      op: "identity-authorize-grant",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      transactionId: "tx-1",
    });
    expect(authorize.status).toBe(409);
    expect(authorize.json["error"]).toBe("GRANT_NOT_RESERVED");
  });

  it("mints the SAME credit id when an interrupted authorization is retried", async () => {
    const h = createHarness();
    await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
    });
    const first = await h.identity({
      op: "identity-authorize-grant",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      transactionId: "tx-1",
    });
    const second = await h.identity({
      op: "identity-authorize-grant",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      transactionId: "tx-1",
    });
    expect(first.json["creatorCreditId"]).toBe(second.json["creatorCreditId"]);
    expect(second.json["state"]).toBe("granting");
  });

  it("follows finalize: after the right is CONSUMED a new purchase is allowed again", async () => {
    const h = createHarness();
    const { granted } = await reserveAndGrant(h, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit-1",
    });
    const creditId = String(granted.json["creatorCreditId"]);

    await h.perCredit(creditId, {
      op: "reserve",
      creatorCreditId: creditId,
      creatorIdentityId: IDENTITY,
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    await h.identity({
      op: "identity-note-reserve",
      creatorIdentityId: IDENTITY,
      creatorCreditId: creditId,
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });

    const blocked = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-2",
      paymentIntentId: "intent-2",
    });
    expect(blocked.status).toBe(409);

    await h.perCredit(creditId, {
      op: "finalize",
      creatorCreditId: creditId,
      creatorIdentityId: IDENTITY,
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationVerified: true,
      sealVerified: true,
    });
    await h.identity({
      op: "identity-note-finalize",
      creatorIdentityId: IDENTITY,
      creatorCreditId: creditId,
    });

    const allowed = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-3",
      paymentIntentId: "intent-3",
    });
    expect(allowed.status).toBe(200);

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.json["summary"]).toEqual(
      expect.objectContaining({ availableCount: 0, consumedCount: 1 })
    );
  });

  it("follows recover: a restored right becomes AVAILABLE again and blocks a new purchase", async () => {
    const h = createHarness();
    const { granted } = await reserveAndGrant(h, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit-1",
    });
    const creditId = String(granted.json["creatorCreditId"]);

    await h.identity({
      op: "identity-note-reserve",
      creatorIdentityId: IDENTITY,
      creatorCreditId: creditId,
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });
    await h.identity({
      op: "identity-note-recover",
      creatorIdentityId: IDENTITY,
      creatorCreditId: creditId,
    });

    const blocked = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-2",
      paymentIntentId: "intent-2",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json["error"]).toBe("CREATOR_ALREADY_HAS_LIVE_RIGHT");
  });
});

describe("identity coordinator — backfill of pre-existing credits", () => {
  it("discovers a legacy AVAILABLE credit and blocks a second purchase", async () => {
    const h = createHarness();
    seedLegacyCredit(h.kv, "legacy-credit-1", "AVAILABLE");

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.status).toBe(200);
    expect(summary.json["summary"]).toEqual(
      expect.objectContaining({ availableCount: 1, enumerationComplete: true })
    );

    const blocked = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json["error"]).toBe("CREATOR_ALREADY_HAS_LIVE_RIGHT");
  });

  it("dedupes one credit reachable through BOTH index shapes", async () => {
    const h = createHarness();
    seedLegacyCredit(h.kv, "legacy-credit-1", "AVAILABLE");
    // The quote-keyed shape points at the SAME credit.
    h.kv.put(
      `creator:credit:index:${IDENTITY}:intent-legacy-credit-1`,
      "legacy-credit-1"
    );

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.json["summary"]).toEqual(
      expect.objectContaining({ availableCount: 1, total: 1 })
    );
  });

  it("reports a CONSUMING legacy credit as consuming (recovery identifiers included)", async () => {
    const h = createHarness();
    seedLegacyCredit(h.kv, "legacy-credit-1", "CONSUMING");
    h.kv.put(
      `creator:credit:lifecycle:${IDENTITY}:lifecycle-legacy-credit-1`,
      JSON.stringify({
        id: "legacy-credit-1",
        creatorIdentityId: IDENTITY,
        status: "CONSUMING",
        lifecycleId: "lifecycle-legacy-credit-1",
        capsuleId: "capsule-legacy-credit-1",
        revision: 2,
        updatedAt: 1_700_000_000_000,
      })
    );

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.json["consuming"]).toEqual([
      expect.objectContaining({
        creatorCreditId: "legacy-credit-1",
        lifecycleId: "lifecycle-legacy-credit-1",
      }),
    ]);
    // …and a new purchase is refused without any client hint.
    const blocked = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
    });
    expect(blocked.json["error"]).toBe("CREATOR_ALREADY_HAS_LIVE_RIGHT");
  });

  it("fails CLOSED when the KV listing is incomplete", async () => {
    const h = createHarness({ listComplete: false });
    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.status).toBe(409);
    expect(summary.json["error"]).toBe("ENUMERATION_INCOMPLETE");

    const blocked = await h.identity({
      op: "identity-reserve-attempt",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json["error"]).toBe("ENUMERATION_INCOMPLETE");
  });

  it("fails CLOSED on an unresolvable pointer (unknown old right)", async () => {
    const h = createHarness();
    h.kv.put(`creator:credit:index:${IDENTITY}:capsule-ghost`, "ghost-credit");

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.status).toBe(409);
    expect(summary.json["error"]).toBe("ENTITLEMENT_STATE_UNKNOWN");
  });

  it("fails CLOSED when a record reachable through the identity prefix belongs to someone else", async () => {
    const h = createHarness();
    seedLegacyCredit(h.kv, "foreign-credit", "AVAILABLE", {
      creatorIdentityId: "someone-else",
    });

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.status).toBe(409);
    expect(summary.json["error"]).toBe("ENTITLEMENT_STATE_UNKNOWN");
  });

  it("keeps the backfill INCOMPLETE until it succeeds (no silent downgrade)", async () => {
    const h = createHarness({ listComplete: false });
    await h.identity({ op: "identity-summary", creatorIdentityId: IDENTITY });

    // A later complete listing must still be able to finish the backfill.
    (h.kv as unknown as { list: unknown }).list = async (options: { prefix?: string }) => ({
      keys: [...h.kv.data.keys()]
        .filter((name) => name.startsWith(options.prefix ?? ""))
        .map((name) => ({ name })),
      list_complete: true,
    });
    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.status).toBe(200);
    expect(summary.json["summary"]).toEqual(
      expect.objectContaining({ enumerationComplete: true })
    );
  });
});

describe("identity coordinator — isolation and validation", () => {
  it("keeps two identities' rights and attempts completely separate", async () => {
    const h = createHarness();
    await reserveAndGrant(h, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit-1",
    });

    const otherIdentity = await (async () => {
      const stub = h.env.CREDIT_OP_COORDINATOR.get(
        h.env.CREDIT_OP_COORDINATOR.idFromName("identity:creator-identity-2")
      );
      const res = await stub.fetch(
        new Request("https://aeterna-credit-coordinator.invalid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "identity-reserve-attempt",
            creatorIdentityId: "creator-identity-2",
            quoteId: "quote-other",
            paymentIntentId: "intent-other",
          }),
        })
      );
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    })();

    // The other identity has no right of its own: it may reserve.
    expect(otherIdentity.status).toBe(200);
  });

  it("rejects malformed payloads instead of guessing", async () => {
    const h = createHarness();
    const res = await h.identity({ op: "identity-summary" });
    expect(res.status).toBe(400);
    expect(res.json["error"]).toBe("INVALID_FIELDS");
  });

  it("is idempotent for the same note (repeated index maintenance is safe)", async () => {
    const h = createHarness();
    const { granted } = await reserveAndGrant(h, {
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creditId: "credit-1",
    });
    const creditId = String(granted.json["creatorCreditId"]);

    const first = await h.identity({
      op: "identity-note-grant",
      creatorIdentityId: IDENTITY,
      quoteId: "quote-1",
      paymentIntentId: "intent-1",
      creatorCreditId: creditId,
    });
    expect(first.json["outcome"]).toBe("ALREADY_RECORDED");

    const summary = await h.identity({
      op: "identity-summary",
      creatorIdentityId: IDENTITY,
    });
    expect(summary.json["summary"]).toEqual(
      expect.objectContaining({ availableCount: 1, total: 1 })
    );
  });
});
