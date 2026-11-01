// @vitest-environment jsdom
/**
 * AETERNA — Home page Protocol link (R9-A48).
 *
 * Pins the R9-A48 decision: EXACTLY ONE Protocol link remains on Home — the
 * one inside the consent sentence. The redundant hero link ("Read the
 * Protocol Rules →") and the footer link ("Information & Legal") are gone.
 * The consent link navigates in the SAME tab (React Router link, no
 * target="_blank"), is styled with the AETERNA gold accent, and clicking it
 * never accepts the consent by itself.
 *
 * jsdom component test. No network, no wallet, no payment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Link, useLocation } from "react-router-dom";
import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import { CreateAccessProvider } from "@/context/CreateAccessContext";
import { CapsuleProvider } from "@/context/CapsuleContext";
import Home from "@/pages/Home";
import { protocolReturnState } from "@/lib/navigation/protocolReturn";

/**
 * The gate underneath Home needs the wallet context and the payment
 * transport. Mock ONLY those boundaries (the real gate logic runs), exactly
 * like the dedicated gate suite does — no provider init in jsdom.
 */
const { stableWallet, signSolanaUSDCPaymentMock } = vi.hoisted(() => ({
  stableWallet: {
    connected: false,
    account: null as string | null,
    walletName: null as string | null,
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })),
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    signTransaction: vi.fn(async (tx: unknown) => tx),
    disconnect: vi.fn(async () => {}),
  },
  signSolanaUSDCPaymentMock: vi.fn(),
}));

vi.mock("@reown/appkit-controllers", () => ({
  CoreHelperUtil: { isMobile: () => false },
  MobileWalletUtil: { handleMobileDeeplinkRedirect: () => {} },
}));

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/lib/wallet/solanaWallet", () => ({
  signSolanaUSDCPayment: signSolanaUSDCPaymentMock,
}));

/** Same-tab navigation probe: the Protocol route of this test tree. */
const ProtocolProbe = () => {
  const location = useLocation();
  return (
    <div data-testid="protocol-route">
      <span data-testid="protocol-state">
        {JSON.stringify(location.state ?? null)}
      </span>
      <Link to="/">back-home</Link>
    </div>
  );
};

const tree = () => (
  <MemoryRouter initialEntries={["/"]}>
    <CapsuleProvider>
      <CreatorIdentityProvider>
        <CreatorCreditProvider>
          <LandingPaymentGateProvider>
            <CreateAccessProvider>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/protocol" element={<ProtocolProbe />} />
              </Routes>
            </CreateAccessProvider>
          </LandingPaymentGateProvider>
        </CreatorCreditProvider>
      </CreatorIdentityProvider>
    </CapsuleProvider>
  </MemoryRouter>
);

const bodyText = (): string =>
  (document.body.textContent ?? "").replace(/\s+/g, " ");

describe("Home — single Protocol link (R9-A48)", () => {
  beforeEach(() => {
    // The gate never starts a wallet flow here; stub fetch defensively so no
    // jsdom network error can leak into an assertion.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    try {
      localStorage.clear();
    } catch {
      /* jsdom always provides localStorage */
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps exactly ONE Protocol link — the consent link — and no redundant legal links", () => {
    render(tree());

    const protocolLinks = Array.from(document.querySelectorAll("a")).filter(
      (a) => a.getAttribute("href") === "/protocol"
    );
    expect(protocolLinks).toHaveLength(1);

    const link = protocolLinks[0];
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe("AETERNA Protocol");
    // Same tab: a router link, never a new-tab anchor.
    expect(link?.getAttribute("target")).toBeNull();
    expect(link?.getAttribute("rel")).toBeNull();
    // Inside the consent sentence.
    expect(link?.closest("label")).toBeTruthy();
    // Gold brand accent + explicit link indicator.
    expect(link?.className).toContain("text-amber-300");
    expect(link?.className).toContain("underline");

    expect(bodyText()).not.toContain("Read the Protocol Rules");
    expect(bodyText()).not.toContain("Information & Legal");
  });

  it("opens the Protocol in the same tab and never accepts the consent by itself", async () => {
    render(tree());

    const gate = screen.getByRole("button", { name: "CREATE CAPSULE" });
    expect(gate.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("link", { name: "AETERNA Protocol" }));

    // SPA navigation inside the same document — the Protocol route renders.
    await waitFor(() =>
      expect(screen.getByTestId("protocol-route")).toBeTruthy()
    );

    // R9-A57: the consent link marks the Home origin, so the Protocol footer
    // can return here. The state carries an origin token only.
    expect(
      JSON.parse(screen.getByTestId("protocol-state").textContent ?? "null")
    ).toEqual(protocolReturnState("home"));

    // Back to Home: the consent is still unchecked — reading the Protocol
    // never substitutes for the explicit acknowledgment.
    fireEvent.click(screen.getByRole("link", { name: "back-home" }));

    await waitFor(() =>
      expect(screen.getByRole("checkbox")).toBeTruthy()
    );
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "false"
    );
    expect(
      screen.getByRole("button", { name: "CREATE CAPSULE" }).hasAttribute(
        "disabled"
      )
    ).toBe(true);
  });

  it("requires the acknowledgment before the creation gate can start", () => {
    render(tree());

    const gate = screen.getByRole("button", { name: "CREATE CAPSULE" });
    expect(gate.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(gate.hasAttribute("disabled")).toBe(false);
  });
});
