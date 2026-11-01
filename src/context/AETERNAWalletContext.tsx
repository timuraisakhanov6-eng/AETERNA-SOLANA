/**
 * AETERNA — Reown AppKit wallet bridge
 *
 * Owns:
 * - AppKit singleton lifecycle
 * - Solana adapter initialization
 * - normalized wallet state for business UI
 * - explicit user disconnect marker
 *
 * Business components must use this context only.
 */

import React, { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  useDisconnect,
  useAppKitProvider,
  useAppKitAccount,
  useAppKitConnections,
  useWalletInfo,
} from '@reown/appkit/react';
import type { Provider as SolanaProvider } from '@reown/appkit-utils/solana';
import {
  ensureReownAppKitInstance,
  getReownAppKitInstance,
} from '@/lib/wallet/reownSolana';
import { shouldDeferAppKitInitialization } from '@/lib/wallet/appKitInitPolicy';
import { connectPhantomHeadless } from '@/lib/wallet/phantomProvider';
import {
  clearExplicitDisconnectMarker,
  hasExplicitDisconnectMarker,
  setExplicitDisconnectMarker,
} from './walletDisconnectMarker';

export interface AeternaWalletState {
  walletId: string | null;
  walletName: string | null;
  account: string | null;
  connected: boolean;
  ready: boolean;
  error: string | null;
}

export interface AeternaWallet extends AeternaWalletState {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  changeWallet: () => Promise<void>;
  openWalletPicker: () => Promise<void>;
  signMessage: (message: string | Uint8Array) => Promise<{ signature: Uint8Array }>;
  signAndSendTransaction: (transaction: import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction) => Promise<{ signature: string }>;
  /**
   * Signs WITHOUT sending, so the caller can capture the transaction
   * signature, persist it, and bind it server-side BEFORE the network
   * sees the transaction. This is what removes the window in which a
   * transaction could be broadcast while the app lost its signature.
   */
  signTransaction: (transaction: import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction) => Promise<import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction>;
}

interface AETERNAWalletContextValue {
  state: AeternaWalletState;
  wallet: AeternaWallet;
}

const initialState: AeternaWalletState = {
  walletId: null,
  walletName: null,
  account: null,
  connected: false,
  ready: false,
  error: null,
};

export const AETERNAWalletContext = React.createContext<AETERNAWalletContextValue | null>(null);

export function useAeternaWallet(): AeternaWallet {
  const context = React.useContext(AETERNAWalletContext);
  if (!context) {
    throw new Error('useAeternaWallet must be used within AETERNAWalletProvider');
  }
  return context.wallet;
}

function normalizeAccount(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

function AETERNAWalletProviderInner({ children }: { children: ReactNode }) {
  const { disconnect: appkitDisconnect } = useDisconnect();
  const { walletProvider } = useAppKitProvider<SolanaProvider>('solana');
  const accountState = useAppKitAccount({ namespace: 'solana' });
  const { walletInfo } = useWalletInfo('solana');
  const connectionsState = useAppKitConnections('solana');

  const [state, setState] = useState<AeternaWalletState>(initialState);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /**
     * R9-A68 - an explicit disconnect survives a reload.
     *
     * AppKit is constructed on every non-deferred route (provider gate) and
     * `enableReconnect: false` makes it disconnect a restored session rather
     * than reconnect. To hold the invariant even if a restored address
     * surfaces before that settles, the reactive account is ignored while the
     * marker is set. `connectPhantom` and `changeWallet` clear the marker
     * BEFORE connecting, so the first real connection is adopted normally on
     * the next address change.
     */
    const explicitlyDisconnected = hasExplicitDisconnectMarker();

    const account = explicitlyDisconnected
      ? null
      : normalizeAccount(accountState.address);
    const connection = explicitlyDisconnected
      ? undefined
      : connectionsState.connections[0];
    const walletId = connection?.connectorId ?? null;
    const walletName = walletInfo?.name ?? connection?.name ?? null;

    setState((prev) => {
      const nextWalletId = walletId;
      const nextWalletName = walletName;
      const nextAccount = account;
      const nextConnected = Boolean(nextAccount);
      const nextReady = true;

      if (
        prev.walletId === nextWalletId &&
        prev.walletName === nextWalletName &&
        prev.account === nextAccount &&
        prev.connected === nextConnected &&
        prev.ready === nextReady
      ) {
        return prev;
      }

      return {
        ...prev,
        walletId: nextWalletId,
        walletName: nextWalletName,
        account: nextAccount,
        connected: nextConnected,
        ready: nextReady,
      };
    });
  }, [accountState.address, connectionsState.connections, walletInfo]);

  /**
   * Model 01 wallet policy: Phantom only.
   *
   * Connects Phantom through AppKit's headless path so the generic AppKit
   * modal is never opened — no wallet selector, no WalletConnect entry and
   * no QR. Fails closed when no injected Phantom wallet is available
   * instead of falling back to the modal.
   */
  const connectPhantom = useCallback(async () => {
    const appKit = await ensureReownAppKitInstance();
    clearExplicitDisconnectMarker();
    await connectPhantomHeadless(appKit);
  }, []);

  const connect = useCallback(async () => {
    try {
      setError(null);
      await connectPhantom();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet connection error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
    }
  }, [connectPhantom]);

  const disconnect = useCallback(async () => {
    try {
      setError(null);
      setExplicitDisconnectMarker();
      await appkitDisconnect({ namespace: 'solana' });
      try {
        const appKit = getReownAppKitInstance();
        appKit.resetWcConnection?.();
        appKit.resetUri?.();
        appKit.resetConnectingWallet?.();
      } catch {
        // ignore public reactive reset failures
      }
      setState(initialState);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet disconnect error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
    }
  }, [appkitDisconnect]);

  const changeWallet = useCallback(async () => {
    try {
      setError(null);
      await ensureReownAppKitInstance();
      clearExplicitDisconnectMarker();
      await appkitDisconnect({ namespace: 'solana' });
      try {
        const appKit = getReownAppKitInstance();
        appKit.resetWcConnection?.();
        appKit.resetUri?.();
        appKit.resetConnectingWallet?.();
      } catch {
        // ignore public reactive reset failures
      }
      // Model 01: reconnecting re-selects Phantom headlessly; the generic
      // wallet modal is never opened.
      await connectPhantom();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet change error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
      throw e;
    }
  }, [appkitDisconnect, connectPhantom]);

  const openWalletPicker = useCallback(async () => {
    setError(null);
    try {
      // Model 01: this is the live connect entry point used by the payment
      // controller. It connects Phantom headlessly — the AppKit modal is
      // never opened, so no wallet selector / WalletConnect / QR appears.
      await connectPhantom();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet picker error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
      throw e;
    }
  }, [connectPhantom]);

  const signMessage = useCallback(async (message: string | Uint8Array) => {
    if (!walletProvider) {
      const failure = 'Wallet provider is not available';
      setError(failure);
      setState((prev) => ({ ...prev, error: failure }));
      throw new Error(failure);
    }

    try {
      setError(null);
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
      const signature = await walletProvider.signMessage(bytes);
      return { signature: new Uint8Array(signature) };
    } catch (e) {
      const messageText = e instanceof Error ? e.message : 'Unknown signMessage error';
      setError(messageText);
      setState((prev) => ({ ...prev, error: messageText }));
      throw e;
    }
  }, [walletProvider]);

  const signAndSendTransaction = useCallback(async (transaction: import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction) => {
    if (!walletProvider) {
      const failure = 'Wallet provider is not available';
      setError(failure);
      setState((prev) => ({ ...prev, error: failure }));
      throw new Error(failure);
    }

    try {
      setError(null);
      const signature = await walletProvider.signAndSendTransaction(transaction);
      return { signature };
    } catch (e) {
      const messageText = e instanceof Error ? e.message : 'Unknown signAndSendTransaction error';
      setError(messageText);
      setState((prev) => ({ ...prev, error: messageText }));
      throw e;
    }
  }, [walletProvider]);

  const signTransaction = useCallback(async (transaction: import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction) => {
    if (!walletProvider) {
      const failure = 'Wallet provider is not available';
      setError(failure);
      setState((prev) => ({ ...prev, error: failure }));
      throw new Error(failure);
    }

    try {
      setError(null);
      return await walletProvider.signTransaction(transaction);
    } catch (e) {
      const messageText = e instanceof Error ? e.message : 'Unknown signTransaction error';
      setError(messageText);
      setState((prev) => ({ ...prev, error: messageText }));
      throw e;
    }
  }, [walletProvider]);

  const wallet = useMemo<AeternaWallet>(
    () => ({
      ...state,
      error,
      connect,
      disconnect,
      changeWallet,
      openWalletPicker,
      signMessage,
      signAndSendTransaction,
      signTransaction,
    }),
    [state, error, connect, disconnect, changeWallet, openWalletPicker, signMessage, signAndSendTransaction, signTransaction]
  );

  const value = useMemo<AETERNAWalletContextValue>(() => ({ state, wallet }), [state, wallet]);

  return <AETERNAWalletContext.Provider value={value}>{children}</AETERNAWalletContext.Provider>;
}

const initializingWallet: AeternaWallet = {
  ...initialState,
  connect: async () => {
    throw new Error('Wallet is initializing');
  },
  disconnect: async () => {
    throw new Error('Wallet is initializing');
  },
  changeWallet: async () => {
    throw new Error('Wallet is initializing');
  },
  openWalletPicker: async () => {
    throw new Error('Wallet is initializing');
  },
  signMessage: async () => {
    throw new Error('Wallet is initializing');
  },
  signAndSendTransaction: async () => {
    throw new Error('Wallet is initializing');
  },
  signTransaction: async () => {
    throw new Error('Wallet is initializing');
  },
};

export function AETERNAWalletProvider({ children }: { children: ReactNode }) {
  const location = useLocation();

  /**
   * SECURITY DECISION (recomputed each render):
   *
   * AppKit emits a MANDATORY `INITIALIZE` telemetry event on construction
   * whose payload embeds `window.location.href`. On a capsule-open route the
   * URL fragment is the capability, so eager construction would leak it.
   *
   * When deferral applies we render the state-only provider and DO NOT mount
   * `AETERNAWalletProviderInner`, because that inner component consumes
   * AppKit hooks (`useWalletInfo`) which THROW when AppKit has not been
   * created. Capsule runtime pages never consume those wallet actions, so
   * the state-only value is sufficient there. AppKit is still created lazily
   * on the allowed connect flow (`ensureReownAppKitInstance`).
   */
  const deferred = shouldDeferAppKitInitialization(
    location.pathname,
    location.hash
  );

  const [ready, setReady] = useState(false);

  useEffect(() => {
    // SECURITY: skip the eager AppKit construction that would emit the
    // mandatory INITIALIZE telemetry with the capability fragment.
    if (shouldDeferAppKitInitialization(location.pathname, location.hash)) {
      /**
       * R9-A62 - do NOT claim readiness here.
       *
       * `ready` gates `AETERNAWalletProviderInner`, whose AppKit hooks
       * throw when no instance exists. Marking ready on this branch made
       * the FIRST navigation away from a capsule URL mount that component
       * before `getReownAppKitInstance()` could run, which threw during
       * render and, with no error boundary, unmounted the whole app: the
       * blank first-click Protocol page.
       *
       * Leaving `ready` false keeps the gate closed. The effect re-runs
       * when the location leaves the deferred route, constructs AppKit,
       * and only then flips `ready`. AppKit is still NEVER constructed
       * while a capability-bearing fragment is present.
       */
      return;
    }

    /**
     * R9-A68 - AppKit is ALWAYS constructed before the inner provider may
     * mount, including after an explicit disconnect.
     *
     * The former `hasExplicitDisconnectMarker()` branch set `ready` WITHOUT
     * constructing AppKit. That mounted `AETERNAWalletProviderInner` with no
     * instance, its hooks threw during render and, with no error boundary,
     * the whole tree unmounted: the blank Home page after disconnect+reload.
     *
     * Keeping the wallet disconnected is not this branch's job.
     * `createAppKit({ enableReconnect: false })` makes AppKit run
     * `unSyncExistingConnection()` on init instead of restoring a stored
     * session, so construction itself cannot reconnect. The marker is still
     * honoured by the account sync below, which refuses to adopt a restored
     * account while an explicit disconnect is in force.
     */
    getReownAppKitInstance();
    setReady(true);
  }, [location.pathname, location.hash]);

  const initializingValue = useMemo<AETERNAWalletContextValue>(
    () => ({ state: initialState, wallet: initializingWallet }),
    []
  );

  // Deferred or not-yet-ready: provide a safe state-only context and DO NOT
  // mount the AppKit-consuming inner provider.
  if (deferred || !ready) {
    return <AETERNAWalletContext.Provider value={initializingValue}>{children}</AETERNAWalletContext.Provider>;
  }

  return <AETERNAWalletProviderInner>{children}</AETERNAWalletProviderInner>;
}
