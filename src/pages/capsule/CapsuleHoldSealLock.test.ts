// @vitest-environment jsdom

/**
 * AETERNA — `aeterna-seal-lock` foreign-lock dead-end regression.
 *
 * Defect (production, read-only audit): when
 * `sessionStorage["aeterna-seal-lock"]` held a DIFFERENT lifecycleId
 * than the one the current capsule was mounted with, the seal effect
 * performed a bare `return` — before `startedRef.current = true` and
 * before `finalizeSealing()`. The creator was left permanently on the
 * non-error "Finalizing your capsule…" screen: no `/api/upload-token`,
 * no error, and therefore no TRY AGAIN (the error screen is the only
 * recovery surface).
 *
 * Fix under test (conservative, `CapsuleHold.tsx` seal effect):
 *   - `existingLock === null`                  -> unchanged
 *   - `existingLock === canonicalLifecycleId`  -> unchanged (re-entry
 *      protection intact; the lock is neither cleared nor overwritten)
 *   - foreign lock                             -> NOT a silent return:
 *      the existing error/recovery UI is surfaced, `finalizeSealing()`
 *      is not called, no upload-token is requested, and the foreign
 *      lock is deliberately NOT superseded. Recovery stays explicit and
 *      user-driven through the existing `handleRetry()` (TRY AGAIN),
 *      which removes the lock and lets the current lifecycle proceed.
 *
 * The REAL component is mounted (real effects, real lock reads/writes);
 * only its external collaborators are mocked. No live network, no Irys,
 * no funding, no payment, no blockchain, no production KV.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const hoisted = vi.hoisted(() => ({
  sealCapsuleCore: vi.fn(),
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({ resetCapsule: vi.fn(), capsuleId: "a".repeat(64) }),
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

vi.mock("@/lib/storage/creatorIrysStorage", () => ({
  createCreatorIrysStorage: vi.fn(() => ({
    name: "mock-storage",
    upload: vi.fn(),
    uploadChunk: vi.fn(),
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

const LOCK_KEY = "aeterna-seal-lock";

/** Lock value left behind by a PREVIOUS flow in this tab. */
const LIFECYCLE_FOREIGN = "lifecycle-old-A";

/** Lifecycle the capsule under test is mounted with. */
const LIFECYCLE_CURRENT = "lifecycle-new-B";

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const RECIPIENT_SECRET = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const VAULT_SHA256 = "e".repeat(64);
const CREATOR_IDENTITY_ID = "creator-1";
const STORAGE_PAYMENT_ID = "storage-payment-1";
const WALLET_ACCOUNT = "wallet-account-1";

const TRUSTED_NOW = 1755000000000;
const OPEN_AT = TRUSTED_NOW + 3_600_000;

const ERROR_TITLE = "Seal session needs to be restarted";

/** Every value the error surface must never leak. */
const SECRETS = [
  RECIPIENT_SECRET,
  CREATOR_AUTHORITY,
  SALT_BASE,
  VAULT_SHA256,
];

function buildHoldState() {
  return {
    billableSizeBytes: 1024,
    expectedAmount: 1,
    openAt: OPEN_AT,
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

function locationState() {
  return {
    holdState: buildHoldState(),
    canonicalLifecycleId: LIFECYCLE_CURRENT,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    storagePaymentId: STORAGE_PAYMENT_ID,
    correlationTransactionId: null,
  };
}

function installFetchMock() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/upload-token") {
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
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockSealCore(finalizationPending: boolean) {
  hoisted.sealCapsuleCore.mockImplementation(
    async (params: { capsuleId: string }) => ({
      capsuleId: params.capsuleId,
      manifest: {},
      recipientLink: "",
      confirmationLink: "/confirmation",
      finalized: !finalizationPending,
      finalizationPending,
    })
  );
}

function renderHold() {
  const walletValue = {
    state: { account: WALLET_ACCOUNT, connected: true },
    wallet: { account: WALLET_ACCOUNT },
  };

  return render(
    React.createElement(
      MemoryRouter,
      {
        initialEntries: [
          { pathname: "/create/hold", state: locationState() },
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

function uploadTokenRequested(fetchMock: ReturnType<typeof installFetchMock>) {
  return fetchMock.mock.calls.some(
    ([url]) => url === "/api/upload-token"
  );
}

function tryAgainButton() {
  return screen.queryByRole("button", { name: /try again/i });
}

/* ───────────────────────── tests ───────────────────────── */

describe("CapsuleHold — aeterna-seal-lock foreign-lock handling", () => {
  beforeEach(() => {
    sessionStorage.clear();
    hoisted.sealCapsuleCore.mockReset();
    mockSealCore(false);
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * 1. FOREIGN LOCK — the flow must refuse to start, but LOUDLY: the
   *    recovery UI appears and the foreign lock is left untouched.
   */
  it("1. foreign lock surfaces the recovery UI and never starts the seal flow", async () => {
    sessionStorage.setItem(LOCK_KEY, LIFECYCLE_FOREIGN);
    const fetchMock = installFetchMock();

    renderHold();

    // Error/recovery UI is rendered (not the endless "Finalizing…" screen).
    expect(await screen.findByText(ERROR_TITLE)).toBeTruthy();
    expect(tryAgainButton()).toBeTruthy();

    // finalizeSealing() must not run: no upload-token, no seal core.
    expect(uploadTokenRequested(fetchMock)).toBe(false);
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();

    // No silent supersede: the foreign lifecycle still owns the lock.
    expect(sessionStorage.getItem(LOCK_KEY)).toBe(LIFECYCLE_FOREIGN);
  });

  /**
   * 2. RETRY AFTER FOREIGN LOCK — the existing TRY AGAIN path stays the
   *    single source of lock recovery.
   */
  it("2. TRY AGAIN clears the foreign lock and lets the current lifecycle proceed", async () => {
    sessionStorage.setItem(LOCK_KEY, LIFECYCLE_FOREIGN);
    // Pending finalization keeps the lock after the seal completes, so
    // post-retry lock OWNERSHIP is observable deterministically (with
    // finalizationPending === false the full-success cleanup would clear
    // it again, which is covered by test 4).
    mockSealCore(true);
    const fetchMock = installFetchMock();

    renderHold();

    const retry = await screen.findByRole("button", { name: /try again/i });
    fireEvent.click(retry);

    // The current lifecycle now runs the normal path.
    await waitFor(() => {
      expect(uploadTokenRequested(fetchMock)).toBe(true);
    });

    // handleRetry() removed the foreign lock; the normal path then
    // claimed it for the CURRENT lifecycle (never auto-superseded).
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBe(LIFECYCLE_FOREIGN);
    expect(sessionStorage.getItem(LOCK_KEY)).toBe(LIFECYCLE_CURRENT);

    // And the flow reaches the seal core with the current lifecycle.
    await waitFor(() => {
      expect(hoisted.sealCapsuleCore).toHaveBeenCalled();
    });
    expect(screen.queryByText(ERROR_TITLE)).toBeNull();
  });

  /**
   * 3. SAME LIFECYCLE — re-entry protection is unchanged: the lock is
   *    honored, the flow proceeds, and (pending finalization) the lock
   *    is deliberately retained for the documented re-entry path.
   */
  it("3. same-lifecycle lock passes through unchanged and is retained while finalization is pending", async () => {
    sessionStorage.setItem(LOCK_KEY, LIFECYCLE_CURRENT);
    mockSealCore(true);
    const fetchMock = installFetchMock();

    renderHold();

    await waitFor(() => {
      expect(uploadTokenRequested(fetchMock)).toBe(true);
    });

    expect(screen.queryByText(ERROR_TITLE)).toBeNull();

    // pending finalization keeps the lock (existing semantics, untouched)
    await waitFor(() => {
      expect(hoisted.sealCapsuleCore).toHaveBeenCalled();
    });
    expect(sessionStorage.getItem(LOCK_KEY)).toBe(LIFECYCLE_CURRENT);
  });

  /**
   * 4. FIRST RUN — no lock: the normal flow is byte-for-byte unchanged,
   *    including the full-success cleanup that removes the lock.
   */
  it("4. first run without a lock keeps the normal flow and clears the lock on full success", async () => {
    const fetchMock = installFetchMock();

    renderHold();

    await waitFor(() => {
      expect(uploadTokenRequested(fetchMock)).toBe(true);
    });

    expect(screen.queryByText(ERROR_TITLE)).toBeNull();

    // full success (finalizationPending === false) clears the lock
    await waitFor(() => {
      expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    });
  });

  /**
   * 5. NO SECRET LEAK — the surfaced detail carries only the two
   *    non-secret lifecycle ids; no secret, key, or plaintext appears in
   *    the rendered error surface or in the console log.
   */
  it("5. foreign-lock error UI and logs leak no secret or plaintext", async () => {
    sessionStorage.setItem(LOCK_KEY, LIFECYCLE_FOREIGN);
    installFetchMock();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHold();

    await screen.findByText(ERROR_TITLE);

    const visible = document.body.textContent ?? "";
    const logged = errorSpy.mock.calls
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");

    // the diagnostic log line is emitted...
    expect(logged).toContain("[AETERNA] Seal session needs to be restarted");

    // ...but neither surface contains secret material
    for (const secret of SECRETS) {
      expect(visible).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }

    // diagnostics are still useful: both lifecycle ids are surfaced
    expect(visible).toContain(LIFECYCLE_FOREIGN);
    expect(visible).toContain(LIFECYCLE_CURRENT);
  });
});
