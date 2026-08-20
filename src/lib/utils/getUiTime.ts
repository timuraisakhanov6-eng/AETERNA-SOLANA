/**
 * AETERNA — UI TIME (NON-AUTHORITY)
 *
 * ⚠️ NOT trusted time
 * ⚠️ MUST NEVER be used for protocol decisions
 *
 * Safe only for:
 * - UI countdown
 * - animations
 * - optimistic rendering
 */

const MIN_TIME =
  1577836800000; // 2020-01-01

const MAX_TIME =
  4102444800000; // 2100-01-01

/**
 * isolate-local monotonic guard
 */

let lastNow: number | null = null;

export async function getUiTime(): Promise<{
  nowUtc: number;
}> {

  /**
   * 🚨 Hard guard — UI only
   * Prevent accidental usage in protocol context
   */
  if (typeof (globalThis as Record<string, unknown>).__AETERNA_PROTOCOL_TIME__ !== "undefined") {
    throw new Error("[AETERNA] UI time used in protocol context");
  }

  /**
   * runtime guard
   */
  if (typeof Date.now !== "function") {
    throw new Error("[AETERNA] UI time failure");
  }

  let now = Date.now();

  if (typeof now !== "number") {
    throw new Error("[AETERNA] UI time failure");
  }

  /**
   * monotonic guard
   */

  if (lastNow !== null) {
    now = Math.max(now, lastNow);
  }

  lastNow = now;

  /**
   * canonical numeric guards
   */

  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(now) ||
    now < MIN_TIME ||
    now > MAX_TIME
  ) {
    throw new Error("[AETERNA] UI time failure");
  }

  return {
    nowUtc: now
  };

}