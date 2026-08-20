/**
 * AETERNA — Solana Payment Configuration Boundary
 *
 * Placeholders only. Actual values must be provided via
 * environment/secrets and never hardcoded.
 *
 * This boundary exists so that Solana payment configuration
 * is not mixed with deprecated EVM/payment-provider config.
 */

export const SOLANA_USDC_MINT_KEY =
  "SOLANA_USDC_MINT" as const;

export const SOLANA_PAYMENT_RECIPIENT_KEY =
  "SOLANA_PAYMENT_RECIPIENT" as const;

export const SOLANA_RPC_URL_KEY =
  "SOLANA_RPC_URL" as const;

export type SolanaPaymentEnv = {
  readonly [SOLANA_USDC_MINT_KEY]: string;
  readonly [SOLANA_PAYMENT_RECIPIENT_KEY]: string;
  readonly [SOLANA_RPC_URL_KEY]: string;
};
