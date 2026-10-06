/**
 * =========================================================
 * AETERNA CONFIRM PRESENCE — client-side cooldown guard (v2)
 * =========================================================
 *
 * Canonical rules enforced:
 *
 * - The cooldown baseline is ONLY the timestamp of the last
 *   SUCCESSFUL presence confirmation (a real `confirmed`
 *   result), persisted as a VERSIONED + NAMESPACED record.
 *
 * - The cooldown must ARM only after a `confirmed` outcome.
 *   `rejected` / `expired` / `network-error` / timeout /
 *   any non-2xx must NOT persist a marker and must NOT show
 *   "WAIT 15 MIN".
 *
 * - HARDENING (v2): a legacy key written by an EARLIER buggy
 *   build (`aeterna-heartbeat-${capsuleId}`, a bare numeric
 *   `Date.now()` written on ANY outcome) is NEVER trusted.
 *   Only the versioned key below is a trustworthy marker:
 *
 *       aeterna-heartbeat-confirmed-v2-${capsuleId}
 *       value = JSON.stringify({ v: 2, at: <ms epoch> })
 *
 *   The old unversioned key is best-effort purged and can
 *   NEVER arm a cooldown or block a click.
 *
 * - A stored record is trusted only when it is valid JSON,
 *   `v === 2`, and `at` is a finite positive safe integer.
 *   Anything else is ignored AND cleared (fail-open for the
 *   retry path — a corrupt/legacy value must never lock the
 *   creator out of a legitimate confirmation).
 *
 * This module is intentionally PURE: it owns no React state,
 * performs no network I/O, and reads no clock of its own.
 * Callers inject `nowMs` so the guard is deterministic and
 * testable. It does NOT touch the server, the heartbeat
 * calculation, manifest.openAt, resolveEffectiveOpenAt,
 * THIRTY_DAYS_MS, authority, links, lifecycle, crypto,
 * payment, storage, Container/Vault, or the waiting screen.
 */

import type { ConfirmPresenceResult } from "@/lib/heartbeat/confirmPresence";

/** Cooldown duration between successful confirmations (15 minutes). */
export const HEARTBEAT_COOLDOWN_MS = 15 * 60 * 1000;

/** Version tag of the trustworthy confirmation record schema. */
export const HEARTBEAT_CONFIRMATION_SCHEMA_VERSION = 2;

/**
 * Legacy (pre-hardening) key: a bare numeric value written on ANY
 * outcome by the earlier buggy build. NEVER trustworthy.
 */
export function legacyHeartbeatCooldownKey(
  capsuleId: string
): string {
  return `aeterna-heartbeat-${capsuleId}`;
}

/**
 * Canonical VERSIONED + NAMESPACED key for the persisted
 * last-SUCCESSFUL confirmation record, scoped per capsule.
 */
export function heartbeatCooldownKey(
  capsuleId: string
): string {
  return `aeterna-heartbeat-confirmed-v2-${capsuleId}`;
}

/** Parsed, validated v2 confirmation record. */
export type ConfirmedRecord = {
  v: 2;
  at: number;
};

/**
 * Read and validate a persisted v2 confirmation record.
 *
 * Returns `{ v: 2, at }` ONLY when the stored value is valid JSON,
 * carries `v === 2`, and `at` is a finite positive safe integer.
 * Any malformed / wrong-version / legacy / absent value yields
 * `null` (and is not trusted).
 */
export function readConfirmedRecord(
  storage: Pick<Storage, "getItem">,
  key: string
): ConfirmedRecord | null {

  if (!key) return null;

  let raw: string | null;

  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }

  if (raw === null) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const record = parsed as { v?: unknown; at?: unknown };

  if (record.v !== HEARTBEAT_CONFIRMATION_SCHEMA_VERSION) {
    return null;
  }

  const at = record.at;

  if (
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    !Number.isSafeInteger(at) ||
    at <= 0
  ) {
    return null;
  }

  return { v: HEARTBEAT_CONFIRMATION_SCHEMA_VERSION, at };
}

/**
 * Decide whether a click must be blocked by an ACTIVE cooldown.
 *
 * A click is blocked only when a valid v2 record exists and less
 * than `HEARTBEAT_COOLDOWN_MS` has elapsed since `at`. An expired
 * cooldown (elapsed >= duration) MUST allow the call. Legacy /
 * absent / malformed records never block.
 */
export function isCooldownActive(
  storage: Pick<Storage, "getItem">,
  key: string,
  nowMs: number
): boolean {

  const record = readConfirmedRecord(storage, key);

  if (record === null) return false;

  const elapsed = nowMs - record.at;

  return Number.isFinite(elapsed) && elapsed >= 0
    ? elapsed < HEARTBEAT_COOLDOWN_MS
    : // A future-dated timestamp (clock skew / tampering) must
      // NOT lock the creator out; treat it as inactive.
      false;
}

/**
 * Remaining cooldown time in ms, for arming a timer on reload.
 *
 * Returns 0 when no active cooldown applies.
 */
export function remainingCooldownMs(
  storage: Pick<Storage, "getItem">,
  key: string,
  nowMs: number
): number {

  const record = readConfirmedRecord(storage, key);

  if (record === null) return 0;

  const elapsed = nowMs - record.at;

  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;

  const remaining = HEARTBEAT_COOLDOWN_MS - elapsed;

  return remaining > 0 ? remaining : 0;
}

/**
 * Persist the v2 record for a SUCCESSFUL confirmation.
 *
 * MUST be called only after `result === "confirmed"`. Writing for
 * any other outcome is a contract violation (it is what caused the
 * production "WAIT 15 MIN without confirmation" defect).
 */
export function persistConfirmedTimestamp(
  storage: Pick<Storage, "setItem">,
  key: string,
  nowMs: number
): void {

  if (!key) return;

  if (
    !Number.isFinite(nowMs) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  ) {
    return;
  }

  const record: ConfirmedRecord = {
    v: HEARTBEAT_CONFIRMATION_SCHEMA_VERSION,
    at: nowMs,
  };

  try {
    storage.setItem(key, JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode / quota) — the in-memory
    // cooldown state still applies for this session; never throw.
  }
}

/**
 * Clear a persisted v2 record (e.g. on a failed attempt, or when
 * an invalid value is detected) so a stale value can never be
 * mistaken for a real one.
 */
export function clearConfirmedTimestamp(
  storage: Pick<Storage, "removeItem">,
  key: string
): void {

  if (!key) return;

  try {
    storage.removeItem(key);
  } catch {
    // best-effort
  }
}

/**
 * Best-effort purge of the LEGACY (pre-hardening) key for a capsule.
 * The legacy value was written on ANY outcome and is NEVER
 * trustworthy; removing it prevents operator confusion and any
 * future accidental read. Never throws.
 */
export function purgeLegacyCooldown(
  storage: Pick<Storage, "removeItem">,
  capsuleId: string
): void {

  if (!capsuleId) return;

  try {
    storage.removeItem(legacyHeartbeatCooldownKey(capsuleId));
  } catch {
    // best-effort
  }
}

/**
 * If a v2 key holds an INVALID value (malformed JSON, wrong version,
 * bad timestamp), clear it so it cannot linger. Returns true when a
 * value was present and had to be cleared. Legacy keys are never read
 * here (they live under a different key) and are purged separately.
 */
export function clearInvalidConfirmedRecord(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string
): boolean {

  if (!key) return false;

  let raw: string | null;

  try {
    raw = storage.getItem(key);
  } catch {
    return false;
  }

  if (raw === null) return false;

  if (readConfirmedRecord(storage, key) !== null) return false;

  clearConfirmedTimestamp(storage, key);

  return true;
}

/**
 * The single authority on whether a confirm result is a SUCCESS
 * that may arm the cooldown. Any value other than "confirmed"
 * (including an unexpected/unknown value) is NOT a success.
 */
export function isConfirmedResult(
  result: ConfirmPresenceResult | null | undefined
): boolean {
  return result === "confirmed";
}

/* =========================================================
   ATTEMPT ORCHESTRATION (pure)
   ========================================================= */

export type ConfirmAttemptOutcome = {
  /** true when the click was blocked before calling the handler. */
  blocked: boolean;
  /** true when the handler was invoked. */
  invoked: boolean;
  /** the handler's result, or null when blocked / not run. */
  result: ConfirmPresenceResult | null;
  /** true only for a genuine success that arms the cooldown. */
  confirmed: boolean;
};

/**
 * Run one CONFIRM PRESENCE attempt end-to-end, owning the cooldown
 * state machine. Pure with respect to caller state: it performs the
 * guard check, invokes `handler` ONLY when not blocked, and arms /
 * persists the v2 record ONLY on a `confirmed` result.
 *
 * Contract:
 *  - blocked  ⇔ an ACTIVE v2 cooldown exists  ⇒ handler NOT called.
 *  - confirmed ⇒ handler returned "confirmed" ⇒ v2 record PERSISTED,
 *                cooldown ARMED, result surfaced.
 *  - otherwise (rejected/expired/network-error/throw) ⇒ v2 record NOT
 *                persisted (and any invalid value cleared), cooldown
 *                NOT armed, result surfaced for a retry.
 *
 * The legacy key is purged once per attempt (best-effort) and is
 * never consulted.
 */
export async function runConfirmPresenceAttempt(args: {
  handler: () => Promise<ConfirmPresenceResult>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  key: string;
  nowMs: () => number;
  legacyCapsuleId?: string | undefined;
  onConfirmed?: () => void;
  onSettled?: () => void;
}): Promise<ConfirmAttemptOutcome> {

  const { handler, storage, key, nowMs } = args;

  // HARDENING: a legacy unversioned value must never block a click
  // OR be trusted. Purge it opportunistically.
  if (args.legacyCapsuleId) {
    purgeLegacyCooldown(storage, args.legacyCapsuleId);
  }

  if (key) {
    // Drop a corrupt/wrong-version v2 value so it cannot linger.
    clearInvalidConfirmedRecord(storage, key);
    if (isCooldownActive(storage, key, nowMs())) {
      return { blocked: true, invoked: false, result: null, confirmed: false };
    }
  }

  let result: ConfirmPresenceResult;

  try {
    result = await handler();
  } catch {
    // A thrown error is not a success; ensure no stale record can be
    // mistaken for one, then allow a retry.
    if (key) clearConfirmedTimestamp(storage, key);
    args.onSettled?.();
    return {
      blocked: false,
      invoked: true,
      result: "network-error",
      confirmed: false,
    };
  }

  if (!isConfirmedResult(result)) {
    if (key) clearConfirmedTimestamp(storage, key);
    args.onSettled?.();
    return { blocked: false, invoked: true, result, confirmed: false };
  }

  if (key) persistConfirmedTimestamp(storage, key, nowMs());
  args.onConfirmed?.();
  args.onSettled?.();

  return { blocked: false, invoked: true, result, confirmed: true };
}
