/**
 * AETERNA — storage verification retry safety (verify-only, never re-fund).
 *
 * The creator pays Irys directly with USDC. If verification then fails, the
 * review is preserved so the payment can be retried — which means a second
 * entry into the flow must NOT fund again, and the retry must touch nothing but
 * /api/storage/verify-payment.
 *
 * These tests pin the exported decision points from CapsuleBuilder.tsx
 * (same pattern as walletFlowEvent / shouldClearStorageReviewOnVerifyFailure):
 *
 * - resolveExistingFundingSignature / ensureStorageFundingSignature:
 *   a storagePaymentId that already has a signature never reaches the funding
 *   callback (G, J);
 * - requestStoragePaymentVerification: exactly one POST, to that one endpoint (H);
 * - verifyStoragePaymentWithRetry: retries ONLY while the outcome is
 *   TRANSACTION_PENDING, bounded, and stops immediately on success or any
 *   terminal reason (I, K).
 *
 * No DOM, no wallet, no network: fetch is stubbed and the funding callback is a
 * spy, so no signature can be requested and no USDC can move.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  ensureStorageFundingSignature,
  isValidFundingSignature,
  readStoredFundingSignature,
  requestStoragePaymentVerification,
  resolveExistingFundingSignature,
  storeFundingSignature,
  verifyStoragePaymentWithRetry,
  FUNDING_LEDGER_KEY_PREFIX,
  STORAGE_VERIFY_MAX_ATTEMPTS,
  type StorageFundingLedger,
} from "@/components/capsule/storageVerificationRetry";

const STORAGE_PAYMENT_ID = "storage-pay-765239e5-f0b7-4aa8-ad18-7835b429954e";
const SIGNATURE =
  "3ET8Mg8axvZNgkwPDyGv9XDa5PonogHZTmESV8f7CcEsZhnZm5s67qk92Xtkezd3XNYvDNbLBaoP8p8bQSszZBTi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    impl(String(input), init)
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Minimal in-memory sessionStorage so the reload path is testable in node. */
function makeSessionStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("funding-signature persistence (sessionStorage)", () => {
  it("A. the first funding stores the signature", async () => {
    const store = makeSessionStorage();
    vi.stubGlobal("sessionStorage", store);

    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));

    const result = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );

    expect(result.funded).toBe(true);
    expect(fund).toHaveBeenCalledTimes(1);
    // Persisted under the payment id, before verification runs.
    expect(readStoredFundingSignature(STORAGE_PAYMENT_ID)).toBe(SIGNATURE);
    expect(store.getItem(`${FUNDING_LEDGER_KEY_PREFIX}${STORAGE_PAYMENT_ID}`)).not.toBeNull();
  });

  it("B. a stored signature for the same storagePaymentId skips funding", async () => {
    vi.stubGlobal("sessionStorage", makeSessionStorage());
    storeFundingSignature(STORAGE_PAYMENT_ID, SIGNATURE);

    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));

    const result = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );

    expect(result.funded).toBe(false);
    expect(result.fundingSignature).toBe(SIGNATURE);
    expect(fund).not.toHaveBeenCalled();
  });

  it("C. the signature survives a simulated reload / component re-entry", async () => {
    const store = makeSessionStorage();
    vi.stubGlobal("sessionStorage", store);

    // First mount: funds and persists.
    const firstFund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));
    await ensureStorageFundingSignature(null, STORAGE_PAYMENT_ID, firstFund);
    expect(firstFund).toHaveBeenCalledTimes(1);

    // Reload: the in-memory ref is gone, sessionStorage is not.
    const afterReloadFund = vi.fn(async () => ({
      fundingSignature: "SHOULD_NOT_BE_USED",
    }));
    const result = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      afterReloadFund
    );

    expect(result.funded).toBe(false);
    expect(result.fundingSignature).toBe(SIGNATURE);
    expect(afterReloadFund).not.toHaveBeenCalled();
  });

  it("regression: fund -> store -> recreate component -> confirm => fundCreatorPaidStorage called 0 times", async () => {
    vi.stubGlobal("sessionStorage", makeSessionStorage());

    // 1. Original mount: the creator funds once.
    const originalFund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));
    await ensureStorageFundingSignature(null, STORAGE_PAYMENT_ID, originalFund);
    expect(originalFund).toHaveBeenCalledTimes(1);

    // 2. Component is recreated: fresh ledger ref, fresh fundCreatorPaidStorage spy.
    const recreatedFund = vi.fn(async () => ({
      fundingSignature: "SHOULD_NOT_BE_USED",
    }));

    // 3. Confirm again on the recreated component.
    const outcome = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      recreatedFund
    );

    // 4. No second funding — the existing payment is verified instead.
    expect(recreatedFund).toHaveBeenCalledTimes(0);
    expect(outcome.funded).toBe(false);
    expect(outcome.fundingSignature).toBe(SIGNATURE);
  });

  it("D. verification uses the stored signature", async () => {
    vi.stubGlobal("sessionStorage", makeSessionStorage());
    storeFundingSignature(STORAGE_PAYMENT_ID, SIGNATURE);

    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));

    const { fundingSignature } = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      vi.fn(async () => ({ fundingSignature: "SHOULD_NOT_BE_USED" }))
    );

    await verifyStoragePaymentWithRetry(STORAGE_PAYMENT_ID, fundingSignature, {
      sleep: async () => undefined,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      storagePaymentId: STORAGE_PAYMENT_ID,
      transactionSignature: SIGNATURE,
    });
  });

  it("H. a malformed or mismatched stored entry is never trusted", async () => {
    const store = makeSessionStorage();
    vi.stubGlobal("sessionStorage", store);
    const key = `${FUNDING_LEDGER_KEY_PREFIX}${STORAGE_PAYMENT_ID}`;

    const malformed = [
      "not json at all",
      JSON.stringify({ storagePaymentId: STORAGE_PAYMENT_ID, fundingSignature: "" }),
      JSON.stringify({ storagePaymentId: STORAGE_PAYMENT_ID, fundingSignature: "0OIl" }),
      // Truncated (not a real signature length).
      JSON.stringify({
        storagePaymentId: STORAGE_PAYMENT_ID,
        fundingSignature: SIGNATURE.slice(0, 64),
      }),
      // Belongs to a different payment.
      JSON.stringify({
        storagePaymentId: "storage-pay-other",
        fundingSignature: SIGNATURE,
      }),
      JSON.stringify({ fundingSignature: SIGNATURE }),
      JSON.stringify([STORAGE_PAYMENT_ID, SIGNATURE]),
      "null",
    ];

    for (const raw of malformed) {
      store.setItem(key, raw);
      expect(readStoredFundingSignature(STORAGE_PAYMENT_ID)).toBeNull();

      const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));
      const result = await ensureStorageFundingSignature(
        null,
        STORAGE_PAYMENT_ID,
        fund
      );
      // An untrusted entry must not block a legitimate first funding…
      expect(result.funded).toBe(true);
      expect(fund).toHaveBeenCalledTimes(1);
    }

    expect(isValidFundingSignature(SIGNATURE)).toBe(true);
    expect(isValidFundingSignature(SIGNATURE.slice(0, 64))).toBe(false);
  });

  it("I. a different storagePaymentId cannot reuse another payment's signature", async () => {
    vi.stubGlobal("sessionStorage", makeSessionStorage());
    storeFundingSignature(STORAGE_PAYMENT_ID, SIGNATURE);

    const otherId = "storage-pay-ffffffff-0000-1111-2222-333333333333";
    expect(readStoredFundingSignature(otherId)).toBeNull();

    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));
    const result = await ensureStorageFundingSignature(null, otherId, fund);

    expect(result.funded).toBe(true);
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("never persists a malformed signature", () => {
    const store = makeSessionStorage();
    vi.stubGlobal("sessionStorage", store);

    storeFundingSignature(STORAGE_PAYMENT_ID, "not-a-signature");
    expect(store.length).toBe(0);
    expect(readStoredFundingSignature(STORAGE_PAYMENT_ID)).toBeNull();
  });

  it("degrades safely when sessionStorage is unavailable", async () => {
    // No sessionStorage global at all (node default).
    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));

    const first = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );
    expect(first.funded).toBe(true);
    expect(readStoredFundingSignature(STORAGE_PAYMENT_ID)).toBeNull();

    // The in-memory ledger still prevents a second payment.
    const second = await ensureStorageFundingSignature(
      { storagePaymentId: STORAGE_PAYMENT_ID, fundingSignature: SIGNATURE },
      STORAGE_PAYMENT_ID,
      fund
    );
    expect(second.funded).toBe(false);
    expect(fund).toHaveBeenCalledTimes(1);
  });
});

describe("F. terminal verification never re-funds", () => {
  it("a terminal verification failure leaves the stored ledger intact", async () => {
    vi.stubGlobal("sessionStorage", makeSessionStorage());

    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));
    const { fundingSignature } = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );

    stubFetch(() =>
      jsonResponse({ ok: false, reason: "DESTINATION_MISMATCH" }, 400)
    );

    const outcome = await verifyStoragePaymentWithRetry(
      STORAGE_PAYMENT_ID,
      fundingSignature,
      { sleep: async () => undefined }
    );
    expect(outcome.ok).toBe(false);

    // The ledger survives, so a later attempt still verifies instead of funding.
    expect(readStoredFundingSignature(STORAGE_PAYMENT_ID)).toBe(SIGNATURE);

    const retry = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );
    expect(retry.funded).toBe(false);
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("G. successful verification continues once and the ledger remains", async () => {
    vi.stubGlobal("sessionStorage", makeSessionStorage());

    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));
    const { fundingSignature } = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );

    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    const outcome = await verifyStoragePaymentWithRetry(
      STORAGE_PAYMENT_ID,
      fundingSignature,
      { sleep: async () => undefined }
    );

    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fund).toHaveBeenCalledTimes(1);
    // Never deleted before a terminally safe state — and not after either, so a
    // later re-entry still cannot fund.
    expect(readStoredFundingSignature(STORAGE_PAYMENT_ID)).toBe(SIGNATURE);
  });

  it("E. TRANSACTION_PENDING retries only verification, never funding", async () => {
    vi.stubGlobal("sessionStorage", makeSessionStorage());

    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));
    const { fundingSignature } = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );

    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      return calls < 3
        ? jsonResponse({ ok: false, reason: "TRANSACTION_PENDING" }, 400)
        : jsonResponse({ ok: true });
    });

    const outcome = await verifyStoragePaymentWithRetry(
      STORAGE_PAYMENT_ID,
      fundingSignature,
      { maxAttempts: 5, sleep: async () => undefined }
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(3);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe("/api/storage/verify-payment");
    }
    expect(fund).toHaveBeenCalledTimes(1);
  });
});

describe("G. an existing funding signature is never re-funded", () => {
  it("skips the funding callback entirely when the ledger holds this payment id", async () => {
    const ledger: StorageFundingLedger = {
      storagePaymentId: STORAGE_PAYMENT_ID,
      fundingSignature: SIGNATURE,
    };
    const fund = vi.fn(async () => ({ fundingSignature: "SHOULD_NOT_BE_USED" }));

    const result = await ensureStorageFundingSignature(
      ledger,
      STORAGE_PAYMENT_ID,
      fund
    );

    expect(result.funded).toBe(false);
    expect(result.fundingSignature).toBe(SIGNATURE);
    // The wallet is never reached: no signAndSendTransaction, no USDC.
    expect(fund).not.toHaveBeenCalled();
  });

  it("funds exactly once when no signature is recorded for this payment id", async () => {
    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));

    const result = await ensureStorageFundingSignature(
      null,
      STORAGE_PAYMENT_ID,
      fund
    );

    expect(result.funded).toBe(true);
    expect(result.fundingSignature).toBe(SIGNATURE);
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("ignores a ledger entry belonging to a different storagePaymentId", async () => {
    const ledger: StorageFundingLedger = {
      storagePaymentId: "storage-pay-other",
      fundingSignature: SIGNATURE,
    };
    const fund = vi.fn(async () => ({ fundingSignature: SIGNATURE }));

    const result = await ensureStorageFundingSignature(
      ledger,
      STORAGE_PAYMENT_ID,
      fund
    );

    expect(result.funded).toBe(true);
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("resolveExistingFundingSignature: only a non-empty signature for the same id counts", () => {
    expect(resolveExistingFundingSignature(null, STORAGE_PAYMENT_ID)).toBeNull();
    expect(
      resolveExistingFundingSignature(
        { storagePaymentId: "other", fundingSignature: SIGNATURE },
        STORAGE_PAYMENT_ID
      )
    ).toBeNull();
    expect(
      resolveExistingFundingSignature(
        { storagePaymentId: STORAGE_PAYMENT_ID, fundingSignature: "" },
        STORAGE_PAYMENT_ID
      )
    ).toBeNull();
    expect(
      resolveExistingFundingSignature(
        { storagePaymentId: STORAGE_PAYMENT_ID, fundingSignature: SIGNATURE },
        STORAGE_PAYMENT_ID
      )
    ).toBe(SIGNATURE);
  });
});

describe("H. verification touches only /api/storage/verify-payment", () => {
  it("issues exactly one POST to that endpoint with the funded signature", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));

    const outcome = await requestStoragePaymentVerification(
      STORAGE_PAYMENT_ID,
      SIGNATURE
    );

    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/storage/verify-payment");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      storagePaymentId: STORAGE_PAYMENT_ID,
      transactionSignature: SIGNATURE,
    });
  });

  it("surfaces the server reason on failure", async () => {
    stubFetch(() =>
      jsonResponse({ ok: false, state: "FAILED", reason: "TRANSACTION_PENDING" }, 400)
    );

    const outcome = await requestStoragePaymentVerification(
      STORAGE_PAYMENT_ID,
      SIGNATURE
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("TRANSACTION_PENDING");
  });
});

describe("I. TRANSACTION_PENDING drives bounded verification retries", () => {
  it("retries while pending and stops as soon as verification succeeds", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls < 3
        ? jsonResponse({ ok: false, reason: "TRANSACTION_PENDING" }, 400)
        : jsonResponse({ ok: true });
    });

    const sleep = vi.fn(async () => undefined);

    const outcome = await verifyStoragePaymentWithRetry(
      STORAGE_PAYMENT_ID,
      SIGNATURE,
      { maxAttempts: 5, sleep }
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(3);
    // Sleep only between attempts.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded attempt budget while still pending", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ ok: false, reason: "TRANSACTION_PENDING" }, 400)
    );

    const outcome = await verifyStoragePaymentWithRetry(
      STORAGE_PAYMENT_ID,
      SIGNATURE,
      { maxAttempts: 3, sleep: async () => undefined }
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("TRANSACTION_PENDING");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(STORAGE_VERIFY_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it("does not retry a terminal reason", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ ok: false, reason: "DESTINATION_MISMATCH" }, 400)
    );

    const outcome = await verifyStoragePaymentWithRetry(
      STORAGE_PAYMENT_ID,
      SIGNATURE,
      { maxAttempts: 5, sleep: async () => undefined }
    );

    expect(outcome.reason).toBe("DESTINATION_MISMATCH");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("J. the retry path cannot fund, sign or upload", () => {
  it("only ever requests /api/storage/verify-payment and touches no wallet surface", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ ok: false, reason: "TRANSACTION_PENDING" }, 400)
    );

    const walletSurface = {
      sendTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(),
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    };
    vi.stubGlobal("phantom", { solana: walletSurface });

    await verifyStoragePaymentWithRetry(STORAGE_PAYMENT_ID, SIGNATURE, {
      maxAttempts: 4,
      sleep: async () => undefined,
    });

    // Every request went to the verification endpoint — no Irys node, no upload.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      expect(url).toBe("/api/storage/verify-payment");
    }

    // The wallet was never invoked, so no signature and no spend occurred.
    expect(walletSurface.sendTransaction).not.toHaveBeenCalled();
    expect(walletSurface.signAndSendTransaction).not.toHaveBeenCalled();
    expect(walletSurface.signMessage).not.toHaveBeenCalled();
    expect(walletSurface.signTransaction).not.toHaveBeenCalled();
  });

  it("K. a successful verification returns once, so the caller continues exactly once", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));

    const outcome = await verifyStoragePaymentWithRetry(
      STORAGE_PAYMENT_ID,
      SIGNATURE,
      { maxAttempts: 5, sleep: async () => undefined }
    );

    expect(outcome.ok).toBe(true);
    // A single call: no repeat after success, so the post-verify continuation
    // (reserve/seal) is entered exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
