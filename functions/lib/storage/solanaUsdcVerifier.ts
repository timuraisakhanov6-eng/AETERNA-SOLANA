/**
 * AETERNA — Authoritative Solana USDC storage-payment verifier
 *
 * Verifies that a Solana Mainnet SPL USDC transfer matches an
 * immutable Storage Quote. All evidence is derived server-side
 * from Alchemy JSON-RPC; client-supplied payment metadata is never
 * trusted.
 *
 * This module does not perform uploads, Irys interactions, or
 * client-side wallet operations.
 */

import { getSolanaTransaction, solanaJsonRpc } from "../solana/rpc";

export interface SolanaUsdcVerificationInput {
  readonly rpcUrl: string;
  readonly transactionSignature: string;
  readonly expectedPayer: string;
  readonly expectedMint: string;
  readonly expectedAmountAtomic: string;
  readonly expectedDestination: string;
}

export interface SolanaUsdcVerificationEvidence {
  readonly ok: true;
  readonly signature: string;
  readonly payer: string;
  readonly mint: string;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly slot: number;
  readonly blockTime: number;
}

export interface SolanaUsdcVerificationFailure {
  readonly ok: false;
  readonly reason:
    | "INVALID_SIGNATURE"
    | "RPC_UNAVAILABLE"
    | "TRANSACTION_NOT_FOUND"
    | "TRANSACTION_PENDING"
    | "TRANSACTION_FAILED"
    | "MALFORMED_TRANSACTION"
    | "PAYER_MISMATCH"
    | "MINT_MISMATCH"
    | "AMOUNT_MISMATCH"
    | "DESTINATION_MISMATCH"
    | "AMBIGUOUS_TRANSFER";
  readonly details?: Record<string, unknown>;
}

export type SolanaUsdcVerificationResult =
  | SolanaUsdcVerificationEvidence
  | SolanaUsdcVerificationFailure;

function normalizePublicKey(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["toBase58"] === "function") {
      return (value as { toBase58: () => string }).toBase58();
    }
    if (typeof record["value"] === "string") {
      return record["value"];
    }
  }
  return null;
}

function normalizeAccountKeys(
  accountKeys: unknown
): string[] {
  if (!Array.isArray(accountKeys)) {
    return [];
  }
  return accountKeys
    .map((item) => normalizePublicKey(item))
    .filter((key): key is string => key !== null);
}

function readTokenBalanceAmount(balance: unknown): string {
  if (!balance || typeof balance !== "object") {
    return "0";
  }
  const record = balance as Record<string, unknown>;
  const uiTokenAmount = record["uiTokenAmount"];
  if (!uiTokenAmount || typeof uiTokenAmount !== "object") {
    return "0";
  }
  const amount = (uiTokenAmount as Record<string, unknown>)["amount"];
  if (typeof amount === "string") {
    return amount;
  }
  return "0";
}

interface SolanaTokenBalance {
  mint: string;
  owner: string;
}

interface SolanaTransactionMeta {
  preTokenBalances?: SolanaTokenBalance[];
  postTokenBalances?: SolanaTokenBalance[];
}

interface SolanaTransactionResponse {
  result?: {
    slot: number;
    blockTime?: number;
    transaction?: { message?: { accountKeys?: unknown } };
    meta?: SolanaTransactionMeta;
    err?: unknown;
  };
}

/**
 * Exact Solana signature shape: base58 (which excludes 0, O, I and l) of a
 * 64-byte value, i.e. 86-88 characters.
 *
 * The previous `[A-Za-z0-9]{64,88}` accepted non-base58 characters and
 * truncated values, so a malformed signature survived validation and then
 * surfaced as a misleading TRANSACTION_NOT_FOUND / RPC_UNAVAILABLE instead of
 * a clear INVALID_SIGNATURE.
 */
const SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

interface SignatureStatusValue {
  slot?: number;
  err?: unknown;
  confirmationStatus?: string;
}

interface SignatureStatusesResponse {
  value?: (SignatureStatusValue | null)[];
}

/**
 * Cross-check for a signature the transaction lookup could not return.
 *
 * A signature that the status API knows about but `getTransaction` cannot yet
 * serve means the payment IS on-chain and merely not visible to this provider
 * yet — that is `TRANSACTION_PENDING`, not "does not exist".
 *
 * Best-effort and read-only: if the status call itself fails we keep the
 * pre-existing outcome (fail closed — the payment is still not accepted).
 */
async function signatureStatusExists(
  rpcUrl: string,
  transactionSignature: string
): Promise<boolean> {
  try {
    const response = (await solanaJsonRpc<SignatureStatusesResponse>(
      rpcUrl,
      "getSignatureStatuses",
      [[transactionSignature], { searchTransactionHistory: true }]
    )) as SignatureStatusesResponse;

    const entry = response?.value?.[0];
    return Boolean(entry);
  } catch {
    return false;
  }
}

export async function verifySolanaUsdcStoragePayment({
  rpcUrl,
  transactionSignature,
  expectedPayer,
  expectedMint,
  expectedAmountAtomic,
  expectedDestination,
}: SolanaUsdcVerificationInput): Promise<SolanaUsdcVerificationResult> {
  if (!SIGNATURE_REGEX.test(transactionSignature)) {
    return {
      ok: false,
      reason: "INVALID_SIGNATURE",
      details: { signature: transactionSignature },
    };
  }

  let transaction: SolanaTransactionResponse;
  try {
    transaction = (await getSolanaTransaction(rpcUrl, transactionSignature)) as SolanaTransactionResponse;
  } catch {
    return {
      ok: false,
      reason: "RPC_UNAVAILABLE",
    };
  }

  const result = transaction.result;
  if (!result) {
    /* The lookup window elapsed with no transaction. Distinguish a payment
       that the chain knows about but this provider cannot serve yet (pending)
       from one that genuinely does not exist. Payment validation is not
       weakened: a pending outcome is still a REJECTION — it only tells the
       caller that retrying verification may succeed. */
    if (await signatureStatusExists(rpcUrl, transactionSignature)) {
      return {
        ok: false,
        reason: "TRANSACTION_PENDING",
      };
    }

    return {
      ok: false,
      reason: "TRANSACTION_NOT_FOUND",
    };
  }

  if (result.err) {
    return {
      ok: false,
      reason: "TRANSACTION_FAILED",
      details: { err: result.err },
    };
  }

  const accountKeys = normalizeAccountKeys(
    result.transaction?.message?.accountKeys
  );
  if (accountKeys.length === 0) {
    return {
      ok: false,
      reason: "MALFORMED_TRANSACTION",
    };
  }

  const payer = accountKeys[0];
  if (payer.toLowerCase() !== expectedPayer.toLowerCase()) {
    return {
      ok: false,
      reason: "PAYER_MISMATCH",
      details: { payer },
    };
  }

  const preTokenBalances = result.meta?.preTokenBalances ?? [];
  const postTokenBalances = result.meta?.postTokenBalances ?? [];

  /* Exact destination authority: the on-chain token recipient MUST be
     the expected Irys destination for the expected mint. No fallback to
     any other owner/balance holder is permitted — a payment to a
     different destination must fail closed. */
  const destinationBalance = postTokenBalances.find(
    (item) =>
      typeof item.owner === "string" &&
      item.owner.toLowerCase() === expectedDestination.toLowerCase() &&
      typeof item.mint === "string" &&
      item.mint.toLowerCase() === expectedMint.toLowerCase()
  );

  if (!destinationBalance) {
    return {
      ok: false,
      reason: "DESTINATION_MISMATCH",
      details: { destination: expectedDestination },
    };
  }

  const senderPostBalance = postTokenBalances.find(
    (item) =>
      typeof item.owner === "string" &&
      item.owner.toLowerCase() === expectedPayer.toLowerCase() &&
      typeof item.mint === "string" &&
      item.mint.toLowerCase() === expectedMint.toLowerCase()
  );
  const senderPreBalance = preTokenBalances.find(
    (item) =>
      typeof item.owner === "string" &&
      item.owner.toLowerCase() === expectedPayer.toLowerCase() &&
      typeof item.mint === "string" &&
      item.mint.toLowerCase() === expectedMint.toLowerCase()
  );

  const postAmount = BigInt(readTokenBalanceAmount(senderPostBalance));
  const preAmount = BigInt(readTokenBalanceAmount(senderPreBalance));
  const delta = preAmount - postAmount;
  const expected = BigInt(expectedAmountAtomic);

  if (delta !== expected) {
    return {
      ok: false,
      reason: "AMOUNT_MISMATCH",
      details: {
        expected: expectedAmountAtomic,
        actual: delta.toString(),
      },
    };
  }

  return {
    ok: true,
    signature: transactionSignature,
    payer,
    mint: expectedMint,
    destination: destinationBalance.owner,
    amountAtomic: delta.toString(),
    slot: result.slot,
    blockTime: result.blockTime ?? 0,
  };
}
