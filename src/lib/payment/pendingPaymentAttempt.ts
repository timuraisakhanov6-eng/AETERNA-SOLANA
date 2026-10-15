/**
 * AETERNA — pending service-payment attempt (client-side pointer).
 *
 * Records the ONE payment attempt this browser currently has in flight,
 * so a failure AFTER the wallet returned a signature can be resumed by
 * VERIFYING THAT SAME TRANSACTION instead of sending a second transfer.
 *
 * This is a pointer, never authority:
 *  - it is not an entitlement, not a proof of payment, and never grants
 *    anything;
 *  - the server remains the sole authority (transaction uniqueness, the
 *    verified-payment record, the identity coordinator's attempt state);
 *  - it is deliberately bounded to a single record, because the identity
 *    coordinator allows at most one active purchase attempt per creator.
 *
 * Outcomes:
 *  - "submitted": the wallet returned a transaction signature, so a
 *    transaction EXISTS and must be verified — never re-sent blindly.
 *  - "unknown": the wallet call failed without a signature and the
 *    failure did not provably happen before sending. A transaction may
 *    therefore exist on-chain: the client must NOT send another one
 *    until the situation is resolved.
 */

export const PENDING_PAYMENT_ATTEMPT_KEY = "aeterna-pending-payment-attempt";

export type PendingPaymentOutcome = "submitted" | "unknown";

export interface PendingPaymentAttempt {
  /** Record format version. */
  version: 2;
  paymentIntentId: string;
  creatorIdentityId: string | null;
  network: "solana" | null;
  account: string | null;
  /** The Solana transaction signature — present once the wallet signed. */
  transactionId: string | null;
  /**
   * The serialized SIGNED transaction (base64), kept ONLY so the exact
   * same bytes can be re-broadcast idempotently after a lost response.
   * It is never sent anywhere except the validated broadcast endpoint,
   * never logged, and never contains a private key.
   */
  signedTransaction: string | null;
  /** Blockhash window of the signed transaction, when known. */
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  outcome: PendingPaymentOutcome;
  createdAt: number;
  updatedAt: number;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored attempt, or null when absent/unreadable/corrupt. */
export function readPendingPaymentAttempt(): PendingPaymentAttempt | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PENDING_PAYMENT_ATTEMPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const paymentIntentId = record["paymentIntentId"];
    const outcome = record["outcome"];
    if (
      typeof paymentIntentId !== "string" ||
      !paymentIntentId ||
      (outcome !== "submitted" && outcome !== "unknown")
    ) {
      return null;
    }
    const str = (value: unknown): string | null =>
      typeof value === "string" && value ? value : null;
    const num = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const updatedAt = num(record["updatedAt"]);
    const createdAt = num(record["createdAt"]);
    const network = record["network"];
    return {
      // Records written by the earlier format are upgraded in place.
      version: 2,
      paymentIntentId,
      creatorIdentityId: str(record["creatorIdentityId"]),
      network: network === "solana" ? "solana" : null,
      account: str(record["account"]),
      transactionId: str(record["transactionId"]),
      signedTransaction: str(record["signedTransaction"]),
      blockhash: str(record["blockhash"]),
      lastValidBlockHeight: num(record["lastValidBlockHeight"]),
      outcome,
      createdAt: createdAt ?? updatedAt ?? 0,
      updatedAt: updatedAt ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persists the pending attempt and reports whether it ACTUALLY landed.
 *
 * The boolean is load-bearing: the payment must not be broadcast when
 * the signature could not be persisted, because a lost response would
 * then be unrecoverable and indistinguishable from "never sent".
 */
export function writePendingPaymentAttempt(
  record: PendingPaymentAttempt
): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(PENDING_PAYMENT_ATTEMPT_KEY, JSON.stringify(record));
    return store.getItem(PENDING_PAYMENT_ATTEMPT_KEY) !== null;
  } catch {
    // Storage unavailable (private mode/quota): fail closed — the caller
    // must not broadcast.
    return false;
  }
}

export function clearPendingPaymentAttempt(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PENDING_PAYMENT_ATTEMPT_KEY);
  } catch {
    // ignore
  }
}
