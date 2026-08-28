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

export function getReownAppKitInstance(): AppKit {
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

export function resetReownAppKitInstance(): void {
  cachedAppKit = null;
}
