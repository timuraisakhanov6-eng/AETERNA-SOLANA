/**
 * AETERNA — useUSDCPayment
 *
 * Supports:
 * - injected wallets (MetaMask / Coinbase / Rabby / Brave / OKX)
 * - WalletConnect fallback (Trust / Rainbow / Safe / Ledger Live / Zerion)
 *
 * Uses viem
 * No WagmiProvider required
 *
 * Selector-compatible version
 * Includes network switch retry logic
 */

import {
  createWalletClient,
  custom,
  parseUnits,
  encodeFunctionData,
  type Address,
} from "viem";

import { base } from "viem/chains";

import EthereumProvider from "@walletconnect/ethereum-provider";

import {
  BASE_CHAIN_ID,
  BASE_CHAIN_PARAMS,
  USDC_CONTRACT,
  USDC_DECIMALS,
  ERC20_TRANSFER_ABI,
  RECIPIENT_ADDRESS,
} from "@/config/web3";

import type { EIP1193Provider } from "viem";


/* ───────────────── TYPES ───────────────── */

export type USDCPaymentError =
  | "NO_WALLET"
  | "USER_REJECTED"
  | "WRONG_NETWORK"
  | "UNKNOWN";


export class USDCPaymentException extends Error {

  constructor(
    public readonly code: USDCPaymentError,
    message: string
  ) {

    super(message);

    this.name = "USDCPaymentException";

  }

}


/* ───────────────── HELPERS ───────────────── */

export function usdToUsdcUnits(
  amountUSD: number
): bigint {

  if (
    typeof amountUSD !== "number" ||
    !Number.isFinite(amountUSD) ||
    amountUSD <= 0
  ) {

    throw new USDCPaymentException(
      "UNKNOWN",
      "Invalid payment amount"
    );

  }

  return parseUnits(
    String(amountUSD),
    USDC_DECIMALS
  );

}


/* ───────────────── WALLETCONNECT PROVIDER ───────────────── */

let walletConnectProvider:
  Awaited<
    ReturnType<typeof EthereumProvider.init>
  > | null = null;


async function getWalletConnectProvider() {

  const projectId =
    import.meta.env
      .VITE_WALLETCONNECT_PROJECT_ID;

  if (!projectId) {

    throw new USDCPaymentException(
      "NO_WALLET",
      "WalletConnect Project ID missing"
    );

  }

  if (!walletConnectProvider) {

    walletConnectProvider =
      await EthereumProvider.init({

        projectId,

        chains: [BASE_CHAIN_ID],

        showQrModal: true,

        metadata: {

          name: "AETERNA",

          description:
            "AETERNA Time Capsule Protocol",

          url:
            import.meta.env
              .VITE_APP_ORIGIN
            || "http://localhost:8080",

          icons: [
            `${import.meta.env
              .VITE_APP_ORIGIN
              || "http://localhost:8080"
            }/favicon.ico`
          ],

        },

      });

  }

  await walletConnectProvider.connect();

  return walletConnectProvider as unknown as EIP1193Provider;

}


/* ───────────────── PROVIDER RESOLUTION ───────────────── */

async function resolveProvider(
  provider?: EIP1193Provider
) {

  if (provider)
    return provider;

  /**
   * ISSUE 1 FIX: WalletConnect fallback was unreachable.
   *
   * Previous logic threw NO_WALLET immediately when window.ethereum
   * was absent, making WalletConnect dead code for Safari iOS,
   * desktop browsers without extensions, and QR-connect flows.
   *
   * Correct resolution:
   * - No browser runtime at all → throw (SSR / non-browser)
   * - Browser runtime but no injected wallet → fall through to WalletConnect
   * - Injected wallet present → use it directly
   */

  if (typeof window === "undefined") {

    throw new USDCPaymentException(
      "NO_WALLET",
      "No browser runtime"
    );

  }

  const ethereum =
    (window as unknown as {
      ethereum?: EIP1193Provider;
    }).ethereum;

  if (ethereum?.request)
    return ethereum;

  return getWalletConnectProvider();

}


/* ───────────────── HOOK ───────────────── */

export function useUSDCPayment() {

  const sendUSDC = async (

    amountUSD: number,
    provider?: EIP1193Provider

  ): Promise<`0x${string}`> => {

    const resolvedProvider =
      await resolveProvider(provider);


    let accounts:
      `0x${string}`[];


    try {

      accounts =
        await resolvedProvider.request({

          method:
            "eth_requestAccounts",

        });

    }

    catch (e) {

      if (isUserRejected(e)) {

        throw new USDCPaymentException(
          "USER_REJECTED",
          "Wallet connection rejected"
        );

      }

      throw new USDCPaymentException(
        "UNKNOWN",
        "Wallet connection failed"
      );

    }


    if (!accounts?.[0]) {

      throw new USDCPaymentException(
        "NO_WALLET",
        "No wallet account found"
      );

    }


    const account =
      accounts[0];


    /* ───────────────── NETWORK SWITCH ───────────────── */

    try {

      await resolvedProvider.request({

        method:
          "wallet_switchEthereumChain",

        params: [

          {

            chainId:
              BASE_CHAIN_PARAMS.chainId,

          },

        ],

      });

    }

    catch (e) {

      if (isChainNotAdded(e)) {

        /**
         * ISSUE 2 FIX: chain-add path was not fail-closed.
         *
         * Previously a rejected wallet_addEthereumChain prompt fell
         * through silently, leaving the provider on a foreign chain
         * while orchestration continued. Mobile wallets (Trust, OKX,
         * Coinbase Mobile) return inconsistent provider states after
         * a rejected add-chain, making subsequent operations ambiguous.
         *
         * Now: rejection on add-chain is immediately classified and
         * thrown — no ambiguous authority state can propagate.
         */

        try {

          await resolvedProvider.request({

            method:
              "wallet_addEthereumChain",

            params: [
              BASE_CHAIN_PARAMS
            ],

          });

        }

        catch (addErr) {

          if (isUserRejected(addErr)) {

            throw new USDCPaymentException(
              "USER_REJECTED",
              "Network addition rejected"
            );

          }

          throw new USDCPaymentException(
            "WRONG_NETWORK",
            "Failed to add network"
          );

        }

      }

      else if (isUserRejected(e)) {

        throw new USDCPaymentException(
          "USER_REJECTED",
          "Network switch rejected"
        );

      }

      else {

        throw new USDCPaymentException(
          "WRONG_NETWORK",
          "Failed to switch network"
        );

      }

    }


    /* ───────────────── VERIFY NETWORK (WITH RETRY) ───────────────── */

    let chainId =
      await resolvedProvider.request({

        method:
          "eth_chainId",

      });


    if (
      chainId !==
      BASE_CHAIN_PARAMS.chainId
    ) {

      /**
       * retry once (Trust / Bybit / Binance wallets need delay)
       */

      await new Promise(
        r => setTimeout(r, 600)
      );

      chainId =
        await resolvedProvider.request({

          method:
            "eth_chainId",

        });

    }


    if (
      chainId !==
      BASE_CHAIN_PARAMS.chainId
    ) {

      throw new USDCPaymentException(
        "WRONG_NETWORK",
        "Incorrect network after switch"
      );

    }


    /* ───────────────── CREATE CLIENT ───────────────── */

    /**
     * Wait for provider transport to sync with the switched chain.
     * MetaMask updates the UI immediately but the EIP-1193 runtime
     * context lags behind — creating walletClient too early causes
     * gas estimation to run against the old chain context, which
     * produces "Gas unavailable" in the MetaMask confirmation UI.
     */

    await new Promise(
      r => setTimeout(r, 300)
    );

    const walletClient =
      createWalletClient({

        account: account as Address,
        chain: base,
        transport:
          custom(resolvedProvider),

      });


    /* ───────────────── BUILD TX ───────────────── */

    const amount =
      usdToUsdcUnits(amountUSD);


    const data =
      encodeFunctionData({

        abi:
          ERC20_TRANSFER_ABI,

        functionName:
          "transfer",

        args: [

          RECIPIENT_ADDRESS,
          amount,

        ],

      });


    /* ───────────────── SEND TX ───────────────── */

    try {

      return await walletClient.sendTransaction({

        account,
        to:
          USDC_CONTRACT as Address,
        data,
        value: 0n,

      });

    }

    catch (e) {

      if (isUserRejected(e)) {

        throw new USDCPaymentException(
          "USER_REJECTED",
          "Transaction rejected"
        );

      }

      throw new USDCPaymentException(
        "UNKNOWN",
        "Transaction failed"
      );

    }

  };


  return {

    sendUSDC,

  };

}


/* ───────────────── ERROR GUARDS ───────────────── */

function isUserRejected(
  e: unknown
): boolean {

  if (
    typeof e !== "object" ||
    e === null
  ) return false;

  const code =
    (e as { code?: unknown }).code;

  /**
   * ISSUE 3 FIX: -32603 removed from user-rejection classification.
   *
   * -32603 is the JSON-RPC internal error code and is legitimately
   * used by wallets for insufficient funds, RPC failures, provider
   * crashes, and transport disconnects — none of which are user
   * rejections. Treating it as USER_REJECTED causes incorrect retry
   * semantics, misleading UX, and nondeterministic fail diagnostics.
   *
   * Only 4001 (EIP-1193 canonical user rejection) is classified here.
   */

  return code === 4001;

}


function isChainNotAdded(
  e: unknown
): boolean {

  if (
    typeof e !== "object" ||
    e === null
  ) return false;

  return (
    (e as { code?: unknown }).code === 4902
  );

}