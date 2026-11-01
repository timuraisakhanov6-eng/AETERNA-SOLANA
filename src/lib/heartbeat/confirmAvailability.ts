/**
 * AETERNA - Confirm Presence availability (R9-A53, countdown in R9-A54).
 *
 * PRESENTATION RULE ONLY. This module answers two UI questions:
 *
 *   "may the Confirm Presence button be clicked right now?"
 *   "if not, how long until it can?"
 *
 * It decides nothing about the capsule: no lifecycle, no open decision, no
 * manifest mutation, no confirmation, no network. The server remains the
 * sole authority (POST /api/heartbeat rejects an early confirmation with
 * CONFIRMATION_WINDOW_NOT_YET_AVAILABLE), and this rule mirrors that check
 * with the SAME constant:
 *
 *   server (functions/api/heartbeat.ts):
 *     if (heartbeatInterval > THIRTY_DAYS_MS &&
 *         (effectiveOpenAt - nowUtc) > THIRTY_DAYS_MS) -> reject
 *
 *   here, with activationAt = effectiveOpenAt - THIRTY_DAYS_MS:
 *     interval <= 30 days            -> available immediately
 *     interval  > 30 days, wait > 0  -> not available, wait `waitDays`
 *     interval  > 30 days, wait <= 0 -> available
 *
 * Countdown
 *   waitMs   = activationAt - trustedNowMs
 *   waitDays = ceil(waitMs / 1 day)   -> never advertises availability early
 *
 * Effective opening time
 *   `effectiveOpenAt` (the value already displayed on the capsule page),
 *   NOT manifest.openAt: a successful confirmation may move the schedule.
 *
 * TIME SOURCE
 * The caller MUST supply trusted time (`trustedNowMs`), i.e. the instant
 * already obtained from the Time Authority (/api/time). This module never
 * reads the device clock - no Date.now(), no performance.now(), no local
 * fallback. When trusted time (or a usable interval) is missing, the rule
 * reports "unknown": the caller must keep the button visible, disabled, and
 * show `Checking availability…` - never enable on a guess.
 */

import { THIRTY_DAYS_MS } from "@/shared/heartbeat/resolveEffectiveOpenAt";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why the button cannot be used right now. */
export type ConfirmBlockReason =
  | "none"
  | "window"
  | "unknown";

export type ConfirmAvailability = {

  /** True when the button may be clickable (subject to existing guards). */
  available: boolean;

  /**
   * True when the button is blocked by the 30-day rule itself (a real
   * countdown exists). Mutually exclusive with `unknown`.
   */
  awaitingWindow: boolean;

  /**
   * True when the verdict cannot be computed (missing/invalid interval, or
   * no trusted time yet). The button must stay disabled and read
   * `Checking availability…`.
   */
  unknown: boolean;

  /** Convenience discriminator for the three states. */
  reason: ConfirmBlockReason;

  /** activationAt - trustedNowMs; > 0 while awaiting the window. */
  waitMs: number | null;

  /** Whole days until activation, rounded UP; >= 1 while awaiting. */
  waitDays: number | null;

  /** effectiveOpenAt - trustedNowMs, or null when it cannot be computed. */
  remainingMs: number | null;

};

export type ConfirmAvailabilityInput = {

  /**
   * manifest.heartbeatInterval - the ORIGINAL opening interval fixed at
   * sealing time. Not a confirmation cadence.
   */
  heartbeatInterval?: number | undefined;

  /**
   * Effective opening moment (UTC ms) - the value already displayed on the
   * capsule page (manifest.openAt adjusted by confirmations).
   */
  effectiveOpenAt?: number | undefined;

  /**
   * Trusted "now" (UTC ms) from the existing time authority. Never a
   * device-clock value; null/undefined means "not known yet".
   */
  trustedNowMs?: number | null | undefined;

};

function unknownAvailability(): ConfirmAvailability {
  return {
    available: false,
    awaitingWindow: false,
    unknown: true,
    reason: "unknown",
    waitMs: null,
    waitDays: null,
    remainingMs: null,
  };
}

function availableNow(remainingMs: number | null): ConfirmAvailability {
  return {
    available: true,
    awaitingWindow: false,
    unknown: false,
    reason: "none",
    waitMs: null,
    waitDays: null,
    remainingMs,
  };
}

export function resolveConfirmAvailability(
  input: ConfirmAvailabilityInput
): ConfirmAvailability {

  const interval =
    input.heartbeatInterval;

  /**
   * Unknown / malformed interval: fail closed. Every sealed manifest
   * carries a valid interval, so this is defensive - but R9-A54 no longer
   * treats missing data as permission to enable the button.
   */
  if (
    typeof interval !== "number" ||
    !Number.isSafeInteger(interval) ||
    interval < 0
  ) {
    return unknownAvailability();
  }

  /**
   * 30 days or less: the window is open for the whole interval, so the
   * button is available from the start and no trusted time is needed.
   */
  if (interval <= THIRTY_DAYS_MS) {
    return availableNow(null);
  }

  const effectiveOpenAt =
    input.effectiveOpenAt;

  const trustedNowMs =
    input.trustedNowMs ?? null;

  /**
   * Longer interval without an authoritative "now" or without an opening
   * moment: stay disabled and ask the UI to show "Checking availability…".
   * NEVER substitute the device clock here.
   */
  if (
    typeof effectiveOpenAt !== "number" ||
    !Number.isSafeInteger(effectiveOpenAt) ||
    typeof trustedNowMs !== "number" ||
    !Number.isSafeInteger(trustedNowMs)
  ) {
    return unknownAvailability();
  }

  const remainingMs =
    effectiveOpenAt - trustedNowMs;

  /**
   * Window opens THIRTY_DAYS_MS before the effective opening moment.
   * Strict `>` mirrors the server: at exactly 30 days the window is open.
   */
  const waitMs =
    remainingMs - THIRTY_DAYS_MS;

  if (waitMs > 0) {
    return {
      available: false,
      awaitingWindow: true,
      unknown: false,
      reason: "window",
      waitMs,
      // Round UP: never advertise availability earlier than it happens.
      waitDays: Math.ceil(waitMs / DAY_MS),
      remainingMs,
    };
  }

  return availableNow(remainingMs);
}
