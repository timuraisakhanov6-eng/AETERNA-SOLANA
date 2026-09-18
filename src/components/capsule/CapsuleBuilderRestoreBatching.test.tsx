// @vitest-environment jsdom
/**
 * AETERNA — PATCH-2M regression test: service-payment result batch race.
 *
 * Reproduces the React 18 automatic-batching race on the REAL
 * CapsuleBuilder wiring (real reducer, real headless service-payment
 * controller, real LandingPaymentGateProvider mirror — only fetch,
 * wallet transport, vault preparation and the Irys module are mocked):
 *
 *   onCreditDiscovered / onCreditReady fire
 *     reportCreditDiscovery/Ready (→ setEntitlement)  ┐ one synchronous
 *     dispatchCreateFlow(...)                          ┘ block → ONE
 *   React 18.3.1 commit: createFlowState = "paid" AND entitlement set.
 *
 * Pre-PATCH-2M the entitlement-restore effect's stale
 * `if (createFlowState === "paid") return;` guard swallowed the ONLY
 * `setServicePaymentResult(...)` write, so paid + servicePaymentResult=null
 * dead-ended handleFinalCreateClick silently (no preparation, no
 * /api/storage/quote, no Final Capsule Review). These tests assert the
 * user-visible behavior — the second Create Capsule click must reach
 * preparePreparedCapsule + /api/capsule/prepared + /api/storage/quote —
 * so they FAIL on pre-patch code and PASS after the one-line fix.
 *
 * Idempotence is pinned on the live wiring: after paid, a rerender must
 * not re-run discovery (second signature), re-grant, or re-quote. A
 * restore-effect render loop would surface here as "Maximum update
 * depth exceeded" or as duplicated endpoint calls.
 *
 * The wallet mock object is deliberately hoisted and shared: production
 * AETERNAWalletContext memoizes its value, and the restore effect
 * depends on the wallet object — a fresh object per render would
 * fabricate effect churn the race test must not introduce.
 *
 * jsdom component test — same convention as CreditRuntimePatch2.test.tsx.
 * All network access is mocked. No production calls. No real payment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

const {
  WALLET_ACCOUNT,
  CREATOR_IDENTITY_ID,
  CREATOR_CREDIT_ID,
  stableWallet,
  signMessageMock,
  sendSolanaUSDCPaymentMock,
  preparePreparedCapsuleMock,
} = vi.hoisted(() => {
  const WALLET_ACCOUNT = "7XkWqBase58WalletAccountFor2MTest";
  const CREATOR_IDENTITY_ID = "creator-identity-2m";
  const CREATOR_CREDIT_ID = "creator-credit-2m";

  const signMessageMock = vi.fn(async () => ({
    signature: new Uint8Array(64),
  }));
  const sendSolanaUSDCPaymentMock = vi.fn(async () => "tx-sig-2m-test");

  // Stable identity across renders (see file header) — mirrors the
  // production useMemo'd wallet context value.
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

  const preparePreparedCapsuleMock = vi.fn(async () => ({
    capsuleId: "capsule-2m-test",
    encryptedSizeBytes: 4096,
    vaultSha256: "a".repeat(64),
    saltBase: "b".repeat(43),
    encryptedVaultPointer: "vault-pointer-2m",
    chunkMetadata: [],
    creatorAuthority: "creator-authority-2m",
  }));

  return {
    WALLET_ACCOUNT,
    CREATOR_IDENTITY_ID,
    CREATOR_CREDIT_ID,
    stableWallet,
    signMessageMock,
    sendSolanaUSDCPaymentMock,
    preparePreparedCapsuleMock,
  };
});

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    // Non-empty: canSeal requires items.length > 0 before the first
    // Create Capsule click is enabled.
    items: [
      {
        id: "item-2m-1",
        type: "text",
        text: "PATCH-2M capsule body",
        createdAt: 1700000000000,
      },
    ],
    capsuleId: "capsule-2m-test",
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
  sendSolanaUSDCPayment: sendSolanaUSDCPaymentMock,
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  fundCreatorPaidStorage: vi.fn(),
  toCreatorIrysWallet: vi.fn(),
}));

/* ───────────────── harness ───────────────── */

const json = (body: unknown, ok = true) => ({
  ok,
  json: async () => body,
});

const CHALLENGE_RESPONSE = () =>
  json({
    ok: true,
    id: "challenge-2m",
    challengeId: "challenge-2m",
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

const NO_CREDIT_DISCOVERY = () =>
  json({
    ok: true,
    status: "none",
    creatorCreditId: null,
    creatorIdentityId: null,
    account: WALLET_ACCOUNT,
  });

const PREPARED_PROJECTION = () =>
  json({ ok: true, preparedProjection: { preparedProjectionId: "projection-2m" } });

const STORAGE_QUOTE = () =>
  json({
    ok: true,
    storagePaymentId: "storage-payment-2m",
    expectedAmountAtomic: "1000000",
    displayAmountUSDC: "1.00",
  });

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

const tree = () =>
  React.createElement(
    MemoryRouter,
    null,
    React.createElement(
      CreatorIdentityProvider,
      null,
      React.createElement(
        CreatorCreditProvider,
        null,
        React.createElement(
          LandingPaymentGateProvider,
          null,
          React.createElement(CapsuleBuilder)
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

describe("PATCH-2M service-payment result batch race", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // jsdom's crypto lacks randomUUID on some Node 20 combinations; the
    // controller's requestQuote needs it. No-op when the API exists.
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: () => "uuid-2m-test",
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    // clearAllMocks (NOT restoreAllMocks): call history must reset
    // between scenarios while the hoisted implementations survive.
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("SCENARIO A: same-batch AVAILABLE discovery populates servicePaymentResult and reaches the storage quote", async () => {
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: AVAILABLE_DISCOVERY },
      { match: "/api/capsule/prepared", respond: PREPARED_PROJECTION },
      { match: "/api/storage/quote", respond: STORAGE_QUOTE },
    ]);

    const view = render(tree());
    await acceptProtocol();

    // First explicit Create Capsule: one signature, one discovery.
    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));

    // setEntitlement + DISCOVERY_AVAILABLE commit in ONE React 18 batch:
    // the flow shows paid ("Creator access ready") regardless of the
    // patch — the race decided here.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Creator access ready"
      );
    });

    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/credit-status")).toHaveLength(1);
    expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(0);

    // servicePaymentResult is asserted indirectly through behavior: the
    // final Create Capsule click must pass its `!servicePaymentResult`
    // guard (CapsuleBuilder handleFinalCreateClick) and reach the
    // prepared projection + canonical Irys quote + Final Capsule Review.
    // PRE-PATCH this click is a silent no-op and these waits time out.
    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));

    await waitFor(
      () => expect(preparePreparedCapsuleMock).toHaveBeenCalledTimes(1),
      { timeout: 3000 }
    );
    await waitFor(() => {
      expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy(); // Final Capsule Review open
    });

    // Idempotence: rerender while paid must not re-run discovery or
    // re-quote, and must not loop the restore effect.
    view.rerender(tree());
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/credit-status")).toHaveLength(1);
    expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(1);
    expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
  });

  it("SCENARIO B: same-batch PAYMENT_CONFIRMED populates servicePaymentResult after the $1 grant", async () => {
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      {
        match: "/api/creator/verify-proof",
        respond: () =>
          json({
            ok: true,
            creatorIdentityId: CREATOR_IDENTITY_ID,
            account: WALLET_ACCOUNT,
          }),
      },
      {
        match: "/api/service-payment/create-quote",
        respond: () =>
          json({
            ok: true,
            paymentIntentId: "payment-intent-2m",
            expectedAmount: 1,
            currency: "USDC",
            expiresAt: Date.now() + 600_000,
          }),
      },
      {
        match: "/api/service-payment/verify",
        respond: () => json({ ok: true, status: "VERIFIED" }),
      },
      {
        match: "/api/creator/grant-credit",
        respond: () =>
          json({ ok: true, status: "AVAILABLE", creatorCreditId: CREATOR_CREDIT_ID }),
      },
      { match: "/api/capsule/prepared", respond: PREPARED_PROJECTION },
      { match: "/api/storage/quote", respond: STORAGE_QUOTE },
    ]);

    const view = render(tree());
    await acceptProtocol();

    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "One-time setup — $1 USDC"
      );
    });

    // PATCH-2J: one signature covers discovery AND proof consumption.
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/verify-proof")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);

    // The $1 step: grant → onCreditReady → reportCreditReady +
    // PAYMENT_CONFIRMED land in one batch. PRE-PATCH the paid state
    // commits with servicePaymentResult still null.
    fireEvent.click(screen.getByRole("button", { name: "Confirm $1 USDC" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Creator access ready"
      );
    });
    expect(sendSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);

    // Next Create Capsule reaches preparation instead of a silent no-op.
    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));

    await waitFor(
      () => expect(preparePreparedCapsuleMock).toHaveBeenCalledTimes(1),
      { timeout: 3000 }
    );
    await waitFor(() => {
      expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Idempotence after paid: no second grant, no second quote.
    view.rerender(tree());
    expect(sendSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
    expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    expect(preparePreparedCapsuleMock).toHaveBeenCalledTimes(1);
  });
});
