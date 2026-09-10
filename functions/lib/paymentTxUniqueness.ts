/**
 * AETERNA — Global Payment Transaction Uniqueness
 *
 * Canonical invariant:
 *   ONE successful on-chain AETERNA service-payment transaction
 *   -> MAXIMUM ONE verified payment -> MAXIMUM ONE Creator Credit,
 *   globally across quotes, paymentIntentIds, identities and credits.
 *
 * Uniqueness identity: network + transactionId.
 * Deliberately independent of paymentIntentId / evidenceId / quoteId /
 * creatorIdentityId / creatorCreditId.
 *
 * Atomicity model:
 *   The existing CreditOperationCoordinator Durable Object class is
 *   extended with payment-tx-claim / payment-tx-check operations.
 *   One Durable Object instance is addressed per
 *   sha256(network:transactionId): the DO single-threaded execution
 *   model serializes concurrent claims for the SAME transaction, and
 *   different transactions map to independent instances, so there is
 *   no cross-transaction bottleneck. Claim state lives in Durable
 *   Object storage, which is durable and NOT subject to the 1-hour
 *   VERIFIED_PAYMENTS KV TTL, so a transaction cannot be replayed
 *   after its evidence record expires.
 */

import { sha256 } from "./sha256";

export type PaymentTxNetwork = "base" | "solana";

export interface PaymentTxClaimInput {
  network: PaymentTxNetwork;
  transactionId: string;
  paymentIntentId: string;
  evidenceId: string;
  creatorIdentityId: string;
  claimedAt: number;
}

export interface PaymentTxBindingEnv {
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(input: Request): Promise<Response>;
    };
  };
}

/**
 * Mirrors the accepted transaction-shape branches of
 * /api/service-payment/verify exactly: 0x + 64 hex -> Base (EVM),
 * 64-88 base58 characters (non-0x) -> Solana. Anything else is not a
 * valid payment transaction identity and must fail closed.
 */
export function resolvePaymentNetwork(transactionId: string): PaymentTxNetwork | null {
  if (transactionId.length === 66 && transactionId.startsWith("0x")) {
    return "base";
  }
  if (!transactionId.startsWith("0x") && /^[A-Za-z0-9]{64,88}$/.test(transactionId)) {
    return "solana";
  }
  return null;
}

/**
 * Durable Object instance name for one payment transaction.
 * idFromName names are bounded, and Solana signatures reach 88
 * characters, so the identity is addressed by its SHA-256 digest
 * (64 hex characters). The full network + transactionId is stored
 * inside the claim record and re-verified by the DO on every read,
 * failing closed on any mismatch.
 */
export async function paymentTxCoordinatorName(
  network: PaymentTxNetwork,
  transactionId: string
): Promise<string> {
  const bytes = new TextEncoder().encode(`${network}:${transactionId}`);
  return sha256(bytes);
}

/**
 * Atomic global claim for a successful payment transaction.
 *
 * MUST be called only after the transaction has passed all existing
 * payment validity checks (network, amount, mint, destination,
 * payer, success/finalization). A failed or invalid transaction must
 * never establish the binding.
 *
 * Returns:
 *   { ok: true }                                   — claim established (first) or
 *                                                    idempotently held by the SAME
 *                                                    paymentIntentId (replay)
 *   { ok: false, conflict: true }                  — a DIFFERENT paymentIntentId
 *                                                    already owns this transaction
 *   { ok: false, conflict: false }                 — coordination unavailable:
 *                                                    fail closed (no verified
 *                                                    payment may be persisted)
 */
export async function claimPaymentTransaction(
  env: PaymentTxBindingEnv,
  input: PaymentTxClaimInput
): Promise<{ ok: true } | { ok: false; conflict: boolean }> {
  const coordinatorBinding = env.CREDIT_OP_COORDINATOR;
  if (!coordinatorBinding) {
    return { ok: false, conflict: false };
  }

  try {
    const name = await paymentTxCoordinatorName(input.network, input.transactionId);
    const stub = coordinatorBinding.get(coordinatorBinding.idFromName(name));

    const response = await stub.fetch(
      new Request("https://aeterna-payment-tx-uniqueness.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "payment-tx-claim", ...input }),
      })
    );

    if (response.status === 409) {
      return { ok: false, conflict: true };
    }
    if (!response.ok) {
      return { ok: false, conflict: false };
    }

    const data = (await response.json().catch(() => null)) as
      | { ok?: unknown }
      | null;
    if (!data || data.ok !== true) {
      return { ok: false, conflict: false };
    }

    return { ok: true };
  } catch {
    return { ok: false, conflict: false };
  }
}

export type PaymentTxCheckOutcome =
  | { ok: true; outcome: "CLAIMED" }
  | { ok: false; reason: "CONFLICT" | "UNVERIFIED" | "UNAVAILABLE" };

/**
 * Read-only validation that a transaction's global binding exists and
 * belongs to the given paymentIntentId. Used at the Creator Credit
 * minting boundary (grant-credit) as defense in depth: verify.ts
 * establishes the binding; grant-credit refuses to mint unless the
 * binding is present and consistent.
 */
export async function checkPaymentTransactionBinding(
  env: PaymentTxBindingEnv,
  input: {
    network: PaymentTxNetwork;
    transactionId: string;
    paymentIntentId: string;
  }
): Promise<PaymentTxCheckOutcome> {
  const coordinatorBinding = env.CREDIT_OP_COORDINATOR;
  if (!coordinatorBinding) {
    return { ok: false, reason: "UNAVAILABLE" };
  }

  try {
    const name = await paymentTxCoordinatorName(input.network, input.transactionId);
    const stub = coordinatorBinding.get(coordinatorBinding.idFromName(name));

    const response = await stub.fetch(
      new Request("https://aeterna-payment-tx-uniqueness.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "payment-tx-check", ...input }),
      })
    );

    if (response.status === 409) {
      return { ok: false, reason: "CONFLICT" };
    }
    if (!response.ok) {
      return { ok: false, reason: "UNAVAILABLE" };
    }

    const data = (await response.json().catch(() => null)) as
      | { ok?: unknown; outcome?: unknown }
      | null;
    if (!data || data.ok !== true) {
      return { ok: false, reason: "UNAVAILABLE" };
    }

    if (data.outcome === "CLAIMED") {
      return { ok: true, outcome: "CLAIMED" };
    }
    if (data.outcome === "NOT_CLAIMED") {
      return { ok: false, reason: "UNVERIFIED" };
    }

    return { ok: false, reason: "UNAVAILABLE" };
  } catch {
    return { ok: false, reason: "UNAVAILABLE" };
  }
}
