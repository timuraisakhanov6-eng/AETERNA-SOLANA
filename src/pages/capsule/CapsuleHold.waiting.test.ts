// @vitest-environment jsdom

/**
 * AETERNA — `/create/hold` post-payment surface (UX contract).
 *
 * SCOPE: PRESENTATION ONLY. These tests pin the three user-facing states of
 * the post-payment waiting page and prove that the page never lies to the
 * creator and never exposes publication internals:
 *
 *   waiting  -> after payment is confirmed, before the seal resolves
 *   success  -> the seal has genuinely completed
 *   failure  -> the seal genuinely failed, with an explicit way forward
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
 * The component decides between the success screen and the historical
 * confirmation redirect by comparing `openAt` against the real clock. The
 * fixture therefore anchors `openAt` to a FAR-FUTURE moment measured from
 * `Date.now()` so the success screen is the deterministic outcome regardless
 * of when the suite runs.
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

/** Wording from the previous waiting screen that must no longer appear. */
const RETIRED_WORDING = [
  "Finalizing your capsule",
  "securely published",
  "keep this window open.",
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

/** A seal result whose confirmation destination is distinguishable. */
function sealResult(finalizationPending = false) {
  return {
    capsuleId: CAPSULE_ID,
    manifest: {},
    recipientLink: "",
    confirmationLink: "/confirmation",
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
   *    payment is confirmed and the capsule is being prepared.
   */
  it("1. shows the waiting state while the seal is in flight", async () => {
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

    release(sealResult());
    await waitFor(() => {
      expect(screen.queryByText(/capsule is being prepared/i)).toBeNull();
    });
  });

  /**
   * 2. SUCCESS STATE — a genuine seal completion is announced, and only
   *    then. This also proves the page does NOT silently redirect away
   *    from the result for a capsule with a future unlock moment.
   */
  it("2. announces success only after the seal genuinely completes", async () => {
    hoisted.sealCapsuleCore.mockImplementation(async () => sealResult());

    renderHold();

    expect(await screen.findByText(/capsule secured/i)).toBeTruthy();

    // the creator is told the capsule is published, not merely "preparing"
    expect(screen.queryByText(/capsule is being prepared/i)).toBeNull();
    expect(visibleText()).toMatch(/secured and published/i);
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

    // no false success, and the waiting state is no longer claimed
    expect(screen.queryByText(/capsule secured/i)).toBeNull();
    expect(screen.queryByText(/capsule is being prepared/i)).toBeNull();

    // payment status stays truthful in the failure copy
    expect(visibleText()).toMatch(/payment was successful/i);
  }, 20_000);

  /**
   * 4. PENDING FINALIZATION IS NOT A FAILURE — a seal whose finalization is
   *    still settling must read as SUCCESS, never as an error.
   */
  it("4. reports success (not failure) when finalization is still pending", async () => {
    hoisted.sealCapsuleCore.mockImplementation(async () => sealResult(true));

    renderHold();

    expect(await screen.findByText(/capsule secured/i)).toBeTruthy();
    expect(
      screen.queryByText(/we couldn't finish preparing your capsule/i)
    ).toBeNull();
  });

  /**
   * 5. RETIRED WORDING — the previous waiting copy must never be rendered
   *    again, in the waiting state or anywhere else.
   */
  it("5. never renders the retired 'Finalizing your capsule' wording", async () => {
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

    release(sealResult());
    await waitFor(() => {
      expect(screen.queryByText(/capsule is being prepared/i)).toBeNull();
    });
    expectNoRetiredWording(visibleText());
  });

  /**
   * 6. NO INTERNAL LEAKAGE — no state exposes publication internals.
   *    Each state is checked in isolation so a leak is attributable.
   */
  it("6. exposes no publication internals in any state", async () => {
    // (a) waiting + (b) success
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
    await screen.findByText(/capsule secured/i);
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
   * 7. UNLOCK MOMENT — the unlock date is labelled and rendered, and it is
   *    the real boundary from the hold state (not an invented one).
   */
  it("7. shows the labelled unlock date taken from the capsule's own boundary", async () => {
    hoisted.sealCapsuleCore.mockImplementation(async () => sealResult());

    renderHold();

    await screen.findByText(/capsule secured/i);

    // a small, muted label — not a headline competing with the title
    const label = screen.getByText(/^unlock date$/i);
    expect(label.className).toMatch(/muted/);

    // the rendered value is derived from the real openAt (UTC millis)
    const expected = new Date(OPEN_AT).toLocaleString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(visibleText()).toContain(expected);
  });

  /**
   * 8. RECOVERY IS REAL — pressing TRY AGAIN after a failure restarts the
   *    flow instead of leaving the creator on a dead end.
   */
  it("8. TRY AGAIN after a failure restarts the seal flow", async () => {
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
    expect(await screen.findByText(/capsule secured/i)).toBeTruthy();
  }, 30_000);
});
