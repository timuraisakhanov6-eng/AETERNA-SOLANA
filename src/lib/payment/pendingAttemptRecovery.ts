/**
 * AETERNA — stale pending-payment-attempt reconciliation (client side).
 *
 * The pending attempt record (pendingPaymentAttempt.ts) is a POINTER for
 * the ONE payment attempt this browser has in flight. A pointer whose
 * blockhash window has PROVABLY expired and whose transaction is PROVABLY
 * absent from Solana can never land and can never verify: keeping it
 * forever forces every future attempt on this intent back into a
 * "resume-verify" loop that ends in the bounded TX_NOT_FOUND window each
 * time, with no prospect of a verdict.
 *
 * WHAT THIS MODULE DECIDES
 * ------------------------
 * It may release the local pointer ONLY when EVERY ONE of the following
 * is proven by server-independent, read-only blockchain facts:
 *
 *  1. EXPIRY — the Solana network block height, read through the
 *     read-only JSON-RPC proxy, EXCEEDS the attempt's recorded
 *     `lastValidBlockHeight` plus a safety margin (getBlockHeight; a
 *     slot count is a different quantity and is never compared with a
 *     block height here).
 *  2. ABSENCE — the recorded transaction signature is unknown BOTH to
 *     `getSignatureStatuses` (with history search) AND to `getTransaction`
 *     (two independent read-only lookups: one consults the wallet/
 *     validator node, the other the ledger history).
 *
 * ANY other outcome keeps the record:
 *   - a known signature status (confirmed OR failed on-chain) means the
 *     transaction EXISTS: the verifier /api/service-payment/verify owns
 *     the verdict; nothing is cleared automatically here;
 *   - a found transaction (getTransaction) blocks release;
 *   - an incompatible pair of answers (one lookup knows the
 *     transaction, the other does not) blocks release;
 *   - every transport failure, unreadable answer, missing ledger window
 *     or missing record field blocks release (fail closed);
 *   - a record without a transactionId has nothing to look up and is
 *     never touched by this module (the controller keeps blocking new
 *     transfers for it — unchanged behaviour).
 *
 * TX_NOT_FOUND FROM THE VERIFIER IS NEVER SUFFICIENT: verify-poll
 * results, record age and the number of failed verification windows are
 * deliberately NOT consulted — this module relies on direct on-chain
 * reads only.
 *
 * BOUNDED RETRIES (liveness without weakening the decision)
 * ---------------------------------------------------------
 * Each read-only check is attempted AT MOST TWICE. A retry happens ONLY
 * for a failure classified as a TEMPORARY transport failure (timeout /
 * network / HTTP 429 / HTTP 5xx); a definitive 4xx refusal is never
 * retried, and a SUCCESSFUL response — including a successful `null` —
 * is never retried. Exhausting the retries leaves the record KEPT: a
 * transient outage can only ever delay a release, never cause one.
 *
 * AUTHORITY
 * ---------
 * Releasing the POINTER does not change any server state. The identity
 * coordinator's purchase attempt — including any signature it has bound —
 * remains the sole authority. A released pointer therefore cannot cause
 * a duplicate payment: before any NEW transfer the controller re-reads
 * the attempt state from the proof-backed endpoint, and a signature the
 * server has bound is resumed instead of re-sent. Conversely, release
 * MUST NOT start a payment: the controller surface that triggers
 * reconciliation stops and lets the creator start the next payment step
 * explicitly.
 */

import {
  clearPendingPaymentAttempt,
  readPendingPaymentAttempt,
} from "./pendingPaymentAttempt";

/** The read-only JSON-RPC methods this reconciliation consumes. */
export type PendingAttemptRpcMethod =
  | "getBlockHeight"
  | "getSignatureStatuses"
  | "getTransaction";

/**
 * One already-allow-listed read-only JSON-RPC call through
 * /api/solana/rpc. It resolves with the RPC `result` value and ALWAYS
 * throws on any transport / HTTP / JSON-RPC error — throw is the
 * caller's only "uncertain" channel and every caller treats a throw as
 * "keep the record".
 */
export type PendingAttemptRpcTransport = (
  method: PendingAttemptRpcMethod,
  params: unknown[]
) => Promise<unknown>;

/**
 * SAFETY MARGIN (blocks) required ABOVE the recorded
 * lastValidBlockHeight before absence is trusted. Rationale: the height
 * is read at the `finalized` commitment (already ~32 slots behind the
 * tip), and ledger history (getTransaction / signature status history
 * search) can lag the finalized height on some providers. The margin
 * makes "expired" strictly later than any realistic indexing delay;
 * until then the transaction could in principle still be indexed, so
 * the record is kept.
 */
export const PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS = 32;

export type PendingAttemptRecoveryStatus =
  | "no_pending_record"
  | "no_transaction_to_recover"
  | "released"
  | "kept";

export interface PendingAttemptRecoveryOutcome {
  readonly status: PendingAttemptRecoveryStatus;
  /** Populated for "kept" — the fail-closed reason. */
  readonly reason?: string;
  /** Populated for "released". */
  readonly releaseReason?: "EXPIRED_AND_ABSENT";
  /**
   * Populated (true) for a "kept" outcome whose reads were blocked by a
   * TEMPORARY transport failure (timeout / HTTP 429 / HTTP 5xx) after the
   * bounded retries were exhausted. Callers use it to tell the creator
   * "the network is temporarily unavailable — your attempt is kept and
   * will be checked again" apart from a NON-transient refusal, WITHOUT
   * ever treating either as proof of absence. It never changes the
   * release decision: reordering, retrying or reclassifying reads must
   * not clear the record.
   */
  readonly transportUnavailable?: boolean;
}

/** Reused transaction-signature shape — the verifier accepts {64,88}. */
const TX_ID_SHAPE = /^[A-Za-z0-9]{64,88}$/;

/**
 * BOUNDED RETRY POLICY for the read-only checks.
 *
 * Only a TEMPORARY transport failure may be retried, and only a strictly
 * bounded number of times: a transient RPC hiccup should not force the
 * creator to wait for the next explicit check, but an outage must never
 * become an endless loop either. Two attempts = one initial read plus one
 * retry — the maximum this stage allows.
 */
export const PENDING_ATTEMPT_MAX_READ_ATTEMPTS = 2;
/** Short, fixed delay between the two bounded attempts (ms). */
export const PENDING_ATTEMPT_RETRY_DELAY_MS = 400;

/**
 * A temporary transport/availability failure: the request either never
 * produced a response (timeout / network) or the edge/upstream answered
 * with a status that means "temporarily unavailable" (429, 5xx).
 *
 * A 4xx other than 429 (a malformed request, a method the proxy refuses)
 * is a CONFIGURATION/BUG signal, not a transient one: retrying it would
 * only repeat the same refusal, so it is deliberately NOT retried.
 */
function isTransientRpcFailure(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
      ? err
      : "";
  if (!message) return false;

  if (/SOLANA_RPC_HTTP_(429|5\d\d)\b/.test(message)) return true;

  return /RPC_TIMEOUT|timeout|aborted|AbortError|network|fetch failed|Failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|load failed/i.test(
    message
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One read, retried at most `attempts` times and ONLY while the failure
 * is classified as transient. A SUCCESSFUL response is never retried —
 * including a successful `null`, which is a definitive observation of
 * absence, not an error. The returned `transient` flag describes the
 * FINAL failure only.
 */
async function readWithTransientRetry(
  transport: PendingAttemptRpcTransport,
  method: PendingAttemptRpcMethod,
  params: unknown[],
  attempts: number,
  delayMs: number
): Promise<{ ok: true; result: unknown } | { ok: false; transient: boolean }> {
  const total = Math.max(1, attempts);
  let transient = false;

  for (let attempt = 0; attempt < total; attempt++) {
    try {
      return { ok: true, result: await transport(method, params) };
    } catch (err) {
      transient = isTransientRpcFailure(err);
      if (!transient || attempt === total - 1) {
        return { ok: false, transient };
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  return { ok: false, transient };
}

function firstSignatureValue(
  statusesResult: unknown
): { known: boolean; readable: boolean } {
  /**
   * getSignatureStatuses resolves to
   * `{ context: { slot }, value: [null | statusObject] }`.
   * `null` means "not known to this node, not in searched history";
   * ANY object — confirmed, failed, finalised or not — means the
   * transaction EXISTS in the chain's records.
   */
  if (!statusesResult || typeof statusesResult !== "object") {
    return { known: false, readable: false };
  }
  const value = (statusesResult as Record<string, unknown>)["value"];
  if (!Array.isArray(value) || value.length < 1) {
    return { known: false, readable: false };
  }
  const first = value[0];
  if (first === null) return { known: false, readable: true };
  if (typeof first === "object") return { known: true, readable: true };
  return { known: false, readable: false };
}

function isTransactionFound(getTransactionResult: unknown): boolean {
  // A transaction record object proves existence. `null` proves absence.
  return (
    typeof getTransactionResult === "object" && getTransactionResult !== null
  );
}

/**
 * The default transport: the SAME-origin read-only proxy every other
 * AETERNA payment-side read already uses (the browser must never call a
 * public Solana RPC directly). Requests carry a JSON-RPC envelope the
 * proxy expects; a non-2xx response, an RPC error body, or an
 * unparseable body throws — and every caller treats a throw as
 * "uncertain → keep the record".
 */
function createProxyRpcTransport(fetchImpl: typeof fetch): PendingAttemptRpcTransport {
  let requestId = 0;
  return async (method, params) => {
    requestId += 1;
    const res = await fetchImpl("/api/solana/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `aeterna-pending-recovery-${requestId}`,
        method,
        params,
      }),
    });
    if (!res.ok) {
      throw new Error(`SOLANA_RPC_HTTP_${res.status}`);
    }
    const data = (await res.json().catch(() => null)) as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: unknown;
      error?: unknown;
    } | null;
    if (!data || data.error !== undefined || data.result === undefined) {
      throw new Error("SOLANA_RPC_ERROR");
    }
    return data.result;
  };
}

/**
 * Reconciles the ONE pending payment attempt this browser holds.
 *
 * Never throws. The outcome status tells the caller what happened:
 *   - "released"     — expiry and absence were both PROVEN; the pointer
 *                      was cleared only while the record still matched
 *                      what was read at the start;
 *   - "kept"         — fail closed for `reason` (never an auto-delete);
 *   - the other two  — nothing was actionable.
 */
export async function reconcileStalePendingPaymentAttempt(
  options: {
    fetchImpl?: typeof fetch;
    rpcTransport?: PendingAttemptRpcTransport;
    /** Overridable in tests only — how "now" is not used for expiry. */
    marginBlocks?: number;
    /** Bounded read attempts (default 2: one read + one transient retry). */
    maxReadAttempts?: number;
    /** Delay between the bounded attempts (ms); tests may pass 0. */
    retryDelayMs?: number;
  } = {}
): Promise<PendingAttemptRecoveryOutcome> {
  const record = readPendingPaymentAttempt();
  if (!record) {
    return { status: "no_pending_record" };
  }

  // A record with no transaction signature has nothing to look up
  // on-chain: nothing here may unblock it — the controller's own
  // "unknown outcome" guard keeps refusing to send.
  if (!record.transactionId) {
    return { status: "no_transaction_to_recover" };
  }

  /**
   * `transportUnavailable` is set ONLY when the final failure was
   * classified as a TEMPORARY transport failure, so callers can phrase
   * "network temporarily unavailable" honestly. It never influences the
   * decision — `keep` is fail-closed either way.
   */
  const keep = (
    reason: string,
    transportUnavailable = false
  ): PendingAttemptRecoveryOutcome => ({
    status: "kept",
    reason,
    ...(transportUnavailable ? { transportUnavailable: true } : {}),
  });

  // The lookups are strict base58-shape reads; a malformed signature
  // must never reach the RPC and must never release the record.
  if (!TX_ID_SHAPE.test(record.transactionId)) {
    return keep("TRANSACTION_ID_UNUSABLE");
  }

  const lastValidBlockHeight = record.lastValidBlockHeight;
  if (
    typeof lastValidBlockHeight !== "number" ||
    !Number.isFinite(lastValidBlockHeight) ||
    !Number.isInteger(lastValidBlockHeight) ||
    lastValidBlockHeight <= 0
  ) {
    // Without the recorded window the expiry cannot be proven at all.
    return keep("BLOCKHASH_WINDOW_UNPROVABLE");
  }

  const transport =
    options.rpcTransport ??
    createProxyRpcTransport(options.fetchImpl ?? fetch);
  const marginBlocks =
    options.marginBlocks ?? PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS;
  const maxReadAttempts = Math.max(
    1,
    options.maxReadAttempts ?? PENDING_ATTEMPT_MAX_READ_ATTEMPTS
  );
  const retryDelayMs =
    options.retryDelayMs ?? PENDING_ATTEMPT_RETRY_DELAY_MS;

  // 1) EXPIRY — network block height vs the recorded window height.
  //    getSlot is a DIFFERENT quantity and is deliberately never
  //    compared with lastValidBlockHeight.
  let currentBlockHeight: number;
  const heightRead = await readWithTransientRetry(
    transport,
    "getBlockHeight",
    [{ commitment: "finalized" }],
    maxReadAttempts,
    retryDelayMs
  );
  if (!heightRead.ok) {
    return keep("BLOCK_HEIGHT_UNAVAILABLE", heightRead.transient);
  }
  {
    const result = heightRead.result;
    if (
      typeof result !== "number" ||
      !Number.isFinite(result) ||
      !Number.isInteger(result) ||
      result < 1
    ) {
      // A RESPONSE that cannot be read is not a transport failure.
      return keep("BLOCK_HEIGHT_UNREADABLE");
    }
    currentBlockHeight = result;
  }

  if (currentBlockHeight <= lastValidBlockHeight + marginBlocks) {
    // The window is provably still alive (or the margin is not yet
    // satisfied): the transaction can still land, so the pointer stays.
    return keep("BLOCKHASH_WINDOW_NOT_PROVABLY_EXPIRED");
  }

  // 2) ABSENCE — signature history and the ledger must both be silent.
  let statusKnown: boolean;
  const statusRead = await readWithTransientRetry(
    transport,
    "getSignatureStatuses",
    [[record.transactionId], { searchTransactionHistory: true }],
    maxReadAttempts,
    retryDelayMs
  );
  if (!statusRead.ok) {
    return keep("SIGNATURE_STATUS_UNAVAILABLE", statusRead.transient);
  }
  {
    const parsed = firstSignatureValue(statusRead.result);
    if (!parsed.readable) return keep("SIGNATURE_STATUS_UNREADABLE");
    statusKnown = parsed.known;
  }

  if (statusKnown) {
    // The transaction EXISTS (confirmed or failed): the verifier owns
    // the verdict and the pointer must remain for a definitive result.
    // An automatic delete here could hide a real payment (or a real
    // failure that still needs its explicit verdict).
    return keep("TRANSACTION_STATUS_KNOWN");
  }

  const txRead = await readWithTransientRetry(
    transport,
    "getTransaction",
    [
      record.transactionId,
      {
        encoding: "json",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ],
    maxReadAttempts,
    retryDelayMs
  );
  if (!txRead.ok) {
    return keep("TRANSACTION_LOOKUP_UNAVAILABLE", txRead.transient);
  }
  const transactionFound = isTransactionFound(txRead.result);
  if (transactionFound) {
    return keep("TRANSACTION_FOUND");
  }

  // 3) RELEASE — only here, with both facts proven, and only while the
  //    record is still the one that was inspected. A record replaced
  //    between the read and the clear is left untouched.
  const latest = readPendingPaymentAttempt();
  if (
    !latest ||
    latest.paymentIntentId !== record.paymentIntentId ||
    latest.transactionId !== record.transactionId
  ) {
    return keep("PENDING_RECORD_CHANGED_DURING_RECONCILIATION");
  }
  clearPendingPaymentAttempt();
  return { status: "released", releaseReason: "EXPIRED_AND_ABSENT" };
}
