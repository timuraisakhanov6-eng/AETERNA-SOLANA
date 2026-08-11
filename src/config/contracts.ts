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
     /** AETERNA Protocol Treasury
      * Deferred/future governance treasury layer.
      *
      * NOT current Web3 payment receiver.
      * NOT used for payment verification in the current model.
      */
     TREASURY:
       "0x97E52713e38320477494aB4283c11f5cD2a49e7B",

     /**
      * AETERNA Executor Hot
      * Current Web3 payment receiver and Publication Authority.
      */
     EXECUTOR_HOT:
       "0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755",

     },

} as const;