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

import { getSolanaTransaction } from "../solana/rpc";

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

export async function verifySolanaUsdcStoragePayment({
  rpcUrl,
  transactionSignature,
  expectedPayer,
  expectedMint,
  expectedAmountAtomic,
  expectedDestination,
}: SolanaUsdcVerificationInput): Promise<SolanaUsdcVerificationResult> {
  if (!/^[A-Za-z0-9]{64,88}$/.test(transactionSignature)) {
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

  const postMintIndex = new Map(
    postTokenBalances.map((item) => [item.mint.toLowerCase(), item])
  );

  const destinationBalance =
    postTokenBalances.find(
      (item) =>
        typeof item.owner === "string" &&
        item.owner.toLowerCase() === expectedDestination.toLowerCase() &&
        typeof item.mint === "string" &&
        item.mint.toLowerCase() === expectedMint.toLowerCase()
    ) ?? postMintIndex.get(expectedMint.toLowerCase());

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
