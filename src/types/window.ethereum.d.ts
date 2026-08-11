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

  }

}

export {};