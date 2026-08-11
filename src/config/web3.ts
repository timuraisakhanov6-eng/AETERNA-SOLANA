/**
 * AETERNA — Web3 / Base network configuration
 */

import { CONTRACTS } from "./contracts";

export const BASE_CHAIN_ID = 8453 as const;

export const USDC_CONTRACT =
  CONTRACTS.BASE.USDC;

export const RECIPIENT_ADDRESS =
  CONTRACTS.BASE.EXECUTOR_HOT;

export const USDC_DECIMALS = 6 as const;


/* ───────────────── ERC20 ABI ───────────────── */

export const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;


/* ───────────────── BASE CHAIN PARAMS (EIP-3085 compatible) ───────────────── */

export const BASE_CHAIN_PARAMS = {

  chainId:
    `0x${BASE_CHAIN_ID.toString(16)}`,

  chainName:
    "Base",

  nativeCurrency: {
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
  },

  rpcUrls: [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
  ],

  blockExplorerUrls: [
    "https://basescan.org",
  ],

};