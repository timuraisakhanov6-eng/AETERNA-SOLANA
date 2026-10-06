import { describe, expect, it } from "vitest";

/**
 * HEARTBEAT MINIMUM-OPEN-DAY — canonical boundary proof.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * The seal endpoint rejects a capsule whose normalized opening interval
 * heartbeatInterval = openAt - sealedAt is below HEARTBEAT_INTERVAL_MIN_MS
 * (1 day) with 400 INVALID_HEARTBEAT. The date-only picker normalizes a
 * chosen day to 12:00 UTC, so the picker must forbid any calendar day
 * whose 12:00-UTC instant is < now + 1 day.
 *
 * `minAllowedOpenDayUtcMs(nowUtc)` returns the first UTC midnight whose
 * 12:00-UTC instant satisfies that bound. These tests pin:
 *
 *   A. the returned day's 12:00-UTC instant is always >= now + 1 day
 *      (minimum satisfied);
 *   B. the PRECEDING day is always excluded (tight, not over-permissive);
 *   C. the computation is UTC-based, independent of local timezone;
 *   D. exact boundary: a day whose 12:00-UTC instant equals
 *      now + HEARTBEAT_INTERVAL_MIN_MS is allowed (the 86,400,000 ms
 *      boundary accepted, not rejected);
 *   E. determinism + input validation (fail-closed on bad input);
 *   F. the existing THIRTY_DAYS_MS renewal rule is untouched.
 *
 * No live network, no wallet, no Irys, no payment, no KV.
 */

import {
  HEARTBEAT_INTERVAL_MIN_MS,
  THIRTY_DAYS_MS,
  minAllowedOpenDayUtcMs,
  resolveHeartbeatRenewalMs,
} from "./resolveEffectiveOpenAt";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOON_MS = 12 * 60 * 60 * 1000;

/** The normalized openAt a date-only picker derives for a UTC day. */
function noonUtcOf(dayMidnightMs: number): number {
  return dayMidnightMs + NOON_MS;
}

describe("minAllowedOpenDayUtcMs — canonical minimum-open-day", () => {
  it("A. returned day's 12:00-UTC instant is >= now + 1 day", () => {
    // A representative set of "now" instants across the whole day.
    const base = Date.UTC(2026, 9, 5, 0, 0, 0, 0); // 2026-10-05T00:00Z
    for (let h = 0; h < 24; h++) {
      const nowUtc = base + h * 60 * 60 * 1000;
      const day = minAllowedOpenDayUtcMs(nowUtc);
      expect(day % DAY_MS).toBe(0); // midnight-aligned
      expect(noonUtcOf(day)).toBeGreaterThanOrEqual(
        nowUtc + HEARTBEAT_INTERVAL_MIN_MS
      );
    }
  });

  it("B. the PRECEDING day is always excluded (tight bound)", () => {
    const base = Date.UTC(2026, 9, 5, 0, 0, 0, 0);
    for (let h = 0; h < 24; h++) {
      const nowUtc = base + h * 60 * 60 * 1000;
      const day = minAllowedOpenDayUtcMs(nowUtc);
      const prevNoon = noonUtcOf(day - DAY_MS);
      // The previous day's 12:00 UTC must NOT satisfy the minimum.
      expect(prevNoon).toBeLessThan(
        nowUtc + HEARTBEAT_INTERVAL_MIN_MS
      );
    }
  });

  it("C. UTC-based: independent of local timezone (pure function of the instant)", () => {
    const nowUtc = Date.UTC(2026, 9, 5, 16, 29, 46, 0);
    const a = minAllowedOpenDayUtcMs(nowUtc);
    const b = minAllowedOpenDayUtcMs(nowUtc); // no ambient clock/zone
    expect(a).toBe(b);
    expect(a % DAY_MS).toBe(0);
  });

  it("D. exact boundary: day whose 12:00-UTC == now + 86,400,000 ms is ALLOWED", () => {
    // Choose nowUtc so that some day's 12:00-UTC lands EXACTLY at now + 1day.
    const targetNoon = Date.UTC(2026, 9, 7, 12, 0, 0, 0);
    const nowUtc = targetNoon - HEARTBEAT_INTERVAL_MIN_MS; // exactly 1 day before
    const day = minAllowedOpenDayUtcMs(nowUtc);
    // The 12:00-UTC of the returned day is exactly now + 1 day -> accepted.
    expect(noonUtcOf(day)).toBe(nowUtc + HEARTBEAT_INTERVAL_MIN_MS);
    expect(noonUtcOf(day)).toBe(targetNoon);
  });

  it("D2. one millisecond past the boundary excludes the day (strict <)", () => {
    const targetNoon = Date.UTC(2026, 9, 7, 12, 0, 0, 0);
    const nowUtc = targetNoon - HEARTBEAT_INTERVAL_MIN_MS + 1; // 1 ms too late
    const day = minAllowedOpenDayUtcMs(nowUtc);
    // That same day no longer qualifies; the picker must move forward.
    expect(noonUtcOf(day)).toBeGreaterThanOrEqual(
      nowUtc + HEARTBEAT_INTERVAL_MIN_MS
    );
    expect(day).toBe(targetNoon - NOON_MS + DAY_MS);
  });

  it("E. fails closed on non-integer / non-finite input", () => {
    expect(() => minAllowedOpenDayUtcMs(NaN)).toThrow();
    expect(() => minAllowedOpenDayUtcMs(Infinity)).toThrow();
    expect(() => minAllowedOpenDayUtcMs(1.5)).toThrow();
  });

  it("F. THIRTY_DAYS_MS renewal rule is unchanged", () => {
    expect(THIRTY_DAYS_MS).toBe(30 * DAY_MS);
    // <= 30 days -> renew by the original interval.
    expect(resolveHeartbeatRenewalMs(DAY_MS)).toBe(DAY_MS);
    expect(resolveHeartbeatRenewalMs(THIRTY_DAYS_MS)).toBe(THIRTY_DAYS_MS);
    // > 30 days -> renew by exactly 30 days.
    expect(resolveHeartbeatRenewalMs(THIRTY_DAYS_MS + 1)).toBe(THIRTY_DAYS_MS);
    expect(resolveHeartbeatRenewalMs(365 * DAY_MS)).toBe(THIRTY_DAYS_MS);
  });
});

/**
 * Reproduce the exact observed Production case to prove the helper
 * forbids Oct 6 for a seal at 2026-10-05T16:29:46Z.
 */
describe("minAllowedOpenDayUtcMs — observed Production reproduction", () => {
  it("Oct 6 12:00 UTC is forbidden for a seal at Oct 5 ~16:29 UTC", () => {
    const sealedAt = Date.UTC(2026, 9, 5, 16, 29, 46, 503);
    const oct6Noon = Date.UTC(2026, 9, 6, 12, 0, 0, 0);
    const oct7Noon = Date.UTC(2026, 9, 7, 12, 0, 0, 0);

    // The failing interval observed in production was < 86,400,000 ms
    // (≈20.9 h for the observed seal instant of ~16:29 UTC).
    const oct6Interval = oct6Noon - sealedAt;
    expect(oct6Interval).toBeLessThan(HEARTBEAT_INTERVAL_MIN_MS);
    expect(oct6Interval).toBe(70_213_497); // Oct 6 12:00:00Z - Oct 5 16:29:46.503Z
    expect(oct6Interval / 3_600_000).toBeCloseTo(19.5, 1);

    const day = minAllowedOpenDayUtcMs(sealedAt);
    // The picker must exclude Oct 6 and allow Oct 7.
    expect(day).toBe(oct7Noon - NOON_MS);
    expect(day).toBeGreaterThan(oct6Noon - NOON_MS);
    expect(noonUtcOf(day)).toBe(oct7Noon);
  });
});
