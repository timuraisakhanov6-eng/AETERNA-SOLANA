import type { ManifestV1 } from "@/types/manifest";

/**
 * AETERNA - Creator Presence presentation predicate (R9-A51).
 *
 * Answers ONE presentation question: "should the Creator Presence
 * explanation / recipient notice be visible for this capsule?"
 *
 * Ground truth (no new protocol rule is introduced here):
 *
 *  - Heartbeat (user-facing: Creator Presence) is a canonical capability.
 *    Complete System Logic v4.3 removed the per-capsule opt-in: there is
 *    no `heartbeatEnabled` flag anywhere, and `heartbeatInterval` is a
 *    REQUIRED manifest field (`assertHeartbeatConsistency`, and the seal
 *    endpoint rejects a manifest without it).
 *
 *  - `heartbeatInterval` is the ORIGINALLY SELECTED opening interval
 *    (openAt - sealedAt at seal time), fixed at sealing. Its presence is
 *    therefore exactly "this capsule's opening date can move under the
 *    Creator Presence renewal rules".
 *
 * Read-only and side-effect free: this module performs no lifecycle,
 * timing, storage, wallet, payment or network work, and MUST NOT be used
 * to decide whether a capsule may open. `resolveEffectiveOpenAt` remains
 * the sole owner of that decision.
 */
export function isCreatorPresenceActive(
  manifest: Pick<ManifestV1, "heartbeatInterval"> | null | undefined
): boolean {

  if (!manifest) {
    return false;
  }

  const interval =
    manifest.heartbeatInterval;

  /**
   * Same numeric contract the resolver enforces: a finite, integral,
   * positive UTC-ms duration. Anything else is not a usable interval, and
   * the copy that explains date movement must not be shown for it.
   */
  return (
    Number.isFinite(interval) &&
    Number.isSafeInteger(interval) &&
    interval > 0
  );

}
