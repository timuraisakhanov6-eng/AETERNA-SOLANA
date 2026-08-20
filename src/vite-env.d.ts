/// <reference types="vite/client" />

/** AETERNA Environment Variables Contract
 *
 * Only truly used runtime env declarations are kept here.
 */

interface ImportMetaEnv {

  /** Base network chain id */
  readonly VITE_BASE_CHAIN_ID: string;

  /** Runtime environment discriminator */
  readonly VITE_APP_ENV?: "development" | "preview" | "production";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
