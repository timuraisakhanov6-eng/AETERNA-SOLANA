/* =========================================
   AETERNA CANONICAL PRICING MODEL
   ========================================= */

/**
 * Pricing invariants
 *
 * first 20MB = $4
 * next 20MB blocks = $3 each
 *
 * Must stay identical across:
 * UI
 * verify.ts
 * upload-token.ts
 * backend validation
 */

export const MB = 1024 * 1024;

export const FIRST_BLOCK_MB = 20;
export const NEXT_BLOCK_MB = 20;

export const FIRST_BLOCK_PRICE = 4.0;
export const NEXT_BLOCK_PRICE = 3.0;


/**
 * Hard protocol safety limits
 *
 * Capsule size ≤ 20GB (Vault V2 invariant)
 */

export const MAX_CAPSULE_SIZE =
  20 * 1024 * 1024 * 1024;


/**
 * Normalize capsule size boundary
 */

function normalizeSize(
  sizeBytes: unknown
): number {

  if (
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > MAX_CAPSULE_SIZE
  ) {

    throw new Error(
      "[AETERNA] Invalid capsule size"
    );

  }

  return sizeBytes;

}


/**
 * Calculates number of paid blocks
 */

export function calculateBlocks(
  sizeBytes: number
): number {

  const normalized =
    normalizeSize(sizeBytes);


  if (normalized === 0) {
    return 1;
  }


  const sizeMB =
    normalized / MB;


  if (sizeMB <= FIRST_BLOCK_MB) {
    return 1;
  }


  const extraMB =
    sizeMB - FIRST_BLOCK_MB;


  const extraBlocks =
    Math.ceil(
      extraMB / NEXT_BLOCK_MB
    );


  return 1 + extraBlocks;

}


/**
 * Canonical pricing function
 *
 * Determines the creator price from the canonical
 * Business Layer pricing model.
 *
 * This function calculates pricing only.
 * It never establishes Business Authority.
 *
 * Canonical flow:
 *
 * PREPARED
 *      ↓
 * calculatePrice()
 *      ↓
 * Business Quote Creation (Server)
 *      ↓
 * Business Quote (immutable)
 *
 * After Business Quote has been created,
 * all subsequent stages MUST consume
 * BusinessQuote.expectedAmount.
 *
 * Payment Authorization,
 * Payment Verification,
 * Upload Authorization,
 * and Settlement
 * MUST NOT recalculate creator pricing.
 */

export function calculatePrice(
  sizeBytes: number
): number {

  const blocks =
    calculateBlocks(sizeBytes);


  const price =
    FIRST_BLOCK_PRICE +
    (blocks - 1) *
    NEXT_BLOCK_PRICE;


  /**
   * Normalize floating precision
   * (Stripe / Paddle safe boundary)
   */

  return Math.round(price * 100) / 100;

}