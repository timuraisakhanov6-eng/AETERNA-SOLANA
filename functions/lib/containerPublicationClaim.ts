/**
 * AETERNA — Container publication claim (atomic)
 *
 * Canonical invariant:
 *   ONE capsule  -> MAXIMUM ONE container publication claim
 *   ONE txId     -> MAXIMUM ONE capsule
 *   ...both established ATOMICALLY.
 *
 * Atomicity model
 * ---------------
 * Cloudflare KV has NO compare-and-set. A KV `get` followed by a KV `put`
 * is two independent round-trips, so two concurrent conflicting container
 * claims can both observe "absent", both write, and both report success
 * while only one record survives. KV is therefore NOT used to decide a
 * container claim.
 *
 * The decision is moved into the EXISTING CreditOperationCoordinator
 * Durable Object — the project's authoritative serialized state-transition
 * mechanism, already used for credit reserve/finalize/recover, global
 * payment-tx uniqueness and credit grants. Durable Object storage is
 * strongly consistent and transactional, and one DO request runs to
 * completion before the next request to the same instance is delivered.
 *
 * Addressing — why ONE instance
 * -----------------------------
 * A per-creator instance (the credit ops' `idFromName(creatorCreditId)`)
 * is NOT sufficient here. The container claim has TWO conflict axes:
 *
 *   (1) one capsule -> one container      (per-capsule)
 *   (2) one txId    -> one capsule        (per-tx, cross-capsule)
 *
 * Two capsules owned by DIFFERENT creators reusing one txId would map to
 * different creator-scoped instances and would not be serialized at all.
 * A single dedicated instance is therefore the smallest canonical atomic
 * authority that covers both axes. The cost is that container claims are
 * serialized globally — acceptable, because a capsule publishes exactly
 * one container, exactly once.
 *
 * This is NOT a new distributed-lock abstraction: it is the existing
 * coordinator DO, addressed by name, exactly like the payment-tx
 * uniqueness instance.
 *
 * Failure model: if the coordinator binding is missing or the call fails,
 * the caller MUST fail closed. No caller may receive success unless the
 * authoritative state transition actually succeeded.
 */

/**
 * The dedicated coordination instance for container publication claims.
 * Bump the suffix only alongside a deliberate storage-schema change.
 */
export const CONTAINER_PUBLICATION_COORDINATOR_NAME =
  "aeterna:container-publication:v1";

export interface ContainerPublicationClaimInput {
  capsuleId: string;
  lifecycleId: string;
  creatorIdentityId: string;
  containerTxId: string;
  layoutDigest: string;
  chunkIds: readonly string[];
}

export interface ContainerPublicationClaimEnv {
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(input: Request): Promise<Response>;
    };
  };
}

export type ContainerPublicationClaimOutcome =
  | { ok: true; outcome: "CLAIMED" | "ALREADY_CLAIMED" }
  | {
      ok: false;
      reason:
        | "TX_ALREADY_CLAIMED"
        | "CONTAINER_ALREADY_PUBLISHED"
        | "UNAVAILABLE";
    };

/**
 * Atomically establish (or idempotently confirm) the authoritative
 * container publication claim.
 *
 * Returns:
 *   { ok: true, outcome: "CLAIMED" }          — no claim existed; established
 *   { ok: true, outcome: "ALREADY_CLAIMED" }  — byte-equal exact replay
 *   { ok: false, reason: "TX_ALREADY_CLAIMED" }        — txId spent on another capsule
 *   { ok: false, reason: "CONTAINER_ALREADY_PUBLISHED" } — capsule already has a container
 *   { ok: false, reason: "UNAVAILABLE" }      — coordination unavailable: fail closed
 */
export async function claimContainerPublication(
  env: ContainerPublicationClaimEnv,
  input: ContainerPublicationClaimInput
): Promise<ContainerPublicationClaimOutcome> {
  const coordinatorBinding = env.CREDIT_OP_COORDINATOR;
  if (!coordinatorBinding) {
    return { ok: false, reason: "UNAVAILABLE" };
  }

  try {
    const stub = coordinatorBinding.get(
      coordinatorBinding.idFromName(CONTAINER_PUBLICATION_COORDINATOR_NAME)
    );

    const response = await stub.fetch(
      new Request("https://aeterna-container-publication.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "container-publication-claim",
          capsuleId: input.capsuleId,
          lifecycleId: input.lifecycleId,
          creatorIdentityId: input.creatorIdentityId,
          containerTxId: input.containerTxId,
          layoutDigest: input.layoutDigest,
          chunkIds: [...input.chunkIds],
        }),
      })
    );

    const data = (await response.json().catch(() => null)) as
      | { ok?: unknown; outcome?: unknown; error?: unknown }
      | null;

    if (response.status === 200) {
      if (!data || data.ok !== true) {
        return { ok: false, reason: "UNAVAILABLE" };
      }
      if (data.outcome === "CONTAINER_PUBLICATION_CLAIMED") {
        return { ok: true, outcome: "CLAIMED" };
      }
      if (data.outcome === "CONTAINER_PUBLICATION_ALREADY_CLAIMED") {
        return { ok: true, outcome: "ALREADY_CLAIMED" };
      }
      return { ok: false, reason: "UNAVAILABLE" };
    }

    if (response.status === 409) {
      if (data?.error === "TX_ALREADY_CLAIMED") {
        return { ok: false, reason: "TX_ALREADY_CLAIMED" };
      }
      if (data?.error === "CONTAINER_ALREADY_PUBLISHED") {
        return { ok: false, reason: "CONTAINER_ALREADY_PUBLISHED" };
      }
      return { ok: false, reason: "UNAVAILABLE" };
    }

    return { ok: false, reason: "UNAVAILABLE" };
  } catch {
    return { ok: false, reason: "UNAVAILABLE" };
  }
}
