/**
 * AETERNA — Payment Verification Contract
 *
 * Defines the input/output boundary for payment verification.
 * Implementations must satisfy this contract without exposing
 * internal verification details.
 */

export type PaymentVerificationInput = {
  readonly transactionId: string;
  readonly capsuleId: string;
  readonly billableSizeBytes: number;
};

export type PaymentVerificationOutput = {
  readonly ok: boolean;
  readonly transactionId: string;
  readonly capsuleId: string;
  readonly method: "solana";
  readonly expectedAmount: number;
  readonly currency: "USD";
  readonly expiresAt: number;
  readonly billableSizeBytes: number;
};
