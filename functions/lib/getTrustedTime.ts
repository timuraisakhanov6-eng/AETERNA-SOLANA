/**
 * AETERNA — Server Trusted Time
 *
 * Canonical server-side time authority.
 *
 * Used by:
 * - create-checkout
 * - upload-token
 * - verify
 * - heartbeat
 * - seal
 *
 * Server already executes inside the authority boundary,
 * therefore it never fetches /api/time.
 */

const MIN_TIME = 1577836800000; // 2020-01-01
const MAX_TIME = 4102444800000; // 2100-01-01

export async function getTrustedTime(): Promise<{
  nowUtc: number;
}> {

  const now = Date.now();

  if (
    !Number.isSafeInteger(now) ||
    now < MIN_TIME ||
    now > MAX_TIME
  ) {
    throw new Error(
      "[AETERNA] Trusted server time violation"
    );
  }

  return {
    nowUtc: now,
  };

}