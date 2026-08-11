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
  capsuleId: string;

  /**
   * Canonical billable user size.
   * Never encrypted size.
   */
  billableSizeBytes: number;

  /**
   * Immutable creator-visible amount.
   */
  expectedAmount: number;

  /**
   * ISO currency code.
   */
  currency: "USD";

  /**
   * Quote creation time (UTC ms).
   */
  createdAt: number;

  /**
   * Quote expiration time (UTC ms).
   */
  expiresAt: number;
}