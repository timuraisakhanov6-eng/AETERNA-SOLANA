/**
 * AETERNA — Reown AppKit wallet bridge
 *
 * Owns:
 * - AppKit singleton lifecycle
 * - Solana adapter initialization
 * - normalized wallet state for business UI
 *
 * Business components must use this context only.
 */

import React, { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { createAppKit, useAppKit, useAppKitAccount, useAppKitConnections, useDisconnect, useAppKitProvider, useWalletInfo } from '@reown/appkit/react';
import type { Provider as SolanaProvider } from '@reown/appkit-utils/solana';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import { solana } from '@reown/appkit/networks';
import type { AppKit } from '@reown/appkit/react';
import type { AppKitNetwork } from '@reown/appkit-common';
import type { ChainAdapter } from '@reown/appkit-controllers';

let cachedAppKit: AppKit | null = null;

export function getReownAppKitInstance(): AppKit {
  if (cachedAppKit) {
    return cachedAppKit;
  }

  const adapter = new SolanaAdapter() as unknown as ChainAdapter;
  const network = solana as AppKitNetwork;

  cachedAppKit = createAppKit({
    projectId: import.meta.env['VITE_WALLETCONNECT_PROJECT_ID'] ?? '8bffca7ae7fabf45907579714bde22cc',
    adapters: [adapter],
    networks: [network],
    defaultNetwork: network,
    metadata: {
      name: 'AETERNA',
      description: 'AETERNA Solana Capsule Protocol',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://aeterna.solana',
      icons: [
        'https://aeterna.solana/favicon.ico',
      ],
    },
  });

  return cachedAppKit;
}

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

export function AETERNAWalletProvider({ children }: { children: ReactNode }) {
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

    setState((prev) => ({
      ...prev,
      walletId,
      walletName,
      account,
      connected: Boolean(account),
      ready: true,
    }));
  }, [accountState.address, connectionsState.connections, walletInfo]);

  const connect = useCallback(async () => {
    try {
      setError(null);
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
      await appkitDisconnect({ namespace: 'solana' });
      setState(initialState);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown wallet disconnect error';
      setError(message);
      setState((prev) => ({ ...prev, error: message }));
    }
  }, [appkitDisconnect]);

  const openWalletPicker = useCallback(async () => {
    setError(null);
    try {
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
      openWalletPicker,
      signMessage,
      signAndSendTransaction,
    }),
    [state, error, connect, disconnect, openWalletPicker, signMessage, signAndSendTransaction]
  );

  const value = useMemo<AETERNAWalletContextValue>(() => ({ state, wallet }), [state, wallet]);

  return <AETERNAWalletContext.Provider value={value}>{children}</AETERNAWalletContext.Provider>;
}
