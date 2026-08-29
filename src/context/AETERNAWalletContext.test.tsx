import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import {
  AETERNAWalletProvider,
  useAeternaWallet,
} from '@/context/AETERNAWalletContext';

const storageKeys: Record<string, string> = {};

function mockSessionStorage(keys: Record<string, string> = {}) {
  return {
    getItem: (key: string) => storageKeys[key] ?? keys[key] ?? null,
    setItem: (key: string, value: string) => {
      storageKeys[key] = value;
    },
    removeItem: (key: string) => {
      delete storageKeys[key];
    },
    clear: () => {
      Object.keys(storageKeys).forEach((key) => delete storageKeys[key]);
    },
  };
}

function createMockAppKit(overrides = {}) {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    resetWcConnection: vi.fn().mockResolvedValue(undefined),
    resetUri: vi.fn().mockResolvedValue(undefined),
    resetConnectingWallet: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const mockUseAppKit = () => ({
  open: vi.fn().mockResolvedValue(undefined),
});

const mockUseDisconnect = () => ({
  disconnect: vi.fn().mockResolvedValue(undefined),
});

const mockUseAppKitProvider = () => ({
  walletProvider: undefined,
});

const mockUseAppKitAccount = () => ({
  address: undefined,
});

const mockUseAppKitConnections = () => ({
  connections: [],
});

const mockUseWalletInfo = () => ({
  name: undefined,
});

vi.mock('@reown/appkit/react', () => ({
  useAppKit: mockUseAppKit,
  useDisconnect: mockUseDisconnect,
  useAppKitProvider: mockUseAppKitProvider,
  useAppKitAccount: mockUseAppKitAccount,
  useAppKitConnections: mockUseAppKitConnections,
  useWalletInfo: mockUseWalletInfo,
  AppKit: class AppKit {},
}));

vi.mock('@/lib/wallet/reownSolana', () => ({
  getReownAppKitInstance: vi.fn(),
  ensureReownAppKitInstance: vi.fn(),
  resetReownAppKitInstance: vi.fn(),
}));

import { getReownAppKitInstance, ensureReownAppKitInstance } from '@/lib/wallet/reownSolana';

function renderTestProvider(sessionStorageState: Record<string, string> = {}) {
  Object.keys(storageKeys).forEach((key) => delete storageKeys[key]);
  Object.entries(sessionStorageState).forEach(([key, value]) => {
    storageKeys[key] = value;
  });

  const originalSessionStorage = global.sessionStorage;

  Object.defineProperty(global, 'sessionStorage', {
    value: mockSessionStorage(sessionStorageState),
    writable: true,
    configurable: true,
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AETERNAWalletProvider>{children}</AETERNAWalletProvider>
  );

  const result = renderHook(() => useAeternaWallet(), { wrapper });

  return {
    result,
    restoreSessionStorage: () => {
      Object.defineProperty(global, 'sessionStorage', {
        value: originalSessionStorage,
        writable: true,
        configurable: true,
      });
    },
  };
}

beforeEach(() => {
  Object.keys(storageKeys).forEach((key) => delete storageKeys[key]);
  vi.clearAllMocks();
});

describe('AETERNAWalletProvider initialization gate', () => {
  it('defers AppKit initialization when explicit disconnect marker is present', async () => {
    const appKit = createMockAppKit();
    (getReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockReturnValue(appKit);
    (ensureReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(appKit);

    const { result } = renderTestProvider({ 'aeterna-wallet-disconnected': '1' });

    expect(getReownAppKitInstance).not.toHaveBeenCalled();
    expect(ensureReownAppKitInstance).not.toHaveBeenCalled();
    expect(result.current.wallet.connect()).rejects.toThrow('Wallet is initializing');
    expect(result.current.wallet.disconnect()).rejects.toThrow('Wallet is initializing');
  });

  it('initializes AppKit when explicit disconnect marker is absent', async () => {
    const appKit = createMockAppKit();
    (getReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockReturnValue(appKit);

    const { result } = renderTestProvider({});

    expect(getReownAppKitInstance).toHaveBeenCalledTimes(1);
    expect(ensureReownAppKitInstance).not.toHaveBeenCalled();
    expect(result.current.state.ready).toBe(true);
    expect(() => result.current.wallet.connect).not.toThrow();
  });
});

describe('AETERNAWalletProvider explicit actions', () => {
  it('clears marker and initializes AppKit on explicit Connect', async () => {
    const appKit = createMockAppKit();
    (getReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockReturnValue(appKit);
    (ensureReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(appKit);

    const { result } = renderTestProvider({ 'aeterna-wallet-disconnected': '1' });

    await act(() => result.current.wallet.connect());

    expect(global.sessionStorage.getItem('aeterna-wallet-disconnected')).toBeNull();
    expect(ensureReownAppKitInstance).toHaveBeenCalledTimes(1);
    expect(appKit.open).toHaveBeenCalledTimes(1);
  });

  it('clears marker, initializes AppKit, disconnects and opens picker on Change Wallet', async () => {
    const appKit = createMockAppKit();
    (getReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockReturnValue(appKit);
    (ensureReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(appKit);

    const { result } = renderTestProvider({ 'aeterna-wallet-disconnected': '1' });

    await act(() => result.current.wallet.changeWallet());

    expect(global.sessionStorage.getItem('aeterna-wallet-disconnected')).toBeNull();
    expect(ensureReownAppKitInstance).toHaveBeenCalledTimes(1);
    expect(appKit.disconnect).toHaveBeenCalledWith({ namespace: 'solana' });
    expect(appKit.open).toHaveBeenCalledTimes(1);
  });

  it('sets marker on explicit Disconnect and clears local state', async () => {
    const appKit = createMockAppKit();
    (getReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockReturnValue(appKit);

    const { result } = renderTestProvider({});
    await act(() => result.current.wallet.connect());
    expect(result.current.state.ready).toBe(true);

    await act(() => result.current.wallet.disconnect());

    expect(global.sessionStorage.getItem('aeterna-wallet-disconnected')).toBe('1');
    expect(appKit.disconnect).toHaveBeenCalledWith({ namespace: 'solana' });
    expect(appKit.resetWcConnection).toHaveBeenCalled();
    expect(result.current.state.connected).toBe(false);
    expect(result.current.state.account).toBeNull();
  });
});

describe('AETERNAWalletContext marker safety', () => {
  it('does not use localStorage for disconnect marker', async () => {
    const setItemSpy = vi.spyOn(global.localStorage, 'setItem');

    const appKit = createMockAppKit();
    (getReownAppKitInstance as unknown as ReturnType<typeof vi.fn>).mockReturnValue(appKit);

    const { result } = renderTestProvider({});
    await act(() => result.current.wallet.disconnect());

    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});
