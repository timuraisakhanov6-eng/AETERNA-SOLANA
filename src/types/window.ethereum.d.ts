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
     * detection. Brand MUST NOT be hardcoded.
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

  }

}

export {};