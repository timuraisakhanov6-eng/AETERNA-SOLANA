/**
 * AETERNA — publication claim 409 classification (client boundary).
 *
 * THE RULE
 * --------
 * A 409 from `/api/publication/claim` is NEVER accepted as success merely
 * because its code looks benign. The client distinguishes:
 *
 *   • corroborated idempotent REPLAY  → accepted (the claim already holds
 *     for this exact txId; the authoritative verify step still runs)
 *   • genuine CONFLICT                → fail closed
 *   • unrecognised / uncorroborated   → fail closed
 *
 * The client cache can never promote a publication to VERIFIED; server
 * authority is unchanged.
 *
 * The Irys upload is mocked away so these tests exercise ONLY the claim
 * boundary — no Irys, no wallet, no network beyond the fetch double.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  uploadCreatorData: vi.fn(async () => ({ dataTxId: "tx".padEnd(43, "Z") })),
}));

vi.mock("@/lib/storage/creatorIrys", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/storage/creatorIrys")>();
  return {
    ...actual,
    uploadCreatorData: hoisted.uploadCreatorData,
  };
});

import { createCreatorIrysStorage } from "./creatorIrysStorage";

function makeCtx() {
  return {
    wallet: {
      publicKey: {},
      signMessage: async () => new Uint8Array([1]),
    },
    creatorIdentityId: "creator-1",
    lifecycleId: "lifecycle-1",
    capsuleId: "a".repeat(64),
    storagePaymentId: "storage-payment-1",
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

/** Install a fetch double returning one fixed claim response. */
function installClaimResponse(res: Response): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function claimViaVaultUpload() {
  const storage = createCreatorIrysStorage(makeCtx());
  return storage.upload(new Uint8Array([1, 2, 3]), "token" as never);
}

describe("creatorIrysStorage — publication claim 409 classification", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    hoisted.uploadCreatorData.mockClear();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("ACCEPT: a corroborated already-claimed replay (claimed:true) resolves", async () => {
    const r = installClaimResponse(
      jsonResponse(409, { ok: false, error: "ALREADY_CLAIMED", claimed: true })
    );
    restoreFetch = r.restore;

    const result = await claimViaVaultUpload();
    expect(result.txId).toBe("tx".padEnd(43, "Z"));
    expect(r.calls.some((u) => u.includes("/api/publication/claim"))).toBe(true);
  });

  it("ACCEPT: a corroborated container replay (state:PENDING) resolves", async () => {
    const r = installClaimResponse(
      jsonResponse(409, {
        ok: false,
        error: "CONTAINER_ALREADY_PUBLISHED",
        state: "PENDING",
      })
    );
    restoreFetch = r.restore;

    const result = await claimViaVaultUpload();
    expect(result.txId).toBe("tx".padEnd(43, "Z"));
  });

  it("REJECT: a benign code WITHOUT corroboration fails closed", async () => {
    // The same code, but the server does NOT report the already-claimed
    // outcome — an uncorroborated 409 must NOT be treated as success.
    const r = installClaimResponse(
      jsonResponse(409, { ok: false, error: "ALREADY_CLAIMED" })
    );
    restoreFetch = r.restore;

    await expect(claimViaVaultUpload()).rejects.toThrow(/publication claim failed/);
  });

  it("REJECT: a genuine conflict (CAPSULE_MISMATCH) fails closed", async () => {
    const r = installClaimResponse(
      jsonResponse(409, { ok: false, error: "CAPSULE_MISMATCH" })
    );
    restoreFetch = r.restore;

    await expect(claimViaVaultUpload()).rejects.toThrow(/CAPSULE_MISMATCH/);
  });

  it("REJECT: a lifecycle/reservation conflict fails closed", async () => {
    const r = installClaimResponse(
      jsonResponse(409, { ok: false, error: "LIFECYCLE_NOT_RESERVED" })
    );
    restoreFetch = r.restore;

    await expect(claimViaVaultUpload()).rejects.toThrow(/LIFECYCLE_NOT_RESERVED/);
  });

  it("REJECT: TX_ALREADY_CLAIMED (cross-capsule) fails closed", async () => {
    const r = installClaimResponse(
      jsonResponse(409, { ok: false, error: "TX_ALREADY_CLAIMED" })
    );
    restoreFetch = r.restore;

    await expect(claimViaVaultUpload()).rejects.toThrow(/TX_ALREADY_CLAIMED/);
  });

  it("REJECT: PUBLICATION_NOT_CONFIRMED (node not yet confirming) fails closed", async () => {
    const r = installClaimResponse(
      jsonResponse(409, { ok: false, error: "PUBLICATION_NOT_CONFIRMED" })
    );
    restoreFetch = r.restore;

    await expect(claimViaVaultUpload()).rejects.toThrow(/PUBLICATION_NOT_CONFIRMED/);
  });

  it("REJECT: an unknown 409 code fails closed", async () => {
    const r = installClaimResponse(
      jsonResponse(409, { ok: false, error: "SOMETHING_NEW" })
    );
    restoreFetch = r.restore;

    await expect(claimViaVaultUpload()).rejects.toThrow(/SOMETHING_NEW/);
  });

  it("ACCEPT: a healthy 200 resolves (regression)", async () => {
    const r = installClaimResponse(
      jsonResponse(200, { ok: true, claimed: true, state: "PENDING" })
    );
    restoreFetch = r.restore;

    const result = await claimViaVaultUpload();
    expect(result.txId).toBe("tx".padEnd(43, "Z"));
  });
});
