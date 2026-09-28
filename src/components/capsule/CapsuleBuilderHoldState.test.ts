// @vitest-environment jsdom
/**
 * AETERNA — regression test: canonical billable size reaches /create/hold.
 *
 * PRODUCTION DEFECT THIS PINS
 * ---------------------------
 * The two-stage creation flow builds the PREPARED identity with a
 * `billableSizeBytes: 0` placeholder (the PREPARED identity carries no
 * size of its own). The canonical storage quote — the ONLY carrier of
 * the real billable size (encrypted Vault + Σ media chunk ciphertext) —
 * arrives in `enterStorageReviewForPrepared`, which used to consume only
 * `storagePaymentId` / `expectedAmountAtomic` / `displayAmountUSDC` and
 * silently DROPPED `billableSizeBytes`.
 *
 * Consequence in production: `handleReserveReady` clones
 * `preparedRef.current` into the `/create/hold` navigation state with
 * `billableSizeBytes: 0`, and CapsuleHold's integrity guard
 * (CapsuleHold.tsx `INVALID_BILLABLE_SIZE_BYTES`) rejects the attempt —
 * AFTER the creator had already paid the $1 service fee AND funded Irys.
 * The creator saw "We couldn't finish preparing your capsule" with
 * Technical details: INVALID_BILLABLE_SIZE_BYTES, and the capsule was
 * never sealed.
 *
 * The sessionStorage recovery record was equally poisoned: it is
 * serialised from the same `preparedRef.current`, so
 * `isValidSessionCapsuleData` (which requires billableSizeBytes > 0)
 * rejected every restore and the flow always re-prepared from scratch.
 *
 * WHAT IS ASSERTED
 * ----------------
 * Driving the REAL CapsuleBuilder wiring to the reserve step must hand
 * `/create/hold` a holdState whose `billableSizeBytes` is the server
 * quote's value VERBATIM (no local arithmetic), and the persisted
 * recovery record must carry the same value.
 *
 * FAILS on pre-fix code (0), PASSES after the write-back.
 *
 * jsdom component test — same harness convention as
 * CapsuleBuilderRestoreBatching.test.tsx. All network access is mocked;
 * no production calls, no real payment, no wallet transaction.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

/* Canonical values the server would return. Distinctive on purpose: a
   "0" placeholder or any locally-derived size cannot collide with these. */
const QUOTE_BILLABLE_SIZE_BYTES = 11_864_321;

const {
  WALLET_ACCOUNT,
  CREATOR_IDENTITY_ID,
  CREATOR_CREDIT_ID,
  stableWallet,
  signMessageMock,
  preparePreparedCapsuleMock,
} = vi.hoisted(() => {
  const WALLET_ACCOUNT = "7XkWqBase58WalletAccountHoldSizeTest";
  const CREATOR_IDENTITY_ID = "creator-identity-holdsize";
  const CREATOR_CREDIT_ID = "creator-credit-holdsize";

  const signMessageMock = vi.fn(async () => ({
    signature: new Uint8Array(64),
  }));

  // Stable identity across renders — mirrors the production useMemo'd
  // wallet context value (see CapsuleBuilderRestoreBatching.test.tsx).
  const stableWallet = {
    connected: true,
    account: WALLET_ACCOUNT,
    walletName: "Test Wallet",
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: signMessageMock,
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    disconnect: vi.fn(async () => {}),
  };

  // The PREPARED identity deliberately carries NO billable size — exactly
  // like the production preparePreparedCapsule contract.
  const preparePreparedCapsuleMock = vi.fn(async () => ({
    capsuleId: "capsule-holdsize-test",
    encryptedSizeBytes: 4096,
    vaultSha256: "a".repeat(64),
    saltBase: "b".repeat(43),
    encryptedVaultPointer: "vault-pointer-holdsize",
    chunkMetadata: [],
    creatorAuthority: "creator-authority-holdsize",
  }));

  return {
    WALLET_ACCOUNT,
    CREATOR_IDENTITY_ID,
    CREATOR_CREDIT_ID,
    stableWallet,
    signMessageMock,
    preparePreparedCapsuleMock,
  };
});

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    items: [
      {
        id: "item-holdsize-1",
        type: "text",
        text: "billable size regression capsule",
        createdAt: 1700000000000,
      },
    ],
    capsuleId: "capsule-holdsize-test",
    addTextItem: vi.fn(),
    addMediaItem: vi.fn(),
    description: "",
    setDescription: vi.fn(),
    unlockAt: 1798761600000,
    setUnlockAt: vi.fn(),
    getMediaFile: vi.fn(),
    resetCapsule: vi.fn(),
  }),
}));

vi.mock("@/components/capsule/ActionMenu", () => ({ default: () => null }));
vi.mock("@/components/capsule/MediaCapture", () => ({ default: () => null }));
vi.mock("@/components/capsule/CapsuleInput", () => ({ default: () => null }));
vi.mock("@/components/capsule/HorizontalCapsule", () => ({
  default: () => null,
}));
vi.mock("@/components/capsule/DateTimePicker", () => ({
  DateTimePicker: () => null,
  normalizeOpenAt: (value: unknown) => value,
}));

vi.mock("@/lib/capsule/preparePreparedCapsule", () => ({
  preparePreparedCapsule: preparePreparedCapsuleMock,
}));

vi.mock("@/lib/wallet/solanaWallet", () => ({
  sendSolanaUSDCPayment: vi.fn(async () => "tx-sig-holdsize"),
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  fundCreatorPaidStorage: vi.fn(),
  toCreatorIrysWallet: vi.fn(),
}));

/* The storage payment ledger + verify retry are real production code
   (sessionStorage-backed, single-fund guarantee). Only the two network
   boundary functions are stubbed so the test never funds or verifies. */
vi.mock("@/components/capsule/storageVerificationRetry", () => ({
  ensureStorageFundingSignature: vi.fn(async () => ({
    fundingSignature: "funding-signature-holdsize",
    funded: true,
  })),
  verifyStoragePaymentWithRetry: vi.fn(async () => ({ ok: true, reason: "" })),
}));

/* ───────────────── harness ───────────────── */

const json = (body: unknown, ok = true) => ({
  ok,
  json: async () => body,
});

const CHALLENGE_RESPONSE = () =>
  json({
    ok: true,
    id: "challenge-holdsize",
    challengeId: "challenge-holdsize",
    challenge: "abc",
    message: "AETERNA identity challenge",
    expiresAt: Date.now() + 600_000,
  });

const AVAILABLE_DISCOVERY = () =>
  json({
    ok: true,
    status: "available",
    creatorCreditId: CREATOR_CREDIT_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    account: WALLET_ACCOUNT,
  });

const PREPARED_PROJECTION = () =>
  json({
    ok: true,
    preparedProjection: { preparedProjectionId: "projection-holdsize" },
  });

/**
 * The canonical quote. `billableSizeBytes` is the field whose loss caused
 * the production failure — the server always sends it.
 */
const STORAGE_QUOTE = () =>
  json({
    ok: true,
    storagePaymentId: "storage-payment-holdsize",
    preparedProjectionId: "projection-holdsize",
    lifecycleId: "lifecycle-holdsize",
    capsuleId: "capsule-holdsize-test",
    billableSizeBytes: QUOTE_BILLABLE_SIZE_BYTES,
    expectedAmountAtomic: "33986",
    displayAmountUSDC: "0.033986",
  });

const RESERVE_LIFECYCLE = () =>
  json({ ok: true, lifecycleId: "lifecycle-holdsize" });

let fetchMock: ReturnType<typeof vi.fn>;

function installFetchRoutes(
  routes: Array<{ match: string; respond: () => ReturnType<typeof json> }>
) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch in test: ${url}`);
    return route.respond();
  });
}

const fetchCallsTo = (fragment: string) =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes(fragment));

/* Probe: captures the exact state the reserve step hands to /create/hold. */
function HoldProbe() {
  const location = useLocation();
  const state = location.state as
    | {
        holdState?: {
          billableSizeBytes?: unknown;
          prepared?: { capsuleId?: unknown };
        };
      }
    | null;

  return React.createElement("div", {
    "data-testid": "hold-probe",
    "data-billable-size": String(state?.holdState?.billableSizeBytes),
    "data-capsule-id": String(state?.holdState?.prepared?.capsuleId),
  });
}

const tree = () =>
  React.createElement(
    MemoryRouter,
    { initialEntries: ["/create"] },
    React.createElement(
      CreatorIdentityProvider,
      null,
      React.createElement(
        CreatorCreditProvider,
        null,
        React.createElement(
          LandingPaymentGateProvider,
          null,
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/create",
              element: React.createElement(CapsuleBuilder),
            }),
            React.createElement(Route, {
              path: "/create/hold",
              element: React.createElement(HoldProbe),
            })
          )
        )
      )
    )
  );

async function acceptProtocol() {
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => {
    expect(
      (screen.getByRole("checkbox") as HTMLElement).dataset["state"]
    ).toBe("checked");
  });
}

describe("canonical billable size propagation to /create/hold", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    (window as unknown as { phantom?: unknown }).phantom = { solana: {} };
    try {
      sessionStorage.clear();
    } catch {
      /* jsdom always provides sessionStorage */
    }
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: () => "uuid-holdsize-test",
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { phantom?: unknown }).phantom;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("hands the server quote's billableSizeBytes to /create/hold and persists it for restore", async () => {
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: AVAILABLE_DISCOVERY },
      { match: "/api/capsule/prepared", respond: PREPARED_PROJECTION },
      { match: "/api/storage/quote", respond: STORAGE_QUOTE },
      { match: "/api/creator/reserve-lifecycle", respond: RESERVE_LIFECYCLE },
    ]);

    render(tree());
    await acceptProtocol();

    // 1. Explicit Create Capsule → discovery (AVAILABLE) → paid.
    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Creator access ready"
      );
    });

    // 2. Second Create Capsule → preparation + projection + canonical quote.
    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));
    await waitFor(
      () => expect(preparePreparedCapsuleMock).toHaveBeenCalledTimes(1),
      { timeout: 3000 }
    );
    await waitFor(() => {
      expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    });

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(
        within(dialog).getByRole("button", { name: "Create Capsule" })
      ).toBeTruthy();
    });

    // 3. Confirm the review → fund (stubbed) → verify (stubbed) → reserve
    //    → navigate to /create/hold.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create Capsule" })
    );

    const probe = await screen.findByTestId("hold-probe");

    // The whole point: the canonical server value, verbatim — not 0 and
    // not any locally recomputed size.
    expect(probe.dataset["billableSize"]).toBe(
      String(QUOTE_BILLABLE_SIZE_BYTES)
    );
    expect(probe.dataset["capsuleId"]).toBe("capsule-holdsize-test");

    // Guard against a regression that would satisfy the value by
    // re-deriving it locally instead of forwarding the quote.
    expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/reserve-lifecycle")).toHaveLength(1);

    // 4. The recovery record must survive isValidSessionCapsuleData
    //    (billableSizeBytes > 0) so a reload can restore the session.
    const stored = sessionStorage.getItem("aeterna-prepared-capsule");
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(String(stored));
    expect(parsed.billableSizeBytes).toBe(QUOTE_BILLABLE_SIZE_BYTES);
    expect(Number.isSafeInteger(parsed.billableSizeBytes)).toBe(true);
    expect(parsed.billableSizeBytes).toBeGreaterThan(0);
  });
});
