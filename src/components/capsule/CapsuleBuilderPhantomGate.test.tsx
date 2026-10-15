// @vitest-environment jsdom
/**
 * AETERNA — Model 01 Phantom-only Create gate.
 *
 * Model 01 supports Phantom only at the wallet UX/integration layer
 * (docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1).
 *
 * ADAPTATION TO THE HOME GATE ARCHITECTURE
 * ----------------------------------------
 * The first Create Capsule click used to run this gate inline on
 * /create. It now runs on the HOME page (CreateAccessGate) and /create is
 * creation-only. The scenarios are therefore pinned where the behaviour
 * actually lives:
 *
 *   Phantom absent  -> installation notice, and NO connect / NO SIWS /
 *                      NO quote / NO $1 payment / NO Irys action.
 *   Phantom present -> the existing connect flow continues unchanged.
 *   mobile, no Phantom -> the official in-app-browser deeplink, never a
 *                      hand-built URL and never a redirect loop.
 *
 * The gate is UX-only and never becomes protocol authority: identity is
 * still established server-side through SIWS, payment is still verified
 * server-side, and Creator Credit authority is unchanged.
 *
 * The final scenario is the builder-side regression that replaces the old
 * inline gate: /create must host NO wallet gate at all — an admitted
 * workspace performs no connect, no discovery and no signature.
 *
 * jsdom component test. All network access is mocked. No production calls.
 * No real payment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import { CreateAccessProvider } from "@/context/CreateAccessContext";
import CreateAccessGate from "@/components/access/CreateAccessGate";
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";
import {
  PHANTOM_EXPLORER_ID,
  PHANTOM_INSTALL_URL,
  PHANTOM_MOBILE_OPEN_LABEL,
  PHANTOM_MOBILE_TITLE,
} from "@/lib/wallet/phantomProvider";

/**
 * Mock the PUBLIC AppKit boundary only (`CoreHelperUtil.isMobile` and
 * `MobileWalletUtil.handleMobileDeeplinkRedirect`) — the real AETERNA gate
 * logic runs underneath.
 */
const { isMobileMock, mobileDeeplinkMock } = vi.hoisted(() => ({
  isMobileMock: vi.fn(() => false),
  mobileDeeplinkMock: vi.fn(),
}));

vi.mock("@reown/appkit-controllers", () => ({
  CoreHelperUtil: { isMobile: isMobileMock },
  MobileWalletUtil: { handleMobileDeeplinkRedirect: mobileDeeplinkMock },
}));

const { stableWallet, openWalletPickerMock, sendSolanaUSDCPaymentMock, signMessageMock } =
  vi.hoisted(() => {
    const openWalletPickerMock = vi.fn(async () => {});
    const sendSolanaUSDCPaymentMock = vi.fn(async () => "tx-sig-phantom-gate");
    const signMessageMock = vi.fn(async () => ({
      signature: new Uint8Array(64),
    }));

    // Mutable per test (connected/disconnected) — same object identity, as
    // production AETERNAWalletContext memoizes its value.
    const stableWallet = {
      connected: false,
      account: null as string | null,
      walletName: null as string | null,
      openWalletPicker: openWalletPickerMock,
      changeWallet: vi.fn(async () => {}),
      signMessage: signMessageMock,
      signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
      disconnect: vi.fn(async () => {}),
    };

    return { stableWallet, openWalletPickerMock, sendSolanaUSDCPaymentMock, signMessageMock };
  });

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    items: [
      {
        id: "item-gate-1",
        type: "text",
        text: "Phantom gate capsule body",
        createdAt: 1700000000000,
      },
    ],
    capsuleId: "capsule-gate-test",
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
vi.mock("@/components/capsule/HorizontalCapsule", () => ({ default: () => null }));
vi.mock("@/components/capsule/DateTimePicker", () => ({
  DateTimePicker: () => null,
  normalizeOpenAt: (value: unknown) => value,
}));

vi.mock("@/lib/capsule/preparePreparedCapsule", () => ({
  preparePreparedCapsule: vi.fn(),
}));

vi.mock("@/lib/wallet/solanaWallet", () => ({
  sendSolanaUSDCPayment: sendSolanaUSDCPaymentMock,
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  fundCreatorPaidStorage: vi.fn(),
  toCreatorIrysWallet: vi.fn(),
}));

/* ───────────────── harness ───────────────── */

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ ok: true }),
}));

const ADMISSION = {
  creatorCreditId: "creator-credit-phantom-gate",
  creatorIdentityId: "creator-identity-phantom-gate",
  account: "7XkWqBase58WalletAccountPhantomGate",
};

/** The Home page's gate. */
const gateTree = () =>
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
          React.createElement(CreateAccessProvider, {
            children: React.createElement(CreateAccessGate),
          })
        )
      )
    )
  );

/** /create with an admission already granted by the Home gate. */
const builderTree = () =>
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
            CreateAccessProvider,
            {
              initialAdmission: ADMISSION,
              children: React.createElement(
                Routes,
                null,
                React.createElement(Route, {
                  path: "/create",
                  element: React.createElement(CapsuleBuilder),
                })
              ),
            }
          )
        )
      )
    )
  );

const GATE_BUTTON = "CREATE CAPSULE";

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String((call as unknown as unknown[])[0]));
}

function setPhantom(present: boolean): void {
  const w = window as unknown as { phantom?: unknown };
  if (present) {
    w.phantom = { solana: {} };
  } else {
    delete w.phantom;
  }
}

describe("Model 01 Phantom-only Create gate (Home access gate)", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    openWalletPickerMock.mockClear();
    sendSolanaUSDCPaymentMock.mockClear();
    signMessageMock.mockClear();
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(false);
    mobileDeeplinkMock.mockReset();
    stableWallet.connected = false;
    stableWallet.account = null;
    stableWallet.walletName = null;
    setPhantom(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setPhantom(false);
  });

  it("1-4: Phantom absent shows the installation notice and performs NO connect, NO SIWS, NO quote, NO payment", async () => {
    setPhantom(false);
    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Phantom Wallet Required"
      );
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Install Phantom to create an AETERNA capsule."
    );

    // No connect, no SIWS, no quote, no $1 payment, no Irys action.
    expect(openWalletPickerMock).not.toHaveBeenCalled();
    expect(sendSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    const urls = requestedUrls();
    expect(urls.some((u) => u.includes("issue-challenge"))).toBe(false);
    expect(urls.some((u) => u.includes("verify-proof"))).toBe(false);
    expect(urls.some((u) => u.includes("credit-status"))).toBe(false);
    expect(urls.some((u) => u.includes("create-quote"))).toBe(false);
    expect(urls.some((u) => u.includes("service-payment/verify"))).toBe(false);
    expect(urls.some((u) => u.includes("grant-credit"))).toBe(false);
    expect(urls.some((u) => u.includes("storage/quote"))).toBe(false);
  });

  it("8: Phantom present continues into the existing connect/identity flow", async () => {
    setPhantom(true);
    // Connected wallet -> connectWallet() goes straight to identity
    // verification (no picker), proving the gate did not block the flow.
    stableWallet.connected = true;
    stableWallet.account = "7XkWqBase58WalletAccountPhantomGate";

    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(() => {
      expect(
        requestedUrls().some((u) => u.includes("issue-challenge"))
      ).toBe(true);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sendSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("10: the installation link is the official Phantom URL with no referral parameter", async () => {
    setPhantom(false);
    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    const link = await screen.findByRole("link", { name: "Install Phantom" });
    expect(PHANTOM_INSTALL_URL).toBe("https://phantom.com/download");
    expect(link.getAttribute("href")).toBe(PHANTOM_INSTALL_URL);
    expect(link.getAttribute("href")).not.toMatch(/ref=|referral|affiliate|utm_/i);
  });

  it("mobile + no injected Phantom offers 'Open in Phantom' and never connects, quotes or pays", async () => {
    isMobileMock.mockReturnValue(true);
    setPhantom(false);
    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(PHANTOM_MOBILE_TITLE);
    });

    // Not the desktop install notice.
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Phantom Wallet Required"
    );

    // Nothing happens before the user reaches Phantom.
    expect(openWalletPickerMock).not.toHaveBeenCalled();
    expect(sendSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    const urls = requestedUrls();
    expect(urls.some((u) => u.includes("issue-challenge"))).toBe(false);
    expect(urls.some((u) => u.includes("create-quote"))).toBe(false);
    expect(urls.some((u) => u.includes("storage/quote"))).toBe(false);

    // No redirect until the user taps the action (no redirect loop).
    expect(mobileDeeplinkMock).not.toHaveBeenCalled();
  });

  it("mobile: 'Open in Phantom' invokes the installed public deeplink utility (no WalletConnect)", async () => {
    isMobileMock.mockReturnValue(true);
    setPhantom(false);
    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await screen.findByRole("button", { name: PHANTOM_MOBILE_OPEN_LABEL });

    fireEvent.click(screen.getByRole("button", { name: PHANTOM_MOBILE_OPEN_LABEL }));

    expect(mobileDeeplinkMock).toHaveBeenCalledTimes(1);
    expect(mobileDeeplinkMock).toHaveBeenCalledWith(PHANTOM_EXPLORER_ID, "solana");
    // The generic AppKit connect path (and its WalletConnect relay) is untouched.
    expect(openWalletPickerMock).not.toHaveBeenCalled();
    expect(sendSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("mobile: the fallback install link is the official Phantom URL", async () => {
    isMobileMock.mockReturnValue(true);
    setPhantom(false);
    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    const link = await screen.findByRole("link", { name: "Install Phantom" });
    expect(link.getAttribute("href")).toBe("https://phantom.com/download");
  });

  it("mobile + injected Phantom (inside Phantom's browser) keeps the normal headless flow", async () => {
    isMobileMock.mockReturnValue(true);
    setPhantom(true);
    stableWallet.connected = true;
    stableWallet.account = "7XkWqBase58WalletAccountPhantomMobile";

    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(() => {
      expect(requestedUrls().some((u) => u.includes("issue-challenge"))).toBe(true);
    });

    // No mobile redirect panel and no deeplink navigation.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mobileDeeplinkMock).not.toHaveBeenCalled();
  });

  it("desktop + no Phantom still shows the install notice and never deeplinks", async () => {
    isMobileMock.mockReturnValue(false);
    setPhantom(false);
    render(gateTree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Phantom Wallet Required");
    });
    expect(mobileDeeplinkMock).not.toHaveBeenCalled();
    expect(openWalletPickerMock).not.toHaveBeenCalled();
  });

  it("REGRESSION: /create hosts NO wallet gate — an admitted workspace never connects or discovers", async () => {
    setPhantom(true);
    stableWallet.connected = true;
    stableWallet.account = ADMISSION.account;

    render(builderTree());

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Creator access ready");
    });

    // The inline gate is gone: no picker, no challenge, no discovery, no
    // signature, no payment on the creation page.
    expect(openWalletPickerMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(sendSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    // …and the phantom notices live on Home, not here.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
