// @vitest-environment jsdom
/**
 * AETERNA — /create admission contract (Home gate → CapsuleBuilder).
 *
 * Pins the client-side half of the access-gate rework:
 *
 *   A. admission seeds the paid workspace with NO connect, NO signature,
 *      NO discovery and NO payment — the Home gate already established
 *      the entitlement server-side;
 *   B. a wallet DISCONNECT voids the (account-bound) admission and returns
 *      the creator to the Home gate;
 *   C. a wallet ACCOUNT SWITCH does the same;
 *   D. without admission the workspace is inert (defense in depth — the
 *      route-level guard in pages/capsule/Create.tsx is the real gate).
 *
 * jsdom component test — same harness convention as the former
 * CapsuleBuilderRestoreBatching suite. All network access is mocked.
 * No production calls, no real payment, no wallet transaction.
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
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

const {
  WALLET_ACCOUNT,
  OTHER_ACCOUNT,
  CREATOR_IDENTITY_ID,
  CREATOR_CREDIT_ID,
  walletControl,
  signMessageMock,
} = vi.hoisted(() => {
  const WALLET_ACCOUNT = "7XkWqBase58WalletAccountAdmission";
  const OTHER_ACCOUNT = "7XkWqBase58WalletAccountAdmissionOther";
  const CREATOR_IDENTITY_ID = "creator-identity-admission";
  const CREATOR_CREDIT_ID = "creator-credit-admission";

  const signMessageMock = vi.fn(async () => ({
    signature: new Uint8Array(64),
  }));

  const baseWallet = {
    connected: true,
    account: WALLET_ACCOUNT,
    walletName: "Phantom",
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: signMessageMock,
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    disconnect: vi.fn(async () => {}),
  };

  // The production wallet context memoizes its value and REPLACES it when
  // the connection state changes. The mock mirrors that: a mutable holder
  // whose object identity changes only on a real wallet event — so the
  // builder's wallet-guard effect sees exactly the production signal.
  // Deliberately typed loosely (account/walletName may be null) so the
  // disconnect scenario can be represented.
  type MockWallet = {
    connected: boolean;
    account: string | null;
    walletName: string | null;
    openWalletPicker: () => Promise<void>;
    changeWallet: () => Promise<void>;
    signMessage: typeof signMessageMock;
    signAndSendTransaction: () => Promise<{ signature: string }>;
    disconnect: () => Promise<void>;
  };

  let currentWallet: MockWallet = { ...baseWallet };

  const makeWallet = (
    connected: boolean,
    account: string | null,
    walletName: string | null
  ): MockWallet => ({
    connected,
    account,
    walletName,
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: signMessageMock,
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    disconnect: vi.fn(async () => {}),
  });

  const walletControl = {
    getWallet: () => currentWallet,
    /** Flip the connection state the way production AETERNAWalletContext does. */
    connect: (account: string = WALLET_ACCOUNT) => {
      currentWallet = makeWallet(true, account, "Phantom");
    },
    disconnect: () => {
      currentWallet = makeWallet(false, null, null);
    },
    switchAccount: (account: string = OTHER_ACCOUNT) => {
      currentWallet = makeWallet(true, account, "Phantom");
    },
  };

  return {
    WALLET_ACCOUNT,
    OTHER_ACCOUNT,
    CREATOR_IDENTITY_ID,
    CREATOR_CREDIT_ID,
    walletControl,
    signMessageMock,
  };
});

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => walletControl.getWallet(),
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    items: [
      {
        id: "item-admission-1",
        type: "text",
        text: "admission contract capsule body",
        createdAt: 1700000000000,
      },
    ],
    capsuleId: "capsule-admission-test",
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
  sendSolanaUSDCPayment: vi.fn(async () => "tx-sig-admission"),
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

/** The Home destination the builder returns to on a wallet event. */
function HomeProbe() {
  return React.createElement("div", { "data-testid": "home-route" });
}

/** The exact admission shape the Home access gate grants after verification. */
const ADMISSION = {
  creatorCreditId: CREATOR_CREDIT_ID,
  creatorIdentityId: CREATOR_IDENTITY_ID,
  account: WALLET_ACCOUNT,
};

const tree = (options?: { seedAdmission?: boolean }) =>
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
              initialAdmission: options?.seedAdmission ? ADMISSION : null,
              children: React.createElement(
                Routes,
                null,
                React.createElement(Route, {
                  path: "/create",
                  element: React.createElement(CapsuleBuilder),
                }),
                React.createElement(Route, {
                  path: "/",
                  element: React.createElement(HomeProbe),
                })
              ),
            }
          )
        )
      )
    )
  );

function acceptProtocol() {
  fireEvent.click(screen.getByRole("checkbox"));
}

describe("/create admission contract", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    signMessageMock.mockClear();
    walletControl.connect();
    (window as unknown as { phantom?: unknown }).phantom = { solana: {} };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { phantom?: unknown }).phantom;
    vi.unstubAllGlobals();
  });

  it("A. admission seeds the paid workspace with NO signature, NO discovery and NO payment", async () => {
    render(tree({ seedAdmission: true }));

    // The Home gate's server-verified outcome is mirrored, not re-run.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Creator access ready"
      );
    });

    acceptProtocol();
    await waitFor(() => {
      expect(
        (screen.getByRole("checkbox") as HTMLElement).dataset["state"]
      ).toBe("checked");
    });

    expect(signMessageMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("home-route")).toBeNull();
  });

  it("B. a wallet disconnect voids admission and returns to the Home gate", async () => {
    const view = render(tree({ seedAdmission: true }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Creator access ready"
      );
    });
    expect(screen.queryByTestId("home-route")).toBeNull();

    // A real wallet event replaces the context value (new identity).
    walletControl.disconnect();
    view.rerender(tree({ seedAdmission: true }));

    await waitFor(() => {
      expect(screen.getByTestId("home-route")).toBeTruthy();
    });
  });

  it("C. an account switch voids admission and returns to the Home gate", async () => {
    const view = render(tree({ seedAdmission: true }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Creator access ready"
      );
    });

    walletControl.switchAccount(OTHER_ACCOUNT);
    view.rerender(tree({ seedAdmission: true }));

    await waitFor(() => {
      expect(screen.getByTestId("home-route")).toBeTruthy();
    });
  });

  it("D. without admission the workspace is inert (no paid status, disabled create)", async () => {
    render(tree());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create Capsule" })).toBeTruthy();
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Create Capsule" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
