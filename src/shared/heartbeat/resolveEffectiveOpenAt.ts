/**
 * Heartbeat Effective-Open-At Resolver (v4.3)
 *
 * Computes effective unlock time using creator presence confirmations,
 * per the canonical Heartbeat Specification (Complete System Logic, v4.3):
 *
 * Heartbeat is always active. heartbeatInterval stores the ORIGINALLY
 * SELECTED opening interval (openAt - sealedAt at seal time), fixed at
 * sealing. It is not an arbitrary confirmation cadence.
 *
 * Renewal Rule (fixed, not proportional to heartbeatInterval):
 *  - original interval <= 30 days -> each confirmation extends openAt
 *    by exactly the original interval.
 *  - original interval  > 30 days -> each confirmation extends openAt
 *    by exactly 30 days (confirmations are only reachable in the final
 *    30-day window in the first place; gating is enforced by the caller
 *    / confirmPresence()).
 *
 * Protocol guarantees:
 *
 * - manifest.openAt remains immutable
 * - rolling extension derived only at runtime
 * - unlock boundary never moves backwards
 * - deterministic result
 * - all temporal values enforced as integer UTC milliseconds
 */

import type {
  OpenAtUtc
} from "@/types/manifest";

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Canonical minimum opening interval for a sealed capsule.
 *
 * Mirrors the server-side seal bound (functions/api/capsule/seal.ts
 * HEARTBEAT_INTERVAL_MIN) and the client validator
 * (assertHeartbeatIntervalBounds): a sealed capsule must open at least
 * ONE FULL DAY after its sealedAt, i.e.
 *
 *   heartbeatInterval = openAt - sealedAt >= HEARTBEAT_INTERVAL_MIN_MS
 *
 * A capsule whose normalized openAt lands within 24 h of sealing is
 * rejected by the seal endpoint with 400 INVALID_HEARTBEAT.
 */
export const HEARTBEAT_INTERVAL_MIN_MS = 24 * 60 * 60 * 1000;

/**
 * Earliest calendar day a date-only picker may allow.
 *
 * The picker is date-only: the chosen day is normalized to 12:00 UTC
 * (see normalizeOpenAt). For the resulting openAt to satisfy the seal
 * bound openAt >= nowUtc + HEARTBEAT_INTERVAL_MIN_MS, the chosen day's
 * 12:00-UTC instant must be at least HEARTBEAT_INTERVAL_MIN_MS after
 * `nowUtc`.
 *
 * Returns the FIRST UTC midnight whose 12:00-UTC instant satisfies the
 * bound, computed entirely in UTC (never local time). Days strictly
 * before the returned value must be disabled by the picker.
 *
 * Pure + deterministic; `nowUtc` is injected (no ambient clock).
 */
export function minAllowedOpenDayUtcMs(
  nowUtc: number
): number {

  if (
    !Number.isFinite(nowUtc) ||
    !Number.isSafeInteger(nowUtc)
  ) {
    throw new Error(
      "[AETERNA] minAllowedOpenDayUtcMs requires a safe-integer UTC instant"
    );
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOON_OFFSET_MS = 12 * 60 * 60 * 1000;

  // Start at the current UTC day's midnight, then advance whole days
  // until that day's 12:00-UTC instant is >= now + the minimum.
  let midnight =
    Math.floor(nowUtc / DAY_MS) * DAY_MS;

  const minOpenAt = nowUtc + HEARTBEAT_INTERVAL_MIN_MS;

  while (midnight + NOON_OFFSET_MS < minOpenAt) {
    midnight += DAY_MS;
  }

  return midnight;

}


type Params = {

  /**
   * Immutable manifest unlock boundary
   */
  manifestOpenAt: OpenAtUtc;

  /**
   * Optional creator confirmation timestamp
   *
   * exactOptionalPropertyTypes-compatible
   */
  lastConfirmedAt?: number | undefined;

  /**
   * The originally selected opening interval (openAt - sealedAt),
   * fixed at sealing time. Canonical manifest.heartbeatInterval.
   *
   * exactOptionalPropertyTypes-compatible
   */
  heartbeatInterval?: number | undefined;

};


/**
 * Canonical Heartbeat renewal amount for a given original interval.
 *
 * <= 30 days -> extend by the original interval itself
 *  > 30 days -> extend by exactly 30 days
 */
export function resolveHeartbeatRenewalMs(
  heartbeatInterval: number
): number {

  return heartbeatInterval <= THIRTY_DAYS_MS
    ? heartbeatInterval
    : THIRTY_DAYS_MS;

}


export function resolveEffectiveOpenAt({

  manifestOpenAt,

  lastConfirmedAt,

  heartbeatInterval = 0,

}: Params): OpenAtUtc {

  /**
   * manifestOpenAt invariant guard
   *
   * Must be a finite integer — fractional ms timestamps introduce
   * determinism drift across distributed runtimes and serialization
   * boundaries. Infinity, NaN, and floats are all rejected.
   */

  if (
    !Number.isFinite(manifestOpenAt) ||
    !Number.isInteger(manifestOpenAt)
  ) {

    throw new Error(
      "[AETERNA] Invalid manifest.openAt"
    );

  }


  /**
   * heartbeat interval invariant guard
   *
   * Must be a finite non-negative integer.
   * Float values (e.g. 1000.5) would cause rolling boundary drift and
   * break cross-runtime parity.
   */

  if (

    !Number.isFinite(heartbeatInterval) ||
    !Number.isInteger(heartbeatInterval) ||
    heartbeatInterval < 0

  ) {

    throw new Error(
      "[AETERNA] Invalid heartbeat timing"
    );

  }


  /**
   * lastConfirmedAt invariant guard
   *
   * Integer check replaces isFinite — a float confirmation timestamp
   * is not a valid UTC ms epoch value and must not influence the
   * rolling boundary calculation.
   */

  const safeLastConfirmedAt =

    Number.isInteger(lastConfirmedAt)

      ? lastConfirmedAt

      : undefined;


  /**
   * No confirmation ever received — return manifest boundary unchanged.
   *
   * Rolling extension requires a real heartbeat. Without one,
   * the capsule opens at manifestOpenAt as originally sealed.
   */

  if (safeLastConfirmedAt === undefined) {

    return manifestOpenAt;

  }


  /**
   * Rolling unlock boundary calculation.
   *
   * Base is lastConfirmedAt — extension is earned only by
   * a real confirmation, not assumed from manifest.openAt.
   *
   * Extension amount follows the fixed Renewal Rule, not the raw
   * heartbeatInterval value (Complete System Logic, "Heartbeat
   * Renewal Rules").
   */

  const renewalMs =
    resolveHeartbeatRenewalMs(
      heartbeatInterval
    );

  const rollingBoundary =

    safeLastConfirmedAt +

    renewalMs;


  /**
   * overflow guard
   */

  if (

    !Number.isFinite(
      rollingBoundary
    )

  ) {

    throw new Error(
      "[AETERNA] Invalid heartbeat timing"
    );

  }


  /**
   * Unlock boundary never moves backwards
   */

  return Math.max(

    manifestOpenAt,

    rollingBoundary

  ) as OpenAtUtc;

}