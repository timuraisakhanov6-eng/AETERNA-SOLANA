/// <reference types="vite/client" />

/**
 * AETERNA Environment Variables Contract
 *
 * Defines strongly-typed access to Vite runtime env variables.
 *
 * SECURITY RULE:
 * Only VITE_* variables are exposed to browser runtime.
 */

interface ImportMetaEnv {

  /**
   * Public application origin
   *
   * Example:
   * https://aeterna.app
   */
  readonly VITE_APP_ORIGIN: string;


  /**
   * WalletConnect project id
   *
   * Used only for wallet transport layer.
   */
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;


  /**
   * Base network chain id
   *
   * Canonical network:
   * Base Mainnet = 8453
   */
  readonly VITE_BASE_CHAIN_ID: string;


  /**
   * Alchemy API Key for Base Mainnet.
   *
   * Reserved for browser runtime access to Base RPC infrastructure,
   * if required by the frontend.
   *
   * NOT used by Executor Hot publication authority.
   * NOT the same as backend RPC configuration.
   */
  readonly VITE_ALCHEMY_KEY: string;


  /**
   * Runtime environment discriminator
   *
   * Optional:
   * development
   * preview
   * production
   */
  readonly VITE_APP_ENV?:
    | "development"
    | "preview"
    | "production";

}


interface ImportMeta {

  readonly env: ImportMetaEnv;

}