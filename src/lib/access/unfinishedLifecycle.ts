/**
 * AETERNA — Unfinished lifecycle recovery records (client-side HINTS only)
 *
 * WHY THIS EXISTS
 * ---------------
 * A Creator Credit moves to CONSUMING the moment the creator-paid Irys
 * storage payment has been verified and `/api/creator/reserve-lifecycle`
 * has bound a lifecycle. An interrupted attempt (browser closed between
 * the reserve and the completed publication + seal) therefore leaves the
 * right bound to a lifecycle that never finished.
 *
 * The server owns the authoritative undo: POST
 * `/api/creator/recover-lifecycle` (signature-authorized by the owning
 * creator identity) delegates the decision to the CreditOperationCoordinator
 * Durable Object, which reads authoritative verification state INSIDE the
 * DO and only restores AVAILABLE when the publication AND the seal are both
 * NOT verified and no publication claim is in flight (CONSUMED / verified /
 * in-flight ⇒ never restored).
 *
 * This module is ONLY the client-side hint store that makes a bounded,
 * USER-TRIGGERED recovery possible after the browser was closed:
 *
 *  - it persists the opaque identifiers (creatorIdentityId / creatorCreditId
 *    / lifecycleId / capsuleId) at the exact moment the server-side reserve
 *    succeeded;
 *  - it is a MULTI-RECORD store keyed by lifecycleId: several interrupted
 *    attempts are tracked independently, and removing one never touches the
 *    others (a single-slot record was previously overwritten by the next
 *    attempt, orphaning the earlier right);
 *  - it carries NO entitlement, payment or secret material — any tampering
 *    is irrelevant because the server re-validates ownership with a signed
 *    identity proof and decides alone;
 *  - it is never consulted automatically: no unmount, tab-close or
 *    home-visit hook calls the recover endpoint. The records merely permit
 *    the Home access gate to OFFER the action to the user;
 *  - it is a POINTER, never proof of ownership and never proof of payment.
 *    Losing a hint can only lose the CONVENIENCE of the one-click recovery,
 *    never the right itself: the server-side credit record and the lifecycle
 *    index remain authoritative. (Known limitation: an interrupted attempt
 *    whose hint is gone is not auto-detected by discovery — see the report.)
 *
 * Storage is localStorage (survives a closed browser — the exact scenario
 * this covers). All access is fail-safe: any storage failure yields
 * "no records", never a crash; malformed entries are dropped individually
 * so one corrupt record cannot hide the others.
 */

import { CAPSULE_ID_REGEX } from "@/lib/crypto/validators";

/** Legacy single-record key (v1). Migrated into the v2 collection on read. */
export const UNFINISHED_LIFECYCLE_KEY = "aeterna-unfinished-lifecycle";

/** Multi-record key (v2). */
export const UNFINISHED_LIFECYCLES_KEY = "aeterna-unfinished-lifecycles";

/** Upper bound on retained hints (oldest dropped first). */
export const MAX_UNFINISHED_LIFECYCLES = 20;

/**
 * The identifiers POST /api/creator/recover-lifecycle requires. Opaque
 * values only — never a secret, never a payment proof.
 */
export interface UnfinishedLifecycleRecord {
  creatorIdentityId: string;
  creatorCreditId: string;
  lifecycleId: string;
  capsuleId: string;
}

/**
 * Strict shape validation. A malformed or partially-written record is
 * treated as absent (fail-closed: no recovery is offered on garbage).
 */
export function isUnfinishedLifecycleRecord(
  value: unknown
): value is UnfinishedLifecycleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record["creatorIdentityId"] === "string" &&
    record["creatorIdentityId"].length > 0 &&
    typeof record["creatorCreditId"] === "string" &&
    record["creatorCreditId"].length > 0 &&
    typeof record["lifecycleId"] === "string" &&
    record["lifecycleId"].length > 0 &&
    typeof record["capsuleId"] === "string" &&
    CAPSULE_ID_REGEX.test(record["capsuleId"])
  );
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Private mode / disabled storage — the hint is simply unavailable.
    return null;
  }
}

function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function parseLegacyRecord(raw: string | null): UnfinishedLifecycleRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUnfinishedLifecycleRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Deduplicate by lifecycleId, keeping the first occurrence. */
function dedupe(
  records: readonly UnfinishedLifecycleRecord[]
): UnfinishedLifecycleRecord[] {
  const byLifecycle = new Map<string, UnfinishedLifecycleRecord>();
  for (const record of records) {
    if (!byLifecycle.has(record.lifecycleId)) {
      byLifecycle.set(record.lifecycleId, record);
    }
  }
  return [...byLifecycle.values()];
}

/**
 * Read every unfinished-lifecycle hint.
 *
 * Tolerates BOTH storage generations and any corruption:
 *  - v2 array under UNFINISHED_LIFECYCLES_KEY;
 *  - v1 single object under UNFINISHED_LIFECYCLE_KEY (migrated on write);
 *  - entries that fail validation are dropped individually.
 *
 * NEVER throws. Returns [] when nothing usable is stored.
 */
export function readUnfinishedLifecycles(): UnfinishedLifecycleRecord[] {
  const store = storage();
  if (!store) return [];

  const collected: UnfinishedLifecycleRecord[] = [];

  const collectionRaw = safeGet(store, UNFINISHED_LIFECYCLES_KEY);
  if (collectionRaw) {
    try {
      const parsed: unknown = JSON.parse(collectionRaw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (isUnfinishedLifecycleRecord(entry)) {
            collected.push(entry);
          }
        }
      }
    } catch {
      // Corrupt collection — fall through to the legacy record below.
    }
  }

  const legacy = parseLegacyRecord(safeGet(store, UNFINISHED_LIFECYCLE_KEY));
  if (legacy) {
    collected.push(legacy);
  }

  return dedupe(collected);
}

/**
 * Insert or replace the hint for ITS lifecycleId. Every other lifecycle is
 * preserved untouched. Best-effort by contract: a storage failure MUST NOT
 * break the successful reserve that precedes it. Never throws.
 */
export function upsertUnfinishedLifecycle(
  record: UnfinishedLifecycleRecord
): void {
  if (!isUnfinishedLifecycleRecord(record)) return;

  const store = storage();
  if (!store) return;

  const next = dedupe([
    record,
    ...readUnfinishedLifecycles().filter(
      (existing) => existing.lifecycleId !== record.lifecycleId
    ),
  ]).slice(0, MAX_UNFINISHED_LIFECYCLES);

  try {
    store.setItem(UNFINISHED_LIFECYCLES_KEY, JSON.stringify(next));
    // The v2 collection is now authoritative for this browser.
    store.removeItem(UNFINISHED_LIFECYCLE_KEY);
  } catch {
    // Non-fatal: recovery simply cannot be offered for this attempt.
  }
}

/**
 * Remove ONE hint by lifecycleId; every other hint is left intact.
 * Omitting lifecycleId clears the whole store (explicit reset only).
 * Best-effort. Never throws.
 */
export function removeUnfinishedLifecycle(lifecycleId?: string): void {
  const store = storage();
  if (!store) return;

  if (lifecycleId === undefined) {
    try {
      store.removeItem(UNFINISHED_LIFECYCLES_KEY);
      store.removeItem(UNFINISHED_LIFECYCLE_KEY);
    } catch {
      // Non-fatal.
    }
    return;
  }

  const remaining = readUnfinishedLifecycles().filter(
    (record) => record.lifecycleId !== lifecycleId
  );

  try {
    if (remaining.length === 0) {
      store.removeItem(UNFINISHED_LIFECYCLES_KEY);
    } else {
      store.setItem(UNFINISHED_LIFECYCLES_KEY, JSON.stringify(remaining));
    }
    store.removeItem(UNFINISHED_LIFECYCLE_KEY);
  } catch {
    // Non-fatal.
  }
}

/* ================= RECOVERY OUTCOME MAPPING (pure) ================= */

/**
 * Client-side classification of the server's recovery answer. The DO is
 * the sole authority; this mapping only decides which USER-FACING message
 * to show and whether the hint may be dropped.
 *
 * - "restored":     the DO restored AVAILABLE — nothing had been published
 *                   or sealed. The normal access-gate flow may continue
 *                   (fresh discovery) without a second payment.
 * - "resolved":     nothing left to recover (already consumed / already
 *                   resolved / record not found). The hint is stale.
 * - "blocked":      publication or seal is verified, or a publication claim
 *                   is in flight — the attempt CANNOT be undone. The hint is
 *                   KEPT (it still describes live server state).
 * - "unauthorized": the owner proof was missing, invalid, expired, or
 *                   belonged to a different creator identity. The hint is
 *                   KEPT and nothing was restored.
 * - "unknown":      transport or protocol failure — the user may retry.
 */
export type RecoveryOutcomeKind =
  | "restored"
  | "resolved"
  | "blocked"
  | "unauthorized"
  | "unknown"
  | "resume-unavailable";

export interface RecoveryOutcome {
  kind: RecoveryOutcomeKind;
  message: string;
}

const RECOVERY_MESSAGES: Record<RecoveryOutcomeKind, string> = {
  restored:
    "Your creation right is restored. Checking access…",
  resolved:
    "That unfinished attempt is already resolved. You can start a new capsule.",
  blocked:
    "This attempt has already published content and cannot be undone. Please contact support.",
  unauthorized:
    "We could not confirm that this wallet owns that creation right. Reconnect the wallet used to pay and try again.",
  unknown:
    "We could not check the unfinished attempt. Please try again.",
  resumeUnavailable:
    "This attempt can't be resumed automatically — its preparation data is missing or does not match. Don't start a new payment; contact support so this attempt can be resolved safely.",
};

/** Outcomes the DO returns when an abort is impossible (server authority). */
const BLOCKED_OUTCOMES = new Set([
  "RESUME",
  "PUBLICATION_VERIFIED_AWAITING_FINALIZATION",
  "SEAL_VERIFIED_AWAITING_FINALIZATION",
  "PUBLICATION_CLAIM_IN_FLIGHT",
]);

/** Owner-proof failures: the request never reached the DO. */
const UNAUTHORIZED_ERRORS = new Set([
  "OWNER_PROOF_REQUIRED",
  "INVALID_SIGNATURE",
  "CHALLENGE_NOT_FOUND",
  "CHALLENGE_CORRUPT",
  "CHALLENGE_EXPIRED",
  "NETWORK_MISMATCH",
  "ACCOUNT_MISMATCH",
  "INVALID_ACCOUNT",
  "CREATOR_IDENTITY_NOT_FOUND",
  "CREATOR_MISMATCH",
]);

/**
 * Map a POST /api/creator/recover-lifecycle response onto a user-facing
 * outcome. Pure: no I/O, no state — unit-testable in the node environment.
 *
 * @param httpStatus HTTP status of the endpoint response.
 * @param payload    Parsed JSON body (or null when unparseable).
 */
export function describeRecoveryResponse(
  httpStatus: number,
  payload: unknown
): RecoveryOutcome {
  const body =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const outcome = typeof body["outcome"] === "string" ? body["outcome"] : "";
  const error = typeof body["error"] === "string" ? body["error"] : "";

  if (outcome === "ABORT_AND_RESTORE_AVAILABLE") {
    return { kind: "restored", message: RECOVERY_MESSAGES.restored };
  }

  if (outcome === "RETURN_EXISTING") {
    return { kind: "resolved", message: RECOVERY_MESSAGES.resolved };
  }

  if (BLOCKED_OUTCOMES.has(outcome)) {
    return { kind: "blocked", message: RECOVERY_MESSAGES.blocked };
  }

  // Endpoint-level 409 before the DO is reached: the lifecycle index has no
  // record for this hint — it is stale, not authoritative state.
  if (error === "LIFECYCLE_NOT_FOUND") {
    return { kind: "resolved", message: RECOVERY_MESSAGES.resolved };
  }

  // Owner-proof rejection — the hint is NOT dropped: it still describes a
  // right that may be recoverable from the correct wallet.
  if (UNAUTHORIZED_ERRORS.has(error) || httpStatus === 401 || httpStatus === 403) {
    return { kind: "unauthorized", message: RECOVERY_MESSAGES.unauthorized };
  }

  return { kind: "unknown", message: RECOVERY_MESSAGES.unknown };
}
