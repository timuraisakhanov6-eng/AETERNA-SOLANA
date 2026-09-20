/**
 * AETERNA — Reown AppKit Solana initialization helper
 *
 * Responsibilities:
 * - create exactly one Reown AppKit instance
 * - register Solana adapter for mainnet
 * - expose the AppKit instance for wallet bridge/context
 *
 * MUST NOT:
 * - instantiate AppKit repeatedly
 * - hardcode multiple wallet providers
 * - expose private wallet data
 */

import { createAppKit, type AppKit } from '@reown/appkit/react';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import { solana } from '@reown/appkit/networks';
import type { AppKitNetwork } from '@reown/appkit-common';
import type { ChainAdapter } from '@reown/appkit-controllers';

let cachedAppKit: AppKit | null = null;

/**
 * Model 01 wallet policy: Phantom only.
 *
 * WalletConnect explorer id for Phantom, taken from the installed
 * @reown/appkit-common registry (PresetsUtil.ConnectorExplorerIds).
 *
 * AppKit applies `includeWalletIds` in ConnectorUtil: any connector whose
 * wallet id is not listed is removed from the wallet list (including
 * injected connectors with no resolvable id), so the connection surface
 * exposes Phantom only.
 *
 * This is a Model 01 UX/integration policy — see
 * docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1. It does
 * not make any wallet brand protocol authority and does not change the
 * AeternaWallet abstraction, Creator Identity, payment verification,
 * Creator Credit authority, or the Irys boundary.
 */
const MODEL_01_PHANTOM_EXPLORER_ID =
  'a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393';

function createAeternaAppKit(): AppKit {
  if (cachedAppKit) {
    return cachedAppKit;
  }

  // Installed Reown types are incompatible with exactOptionalPropertyTypes
  // for SolanaAdapter/network objects. Runtime is verified; cast is the
  // narrowest safe workaround until package types align.
  const adapter = new SolanaAdapter() as unknown as ChainAdapter;
  const network = solana as AppKitNetwork;

  cachedAppKit = createAppKit({
    projectId: import.meta.env['VITE_WALLETCONNECT_PROJECT_ID'] ?? '8bffca7ae7fabf45907579714bde22cc',
    adapters: [adapter],
    networks: [network],
    defaultNetwork: network,
    allWallets: 'HIDE',
    includeWalletIds: [MODEL_01_PHANTOM_EXPLORER_ID],
    metadata: {
      name: 'AETERNA',
      description: 'AETERNA Solana Capsule Protocol',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://aeterna.solana',
      icons: [
        'https://aeterna.solana/favicon.ico',
      ],
    },
    features: {
      email: false,
      socials: false,
    },
    enableReconnect: false,
  });

  return cachedAppKit;
}

export function getReownAppKitInstance(): AppKit {
  return createAeternaAppKit();
}

export function ensureReownAppKitInstance(): Promise<AppKit> {
  return Promise.resolve(createAeternaAppKit());
}

export function resetReownAppKitInstance(): void {
  cachedAppKit = null;
}
