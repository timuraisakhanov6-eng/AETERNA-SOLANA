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

/**
 * Operation-level deadline for the discrete `GET /api/time`.
 *
 * Bounds ONE request only — not the capsule preparation or the page.
 * `/api/time` is a same-origin Function with no outbound network call,
 * so it settles in milliseconds; 8 s matches the project's canonical
 * bounded-HTTP constant. A genuinely non-settling request now rejects
 * into the existing `"[AETERNA] Trusted time unavailable"` /
 * `"Trusted time violation"` fail-closed path instead of hanging.
 */
const TIME_REQUEST_TIMEOUT_MS = 8_000;

export async function getTrustedTime(): Promise<{
  nowUtc: number;
}> {

  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(
      () => controller.abort(),
      TIME_REQUEST_TIMEOUT_MS
    );

  let res: Response;

  try {

    res =
      await fetch("/api/time", {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });

  } finally {

    clearTimeout(timeoutId);

  }

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