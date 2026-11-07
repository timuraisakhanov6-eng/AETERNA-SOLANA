/**
 * R9-A92 F3 — the publication-claim boundary classifies its failures.
 *
 * THE RULE
 * --------
 * A DEFINITIVE server answer (an authoritative conflict or a malformed
 * request) carries sealRetryPolicy="terminal": the caller's bounded
 * retry loop stops instead of repeating an identical request that cannot
 * change the outcome. TRANSIENT answers (node not yet confirming,
 * coordination unavailable, rate limit, transport, unknown codes) stay
 * "retryable" under the existing bounded policy.
 *
 * The classification uses ONLY the fixed server error code — no body
 * payload is stored. The Irys upload is mocked away; only the claim
 * boundary is exercised.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { readSealRetryPolicy } from "@/lib/capsule/sealDiagnostic";

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
    creatorCreditId: "credit-1",
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

function installClaimResponse(res: Response): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(() => Promise.resolve(res)) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function claimViaVaultUpload() {
  const storage = createCreatorIrysStorage(makeCtx());
  return storage.upload(new Uint8Array([1, 2, 3]), "token" as never);
}

async function expectPolicy(
  status: number,
  body: Record<string, unknown>,
  policy: "terminal" | "retryable",
  messagePart: string
) {
  const install = installClaimResponse(jsonResponse(status, body));
  try {
    await expect(claimViaVaultUpload()).rejects.toSatisfy((error: unknown) => {
      expect(readSealRetryPolicy(error)).toBe(policy);
      expect((error as Error).message).toContain(messagePart);
      return true;
    });
  } finally {
    install.restore();
  }
}

describe("creatorIrysStorage — claim retry classification (R9-A92 F3)", () => {
  beforeEach(() => {
    hoisted.uploadCreatorData.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("terminal: an authoritative lifecycle conflict", async () => {
    await expectPolicy(409, { ok: false, error: "LIFECYCLE_NOT_RESERVED" }, "terminal", "LIFECYCLE_NOT_RESERVED");
  });

  it("terminal: a capsule/state conflict", async () => {
    await expectPolicy(409, { ok: false, error: "CAPSULE_MISMATCH" }, "terminal", "CAPSULE_MISMATCH");
  });

  it("terminal: an already-published container conflict", async () => {
    await expectPolicy(409, { ok: false, error: "CONTAINER_ALREADY_PUBLISHED" }, "terminal", "CONTAINER_ALREADY_PUBLISHED");
  });

  it("terminal: a spent transaction id", async () => {
    await expectPolicy(409, { ok: false, error: "TX_ALREADY_CLAIMED" }, "terminal", "TX_ALREADY_CLAIMED");
  });

  it("terminal: a malformed request (client error)", async () => {
    await expectPolicy(400, { ok: false, error: "INVALID_TX_ID" }, "terminal", "INVALID_TX_ID");
  });

  it("RETRYABLE: the node has not confirmed yet (the server's own retryable 409)", async () => {
    await expectPolicy(409, { ok: false, error: "PUBLICATION_NOT_CONFIRMED" }, "retryable", "PUBLICATION_NOT_CONFIRMED");
  });

  it("RETRYABLE: coordination unavailable", async () => {
    await expectPolicy(503, { ok: false, error: "CONTAINER_CLAIM_UNAVAILABLE" }, "retryable", "CONTAINER_CLAIM_UNAVAILABLE");
  });

  it("RETRYABLE: rate limited", async () => {
    await expectPolicy(429, { ok: false, error: "TOO_MANY_REQUESTS" }, "retryable", "TOO_MANY_REQUESTS");
  });

  it("RETRYABLE: an unknown 409 keeps the pre-existing bounded retry", async () => {
    await expectPolicy(409, { ok: false, error: "SOMETHING_NEW" }, "retryable", "SOMETHING_NEW");
  });

  it("RETRYABLE: a transport failure stays transient and unchanged", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new TypeError("network down"))
    ) as unknown as typeof fetch;
    try {
      await expect(claimViaVaultUpload()).rejects.toSatisfy((error: unknown) => {
        expect((error as Error).message).toContain("network down");
        expect(readSealRetryPolicy(error)).toBe("retryable");
        return true;
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("a corroborated replay still resolves (regression)", async () => {
    const install = installClaimResponse(
      jsonResponse(409, { ok: false, error: "ALREADY_CLAIMED", claimed: true })
    );
    try {
      const result = await claimViaVaultUpload();
      expect(result.txId).toBe("tx".padEnd(43, "Z"));
    } finally {
      install.restore();
    }
  });

  it("the claim body carries the creatorCreditId ADDRESS (R9-A92 F1)", async () => {
    let captured: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return Promise.resolve(jsonResponse(200, { ok: true, claimed: true }));
    }) as unknown as typeof fetch;
    try {
      await claimViaVaultUpload();
      expect(captured).toContain('"creatorCreditId":"credit-1"');
    } finally {
      globalThis.fetch = original;
    }
  });

  it("a context WITHOUT the address sends a legacy body without the field", async () => {
    const ctx = makeCtx();
    delete (ctx as { creatorCreditId?: string }).creatorCreditId;
    let captured: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return Promise.resolve(jsonResponse(200, { ok: true, claimed: true }));
    }) as unknown as typeof fetch;
    try {
      const storage = createCreatorIrysStorage(ctx);
      await storage.upload(new Uint8Array([1, 2, 3]), "token" as never);
      expect(captured).not.toContain("creatorCreditId");
    } finally {
      globalThis.fetch = original;
    }
  });
});
