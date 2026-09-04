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
import {
  useAppKit,
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
  const { open } = useAppKit();
  const { disconnect: appkitDisconnect } = useDisconnect();
  const { walletProvider } = useAppKitProvider<SolanaProvider>('solana');
  const accountState = useAppKitAccount({ namespace: 'solana' });
  const { walletInfo } = useWalletInfo('solana');
  const connectionsState = useAppKitConnections('solana');

  const [state, setState] = useState<AeternaWalletState>(initialState);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const account = normalizeAccount(accountState.address);
    const connection = connectionsState.connections[0];
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

  const connect = useCallback(async () => {
    try {
      setError(null);
      await ensureReownAppKitInstance();
      clearExplicitDisconnectMarker();
      await open();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet connection error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
    }
  }, [open]);

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
      await open();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet change error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
      throw e;
    }
  }, [appkitDisconnect, open]);

  const openWalletPicker = useCallback(async () => {
    setError(null);
    try {
      clearExplicitDisconnectMarker();
      await open();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet picker error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
      throw e;
    }
  }, [open]);

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
    }),
    [state, error, connect, disconnect, changeWallet, openWalletPicker, signMessage, signAndSendTransaction]
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
};

export function AETERNAWalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (hasExplicitDisconnectMarker()) {
      setReady(true);
      return;
    }
    getReownAppKitInstance();
    setReady(true);
  }, []);

  const initializingValue = useMemo<AETERNAWalletContextValue>(
    () => ({ state: initialState, wallet: initializingWallet }),
    []
  );

  if (!ready) {
    return <AETERNAWalletContext.Provider value={initializingValue}>{children}</AETERNAWalletContext.Provider>;
  }

  return <AETERNAWalletProviderInner>{children}</AETERNAWalletProviderInner>;
}
