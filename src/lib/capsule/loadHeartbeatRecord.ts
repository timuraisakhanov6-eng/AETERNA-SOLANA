/**
 * AETERNA Heartbeat Loader (v1.3)
 *
 * Loads creator presence confirmation timestamp.
 *
 * Protocol rules:
 * - fragment secret NEVER transmitted
 * - manifest NEVER modified
 * - fail-closed fallback enforced
 * - trusted time enforced server-side
 */

import {
  CAPSULE_ID_REGEX
} from "@/lib/crypto/validators";


export interface HeartbeatRecord {

  capsuleId: string;

  /**
   * Last trusted confirmation timestamp (UTC ms)
   *
   * null = no confirmations exist
   */
  lastConfirmedAt: number | null;

}


/**
 * Loads heartbeat confirmation record.
 *
 * Fail-safe behaviour:
 * returns null if unavailable
 *
 * Caller must fallback to:
 *
 * manifest.openAt
 */
export async function loadHeartbeatRecord(
  capsuleId: string
): Promise<HeartbeatRecord | null> {

  /**
   * capsuleId invariant guard (HEX64)
   */

  if (!CAPSULE_ID_REGEX.test(capsuleId)) {

    return null;

  }

  try {

    const res = await fetch(
      `/api/heartbeat?capsuleId=${encodeURIComponent(capsuleId)}`
    );

    if (!res.ok) {

      return null;

    }

    const data: unknown =
      await res.json();

    /**
     * JSON shape guard
     */

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {

      return null;

    }

    const record =
      data as {
        readonly lastConfirmedAt?: unknown;
      };

    /**
     * timestamp invariant guard
     */

    if (
      record.lastConfirmedAt !== null &&
      record.lastConfirmedAt !== undefined &&
      (
        typeof record.lastConfirmedAt !== "number" ||
        !Number.isFinite(record.lastConfirmedAt) ||
        !Number.isInteger(record.lastConfirmedAt) ||
        record.lastConfirmedAt <= 0
      )
    ) {

      return null;

    }

    return {

      capsuleId,

      lastConfirmedAt:
        typeof record.lastConfirmedAt === "number"
          ? record.lastConfirmedAt
          : null

    };

  } catch {

    /**
     * KV unavailable
     * endpoint unreachable
     * network failure
     *
     * protocol requires fail-closed fallback
     */

    return null;

  }

}