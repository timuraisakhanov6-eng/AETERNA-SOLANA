/**
 * AETERNA — Device detection helpers (UI layer only)
 *
 * Safe for:
 * - browser runtime
 * - SSR environments
 * - Cloudflare Workers
 * - test runners
 *
 * MUST NOT be used in:
 * - crypto logic
 * - storage logic
 * - sealing pipeline
 * - manifest generation
 */


/**
 * Detects whether device supports touch input
 *
 * Note:
 * touch ≠ mobile
 *
 * Examples:
 * MacBook Safari → true
 * Windows touchscreen laptop → true
 * iPhone → true
 * Desktop PC → false
 */

export function isTouchDevice(): boolean {

  if (typeof window === "undefined") {
    return false;
  }

  const hasTouchStart =
    "ontouchstart" in window;

  const hasTouchPoints =
    typeof navigator !== "undefined" &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 0;

  return (
    hasTouchStart ||
    hasTouchPoints
  );

}


/**
 * Detects whether device is mobile-class device
 *
 * Used for:
 * - adaptive UI layout
 * - chunk sizing decisions
 * - upload parallelism tuning
 */

export function isMobileDevice(): boolean {

  if (
    typeof navigator === "undefined" ||
    typeof navigator.userAgent !== "string"
  ) {
    return false;
  }

  return /Mobi|Android|iPhone|iPad/i.test(
    navigator.userAgent
  );

}