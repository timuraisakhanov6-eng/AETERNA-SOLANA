/**
 * AETERNA — Canonical Business Quote
 *
 * Represents the immutable commercial agreement
 * between the creator and AETERNA.
 *
 * Business Quote exists only during the payment lifecycle.
 * It never becomes part of Vault, Manifest or Runtime.
 */

export interface BusinessQuote {
  paymentIntentId: string;

  /**
   * Immutable creator-visible amount.
   */
  expectedAmount: number;

  /**
   * Denomination of the canonical AETERNA service fee.
   *
   * The AETERNA service fee is natively denominated and settled in
   * USDC. It is NOT a USD amount and is NOT produced by any USD→USDC
   * conversion, exchange rate, oracle, or price source.
   */
  currency: "USDC";

  /**
   * Quote creation time (UTC ms).
   */
  createdAt: number;

  /**
   * Quote expiration time (UTC ms).
   */
  expiresAt: number;
}
