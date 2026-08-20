/**
 * AETERNA — Canonical Contract Registry
 *
 * Single source of truth for all on-chain addresses.
 */

export const CONTRACTS = {

  BASE: {

    /**
     * USDC (Base Mainnet)
     * Official Circle deployment
     */
    USDC:
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

    /**
     * AETERNA MVP Settlement Wallet
     * Current temporary hardware-backed EOA for Base Mainnet native USDC
     * service payments. Future target: Safe 2-of-3 multisig.
     */
    SETTLEMENT_WALLET:
      "0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755",

  },

} as const;
