// @vitest-environment jsdom
/**
 * AETERNA — R9-A62: AppKit initialization ORDER on recipient navigation.
 *
 * Regression for the first-click blank Protocol page (R9-A61 diagnosis).
 *
 * The fake mirrors exactly what production showed:
 *   - `AETERNAWalletProviderInner` guards 92-94 (useDisconnect,
 *     useAppKitProvider, useAppKitAccount, useAppKitConnections) render
 *     without an AppKit instance;
 *   - `useWalletInfo('solana')` (line 95) THROWS
 *     "Please call \"createAppKit\" before using \"useWalletInfo\" hook".
 *
 * The provider used to mark itself ready inside the deferral branch without
 * constructing AppKit, so the first navigation from `/capsule/:id#<cap>` to
 * `/protocol` mounted the inner provider before any instance existed.
 *
 * SYNTHETIC values only. Every assertion runs with a disconnected wallet:
 * a recipient must never need one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, render, act, cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import React, { type ReactNode } from "react";

const SYNTHETIC_CAPSULE_ID = "c".repeat(64);
const SYNTHETIC_RECIPIENT = "a".repeat(64);
const CAPSULE_ENTRY = `/capsule/${SYNTHETIC_CAPSULE_ID}#${SYNTHETIC_RECIPIENT}`;
const PROTOCOL_ENTRY = "/protocol?section=opening-presence";

/** Records constructions and the moment each inner-provider hook mounted. */
const sdk = vi.hoisted(() => ({
  constructions: 0,
  modalOpens: 0,
  hookMounts: [] as Array<{ hook: string; constructionsAtMount: number }>,
}));

vi.mock("@reown/appkit/react", () => ({
  createAppKit: () => {
    sdk.constructions += 1;
    return {
      open: async () => {
        sdk.modalOpens += 1;
      },
    };
  },
  useDisconnect: () => ({ disconnect: vi.fn().mockResolvedValue(undefined) }),
  useAppKitProvider: () => ({ walletProvider: undefined }),
  useAppKitAccount: () => ({ address: undefined }),
  useAppKitConnections: () => ({ connections: [] }),
  useWalletInfo: () => {
    // Record the first call per mounted component instance (this hook is
    // invoked on every render, so a plain counter would report renders).
    const recorded = React.useRef(false);
    if (!recorded.current) {
      recorded.current = true;
      sdk.hookMounts.push({
        hook: "useWalletInfo",
        constructionsAtMount: sdk.constructions,
      });
    }

    if (sdk.constructions === 0) {
      throw new Error(
        'Please call "createAppKit" before using "useWalletInfo" hook'
      );
    }

    return { name: undefined };
  },
}));

vi.mock("@/lib/wallet/reownSolana", () => {
  let cached: { open: () => Promise<void> } | null = null;

  const create = () => {
    sdk.constructions += 1;
    cached = {
      open: async () => {
        sdk.modalOpens += 1;
      },
    };
    return cached;
  };

  return {
    getReownAppKitInstance: () => cached ?? create(),
    ensureReownAppKitInstance: async () => cached ?? create(),
    resetReownAppKitInstance: () => {
      cached = null;
    },
  };
});

import {
  AETERNAWalletProvider,
  useAeternaWallet,
} from "@/context/AETERNAWalletContext";
import { resetReownAppKitInstance } from "@/lib/wallet/reownSolana";
import Protocol from "@/pages/Protocol";

function renderAt(initialEntry: string) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      React.createElement(AETERNAWalletProvider, null, children)
    );

  return renderHook(
    () => ({ wallet: useAeternaWallet(), navigate: useNavigate() }),
    { wrapper }
  );
}

beforeEach(() => {
  // The mocked wallet boundary keeps a module-level singleton, exactly like
  // the real `cachedAppKit`. Reset BOTH so every test starts from "no
  // instance exists" (otherwise the instance and the counter disagree).
  resetReownAppKitInstance();
  // The real Protocol page calls window.scrollTo on mount; jsdom has no
  // implementation and logs a "Not implemented" notice.
  vi.stubGlobal("scrollTo", vi.fn());
  sdk.constructions = 0;
  sdk.modalOpens = 0;
  sdk.hookMounts.length = 0;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("R9-A62 AppKit initialization order", () => {
  it("opens the Protocol on the FIRST navigation away from a recipient capsule URL", async () => {
    const { result } = renderAt(CAPSULE_ENTRY);

    // Recipient route: the wallet integration stays inert, nothing is built.
    expect(result.current.wallet.ready).toBe(false);
    expect(sdk.constructions).toBe(0);
    expect(sdk.hookMounts).toHaveLength(0);

    await act(async () => {
      result.current.navigate(PROTOCOL_ENTRY);
    });

    // No render throw, and the wallet context only comes alive afterwards.
    expect(result.current.wallet.ready).toBe(true);
    expect(sdk.constructions).toBe(1);
  });

  it("mounts the AppKit-consuming provider only once an instance exists", async () => {
    const { result } = renderAt(CAPSULE_ENTRY);

    await act(async () => {
      result.current.navigate(PROTOCOL_ENTRY);
    });

    expect(sdk.hookMounts).toEqual([
      { hook: "useWalletInfo", constructionsAtMount: 1 },
    ]);
  });

  it("requires no wallet for the recipient: disconnected, no modal, no prompt", async () => {
    const { result } = renderAt(CAPSULE_ENTRY);

    await act(async () => {
      result.current.navigate(PROTOCOL_ENTRY);
    });

    expect(sdk.modalOpens).toBe(0);
    expect(result.current.wallet.connected).toBe(false);
    expect(result.current.wallet.account).toBeNull();
    expect(result.current.wallet.walletId).toBeNull();
  });

  it("keeps the recipient inert when navigating back to the capsule URL", async () => {
    const { result } = renderAt(CAPSULE_ENTRY);

    await act(async () => {
      result.current.navigate(PROTOCOL_ENTRY);
    });

    await act(async () => {
      result.current.navigate(CAPSULE_ENTRY);
    });

    // No second construction, no second mount, no wallet prompt.
    expect(sdk.constructions).toBe(1);
    expect(sdk.hookMounts).toHaveLength(1);
    expect(sdk.modalOpens).toBe(0);
  });

  it("renders the REAL Protocol page on that first navigation", async () => {
    const Harness = () => {
      const navigate = useNavigate();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          { type: "button", onClick: () => navigate(PROTOCOL_ENTRY) },
          "open protocol"
        ),
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: "/capsule/:capsuleId",
            element: React.createElement("p", null, "capsule surface"),
          }),
          React.createElement(Route, {
            path: "/protocol",
            element: React.createElement(Protocol),
          })
        )
      );
    };

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [CAPSULE_ENTRY] },
        React.createElement(
          AETERNAWalletProvider,
          null,
          React.createElement(Harness)
        )
      )
    );

    expect(screen.getByText("capsule surface")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("open protocol"));
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Protocol"
    );
    expect(screen.getByText("Creator Presence")).toBeTruthy();
    expect(sdk.modalOpens).toBe(0);
  });

  it("still initializes AppKit eagerly on a normal creator route", () => {
    const { result } = renderAt("/create");

    expect(sdk.constructions).toBe(1);
    expect(result.current.wallet.ready).toBe(true);
  });
});