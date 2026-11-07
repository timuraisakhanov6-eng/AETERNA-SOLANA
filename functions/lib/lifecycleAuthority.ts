/**
 * R9-A92.3 — shared READ-ONLY lifecycle authority resolution.
 *
 * WHY THIS EXISTS
 * ---------------
 * The lifecycle KV projection (`creator:credit:lifecycle:<identity>:<lifecycle>`)
 * is written by the CreditOperationCoordinator and is eventually consistent:
 * a read can legitimately miss it for a short window immediately after the
 * reservation. The publication claim already resolves that window through
 * the coordinator's authoritative `op:"read"`; the later mandatory stages
 * (publication verify, seal, seal verify, finalize) did not, so a stale
 * window could pass the claim and then fail later.
 *
 * This module holds the ONE implementation of that read-only fallback.
 * It does not decide any stage's permission: it returns the authoritative
 * credit record and the caller applies its own stage-specific rules.
 *
 * SAFETY
 * ------
 * • `creatorCreditId` is an ADDRESS only. It selects which coordinator
 *   instance is read; it never authorizes anything by itself.
 * • Every compared value comes from the server-persisted DO record.
 * • Identity is compared BEFORE the capsule/lifecycle bindings, so a
 *   foreign credit cannot disclose its state.
 * • The read creates, reserves, repairs and mutates NOTHING.
 * • Missing binding, transport error, non-2xx, malformed body, `ok:false`,
 *   `NOT_FOUND` and every mismatch all fail closed.
 * • No KV write is performed, so this cannot reintroduce the stale
 *   projection race removed in R9-A92.1.
 */

export interface LifecycleCoordinatorBinding {
  idFromName(name: string): { id: string };
  get(binding: { id: string }): {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  };
}

export interface LifecycleAuthorityEnv {
  CREDIT_OP_COORDINATOR?: LifecycleCoordinatorBinding | undefined;
}

export interface AuthoritativeLifecycleCredit {
  id: string;
  status: string;
  creatorIdentityId: string;
  capsuleId: string;
}

export type LifecycleAuthorityFailure =
  /** Coordinator binding missing, unreachable, non-2xx, or unparseable. */
  | "UNAVAILABLE"
  /** The coordinator answered but holds no record for the addressed id. */
  | "NOT_FOUND"
  /** The record exists but does not belong to this creator identity. */
  | "IDENTITY_MISMATCH"
  /** The record exists but is bound to another capsule. */
  | "CAPSULE_MISMATCH"
  /** The record exists but is bound to another lifecycle (or none). */
  | "LIFECYCLE_MISMATCH";

export interface LifecycleAuthorityInput {
  creatorCreditId: string;
  creatorIdentityId: string;
  lifecycleId: string;
  capsuleId: string;
}

export type LifecycleAuthorityResult =
  | { ok: true; credit: AuthoritativeLifecycleCredit }
  | { ok: false; reason: LifecycleAuthorityFailure };

export async function readAuthoritativeLifecycle(
  env: LifecycleAuthorityEnv,
  input: LifecycleAuthorityInput
): Promise<LifecycleAuthorityResult> {
  const binding = env.CREDIT_OP_COORDINATOR;

  if (
    !binding ||
    typeof binding.idFromName !== "function" ||
    typeof binding.get !== "function"
  ) {
    return { ok: false, reason: "UNAVAILABLE" };
  }

  let response: Response;
  try {
    const stub = binding.get(binding.idFromName(input.creatorCreditId));
    response = await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "read",
          creatorCreditId: input.creatorCreditId,
        }),
      })
    );
  } catch {
    return { ok: false, reason: "UNAVAILABLE" };
  }

  if (!response.ok) {
    return { ok: false, reason: "UNAVAILABLE" };
  }

  let data: {
    ok?: unknown;
    outcome?: unknown;
    status?: unknown;
    creatorCreditId?: unknown;
    creatorIdentityId?: unknown;
    capsuleId?: unknown;
    lifecycleId?: unknown;
  } | null = null;

  try {
    data = (await response.json()) as typeof data;
  } catch {
    data = null;
  }

  // An unverifiable answer is never a success.
  if (!data || data.ok !== true || data.outcome !== "FOUND") {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const canonicalIdentity =
    typeof data.creatorIdentityId === "string" ? data.creatorIdentityId : "";
  const canonicalCapsuleId =
    typeof data.capsuleId === "string" ? data.capsuleId : "";
  const canonicalCreditId =
    typeof data.creatorCreditId === "string" && data.creatorCreditId.length > 0
      ? data.creatorCreditId
      : input.creatorCreditId;
  const canonicalStatus =
    typeof data.status === "string" ? data.status : "";

  /**
   * IDENTITY FIRST. A caller may address any credit id, so a foreign record
   * must collapse into IDENTITY_MISMATCH regardless of its state.
   */
  if (canonicalIdentity !== input.creatorIdentityId) {
    return { ok: false, reason: "IDENTITY_MISMATCH" };
  }

  if (canonicalCapsuleId !== input.capsuleId) {
    return { ok: false, reason: "CAPSULE_MISMATCH" };
  }

  if (data.lifecycleId !== input.lifecycleId) {
    return { ok: false, reason: "LIFECYCLE_MISMATCH" };
  }

  return {
    ok: true,
    credit: {
      id: canonicalCreditId,
      status: canonicalStatus,
      creatorIdentityId: canonicalIdentity,
      capsuleId: canonicalCapsuleId,
    },
  };
}
