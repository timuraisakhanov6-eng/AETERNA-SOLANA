// @vitest-environment jsdom
/**
 * AETERNA — Model 01 Phantom-only connection surface.
 *
 * The live audit found that AppKit 1.8.23 always offers a WalletConnect
 * entry in its connect modal, even with `allWallets:'HIDE'` and
 * `includeWalletIds:[phantom]` — `ConnectorUtil` applies those filters only
 * to INJECTED/ANNOUNCED/MULTI_CHAIN connectors, and the WalletConnect
 * connector is registered unconditionally by the Solana adapter.
 *
 * Model 01 therefore never opens that modal: the wallet context connects
 * Phantom through AppKit's supported headless path
 * (`appKit.getWalletList()` → `appKit.connectWallet(item, 'solana')`), which
 * for an injected wallet performs an internal `connectExternal` — no modal,
 * no wallet selector, no WalletConnect entry, no QR.
 *
 * These tests pin that behaviour on the REAL AETERNAWalletContext (only the
 * AppKit module boundary is mocked). They are a `.test.ts` file because the
 * suite's `.test.tsx` set is opted in per file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React, { type ReactNode } from "react";

const {
  PHANTOM_ITEM,
  WALLETCONNECT_ITEM,
  SOLFLARE_ITEM,
  createMockAppKit,
  ensureReownAppKitInstanceMock,
  getReownAppKitInstanceMock,
} = vi.hoisted(() => {
  const PHANTOM_ITEM = {
    id: "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393",
    name: "Phantom",
    imageUrl: "",
    connectors: [
      {
        id: "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393",
        chain: "solana",
      },
    ],
    walletInfo: {},
    isInjected: true,
    isRecent: false,
  };

  const WALLETCONNECT_ITEM = {
    id: "walletConnect",
    name: "WalletConnect",
    imageUrl: "",
    connectors: [],
    walletInfo: {},
    isInjected: false,
    isRecent: false,
  };

  const SOLFLARE_ITEM = {
    id: "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79",
    name: "Solflare",
    imageUrl: "",
    connectors: [
      {
        id: "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79",
        chain: "solana",
      },
    ],
    walletInfo: {},
    isInjected: true,
    isRecent: false,
  };

  const createMockAppKit = (wallets: unknown[] = [PHANTOM_ITEM]) => ({
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    resetWcConnection: vi.fn().mockResolvedValue(undefined),
    resetUri: vi.fn().mockResolvedValue(undefined),
    resetConnectingWallet: vi.fn().mockResolvedValue(undefined),
    getWalletList: vi.fn(() => ({ wallets, wcWallets: [], page: 1, count: wallets.length })),
    connectWallet: vi.fn().mockResolvedValue(undefined),
  });

  return {
    PHANTOM_ITEM,
    WALLETCONNECT_ITEM,
    SOLFLARE_ITEM,
    createMockAppKit,
    ensureReownAppKitInstanceMock: vi.fn(),
    getReownAppKitInstanceMock: vi.fn(),
  };
});

vi.mock("@reown/appkit/react", () => ({
  useAppKitProvider: () => ({ walletProvider: undefined }),
  useAppKitAccount: () => ({ address: undefined }),
  useAppKitConnections: () => ({ connections: [] }),
  useWalletInfo: () => ({ name: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@/lib/wallet/reownSolana", () => ({
  getReownAppKitInstance: getReownAppKitInstanceMock,
  ensureReownAppKitInstance: ensureReownAppKitInstanceMock,
  resetReownAppKitInstance: vi.fn(),
}));

import {
  AETERNAWalletProvider,
  useAeternaWallet,
} from "@/context/AETERNAWalletContext";
import { PHANTOM_NOT_AVAILABLE } from "@/lib/wallet/phantomProvider";

const storageKeys: Record<string, string> = {};

function installLocalStorage() {
  Object.defineProperty(global, "localStorage", {
    value: {
      getItem: (key: string) => storageKeys[key] ?? null,
      setItem: (key: string, value: string) => {
        storageKeys[key] = value;
      },
      removeItem: (key: string) => {
        delete storageKeys[key];
      },
      clear: () => {
        Object.keys(storageKeys).forEach((key) => delete storageKeys[key]);
      },
    },
    writable: true,
    configurable: true,
  });
}

function renderWallet() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(AETERNAWalletProvider, null, children);

  return renderHook(() => useAeternaWallet(), { wrapper });
}

beforeEach(() => {
  Object.keys(storageKeys).forEach((key) => delete storageKeys[key]);
  installLocalStorage();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Model 01 Phantom-only connect surface", () => {
  it("openWalletPicker connects Phantom headlessly and never opens the modal", async () => {
    const appKit = createMockAppKit();
    ensureReownAppKitInstanceMock.mockResolvedValue(appKit);
    getReownAppKitInstanceMock.mockReturnValue(appKit);

    const { result } = renderWallet();

    await act(() => result.current.openWalletPicker());

    // The live connect entry point used by the payment controller.
    expect(appKit.connectWallet).toHaveBeenCalledTimes(1);
    expect(appKit.connectWallet).toHaveBeenCalledWith(PHANTOM_ITEM, "solana");
    // No generic modal ⇒ no wallet selector, no WalletConnect entry, no QR.
    expect(appKit.open).not.toHaveBeenCalled();
  });

  it("connect() also uses the headless Phantom path (no modal)", async () => {
    const appKit = createMockAppKit();
    ensureReownAppKitInstanceMock.mockResolvedValue(appKit);
    getReownAppKitInstanceMock.mockReturnValue(appKit);

    const { result } = renderWallet();

    await act(() => result.current.connect());

    expect(appKit.connectWallet).toHaveBeenCalledWith(PHANTOM_ITEM, "solana");
    expect(appKit.open).not.toHaveBeenCalled();
  });

  it("fails closed when only a WalletConnect entry exists — never falls back to the modal", async () => {
    const appKit = createMockAppKit([WALLETCONNECT_ITEM]);
    ensureReownAppKitInstanceMock.mockResolvedValue(appKit);
    getReownAppKitInstanceMock.mockReturnValue(appKit);

    const { result } = renderWallet();

    await expect(result.current.openWalletPicker()).rejects.toThrow(
      PHANTOM_NOT_AVAILABLE
    );

    expect(appKit.connectWallet).not.toHaveBeenCalled();
    expect(appKit.open).not.toHaveBeenCalled();
  });

  it("fails closed when a non-Phantom injected wallet is the only option", async () => {
    const appKit = createMockAppKit([SOLFLARE_ITEM]);
    ensureReownAppKitInstanceMock.mockResolvedValue(appKit);
    getReownAppKitInstanceMock.mockReturnValue(appKit);

    const { result } = renderWallet();

    await expect(result.current.openWalletPicker()).rejects.toThrow(
      PHANTOM_NOT_AVAILABLE
    );
    expect(appKit.connectWallet).not.toHaveBeenCalled();
    expect(appKit.open).not.toHaveBeenCalled();
  });

  it("fails closed when the wallet list is empty", async () => {
    const appKit = createMockAppKit([]);
    ensureReownAppKitInstanceMock.mockResolvedValue(appKit);
    getReownAppKitInstanceMock.mockReturnValue(appKit);

    const { result } = renderWallet();

    await expect(result.current.openWalletPicker()).rejects.toThrow(
      PHANTOM_NOT_AVAILABLE
    );
    expect(appKit.connectWallet).not.toHaveBeenCalled();
    expect(appKit.open).not.toHaveBeenCalled();
  });

  it("disconnect still works and does not connect anything", async () => {
    const appKit = createMockAppKit();
    ensureReownAppKitInstanceMock.mockResolvedValue(appKit);
    getReownAppKitInstanceMock.mockReturnValue(appKit);

    const { result } = renderWallet();

    await act(() => result.current.disconnect());

    expect(appKit.connectWallet).not.toHaveBeenCalled();
    expect(appKit.open).not.toHaveBeenCalled();
    expect(global.localStorage.getItem("aeterna-wallet-disconnected")).toBe("1");
  });
});
