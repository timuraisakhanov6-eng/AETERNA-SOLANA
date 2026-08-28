/**
 * AETERNA — Storage Payment
 *
 * Business Authority record for creator-funded Irys storage payment.
 *
 * Bound to a Storage Quote.
 */

export interface StoragePayment {
  readonly storagePaymentId: string;
  readonly quote: {
    readonly storagePaymentId: string;
    readonly preparedProjectionId: string;
    readonly creatorIdentityId: string;
    readonly lifecycleId: string;
    readonly capsuleId: string;
    readonly billableSizeBytes: number;
    readonly vaultSha256: string;
    readonly expectedAmountAtomic: string;
    readonly displayAmountUSDC: string;
    readonly currency: "USDC";
    readonly network: "solana-mainnet";
    readonly tokenMint:
      | "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    readonly irysToken: "usdc-solana";
    readonly irysDestination: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly state: "CREATED" | "EXPIRED";
  };
  readonly transactionSignature: string;
  readonly payer: string;
  readonly mint: string;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly network: "solana-mainnet";
  readonly verifiedAt: number;
  readonly state: "PAYMENT_AUTHORIZED" | "PAYMENT_VERIFIED" | "FAILED" | "EXPIRED";
}
