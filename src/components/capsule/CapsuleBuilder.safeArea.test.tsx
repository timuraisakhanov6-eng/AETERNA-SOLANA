// @vitest-environment jsdom
/**
 * =========================================================
 * AETERNA — CapsuleBuilder safe-area contract (R9-A88.11)
 * =========================================================
 *
 * `viewport-fit=cover` is global, so the fixed 64 px header on /create was
 * positioned against the PHYSICAL screen edge: its content band (and the Back
 * control) sat inside the iOS status bar, and the Back link at 20 px was also
 * inside the landscape sensor inset.
 *
 * The component renders inline styles, so this suite asserts the exact style
 * attribute and class list that reach the DOM — not a CSS cascade.
 *
 * What is pinned:
 *  1  header height is `calc(64px + env(safe-area-inset-top))`
 *  2  header content is pushed down by exactly `env(safe-area-inset-top)`
 *  3  main keeps a 32 px gap after the complete header
 *  4  the Back control clears the left inset at its original 1.25rem
 *  5  zero-inset arithmetic is the ORIGINAL geometry (64 / 96 / 20 px)
 *  6  Back still points at "/" (navigation contract untouched)
 *
 * jsdom does not emulate a physical iPhone, `env()` values, or layout. Only the
 * declaration contract is observed here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import { CreateAccessProvider } from "@/context/CreateAccessContext";
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

const { stableWallet } = vi.hoisted(() => ({
  stableWallet: {
    connected: true,
    account: "7XkWqBase58WalletAccountSafeArea",
    walletName: "Phantom",
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })),
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    disconnect: vi.fn(async () => {}),
  },
}));

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    items: [],
    capsuleId: "capsule-safe-area-test",
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

vi.mock("@reown/appkit-controllers", () => ({
  CoreHelperUtil: { isMobile: () => false },
  MobileWalletUtil: { handleMobileDeeplinkRedirect: vi.fn() },
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
  sendSolanaUSDCPayment: vi.fn(),
}));
vi.mock("@/lib/storage/creatorIrys", () => ({
  fundCreatorPaidStorage: vi.fn(),
  toCreatorIrysWallet: vi.fn(),
}));

const ADMISSION = {
  creatorCreditId: "creator-credit-safe-area",
  creatorIdentityId: "creator-identity-safe-area",
  account: "7XkWqBase58WalletAccountSafeArea",
};

function tree() {
  return (
    <MemoryRouter initialEntries={["/create"]}>
      <CreatorIdentityProvider>
        <CreatorCreditProvider>
          <LandingPaymentGateProvider>
            <CreateAccessProvider initialAdmission={ADMISSION}>
              <Routes>
                <Route path="/create" element={<CapsuleBuilder />} />
              </Routes>
            </CreateAccessProvider>
          </LandingPaymentGateProvider>
        </CreatorCreditProvider>
      </CreatorIdentityProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("R9-A88.11 — CapsuleBuilder header safe area", () => {
  it("1/2/5: header grows by the top inset and keeps its original 64px band", () => {
    const { container } = render(tree());

    const header = container.querySelector("header");
    expect(header).not.toBeNull();

    const style = (header as HTMLElement).getAttribute("style") ?? "";

    // Height carries the inset; the constant term is the original 64 px, so a
    // zero-inset device renders exactly the old bar.
    expect(style).toContain("height: calc(64px + env(safe-area-inset-top))");

    const classes = (header as HTMLElement).className.split(/\s+/);

    // Content is pushed below the status bar by exactly the inset (no extra
    // offset), and the bar is still anchored to the viewport top so its
    // background fills the unsafe strip. This is expressed as a Tailwind class
    // rather than an inline style: jsdom's CSS parser drops a bare `env()`
    // declaration from the style attribute, while the class list and the
    // compiled stylesheet both keep it observable.
    expect(classes).toContain("pt-[env(safe-area-inset-top)]");
    expect(classes).toContain("fixed");
    expect(classes).toContain("top-0");
    expect(classes).toContain("left-0");
    expect(classes).toContain("right-0");
  });

  it("3/5: main preserves the original 32px gap below the complete header", () => {
    const { container } = render(tree());

    const main = container.querySelector("main");
    expect(main).not.toBeNull();

    const style = (main as HTMLElement).getAttribute("style") ?? "";

    // 96 px = 64 px header + 32 px gap; the inset is added because the header
    // also grew by it.
    expect(style).toContain("padding-top: calc(96px + env(safe-area-inset-top))");
  });

  it("4/5/6: Back control clears the left inset and keeps its 1.25rem spacing", () => {
    render(tree());

    const back = screen.getByRole("link", { name: /Back/i });
    const classes = back.className.split(/\s+/);

    expect(classes).toContain(
      "left-[calc(env(safe-area-inset-left)+1.25rem)]",
    );

    // The flat 20 px offset is gone, so no cascade order can reinstate it.
    expect(classes).not.toContain("left-5");

    // Navigation contract untouched.
    expect(back.getAttribute("href")).toBe("/");
  });
});