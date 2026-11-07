/**
 * R9-A92.1 — local Runtime cleanup for an AUTHORITATIVELY abandoned attempt.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * R9-A92 F2 preserves the prepared encrypted Vault across incomplete seal
 * exits so a legitimate continuation can reuse it. That is correct, but it
 * means an attempt the creator explicitly ABANDONS would otherwise keep its
 * ciphertext in IndexedDB forever: the session registry is in-memory, so
 * after a reload `destroyRuntime` is a no-op and nothing else ever clears
 * the persisted records.
 *
 * THE ONLY SAFE TRIGGER
 * ---------------------
 * `ABORT_AND_RESTORE_AVAILABLE` (kind `"restored"`) is the Durable
 * Object's authoritative decision that this attempt never reached
 * publication and its creation right was released. At that exact
 * transition the prepared payload is dead: the lifecycle is gone, so no
 * resume/claim can ever use it again.
 *
 * Every other outcome is deliberately excluded:
 *   - "resolved"  — already consumed/published; the Runtime is not ours to
 *                   destroy on a stale hint (finalization owns cleanup).
 *   - "blocked"   — publication exists; the attempt may still be resumed.
 *   - "unauthorized" / "unknown" — nothing was decided; the attempt is
 *                   still live and must keep its payload for retry.
 *   - "resume-unavailable" — the attempt stays resumable.
 *
 * Local deletion is BEST EFFORT. A browser that refuses the deletion must
 * never turn an already-successful server-side restore into a failure or
 * a misleading error.
 */

import { discardRuntime } from "@/lib/runtime/runtimeRegistry";

import type { RecoveryOutcomeKind } from "@/lib/access/unfinishedLifecycle";

/**
 * Clears the persisted Runtime of `capsuleId` ONLY when the recovery
 * outcome is the authoritative abandonment (`"restored"`).
 *
 * @param kind      The recovery outcome kind actually returned by the
 *                  server decision (`describeRecoveryResponse`).
 * @param capsuleId The capsule id from the SAME verified unfinished-
 *                  lifecycle record that produced the request — never a
 *                  value derived from UI state or a different attempt.
 */
export async function discardAbandonedRuntime(
  kind: RecoveryOutcomeKind,
  capsuleId: string
): Promise<void> {
  if (kind !== "restored") {
    return;
  }

  try {
    await discardRuntime(capsuleId);
  } catch {
    /**
     * Best effort by contract: the server already restored the right.
     * A local deletion failure is not surfaced and cannot undo it.
     */
  }
}
