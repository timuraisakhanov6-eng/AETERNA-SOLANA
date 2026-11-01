/**
 * AETERNA - Confirm Presence availability + countdown (R9-A53/R9-A54).
 *
 * Pure-function suite for resolveConfirmAvailability(). No DOM, no network,
 * no storage, no clock: every input is explicit.
 *
 *   activationAt = effectiveOpenAt - 30 days
 *   waitMs       = activationAt - trustedNowMs
 *   waitDays     = ceil(waitMs / 1 day)   (never advertises early)
 *
 *   interval <= 30 days                 -> available, no countdown
 *   interval  > 30 days, waitMs > 0     -> disabled + waitDays
 *   interval  > 30 days, waitMs <= 0    -> available
 *   missing/invalid interval or trusted -> disabled, "unknown"
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveConfirmAvailability } from "./confirmAvailability";
import { THIRTY_DAYS_MS } from "@/shared/heartbeat/resolveEffectiveOpenAt";

const HERE = dirname(fileURLToPath(import.meta.url));

const MODULE_SRC = readFileSync(
  resolve(HERE, "confirmAvailability.ts"),
  "utf8"
);

/** Executable code only: comments legitimately NAME the forbidden APIs. */
const MODULE_CODE = MODULE_SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

const SERVER_SRC = readFileSync(
  resolve(HERE, "../../../functions/api/heartbeat.ts"),
  "utf8"
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function decide(
  intervalDays: number,
  remainingDays: number,
  nowMs: number = NOW
) {
  return resolveConfirmAvailability({
    heartbeatInterval: intervalDays * DAY_MS,
    effectiveOpenAt: NOW + remainingDays * DAY_MS,
    trustedNowMs: nowMs,
  });
}

describe("intervals of 30 days or less", () => {
  it.each([30, 7, 1])(
    "is immediately available with no countdown (%i-day interval)",
    (days) => {
      for (const remaining of [days, 18, 3, 0]) {
        const result = decide(days, remaining);
        expect(result.available).toBe(true);
        expect(result.awaitingWindow).toBe(false);
        expect(result.unknown).toBe(false);
        expect(result.waitDays).toBeNull();
      }
    }
  );

  it("does not need trusted time at all", () => {
    const result = resolveConfirmAvailability({
      heartbeatInterval: 30 * DAY_MS,
      effectiveOpenAt: NOW + 10 * DAY_MS,
      trustedNowMs: null,
    });

    expect(result.available).toBe(true);
    expect(result.waitDays).toBeNull();
  });
});

describe("countdown for intervals longer than 30 days", () => {
  it.each([
    [90, 60],
    [89, 59],
    [60, 30],
    [31, 1],
  ])(
    "effective opening in %i days -> Available in %i days",
    (remainingDays, expectedWait) => {
      const result = decide(90, remainingDays);

      expect(result.available).toBe(false);
      expect(result.awaitingWindow).toBe(true);
      expect(result.unknown).toBe(false);
      expect(result.waitMs).toBe(expectedWait * DAY_MS);
      expect(result.waitDays).toBe(expectedWait);
      expect(result.remainingMs).toBe(remainingDays * DAY_MS);
    }
  );

  it("is active at exactly 30 days remaining", () => {
    const result = decide(90, 30);
    expect(result.available).toBe(true);
    expect(result.awaitingWindow).toBe(false);
    // No countdown state at all once the window is open.
    expect(result.waitMs).toBeNull();
    expect(result.waitDays).toBeNull();
  });

  it.each([29, 15, 5, 1, 0])(
    "stays active inside the final window (%i days remaining)",
    (remaining) => {
      const result = decide(90, remaining);
      expect(result.available).toBe(true);
      expect(result.waitDays).toBeNull();
    }
  );
});

describe("rounding never enables the button early", () => {
  it("rounds a partial day up", () => {
    // 30 days + 1 ms remaining -> still one whole day of waiting.
    const result = resolveConfirmAvailability({
      heartbeatInterval: 90 * DAY_MS,
      effectiveOpenAt: NOW + THIRTY_DAYS_MS + 1,
      trustedNowMs: NOW,
    });

    expect(result.available).toBe(false);
    expect(result.waitDays).toBe(1);
    expect(result.waitMs).toBe(1);
  });

  it("rounds 59 days and 12 hours up to 60", () => {
    const result = resolveConfirmAvailability({
      heartbeatInterval: 90 * DAY_MS,
      effectiveOpenAt: NOW + 89 * DAY_MS + 12 * 60 * 60 * 1000,
      trustedNowMs: NOW,
    });

    expect(result.available).toBe(false);
    expect(result.waitDays).toBe(60);
  });

  it("never reports zero days while the window is still closed", () => {
    for (const extraMs of [1, 1_000, 60_000, DAY_MS - 1]) {
      const result = resolveConfirmAvailability({
        heartbeatInterval: 90 * DAY_MS,
        effectiveOpenAt: NOW + THIRTY_DAYS_MS + extraMs,
        trustedNowMs: NOW,
      });

      expect(result.available).toBe(false);
      expect(result.waitDays).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("the countdown follows the effective opening moment", () => {
  it("uses effectiveOpenAt, so a confirmation that moves it changes the label", () => {
    // 90-day interval sealed with 90 days to go: 60 days of waiting.
    expect(decide(90, 90).waitDays).toBe(60);

    // A successful confirmation moves the effective opening moment later;
    // the same rule then reports the new wait without any extra state.
    expect(decide(90, 120).waitDays).toBe(90);
    expect(decide(90, 75).waitDays).toBe(45);
  });
});

describe("unknown or missing trusted time fails closed", () => {
  it.each([null, undefined])(
    "is unavailable and unknown when trusted time is %s",
    (trustedNowMs) => {
      const result = resolveConfirmAvailability({
        heartbeatInterval: 90 * DAY_MS,
        effectiveOpenAt: NOW + 90 * DAY_MS,
        trustedNowMs,
      });

      expect(result.available).toBe(false);
      expect(result.unknown).toBe(true);
      expect(result.awaitingWindow).toBe(false);
      expect(result.waitDays).toBeNull();
      expect(result.reason).toBe("unknown");
    }
  );

  it("is unknown when the interval is missing or malformed", () => {
    for (const interval of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 90.5, -1]) {
      const result = resolveConfirmAvailability({
        heartbeatInterval: interval,
        effectiveOpenAt: NOW + 90 * DAY_MS,
        trustedNowMs: NOW,
      });

      expect(result.available).toBe(false);
      expect(result.unknown).toBe(true);
    }
  });

  it("is unknown when the effective opening moment is missing", () => {
    const result = resolveConfirmAvailability({
      heartbeatInterval: 90 * DAY_MS,
      trustedNowMs: NOW,
    });

    expect(result.available).toBe(false);
    expect(result.unknown).toBe(true);
  });
});

describe("no clock, no I/O, no duplicated constants", () => {
  it("never reads a clock or performs I/O", () => {
    expect(MODULE_CODE).not.toContain("Date.now");
    expect(MODULE_CODE).not.toContain("performance.now");
    expect(MODULE_CODE).not.toContain("new Date");
    expect(MODULE_CODE).not.toContain("fetch(");
    expect(MODULE_CODE).not.toContain("localStorage");
  });

  it("reuses the canonical 30-day constant instead of redefining it", () => {
    expect(MODULE_SRC).toContain(
      'import { THIRTY_DAYS_MS } from "@/shared/heartbeat/resolveEffectiveOpenAt";'
    );
    expect(MODULE_CODE).not.toContain("2592000000");
  });

  it("still mirrors the server's strict window comparison", () => {
    expect(SERVER_SRC).toContain(
      "(manifest.heartbeatInterval as number) > THIRTY_DAYS_MS"
    );
    expect(SERVER_SRC).toContain(
      "(effectiveOpenAt - nowUtc) > THIRTY_DAYS_MS"
    );
    expect(SERVER_SRC).toContain("CONFIRMATION_WINDOW_NOT_YET_AVAILABLE");
  });
});
