/**
 * AETERNA — Payment Domain Types
 *
 * Chain-neutral payment types used across the frontend.
 * Blockchain-specific details belong in the verification layer.
 */

export type PaymentMethod = "solana";

export type PaymentStatus =
  | "idle"
  | "pending"
  | "verified"
  | "failed"
  | "expired";

export interface PaymentState {
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly transactionId: string | null;
  readonly error: string | null;
}
