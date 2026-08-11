/**
 * AETERNA Trusted Time — canonical helper
 *
 * Temporal Authority Layer v1.3
 *
 * Source of truth:
 * /api/time endpoint
 *
 * ❗ PROTOCOL AUTHORITY ONLY
 * ❗ MUST be used for:
 * - unlock evaluation
 * - heartbeat validation
 * - open condition
 *
 * ❗ MUST NOT fallback to client time
 */

const MIN_TIME =
  1577836800000; // 2020-01-01

const MAX_TIME =
  4102444800000; // 2100-01-01

export async function getTrustedTime(): Promise<{
  nowUtc: number;
}> {

  const res =
    await fetch("/api/time", {
      method: "GET",
      cache: "no-store"
    });

  if (!res.ok) {
    throw new Error(
      "[AETERNA] Trusted time unavailable"
    );
  }

  const data =
    await res.json().catch(() => null);

  const now =
    data?.nowUtc;

  if (

    typeof now !== "number" ||

    !Number.isFinite(now) ||

    !Number.isSafeInteger(now) ||

    now < MIN_TIME ||

    now > MAX_TIME

  ) {

    throw new Error(
      "[AETERNA] Trusted time violation"
    );

  }

  return {
    nowUtc: now
  };

}