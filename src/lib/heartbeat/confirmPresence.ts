/**
 * =========================================================
 * AETERNA Heartbeat Presence Confirmation (v1.3)
 * =========================================================
 *
 * Confirms creator presence using delegated capability:
 *
 * creatorAuthorityFragment (HEX64)
 *
 * Canonical rules enforced:
 *
 * - fragment must be HEX64
 * - capsuleId must be HEX64
 * - trusted time boundary required
 * - confirmation forbidden after effectiveOpenAt
 * - rolling confirmation window respected
 */

import { sendHeartbeat } from "@/lib/capsule/sendHeartbeat";

import {
  resolveEffectiveOpenAt,
  THIRTY_DAYS_MS
} from "@/shared/heartbeat/resolveEffectiveOpenAt";

import { getTrustedTime } from "@/shared/time/getTrustedTime";

import type {
  OpenAtUtc
} from "@/types/manifest";

import {
  CAPSULE_ID_REGEX,
  SHA256_REGEX
} from "@/lib/crypto/validators";


/**
 * Trusted Time canonical bounds
 * must match getTrustedTime.ts
 */

const MIN_TIME =
  1577836800000;

const MAX_TIME =
  4102444800000;


export type ConfirmPresenceParams = {

  capsuleId: string;

  creatorAuthorityFragment: string;

  manifestOpenAt: OpenAtUtc;

  heartbeatInterval?: number | undefined;

  lastConfirmedAt?: number | undefined;

  /**
   * Optional trusted time injection.
   *
   * When provided, avoids duplicate trusted-time requests.
   * Otherwise resolved internally.
   */
  trustedNow?: number | undefined;

};


export type ConfirmPresenceResult =
  | "confirmed"
  | "expired"
  | "rejected"
  | "network-error";


export async function confirmPresence({

  capsuleId,

  creatorAuthorityFragment,

  manifestOpenAt,

  heartbeatInterval = 0,

  lastConfirmedAt,

  trustedNow,

}: ConfirmPresenceParams): Promise<ConfirmPresenceResult> {


  /**
   * capsuleId invariant guard (HEX64)
   */

  if (
    !CAPSULE_ID_REGEX.test(
      capsuleId
    )
  ) {

    return "rejected";

  }


  /**
   * creatorAuthorityFragment invariant guard (HEX64)
   */

  if (
    !creatorAuthorityFragment ||
    !SHA256_REGEX.test(
      creatorAuthorityFragment
    )
  ) {

    return "rejected";

  }


  /**
   * manifestOpenAt invariant guard
   * Trusted Time Authority Layer bounds
   */

  if (
    !Number.isFinite(
      manifestOpenAt
    ) ||

    !Number.isSafeInteger(
      manifestOpenAt
    ) ||

    manifestOpenAt < MIN_TIME ||

    manifestOpenAt > MAX_TIME
  ) {

    return "rejected";

  }


  /**
   * heartbeat interval invariant guard
   */

  if (
    !Number.isFinite(heartbeatInterval) ||
    heartbeatInterval < 0
  ) {

    return "rejected";

  }


  /**
   * lastConfirmedAt invariant guard
   */

  if (
    lastConfirmedAt !== undefined &&
    !Number.isFinite(
      lastConfirmedAt
    )
  ) {

    return "rejected";

  }


  try {

    /**
     * trusted-time boundary
     *
     * caller may inject trustedNow
     * otherwise resolve internally
     */

    const nowUtc =

      typeof trustedNow === "number" &&
      Number.isFinite(trustedNow) &&
      Number.isSafeInteger(trustedNow) &&
      trustedNow >= MIN_TIME &&
      trustedNow <= MAX_TIME

        ? trustedNow

        : (await getTrustedTime()).nowUtc;


    /**
     * resolve rolling confirmation window boundary
     * (prior to this confirmation)
     */

    const effectiveOpenAt =
      resolveEffectiveOpenAt({

        manifestOpenAt,

        heartbeatInterval,

        lastConfirmedAt,

      });


    /**
     * post-open confirmation forbidden
     */

    if (
      nowUtc >= effectiveOpenAt
    ) {

      return "expired";

    }


    /**
     * Heartbeat Window gating (Complete System Logic,
     * "Heartbeat Window"):
     *
     * If the originally selected opening interval (heartbeatInterval)
     * exceeds 30 days, confirmations remain unavailable until the
     * remaining time until the effective opening moment reaches 30
     * days. Before that moment the creator may view Heartbeat status
     * but cannot submit confirmations.
     */

    if (
      heartbeatInterval > THIRTY_DAYS_MS &&
      (effectiveOpenAt - nowUtc) > THIRTY_DAYS_MS
    ) {

      return "rejected";

    }


    /**
     * send heartbeat confirmation
     *
     * sendHeartbeat returns ConfirmPresenceResult directly.
     * Any non-"confirmed" result propagates as-is — no
     * re-mapping, no collapse. "expired" remains "expired",
     * "network-error" remains "network-error", "rejected"
     * remains "rejected".
     */

    const result =
      await sendHeartbeat(
        capsuleId,
        creatorAuthorityFragment
      );


    if (result !== "confirmed") {

      return result;

    }


    return "confirmed";

  }

  catch (err) {

    console.error(
      "[AETERNA] confirmPresence failed:",
      err
    );

    return "network-error";

  }

}