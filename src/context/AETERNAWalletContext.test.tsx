// @vitest-environment jsdom
/**
 * AETERNA — wallet context provider (R9-A69 alignment).
 *
 * DORMANT SUITE. `vitest.config.ts` deliberately keeps it out of the active
 * run; that stays true. The file is kept in sync with the implementation so it
 * can be re-enabled without a rewrite.
 *
 * Contract covered here (R9-A62 + R9-A68):
 *
 *   - AppKit is constructed BEFORE `AETERNAWalletProviderInner` may mount,
 *     with or without the explicit-disconnect marker;
 *   - the marker never causes an automatic connection and survives a reload;
 *   - an explicit connect goes through the headless Phantom path, clears the
 *     marker and never opens the generic AppKit modal;
 *   - an explicit disconnect sets the marker and clears the local state.
 *
 * Harness notes: the provider reads the router location, so the wrapper mounts
 * a MemoryRouter; AppKit and the Phantom connector are mocked, so no real
 * wallet, modal or network call is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React, { type ReactNode } from 'react';
import {
  AETERNAWalletProvider,
  useAeternaWallet,
} from '@/context/AETERNAWalletContext';

const MARKER_KEY = 'aeterna-wallet-disconnected';

const hoisted = vi.hoisted(() => ({
  disconnect: vi.fn(),
  connectPhantomHeadless: vi.fn(),
  /* Hook stubs live in the hoisted scope because `vi.mock` factories are
     hoisted above the module body. */
  useAppKit: () => ({ open: vi.fn().mockResolvedValue(undefined) }),
  useAppKitProvider: () => ({ walletProvider: undefined }),
  useAppKitAccount: () => ({ address: undefined }),
  useAppKitConnections: () => ({ connections: [] }),
  useWalletInfo: () => ({ name: undefined }),
}));

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

vi.mock('@reown/appkit/react', () => ({
  useAppKit: hoisted.useAppKit,
  useDisconnect: () => ({ disconnect: hoisted.disconnect }),
  useAppKitProvider: hoisted.useAppKitProvider,
  useAppKitAccount: hoisted.useAppKitAccount,
  useAppKitConnections: hoisted.useAppKitConnections,
  useWalletInfo: hoisted.useWalletInfo,
  AppKit: class AppKit {},
}));

vi.mock('@/lib/wallet/reownSolana', () => ({
  getReownAppKitInstance: vi.fn(),
  ensureReownAppKitInstance: vi.fn(),
  resetReownAppKitInstance: vi.fn(),
}));

vi.mock('@/lib/wallet/phantomProvider', () => ({
  connectPhantomHeadless: hoisted.connectPhantomHeadless,
}));

import {
  getReownAppKitInstance,
  ensureReownAppKitInstance,
} from '@/lib/wallet/reownSolana';

const getInstanceMock = getReownAppKitInstance as unknown as ReturnType<typeof vi.fn>;
const ensureInstanceMock = ensureReownAppKitInstance as unknown as ReturnType<typeof vi.fn>;

function renderTestProvider(
  markerState: Record<string, string> = {},
  entry = '/'
) {
  localStorage.clear();
  Object.entries(markerState).forEach(([key, value]) => {
    localStorage.setItem(key, value);
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>
      <AETERNAWalletProvider>{children}</AETERNAWalletProvider>
    </MemoryRouter>
  );

  return renderHook(() => useAeternaWallet(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  hoisted.disconnect.mockResolvedValue(undefined);
  hoisted.connectPhantomHeadless.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('AETERNAWalletProvider initialization gate', () => {
  it('initializes AppKit once even when the explicit disconnect marker is present', async () => {
    const appKit = createMockAppKit();
    getInstanceMock.mockReturnValue(appKit);
    ensureInstanceMock.mockResolvedValue(appKit);

    const { result } = renderTestProvider({ [MARKER_KEY]: '1' });

    /**
     * R9-A68: construction is mandatory on every non-deferred route. The old
     * expectation (never construct) is exactly what mounted the inner provider
     * without an instance and blanked the page.
     */
    expect(getInstanceMock).toHaveBeenCalledTimes(1);
    expect(ensureInstanceMock).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(true);

    // The marker still suppresses any automatic connection.
    expect(hoisted.connectPhantomHeadless).not.toHaveBeenCalled();
    expect(localStorage.getItem(MARKER_KEY)).toBe('1');
  });

  it('initializes AppKit when explicit disconnect marker is absent', async () => {
    const appKit = createMockAppKit();
    getInstanceMock.mockReturnValue(appKit);

    const { result } = renderTestProvider({});

    expect(getInstanceMock).toHaveBeenCalledTimes(1);
    expect(ensureInstanceMock).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(true);
    expect(() => result.current.connect).not.toThrow();
  });

  it('never initializes AppKit on a recipient capsule route', async () => {
    const appKit = createMockAppKit();
    getInstanceMock.mockReturnValue(appKit);
    ensureInstanceMock.mockResolvedValue(appKit);

    const { result } = renderTestProvider(
      { [MARKER_KEY]: '1' },
      `/capsule/${'c'.repeat(64)}#${'a'.repeat(64)}`
    );

    expect(getInstanceMock).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    expect(hoisted.connectPhantomHeadless).not.toHaveBeenCalled();
  });
});

describe('AETERNAWalletProvider explicit actions', () => {
  it('clears marker and connects Phantom headlessly on explicit Connect', async () => {
    const appKit = createMockAppKit();
    getInstanceMock.mockReturnValue(appKit);
    ensureInstanceMock.mockResolvedValue(appKit);

    const { result } = renderTestProvider({ [MARKER_KEY]: '1' });

    await act(async () => {
      await result.current.connect();
    });

    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(ensureInstanceMock).toHaveBeenCalledTimes(1);
    expect(hoisted.connectPhantomHeadless).toHaveBeenCalledTimes(1);
    expect(hoisted.connectPhantomHeadless).toHaveBeenCalledWith(appKit);

    // Headless policy: the generic AppKit modal is never opened.
    expect(appKit.open).not.toHaveBeenCalled();
  });

  it('clears marker, disconnects and reconnects on Change Wallet', async () => {
    const appKit = createMockAppKit();
    getInstanceMock.mockReturnValue(appKit);
    ensureInstanceMock.mockResolvedValue(appKit);

    const { result } = renderTestProvider({ [MARKER_KEY]: '1' });

    await act(async () => {
      await result.current.changeWallet();
    });

    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
    // changeWallet ensures AppKit itself and then calls connectPhantom,
    // which ensures again: two calls are the current contract.
    expect(ensureInstanceMock).toHaveBeenCalledTimes(2);
    expect(hoisted.disconnect).toHaveBeenCalledWith({ namespace: 'solana' });
    expect(appKit.resetWcConnection).toHaveBeenCalled();
    expect(hoisted.connectPhantomHeadless).toHaveBeenCalledTimes(1);
    expect(appKit.open).not.toHaveBeenCalled();
  });

  it('sets marker on explicit Disconnect and clears local state', async () => {
    const appKit = createMockAppKit();
    getInstanceMock.mockReturnValue(appKit);
    ensureInstanceMock.mockResolvedValue(appKit);

    const { result } = renderTestProvider({});

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.ready).toBe(true);

    await act(async () => {
      await result.current.disconnect();
    });

    expect(localStorage.getItem(MARKER_KEY)).toBe('1');
    expect(hoisted.disconnect).toHaveBeenCalledWith({ namespace: 'solana' });
    expect(appKit.resetWcConnection).toHaveBeenCalled();
    expect(result.current.connected).toBe(false);
    expect(result.current.account).toBeNull();
  });
});

describe('AETERNAWalletContext marker safety', () => {
  it('uses localStorage for the marker and survives a simulated reload without reconnecting', async () => {
    const appKit = createMockAppKit();
    getInstanceMock.mockReturnValue(appKit);
    ensureInstanceMock.mockResolvedValue(appKit);

    const first = renderTestProvider({});
    await act(async () => {
      await first.result.current.disconnect();
    });

    // The marker is persisted in localStorage (not in memory or React state).
    expect(localStorage.getItem(MARKER_KEY)).toBe('1');

    getInstanceMock.mockClear();
    hoisted.connectPhantomHeadless.mockClear();

    /**
     * R9-A68 reload contract: AppKit is constructed again (so the UI can
     * mount), the marker survives, and nothing connects by itself.
     */
    const reload = renderTestProvider({
      [MARKER_KEY]: localStorage.getItem(MARKER_KEY) ?? '1',
    });

    expect(getInstanceMock).toHaveBeenCalledTimes(1);
    expect(reload.result.current.ready).toBe(true);
    expect(reload.result.current.connected).toBe(false);
    expect(hoisted.connectPhantomHeadless).not.toHaveBeenCalled();
    expect(localStorage.getItem(MARKER_KEY)).toBe('1');
  });
});