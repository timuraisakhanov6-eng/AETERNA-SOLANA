// @vitest-environment jsdom

/**
 * AETERNA — `/create/hold` post-payment surface (UX contract).
 *
 * SCOPE: PRESENTATION ONLY. These tests pin the THREE user-facing states of
 * the post-payment surface and prove the page never lies to the creator and
 * never exposes publication internals:
 *
 *   waiting  -> after payment is confirmed, before the seal resolves
 *   success  -> the seal has genuinely completed: the creator is navigated
 *               DIRECTLY to CapsuleView (canonical `confirmationLink`)
 *   failure  -> the seal genuinely failed, with an explicit way forward
 *
 * CANONICAL POST-SEAL NAVIGATION (Task L2):
 *   After a successful seal the component MUST call
 *   `navigate(result.confirmationLink, { replace: true })` UNCONDITIONALLY —
 *   including when the unlock moment is in the FUTURE. There is NO
 *   intermediate "Capsule secured" terminal page.
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
import { configure } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";

/**
 * The seal flow retries a failed attempt 3 times with exponential backoff
 * (1s, then 2s) before surfacing the failure surface. That retry policy is
 * production behaviour and is deliberately NOT altered for tests, so the
 * async window here must comfortably outlast ~3s of backoff.
 */
configure({ asyncUtilTimeout: 10_000 });

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

/**
 * CANONICAL NAVIGATION OBSERVATION.
 *
 * The component MUST navigate to `result.confirmationLink` (the canonical
 * `/capsule/:capsuleId` CapsuleView destination) UNCONDITIONALLY after a
 * successful seal. `useNavigate` is wrapped so the destination AND options
 * are observable; every other react-router export is passed through real.
 */
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
import { getRuntime } from "@/lib/runtime/runtimeRegistry";

/* ───────────────────────── fixtures ───────────────────────── */

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const RECIPIENT_SECRET = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const VAULT_SHA256 = "e".repeat(64);
const CREATOR_IDENTITY_ID = "creator-1";
const STORAGE_PAYMENT_ID = "storage-payment-1";
const WALLET_ACCOUNT = "wallet-account-1";
const LIFECYCLE_ID = "lifecycle-1";

const TRUSTED_NOW = 1755000000000;

/**
 * The canonical CapsuleView destination for the fixture capsuleId. The
 * component must navigate here after a successful seal, exactly as produced
 * by `sealCapsuleCore` (`/capsule/${capsuleId}#...`). Assertions pin the
 * canonical `/capsule/:capsuleId` prefix.
 */
const CONFIRMATION_LINK = `/capsule/${CAPSULE_ID}#${RECIPIENT_SECRET}&c=${CREATOR_AUTHORITY}`;

/**
 * The fixture anchors `openAt` to a FAR-FUTURE moment measured from
 * `Date.now()`. Under the canonical flow a future unlock moment STILL
 * navigates straight to CapsuleView — the previous "Capsule secured"
 * special case for future unlocks is what Task L2 removed. Anchoring to the
 * future therefore makes this the STRONGEST variant of the navigation test.
 */
const OPEN_AT = Date.now() + 365 * 24 * 3_600_000;

/**
 * Vocabulary that must NEVER reach the creator. Every entry is an internal
 * publication concern: storage/funding rails, chunking, tokens, seal
 * mechanics, finalization, and provider/product names.
 */
const FORBIDDEN_INTERNALS = [
  "irys",
  "fund",
  "upload-token",
  "uploadToken",
  "chunk",
  "vault",
  "storage token",
  "storagePaymentId",
  "finaliz",
  "seal",
  "lifecycle",
  "capsuleId",
  "manifest",
  "creatorIdentity",
];

/** Wording from retired screens that must no longer appear. */
const RETIRED_WORDING = [
  "Finalizing your capsule",
  "securely published",
  "keep this window open.",
  // Task L2: the non-canonical intermediate success page.
  "Capsule secured",
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
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    storagePaymentId: STORAGE_PAYMENT_ID,
    correlationTransactionId: null,
  };
}

function installFetchMock() {
  return vi.fn(async (url: string) => {
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
}

/** A seal result whose confirmation destination is the canonical CapsuleView. */
function sealResult(finalizationPending = false) {
  return {
    capsuleId: CAPSULE_ID,
    manifest: {},
    recipientLink: `/capsule/${CAPSULE_ID}#${RECIPIENT_SECRET}`,
    confirmationLink: CONFIRMATION_LINK,
    finalized: !finalizationPending,
    finalizationPending,
  };
}

function renderHold() {
  const walletValue = {
    state: { account: WALLET_ACCOUNT, connected: true },
    wallet: { account: WALLET_ACCOUNT },
  };

  const utils = render(
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

  return utils;
}

function visibleText() {
  return document.body.textContent ?? "";
}

/**
 * Asserts that no internal publication vocabulary is visible. Matching is
 * case-insensitive because the failure mode being guarded against is
 * leaking such a word in ANY casing.
 */
function expectNoInternals(text: string) {
  const haystack = text.toLowerCase();
  for (const term of FORBIDDEN_INTERNALS) {
    expect(haystack).not.toContain(term.toLowerCase());
  }
}

function expectNoRetiredWording(text: string) {
  for (const phrase of RETIRED_WORDING) {
    expect(text).not.toContain(phrase);
  }
}

/* ───────────────────────── tests ───────────────────────── */

describe("CapsuleHold — post-payment user-facing surface", () => {
  beforeEach(() => {
    sessionStorage.clear();
    hoisted.sealCapsuleCore.mockReset();
    hoisted.resetCapsule.mockReset();
    hoisted.navigate.mockReset();
    vi.stubGlobal("fetch", installFetchMock());
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * 1. WAITING STATE — while the seal is in flight the creator sees that
   *    payment is confirmed and the capsule is being prepared — and is NOT
   *    navigated anywhere yet (no false success before canonical seal
   *    completion).
   */
  it("1. shows the waiting state while the seal is in flight (no navigation yet)", async () => {
    // A seal that never resolves keeps the component in the waiting state.
    let release: (value: unknown) => void = () => {};
    hoisted.sealCapsuleCore.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    renderHold();

    expect(
      await screen.findByText(/capsule is being prepared/i)
    ).toBeTruthy();
    expect(visibleText()).toMatch(/payment is confirmed/i);

    // never a false success while work is still running
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
    // and never a premature navigation
    expect(hoisted.navigate).not.toHaveBeenCalled();

    release(sealResult());
    // after the seal resolves the canonical navigation fires exactly once
    await waitFor(() => {
      expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * 2. CANONICAL SUCCESS NAVIGATION — a genuine seal completion navigates
   *    the creator DIRECTLY to CapsuleView via the seal's confirmationLink,
   *    and NO intermediate "Capsule secured" surface is rendered. Because
   *    the fixture's `openAt` is in the FUTURE, this test also proves the
   *    removed future-unlock special case: a future unlock still navigates.
   */
  it("2. navigates directly to CapsuleView on canonical seal success (no success page)", async () => {
    hoisted.sealCapsuleCore.mockImplementation(async () => sealResult());

    renderHold();

    await waitFor(() => {
      expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    });

    // canonical destination + replace semantics
    expect(hoisted.navigate).toHaveBeenCalledWith(CONFIRMATION_LINK, {
      replace: true,
    });
    // the canonical destination is the CapsuleView route
    expect(CONFIRMATION_LINK.startsWith(`/capsule/${CAPSULE_ID}`)).toBe(true);

    // NO intermediate success surface, and no "secured and published" copy
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
    expect(visibleText()).not.toMatch(/secured and published/i);
  });

  /**
   * 3. FAILURE STATE — a seal failure produces the failure surface and a
   *    way forward. Never a success screen, never a stuck waiting screen.
   */
  it("3. shows the failure state with a recovery action when sealing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    hoisted.sealCapsuleCore.mockRejectedValue(new Error("boom"));

    renderHold();

    expect(
      await screen.findByText(
        /we couldn't finish preparing your capsule/i,
        undefined,
        { timeout: 15_000 }
      )
    ).toBeTruthy();

    expect(
      screen.getByRole("button", { name: /try again/i })
    ).toBeTruthy();

    // no false success, no waiting claim, and NO navigation on failure
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
    expect(screen.queryByText(/capsule is being prepared/i)).toBeNull();
    expect(hoisted.navigate).not.toHaveBeenCalled();

    // payment status stays truthful in the failure copy
    expect(visibleText()).toMatch(/payment was successful/i);
  }, 20_000);

  /**
   * 3b. TERMINAL PATH (Task J3) — an operation-level stall (a
   *     never-settling IndexedDB open surfaced as J3's typed
   *     IdbOpenTimeoutError, from the self-contained idbOpenDeadline
   *     helper) must reach the SAME visible failure surface as any other
   *     seal failure: no infinite wait, no false success, an explicit way
   *     forward.
   */
  it("3b. a bounded-operation timeout reaches the failure surface (no permanent wait)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    // getRuntime is where the bounded IDB open lives. Simulate the deployed
    // wedge having been converted into a rejection by the deadline.
    const { IdbOpenTimeoutError, IDB_OPEN_DEADLINE_MS } = await import(
      "@/lib/runtime/idbOpenDeadline"
    );
    vi.mocked(getRuntime).mockRejectedValueOnce(
      new IdbOpenTimeoutError(IDB_OPEN_DEADLINE_MS)
    );

    renderHold();

    expect(
      await screen.findByText(
        /we couldn't finish preparing your capsule/i,
        undefined,
        { timeout: 15_000 }
      )
    ).toBeTruthy();

    expect(
      screen.getByRole("button", { name: /try again/i })
    ).toBeTruthy();

    // Never a false success, never a stuck waiting screen.
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
    expect(screen.queryByText(/capsule is being prepared/i)).toBeNull();
  }, 20_000);

  /**
   * 4. PENDING FINALIZATION IS NOT A FAILURE — a seal whose finalization is
   *    still settling must read as SUCCESS: the creator is navigated to
   *    CapsuleView exactly as on a fully-finalized seal (never an error, and
   *    never a stuck waiting screen).
   */
  it("4. navigates to CapsuleView (not failure) when finalization is still pending", async () => {
    hoisted.sealCapsuleCore.mockImplementation(async () => sealResult(true));

    renderHold();

    await waitFor(() => {
      expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    });

    expect(hoisted.navigate).toHaveBeenCalledWith(CONFIRMATION_LINK, {
      replace: true,
    });
    expect(
      screen.queryByText(/we couldn't finish preparing your capsule/i)
    ).toBeNull();
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
  });

  /**
   * 5. RETIRED WORDING — the previous waiting copy AND the retired
   *    "Capsule secured" success copy must never be rendered again, in the
   *    waiting state or anywhere else.
   */
  it("5. never renders retired waiting/success wording", async () => {
    let release: (value: unknown) => void = () => {};
    hoisted.sealCapsuleCore.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    renderHold();

    await screen.findByText(/capsule is being prepared/i);
    expectNoRetiredWording(visibleText());
    expectNoInternals(visibleText());

    release(sealResult());
    await waitFor(() => {
      expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    });
    // after canonical success the component navigates away; no retired
    // "Capsule secured" copy is ever rendered.
    expectNoRetiredWording(visibleText());
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
  });

  /**
   * 6. NO INTERNAL LEAKAGE — no state exposes publication internals.
   *    Each state is checked in isolation so a leak is attributable.
   */
  it("6. exposes no publication internals in any state", async () => {
    // (a) waiting + (b) canonical success
    let release: (value: unknown) => void = () => {};
    hoisted.sealCapsuleCore.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    cleanup();
    renderHold();
    await screen.findByText(/capsule is being prepared/i);
    expectNoInternals(visibleText());

    release(sealResult());
    await waitFor(() => {
      expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    });
    // The canonical destination is CapsuleView; the hold surface itself
    // must not have leaked any internals before navigating away.
    expectNoInternals(visibleText());

    // (c) failure — must outlast the 1s+2s retry backoff
    cleanup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    hoisted.sealCapsuleCore.mockReset();
    hoisted.sealCapsuleCore.mockRejectedValue(new Error("boom"));

    renderHold();
    await screen.findByText(
      /we couldn't finish preparing your capsule/i,
      undefined,
      { timeout: 15_000 }
    );
    expectNoInternals(visibleText());
  }, 20_000);

  /**
   * 7. NO DUPLICATE NAVIGATION — a completed seal navigates exactly once,
   *    even as the effect settles. The removed non-canonical success surface
   *    ("Capsule secured" / "secured and published") must not be rendered;
   *    the waiting surface may still be mounted in this mocked-navigate
   *    harness, but NO success page is ever shown.
   */
  it("7. navigates exactly once and renders no 'Capsule secured' surface", async () => {
    hoisted.sealCapsuleCore.mockImplementation(async () => sealResult());

    renderHold();

    await waitFor(() => {
      expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    });

    // allow any trailing effect work to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(hoisted.navigate).toHaveBeenCalledTimes(1);

    // the removed success surface must never appear
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
    expect(visibleText()).not.toMatch(/secured and published/i);
    expect(hoisted.navigate).toHaveBeenCalledWith(CONFIRMATION_LINK, {
      replace: true,
    });
  });

  /**
   * 8. RECOVERY IS REAL — pressing TRY AGAIN after a failure restarts the
   *    flow instead of leaving the creator on a dead end; the healed run
   *    then navigates canonically to CapsuleView exactly once.
   */
  it("8. TRY AGAIN after a failure restarts the seal flow and then navigates", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Every attempt fails, so the flow lands on the failure surface.
    hoisted.sealCapsuleCore.mockRejectedValue(new Error("boom"));

    renderHold();

    // the failing attempt burns 3 tries with 1s+2s backoff
    const retry = await screen.findByRole(
      "button",
      { name: /try again/i },
      { timeout: 15_000 }
    );
    expect(hoisted.sealCapsuleCore).toHaveBeenCalledTimes(3);
    // no navigation while failing
    expect(hoisted.navigate).not.toHaveBeenCalled();

    // now healing succeeds; TRY AGAIN must actually re-run the flow
    hoisted.sealCapsuleCore.mockReset();
    hoisted.sealCapsuleCore.mockImplementation(async () => sealResult());
    fireEvent.click(retry);

    await waitFor(
      () => {
        expect(hoisted.sealCapsuleCore).toHaveBeenCalledTimes(1);
      },
      { timeout: 15_000 }
    );

    await waitFor(() => {
      expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.navigate).toHaveBeenCalledWith(CONFIRMATION_LINK, {
      replace: true,
    });
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
  }, 30_000);

  /**
   * 9. LAST SEAL ERROR FIX — the failure surface must preserve the
   *    diagnosable underlying reason (the `lastSealError` closure fix), not
   *    throw a ReferenceError that leaves the creator stuck.
   */
  it("9. surfaces the underlying seal error detail on failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    hoisted.sealCapsuleCore.mockRejectedValue(
      new Error("SEAL_UPLOAD_FAILED")
    );

    renderHold();

    await screen.findByText(
      /we couldn't finish preparing your capsule/i,
      undefined,
      { timeout: 15_000 }
    );

    // technical details are exposed via the collapsible disclosure
    expect(screen.getByText(/technical details/i)).toBeTruthy();
  }, 20_000);
});
