// @vitest-environment jsdom
/**
 * AETERNA - explicit wallet disconnect (R9-A68).
 *
 * After an explicit disconnect the app must survive a reload: Home renders,
 * the wallet stays disconnected, nothing connects on its own, and the manual
 * Phantom entry point still works.
 *
 * The AppKit fake mirrors the real SDK contract that caused the blank page:
 * its hooks THROW when no instance exists, exactly like
 * `useWalletInfo` does in production. A passing suite therefore proves the
 * inner provider can only mount after `getReownAppKitInstance()` ran.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React, { type ReactNode } from "react";

const CAPSULE_ID = "c".repeat(64);
const FRAGMENT = "#" + "a".repeat(64);
const MARKER_KEY = "aeterna-wallet-disconnected";
const RESTORED_ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** Records AppKit construction and the Phantom connect path. */
const sdk = vi.hoisted(() => ({
  constructions: 0,
  modalOpens: 0,
  hookMounts: [] as Array<{ hook: string; constructionsAtMount: number }>,
}));

const connectPhantomHeadlessMock = vi.hoisted(() => vi.fn());
const ensureInstanceMock = vi.hoisted(() => vi.fn());

vi.mock("@reown/appkit/react", () => {
  const guard = (hook: string) => {
    if (sdk.constructions === 0) {
      throw new Error(`Please call "createAppKit" before using "${hook}" hook`);
    }
  };

  return {
    createAppKit: () => {
      sdk.constructions += 1;
      return { open: async () => { sdk.modalOpens += 1; } };
    },
    useDisconnect: () => ({
      disconnect: vi.fn().mockResolvedValue(undefined),
    }),
    useAppKitProvider: () => ({ walletProvider: undefined }),
    useAppKitAccount: () => ({ address: RESTORED_ACCOUNT }),
    useAppKitConnections: () => ({ connections: [] }),
    useWalletInfo: () => {
      const recorded = React.useRef(false);
      if (!recorded.current) {
        recorded.current = true;
        sdk.hookMounts.push({
          hook: "useWalletInfo",
          constructionsAtMount: sdk.constructions,
        });
      }
      guard("useWalletInfo");
      return { name: "Phantom" };
    },
  };
});

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

  ensureInstanceMock.mockImplementation(async () => cached ?? create());

  return {
    getReownAppKitInstance: () => cached ?? create(),
    ensureReownAppKitInstance: () => ensureInstanceMock(),
    resetReownAppKitInstance: () => {
      cached = null;
    },
  };
});

vi.mock("@/lib/wallet/phantomProvider", () => ({
  connectPhantomHeadless: connectPhantomHeadlessMock,
}));

import {
  AETERNAWalletProvider,
  useAeternaWallet,
} from "@/context/AETERNAWalletContext";
import { resetReownAppKitInstance } from "@/lib/wallet/reownSolana";

function renderAt(entry: string) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      React.createElement(AETERNAWalletProvider, null, children)
    );

  return renderHook(() => useAeternaWallet(), { wrapper });
}

function setMarker(present: boolean) {
  if (present) {
    localStorage.setItem(MARKER_KEY, "1");
  } else {
    localStorage.removeItem(MARKER_KEY);
  }
}

beforeEach(() => {
  // The mocked wallet boundary keeps a module-level singleton, like the
  // real `cachedAppKit`: reset it so every test starts with no instance.
  resetReownAppKitInstance();
  sdk.constructions = 0;
  sdk.modalOpens = 0;
  sdk.hookMounts.length = 0;
  connectPhantomHeadlessMock.mockReset();
  connectPhantomHeadlessMock.mockResolvedValue(undefined);
  ensureInstanceMock.mockClear();
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("R9-A68 explicit disconnect - startup", () => {
  it("mounts the inner provider only after AppKit exists (no blank Home)", () => {
    setMarker(true);

    const { result } = renderAt("/");

    // Without the fix the throwing hook kills this render (blank page).
    expect(result.current.ready).toBe(true);
    expect(sdk.constructions).toBe(1);
    expect(sdk.hookMounts).toEqual([
      { hook: "useWalletInfo", constructionsAtMount: 1 },
    ]);
  });

  it("does not connect, prompt or open the wallet on load", () => {
    setMarker(true);

    const { result } = renderAt("/");

    expect(connectPhantomHeadlessMock).not.toHaveBeenCalled();
    expect(sdk.modalOpens).toBe(0);
    expect(result.current.connected).toBe(false);
  });

  it("keeps a wallet that AppKit could restore disconnected", () => {
    setMarker(true);

    const { result } = renderAt("/");

    // The account hook reports a restored address; the marker must win.
    expect(result.current.account).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.walletId).toBeNull();
  });

  it("still renders disconnected when no marker is present", () => {
    setMarker(false);

    renderAt("/");

    expect(sdk.constructions).toBe(1);
  });
});

describe("R9-A68 explicit disconnect - manual connect", () => {
  it("keeps the manual Phantom entry point working and clears the marker", async () => {
    setMarker(true);

    const { result } = renderAt("/");
    expect(connectPhantomHeadlessMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.connect();
    });

    expect(connectPhantomHeadlessMock).toHaveBeenCalledTimes(1);
    expect(ensureInstanceMock).toHaveBeenCalled();
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(sdk.modalOpens).toBe(0);
  });
});

describe("R9-A68 explicit disconnect - recipient isolation", () => {
  it("never constructs AppKit on a recipient capsule route", () => {
    setMarker(true);

    const { result } = renderAt(`/capsule/${CAPSULE_ID}${FRAGMENT}`);

    expect(sdk.constructions).toBe(0);
    expect(result.current.ready).toBe(false);
    expect(connectPhantomHeadlessMock).not.toHaveBeenCalled();
  });
});