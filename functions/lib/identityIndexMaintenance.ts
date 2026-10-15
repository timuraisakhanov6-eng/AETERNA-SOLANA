/**
 * AETERNA — identity coordinator index maintenance.
 *
 * Called by the credit endpoints AFTER their authoritative per-credit
 * Durable Object operation succeeded, so the identity-scoped index
 * (the purchase guard's source of truth) follows every transition:
 *
 *   reserve  -> note-reserve  (CONSUMING + lifecycleId)
 *   finalize -> note-finalize (CONSUMED)
 *   recover  -> note-recover  (AVAILABLE again)
 *
 * A failed note NEVER fails the authoritative operation: the per-credit
 * coordinator already accepted the transition, and the index is
 * conservative in the safe direction (it can only overstate liveness,
 * which blocks a purchase rather than allowing one). The identity
 * coordinator's read-through refresh repairs any missed note on the
 * next decision, and a never-repaired stale entry is still safe — it
 * can only make the purchase guard stricter, never weaker.
 */

interface IdentityCoordinatorBinding {
  idFromName(name: string): { id: string };
  get(binding: { id: string }): {
    fetch(request: Request): Promise<Response>;
  };
}

export interface IdentityIndexMaintenanceEnv {
  CREDIT_OP_COORDINATOR?: IdentityCoordinatorBinding;
}

export type IdentityTransitionKind = "reserve" | "finalize" | "recover";

export async function noteIdentityTransition(
  env: IdentityIndexMaintenanceEnv,
  kind: IdentityTransitionKind,
  input: {
    creatorIdentityId: string;
    creatorCreditId: string;
    lifecycleId?: string;
    capsuleId?: string;
  }
): Promise<void> {
  const binding = env.CREDIT_OP_COORDINATOR;
  if (!binding) return;

  const op =
    kind === "reserve"
      ? "identity-note-reserve"
      : kind === "finalize"
      ? "identity-note-finalize"
      : "identity-note-recover";

  try {
    const stub = binding.get(
      binding.idFromName(`identity:${input.creatorIdentityId}`)
    );
    await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, ...input }),
      })
    );
  } catch (err) {
    // Best-effort by design: the authoritative transition already
    // happened; a missing note only ever makes the guard stricter.
    console.error(`[identity-index] ${op} note failed`, err);
  }
}
