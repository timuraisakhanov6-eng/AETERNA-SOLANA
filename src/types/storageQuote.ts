/**
 * AETERNA — Capsule Storage Quote
 *
 * Business Authority artifact for creator-funded Irys storage.
 *
 * This quote is immutable once created.
 */

export interface StorageQuote {
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
}
