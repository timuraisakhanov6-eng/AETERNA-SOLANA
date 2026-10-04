// @vitest-environment jsdom

/**
 * REGRESSION — CapsuleHold STEP 1 upload-token retry behavior.
 *
 * CORRECT SEMANTICS (after fix):
 *   RETRY: network/fetch error, HTTP 500–599
 *   NO RETRY: HTTP 400–499 (deterministic auth failures)
 *
 * These tests verify EXACT retry count and fail-closed behavior.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { configure } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";

configure({ asyncUtilTimeout: 15_000 });

const hoisted = vi.hoisted(() => ({
  sealCapsuleCore: vi.fn(),
  resetCapsule: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    resetCapsule: hoisted.resetCapsule,
    capsuleId: "a".repeat(64),
  }),
}));

vi.mock("@/context/AETERNAWalletContext", async () => {
  const ReactModule = await import("react");
  return {
    AETERNAWalletContext: ReactModule.createContext(null),
  };
});

vi.mock("@/lib/capsule/sealCapsuleCore", () => ({
  sealCapsuleCore: hoisted.sealCapsuleCore,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom"
  );
  return {
    ...actual,
    useNavigate: () => hoisted.navigate,
  };
});

vi.mock("@/lib/storage/creatorIrysStorage", () => ({
  createCreatorIrysStorage: vi.fn(() => ({
    name: "mock-storage",
    upload: vi.fn(),
    uploadContainer: vi.fn(),
    download: vi.fn(),
  })),
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  toCreatorIrysWallet: vi.fn(() => ({ publicKey: {} })),
}));

vi.mock("@/lib/runtime/runtimeRegistry", () => ({
  getRuntime: vi.fn(async () => ({
    readVault: async () => new Uint8Array(0),
    removeVault: async () => {},
  })),
  destroyRuntime: vi.fn(async () => {}),
}));

import CapsuleHold from "@/pages/capsule/CapsuleHold";
import { AETERNAWalletContext } from "@/context/AETERNAWalletContext";

/* ───────────────────────── fixtures ───────────────────────── */

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const RECIPIENT_SECRET = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const VAULT_SHA256 = "e".repeat(64);
const CREATOR_IDENTITY_ID = "creator-1";
const CREATOR_CREDIT_ID = "credit-1";
const STORAGE_PAYMENT_ID = "storage-payment-1";
const WALLET_ACCOUNT = "wallet-account-1";
const LIFECYCLE_ID = "lifecycle-1";
const TRUSTED_NOW = 1755000000000;

function buildHoldState() {
  return {
    billableSizeBytes: 1024,
    expectedAmount: 1,
    openAt: Date.now() + 365 * 24 * 3_600_000,
    itemIds: ["item-1"],
    creatorAuthority: CREATOR_AUTHORITY,
    prepared: {
      capsuleId: CAPSULE_ID,
      encryptedVaultPointer: `aeterna-local-vault:${CAPSULE_ID}`,
      encryptedSizeBytes: 1024,
      vaultSha256: VAULT_SHA256,
      saltBase: SALT_BASE,
      recipientSecret: RECIPIENT_SECRET,
      creatorAuthority: CREATOR_AUTHORITY,
      chunkMetadata: [],
    },
  };
}

function locationState(withCreditId = true) {
  return {
    holdState: buildHoldState(),
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    ...(withCreditId ? { creatorCreditId: CREATOR_CREDIT_ID } : {}),
    storagePaymentId: STORAGE_PAYMENT_ID,
    correlationTransactionId: null,
  };
}

function renderHold(withCreditId = true) {
  const walletValue = {
    state: {
      account: WALLET_ACCOUNT,
      connected: true,
      walletId: "phantom",
      walletName: "Phantom",
      ready: true,
      error: null,
    },
    wallet: { account: WALLET_ACCOUNT },
  } as unknown as React.ContextType<typeof AETERNAWalletContext>;

  return render(
    React.createElement(
      MemoryRouter,
      {
        initialEntries: [
          { pathname: "/create/hold", state: locationState(withCreditId) },
        ],
      },
      React.createElement(
        AETERNAWalletContext.Provider,
        { value: walletValue },
        React.createElement(CapsuleHold)
      )
    )
  );
}

/* ───────────────────────── tests ───────────────────────── */

describe("CapsuleHold — upload-token retry semantics", () => {
  beforeEach(() => {
    sessionStorage.clear();
    hoisted.sealCapsuleCore.mockReset();
    hoisted.resetCapsule.mockReset();
    hoisted.navigate.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * A. 503 → 503 → 200
   * Expectation: 3 HTTP requests, then success, token passed to seal.
   */
  it("A. retries 503 twice then succeeds on third attempt", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          if (requestCount <= 2) {
            return {
              ok: false,
              status: 503,
              json: async () => ({ error: "SERVICE_UNAVAILABLE" }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ uploadToken: "t".repeat(32) }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    hoisted.sealCapsuleCore.mockImplementation(async () => ({
      capsuleId: CAPSULE_ID,
      manifest: {},
      recipientLink: `/capsule/${CAPSULE_ID}#${RECIPIENT_SECRET}`,
      confirmationLink: `/capsule/${CAPSULE_ID}#${RECIPIENT_SECRET}&c=${CREATOR_AUTHORITY}`,
      finalized: true,
      finalizationPending: false,
    }));

    renderHold();

    await vi.advanceTimersByTimeAsync(8_000); // 2s + 4s backoff + margin

    await waitFor(
      () => {
        expect(hoisted.navigate).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(3);
    expect(hoisted.sealCapsuleCore).toHaveBeenCalledTimes(1);
  }, 20_000);

  /**
   * B. 503 → 503 → 503
   * Expectation: 3 requests, then fail-closed, seal NOT called.
   */
  it("B. fails closed after three 503 attempts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: "SERVICE_UNAVAILABLE" }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold();

    await vi.advanceTimersByTimeAsync(8_000);

    await waitFor(
      () => {
        expect(
          screen.queryByText(/we couldn't finish preparing your capsule/i)
        ).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(3);
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
  }, 20_000);

  /**
   * C. 403
   * Expectation: EXACTLY 1 request, immediate fail-closed.
   */
  it("C. does NOT retry 403 — exactly 1 request then fail-closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          return {
            ok: false,
            status: 403,
            json: async () => ({ error: "LIFECYCLE_CREDIT_NOT_FOUND" }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold();

    await waitFor(
      () => {
        expect(
          screen.queryByText(/we couldn't finish preparing your capsule/i)
        ).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(1);
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
  }, 20_000);

  /**
   * D. 409
   * Expectation: EXACTLY 1 request, immediate fail-closed.
   */
  it("D. does NOT retry 409 — exactly 1 request then fail-closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "STORAGE_PAYMENT_NOT_VERIFIED" }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold();

    await waitFor(
      () => {
        expect(
          screen.queryByText(/we couldn't finish preparing your capsule/i)
        ).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(1);
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
  }, 20_000);

  /**
   * E. 400
   * Expectation: EXACTLY 1 request, immediate fail-closed.
   */
  it("E. does NOT retry 400 — exactly 1 request then fail-closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "INVALID_BODY" }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold();

    await waitFor(
      () => {
        expect(
          screen.queryByText(/we couldn't finish preparing your capsule/i)
        ).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(1);
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
  }, 20_000);

  /**
   * F. network error → 200
   * Expectation: retry after network error, then success.
   */
  it("F. retries network error then succeeds", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          if (requestCount === 1) {
            throw new Error("NETWORK_ERROR");
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ uploadToken: "t".repeat(32) }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    hoisted.sealCapsuleCore.mockImplementation(async () => ({
      capsuleId: CAPSULE_ID,
      manifest: {},
      recipientLink: `/capsule/${CAPSULE_ID}#${RECIPIENT_SECRET}`,
      confirmationLink: `/capsule/${CAPSULE_ID}#${RECIPIENT_SECRET}&c=${CREATOR_AUTHORITY}`,
      finalized: true,
      finalizationPending: false,
    }));

    renderHold();

    await vi.advanceTimersByTimeAsync(4_000);

    await waitFor(
      () => {
        expect(hoisted.navigate).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(2);
    expect(hoisted.sealCapsuleCore).toHaveBeenCalledTimes(1);
  }, 20_000);

  /**
   * G. 200 but invalid/missing uploadToken
   * Expectation: fail-closed (no retry — 200 is success, but missing token is client validation failure).
   */
  it("G. fails closed when 200 response lacks valid uploadToken", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }), // no uploadToken
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold();

    await waitFor(
      () => {
        expect(
          screen.queryByText(/we couldn't finish preparing your capsule/i)
        ).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(1);
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
  }, 20_000);

  /**
   * H. AUTHORITATIVE-READ ADDRESS.
   * When the navigation state carries creatorCreditId, the upload-token body
   * must carry it too, so the server reads the Creator Credit from the
   * Durable Object instead of the eventually-consistent KV lifecycle
   * projection (the production LIFECYCLE_CREDIT_NOT_FOUND cause).
   * The retry policy is unchanged: a 403 is still exactly 1 request.
   */
  it("H. sends creatorCreditId in the upload-token body and still does not retry 403", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestCount = 0;
    const captured: { body: Record<string, unknown> | null } = { body: null };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url === "/api/upload-token") {
          requestCount++;
          captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return {
            ok: false,
            status: 403,
            json: async () => ({ error: "LIFECYCLE_CREDIT_NOT_FOUND" }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold();

    await waitFor(
      () => {
        expect(
          screen.queryByText(/we couldn't finish preparing your capsule/i)
        ).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(1);
    expect(captured.body).toMatchObject({
      creatorIdentityId: CREATOR_IDENTITY_ID,
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorCreditId: CREATOR_CREDIT_ID,
    });
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
  }, 20_000);

  /**
   * I. LEGACY COMPATIBILITY.
   * With no creatorCreditId in the navigation state the field must be
   * OMITTED (not sent as null), so the server keeps the existing KV path and
   * the legacy/recovery flows are byte-for-byte unchanged.
   */
  it("I. omits creatorCreditId entirely when the navigation state has none", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const captured: { body: Record<string, unknown> | null } = { body: null };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url === "/api/upload-token") {
          captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return {
            ok: false,
            status: 403,
            json: async () => ({ error: "LIFECYCLE_CREDIT_NOT_FOUND" }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold(false);

    await waitFor(
      () => {
        expect(captured.body).not.toBeNull();
      },
      { timeout: 10_000 }
    );

    expect(Object.keys(captured.body ?? {})).not.toContain("creatorCreditId");
    expect(captured.body).toMatchObject({
      creatorIdentityId: CREATOR_IDENTITY_ID,
      canonicalLifecycleId: LIFECYCLE_ID,
    });
  }, 20_000);

  /**
   * J. ANY 4xx -> exactly 1 request.
   *
   * The retry decision is driven by the HTTP STATUS, never by the error
   * text. Every row below either carries a code the client has never
   * hardcoded or carries no code at all — all of them must fail closed on
   * the FIRST attempt. (Under the previous message-text classification
   * several of these were retried three times.)
   */
  it.each<{ status: number; code?: string | undefined }>([
    { status: 400, code: "INVALID_BODY" },
    { status: 400, code: undefined },
    { status: 403, code: "SOME_UNKNOWN_CODE" },
    { status: 403, code: "LIFECYCLE_CREDIT_NOT_FOUND" },
    { status: 409, code: "STORAGE_PAYMENT_NOT_VERIFIED" },
    { status: 415, code: undefined },
    { status: 422, code: "UNPROCESSABLE_ENTITY" },
    { status: 429, code: undefined },
  ])(
    "J. HTTP $status (code: $code) -> exactly 1 request, fail-closed",
    async ({ status, code }) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      let requestCount = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/api/upload-token") {
            requestCount++;
            return {
              ok: false,
              status,
              json: async () => (code ? { error: code } : {}),
            };
          }
          if (url === "/api/time") {
            return {
              ok: true,
              status: 200,
              json: async () => ({ nowUtc: TRUSTED_NOW }),
            };
          }
          throw new Error("UNEXPECTED_FETCH:" + url);
        })
      );

      renderHold();

      await waitFor(
        () => {
          expect(
            screen.queryByText(/we couldn't finish preparing your capsule/i)
          ).toBeTruthy();
        },
        { timeout: 10_000 }
      );

      expect(requestCount).toBe(1);
      expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
      expect(hoisted.navigate).not.toHaveBeenCalled();
    },
    20_000
  );

  /**
   * K. ANY 5xx -> retried.
   * 500 is a second data point in the 5xx range beside the 503 tests above:
   * three attempts, then fail-closed.
   */
  it("K. HTTP 500 -> retried (exactly 3 requests, then fail-closed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/upload-token") {
          requestCount++;
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "INTERNAL_ERROR" }),
          };
        }
        if (url === "/api/time") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nowUtc: TRUSTED_NOW }),
          };
        }
        throw new Error("UNEXPECTED_FETCH:" + url);
      })
    );

    renderHold();

    await vi.advanceTimersByTimeAsync(8_000);

    await waitFor(
      () => {
        expect(
          screen.queryByText(/we couldn't finish preparing your capsule/i)
        ).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    expect(requestCount).toBe(3);
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
  }, 20_000);
});
