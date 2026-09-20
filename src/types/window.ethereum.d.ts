import type { EIP1193Provider } from "viem";

declare global {

  interface Window {

    /**
     * EIP-1193 compatible injected wallet provider.
     *
     * Present only in Creator Runtime.
     * Optional by protocol design.
     *
     * Supports:
     * - MetaMask
     * - Coinbase Wallet
     * - Rabby
     * - multi-provider injection environments
     */

    readonly ethereum?: EIP1193Provider & {

      /**
       * Optional multi-provider injection list
       * used by modern wallet environments
       */

      providers?: EIP1193Provider[];

    };

    /**
     * Solana-compatible wallet provider.
     *
     * Present only in Creator Runtime when a supported Solana-compatible
     * wallet is available.
     *
     * Supports Wallet Standard / standard Solana wallet capability
     * detection. The protocol layer does not hardcode a wallet brand;
     * Model 01 restricts the wallet UX/integration surface to Phantom
     * (see docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1).
     */

    readonly solana?: {
      publicKey?: { toBase58(): string } | string;
      signMessage?: (message: Uint8Array) => Promise<{ signature: Uint8Array } | Uint8Array>;
      signTransaction?: (transaction: unknown) => Promise<unknown>;
      signAndSendTransaction?: (transaction: unknown) => Promise<{ signature: string } | string>;
      connect?: () => Promise<void>;
      disconnect?: () => Promise<void>;
      autoConnect?: boolean;
    };

    readonly solana_wallet?: Window["solana"];

    /**
     * Phantom-injected Solana provider.
     *
     * Model 01 supports Phantom only at the wallet UX/integration layer.
     * Used exclusively as a UX availability gate — never as protocol
     * authority. Prefer this namespace over `window.solana`, which another
     * injected wallet may claim.
     */

    readonly phantom?: {
      readonly solana?: Window["solana"];
    };

  }

}

export {};