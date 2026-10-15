/**
 * AETERNA — Credit Operation Coordinator (Durable Object)
 *
 * Authoritative distributed serialization boundary for all mutations
 * on one Creator Credit: reserve, finalize, recover.
 *
 * Invariant:
 *   ONE creatorCreditId
 *   -> ONE CreditOperationCoordinator
 *   -> serialized reserve/finalize/recover operations
 *
 * Failure model:
 * - Durable Object storage survives worker crashes/restarts.
 * - A lost request retry reads authoritative state.
 * - Two concurrent requests for the same credit are serialized
 *   by the Durable Object single-threaded execution model.
 */

interface CreditRecord {
  id: string;
  creatorIdentityId: string;
  status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
  capsuleId: string;
  lifecycleId: string | null;
  /**
   * Canonical quote/payment binding identifier (Finalization/Publication/
   * Seal/Recovery Runtime Interface Spec §5.1: the Credit Record carries
   * "quote/payment binding identifiers").
   *
   * Server-derived only: set by handleReserve from the persisted credit
   * record's quote binding. It is the link that lets the downstream upload
   * token (and therefore /api/capsule/seal) resolve the SAME
   * server-persisted VerifiedPayment evidence for this flow. Never
   * accepted from the client. Optional for backward compatibility; a
   * missing value fails closed downstream.
   */
  paymentIntentId?: string | null;
  revision: number;
  updatedAt: number;
}

interface OpResult {
  ok: boolean;
  outcome: string;
  status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
  creatorCreditId: string;
  lifecycleId: string | null;
  revision: number;
  error?: string;
}

type Operation =
  | { op: "reserve"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string; paymentIntentId?: string | null }
  | { op: "finalize"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string; publicationVerified: boolean; sealVerified: boolean }
  | { op: "recover"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string; publicationState: string; sealState: string }
  | { op: "vault-publication-claim"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string; outcome?: string }
  | {
      op: "container-publication-claim";
      capsuleId: string;
      lifecycleId: string;
      creatorIdentityId: string;
      containerTxId: string;
      layoutDigest: string;
      chunkIds: string[];
    }
  | { op: "read"; creatorCreditId: string }
  /* ---- identity-scoped entitlement coordination ---- */
  | { op: "identity-summary"; creatorIdentityId: string }
  | {
      op: "identity-reserve-attempt";
      creatorIdentityId: string;
      quoteId: string;
      paymentIntentId: string;
    }
  | {
      op: "identity-authorize-grant";
      creatorIdentityId: string;
      quoteId: string;
      paymentIntentId: string;
      transactionId: string;
    }
  | {
      op: "identity-note-grant";
      creatorIdentityId: string;
      quoteId: string;
      paymentIntentId: string;
      creatorCreditId: string;
    }
  | {
      op: "identity-note-reserve";
      creatorIdentityId: string;
      creatorCreditId: string;
      lifecycleId: string;
      capsuleId: string;
    }
  | {
      op: "identity-note-finalize";
      creatorIdentityId: string;
      creatorCreditId: string;
    }
  | {
      op: "identity-note-recover";
      creatorIdentityId: string;
      creatorCreditId: string;
    }
  | {
      op: "identity-resolve-intent";
      creatorIdentityId: string;
      paymentIntentId: string;
    }
  | {
      op: "identity-bind-broadcast-signature";
      creatorIdentityId: string;
      paymentIntentId: string;
      transactionId: string;
    }
  | {
      op: "payment-tx-claim";
      network: string;
      transactionId: string;
      paymentIntentId: string;
      evidenceId: string;
      creatorIdentityId: string;
      claimedAt: number;
    }
| {
op: "payment-tx-check";
network: string;
transactionId: string;
paymentIntentId: string;
}
| {
op: "grant";
creatorIdentityId: string;
quoteId: string;
paymentIntentId: string;
transactionId: string;
evidenceId: string;
/**
 * Server-injected credit id minted by the identity coordinator's
 * authorize-grant op. Used ONLY when creating a NEW claim (replays keep
 * their stored id), so a retried grant of the same attempt converges on
 * the same credit. Never accepted from a client.
 */
creatorCreditId?: string;
};

/**
 * AETERNA — Global payment transaction uniqueness record.
 *
 * Canonical invariant: ONE successful on-chain AETERNA service-payment
 * transaction (network + transactionId) -> MAXIMUM ONE verified
 * payment -> MAXIMUM ONE Creator Credit, globally across quotes,
 * paymentIntentIds, identities and credits.
 *
 * One CreditOperationCoordinator instance is addressed per
 * sha256(network:transactionId); the single-threaded execution model
 * serializes concurrent claims for the SAME transaction, and claim
 * state survives in Durable Object storage — deliberately NOT subject
 * to the 1-hour VERIFIED_PAYMENTS KV TTL.
 */
export interface PaymentTxClaimRecord {
  network: string;
  transactionId: string;
  paymentIntentId: string;
  evidenceId: string;
  creatorIdentityId: string;
  claimedAt: number;
}

interface PaymentTxOpResult {
  ok: boolean;
  outcome: string;
  claim?: PaymentTxClaimRecord;
  error?: string;
}

interface CoordinatorEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(options: { prefix: string }): Promise<{
      keys: Array<{ name: string }>;
      list_complete?: boolean;
    }>;
  };
  PUBLICATION_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
  };
  SEAL_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
  };
  /**
   * Self-binding to this Durable Object's own namespace. Used by the
   * identity coordinator to read the authoritative per-credit records
   * (op "read") of OTHER instances of the same class, so an index entry
   * can be refreshed from the record that authored the transition
   * instead of trusting a possibly stale snapshot. Optional: without
   * it the index snapshot stands (it is conservative in the safe
   * direction — see identityRefreshLiveEntries).
   */
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(request: Request): Promise<Response>;
    };
  };
}

function creditKey(creatorCreditId: string): string {
  return `credit:${creatorCreditId}`;
}

function opKey(creatorCreditId: string, op: string, lifecycleId: string | null): string {
  return `op:${creatorCreditId}:${op}:${lifecycleId ?? "global"}`;
}

async function getCreditRecord(state: DurableObjectState, creatorCreditId: string): Promise<CreditRecord | null> {
  const raw = await state.storage.get<CreditRecord>(creditKey(creatorCreditId));
  return raw ?? null;
}

async function setCreditRecord(state: DurableObjectState, record: CreditRecord): Promise<void> {
  await state.storage.put(creditKey(record.id), record);
}

async function getOpResult(state: DurableObjectState, key: string): Promise<OpResult | null> {
  const raw = await state.storage.get<OpResult>(key);
  return raw ?? null;
}

async function setOpResult(state: DurableObjectState, key: string, result: OpResult): Promise<void> {
  await state.storage.put(key, result);
}

async function writeLifecycleIndex(env: CoordinatorEnv, creatorIdentityId: string, lifecycleId: string, credit: CreditRecord): Promise<void> {
  const key = `creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`;
  await env.CREATOR_CREDITS.put(key, JSON.stringify(credit));
}

async function writeCreditIndex(env: CoordinatorEnv, creatorIdentityId: string, capsuleId: string, credit: CreditRecord): Promise<void> {
  const key = `creator:credit:index:${creatorIdentityId}:${capsuleId}`;
  await env.CREATOR_CREDITS.put(key, credit.id);
}

async function writeCreditRecord(env: CoordinatorEnv, credit: CreditRecord): Promise<void> {
  const key = `creator:credit:${credit.id}`;
  await env.CREATOR_CREDITS.put(key, JSON.stringify(credit));
}

async function deleteLifecycleIndex(env: CoordinatorEnv, creatorIdentityId: string, lifecycleId: string): Promise<void> {
  const key = `creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`;
  await env.CREATOR_CREDITS.delete(key);
}

function successResponse(result: OpResult): Response {
  const payload = { ...result, ok: true };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function failureResponse(error: string, status = 409, creditId = "", lifecycleId: string | null = null, creditStatus: "AVAILABLE" | "CONSUMING" | "CONSUMED" = "AVAILABLE", revision = 0): Response {
  const result: OpResult = {
    ok: false,
    outcome: error,
    status: creditStatus,
    creatorCreditId: creditId,
    lifecycleId,
    revision,
    error,
  };
  return new Response(JSON.stringify(result), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Authoritative read projection for `op: "read"`.
 *
 * This is the READ-ONLY view of the Durable Object's own credit record —
 * the strongly consistent store that authored the reserve. Consumers that
 * must not observe a stale KV projection (the upload-token gate) read the
 * credit through here instead of KV, whose reads are eventually consistent
 * (default read cacheTtl 60s) and cache negative lookups.
 *
 * No new state is introduced: these are the existing CreditRecord fields,
 * surfaced verbatim. `op: "read"` performs no writes.
 */
interface CreditReadResult {
  ok: boolean;
  outcome: "FOUND" | "NOT_FOUND";
  status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
  creatorCreditId: string;
  creatorIdentityId: string;
  capsuleId: string;
  lifecycleId: string | null;
  paymentIntentId: string | null;
  revision: number;
}

function creditReadResponse(result: CreditReadResult): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Normalizes a server-derived payment intent binding. A non-string or blank
 * value yields null (never a fabricated identifier); downstream gates fail
 * closed on null.
 */
function normalizePaymentIntentId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

async function handleReserve(state: DurableObjectState, env: CoordinatorEnv, request: Operation & { op: "reserve" }): Promise<Response> {
  const { creatorCreditId, creatorIdentityId, lifecycleId, capsuleId, paymentIntentId } = request;

  let credit = await getCreditRecord(state, creatorCreditId);
  const idempotencyKey = opKey(creatorCreditId, "reserve", lifecycleId);
  const idempotent = await getOpResult(state, idempotencyKey);
  if (idempotent && idempotent.ok) {
    const refreshed = await getCreditRecord(state, creatorCreditId);
    return successResponse({
      ok: true,
      outcome: idempotent.outcome,
      status: refreshed?.status ?? "AVAILABLE",
      creatorCreditId,
      lifecycleId,
      revision: refreshed?.revision ?? idempotent.revision,
    });
  }

  if (!credit) {
    const now = Date.now();
    credit = {
      id: creatorCreditId,
      creatorIdentityId,
      status: "AVAILABLE",
      capsuleId,
      lifecycleId: null,
      paymentIntentId: normalizePaymentIntentId(paymentIntentId),
      revision: 1,
      updatedAt: now,
    };
    await setCreditRecord(state, credit);
    await writeCreditRecord(env, credit);
    await writeCreditIndex(env, creatorIdentityId, capsuleId, credit);
  }

  if (credit.status === "CONSUMED") {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "ALREADY_CONSUMED",
      status: "CONSUMED",
      creatorCreditId,
      lifecycleId: credit.lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("ALREADY_CONSUMED", 409, creatorCreditId, credit.lifecycleId, "CONSUMED", credit.revision);
  }

  if (credit.creatorIdentityId !== creatorIdentityId) {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "IDENTITY_MISMATCH",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("IDENTITY_MISMATCH", 409, creatorCreditId, lifecycleId, credit.status, credit.revision);
  }

  if (credit.status === "CONSUMING") {
    const already = credit.lifecycleId === lifecycleId ? "ALREADY_RESERVED_FOR_SAME_LIFECYCLE" : "ALREADY_CONSUMING";
    await setOpResult(state, idempotencyKey, {
      ok: already === "ALREADY_RESERVED_FOR_SAME_LIFECYCLE",
      outcome: already,
      status: "CONSUMING",
      creatorCreditId,
      lifecycleId: credit.lifecycleId,
      revision: credit.revision,
    });
    if (already === "ALREADY_RESERVED_FOR_SAME_LIFECYCLE") {
      return successResponse({
        ok: true,
        outcome: already,
        status: "CONSUMING",
        creatorCreditId,
        lifecycleId: credit.lifecycleId,
        revision: credit.revision,
      });
    }
    return failureResponse(already, 409, creatorCreditId, credit.lifecycleId, "CONSUMING", credit.revision);
  }

  if (credit.capsuleId !== capsuleId) {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "CAPSULE_MISMATCH",
      status: credit.status,
      creatorCreditId,
      lifecycleId: null,
      revision: credit.revision,
    });
    return failureResponse("CAPSULE_MISMATCH", 409, creatorCreditId, null, credit.status, credit.revision);
  }

  const updated: CreditRecord = {
    ...credit,
    status: "CONSUMING",
    lifecycleId,
    capsuleId,
    // Preserve the existing server-derived binding when the request omits it
    // (e.g. an idempotent re-reserve after the KV credit record was already
    // rewritten). Never overwrite a known binding with null.
    paymentIntentId:
      normalizePaymentIntentId(paymentIntentId) ??
      credit.paymentIntentId ??
      null,
    revision: credit.revision + 1,
    updatedAt: Date.now(),
  };
  await setCreditRecord(state, updated);
  await writeCreditRecord(env, updated);
  await writeLifecycleIndex(env, creatorIdentityId, lifecycleId, updated);
  await writeCreditIndex(env, creatorIdentityId, capsuleId, updated);

  await setOpResult(state, idempotencyKey, {
    ok: true,
    outcome: "RESERVED",
    status: "CONSUMING",
    creatorCreditId,
    lifecycleId,
    revision: updated.revision,
  });

  return successResponse({
    ok: true,
    outcome: "RESERVED",
    status: "CONSUMING",
    creatorCreditId,
    lifecycleId,
    revision: updated.revision,
  });
}

/**
 * Authoritative verification state is read inside the Durable Object
 * immediately before any recovery mutation. Corrupt/unparseable
 * records fail closed to NOT_VERIFIED — they must never enable a
 * restore.
 */
async function readAuthoritativeState(
  env: CoordinatorEnv,
  lifecycleId: string
): Promise<{ publicationState: string; sealState: string }> {
  const resolve = async (raw: string | null): Promise<string> => {
    if (!raw) return "NOT_VERIFIED";
    try {
      const record = JSON.parse(raw) as { state?: unknown };
      if (record.state === "VERIFIED") return "VERIFIED";
      if (record.state === "PENDING") return "PENDING";
      return "NOT_VERIFIED";
    } catch {
      return "NOT_VERIFIED";
    }
  };

  const [publicationState, sealState] = await Promise.all([
    resolve(await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${lifecycleId}`)),
    resolve(await env.SEAL_VERIFICATIONS.get(`creator:seal:${lifecycleId}`)),
  ]);

  return { publicationState, sealState };
}

async function handleVaultPublicationClaim(state: DurableObjectState, env: CoordinatorEnv, request: Operation & { op: "vault-publication-claim" }): Promise<Response> {
  const { creatorCreditId, creatorIdentityId, lifecycleId, capsuleId } = request;
  const explicitFailure = request.outcome === "PUBLICATION_EXPLICIT_FAILURE";

  const idempotencyKey = opKey(creatorCreditId, "vault-publication-claim", lifecycleId);
  const existing = await getOpResult(state, idempotencyKey);

  if (existing && existing.creatorCreditId === creatorCreditId && existing.lifecycleId === lifecycleId) {
    if (explicitFailure && existing.outcome !== "VAULT_PUBLICATION_EXPLICIT_FAILURE") {
      // fall through: authorized explicit failure overwrites the open claim
    } else if (existing.outcome === "VAULT_PUBLICATION_EXPLICIT_FAILURE") {
      return failureResponse(
        existing.outcome,
        409,
        creatorCreditId,
        lifecycleId,
        existing.status,
        existing.revision
      );
    } else {
      return successResponse({
        ok: true,
        outcome: existing.outcome,
        status: existing.status,
        creatorCreditId,
        lifecycleId,
        revision: existing.revision,
      });
    }
  }

  const credit = await getCreditRecord(state, creatorCreditId);
  if (!credit) {
    return failureResponse("LIFECYCLE_NOT_FOUND", 409, creatorCreditId, lifecycleId, "AVAILABLE", 0);
  }

  if (credit.status !== "CONSUMING") {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "CREDIT_NOT_CONSUMING",
      status: credit.status,
      creatorCreditId,
      lifecycleId: credit.lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("CREDIT_NOT_CONSUMING", 409, creatorCreditId, credit.lifecycleId, credit.status, credit.revision);
  }

  if (credit.creatorIdentityId !== creatorIdentityId || credit.lifecycleId !== lifecycleId) {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "LIFECYCLE_NOT_FOUND",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("LIFECYCLE_NOT_FOUND", 409, creatorCreditId, lifecycleId, credit.status, credit.revision);
  }

  if (credit.capsuleId !== capsuleId) {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "CAPSULE_MISMATCH",
      status: credit.status,
      creatorCreditId,
      lifecycleId: null,
      revision: credit.revision,
    });
    return failureResponse("CAPSULE_MISMATCH", 409, creatorCreditId, null, credit.status, credit.revision);
  }

  if (explicitFailure) {
    const claim: OpResult = {
      ok: false,
      outcome: "VAULT_PUBLICATION_EXPLICIT_FAILURE",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    };
    await setOpResult(state, idempotencyKey, claim);
    return failureResponse("VAULT_PUBLICATION_EXPLICIT_FAILURE", 409, creatorCreditId, lifecycleId, credit.status, credit.revision);
  }

  const claim: OpResult = {
    ok: true,
    outcome: "VAULT_PUBLICATION_CLAIMED",
    status: "CONSUMING",
    creatorCreditId,
    lifecycleId,
    revision: credit.revision,
  };
  await setOpResult(state, idempotencyKey, claim);

  return successResponse({
    ok: true,
    outcome: claim.outcome,
    status: claim.status,
    creatorCreditId,
    lifecycleId,
    revision: claim.revision,
  });
}

/* ================= CONTAINER PUBLICATION CLAIM (Stage 4.1) ================= */

/**
 * The authoritative container publication claim, held in Durable Object
 * storage.
 *
 * This is claim IDENTITY only. The verification `state`
 * (PENDING/VERIFIED/REJECTED) lives in the KV projection and is advanced
 * by /api/publication/verify exactly as before — the DO is authoritative
 * for "does this claim exist, and whose is it", not for verification.
 */
export interface ContainerPublicationClaimRecord {
  capsuleId: string;
  lifecycleId: string;
  creatorIdentityId: string;
  containerTxId: string;
  layoutDigest: string;
  chunkIds: string[];
}

/** The global txId -> capsule binding for container publications. */
export interface ContainerPublicationTxBinding {
  capsuleId: string;
  lifecycleId: string;
}

interface ContainerClaimOpResult {
  ok: boolean;
  outcome: string;
  capsuleId: string;
  containerTxId: string;
  error?: string;
}

function containerClaimKey(capsuleId: string): string {
  return `container-publication-claim:${capsuleId}`;
}

function containerTxBindingKey(containerTxId: string): string {
  return `container-publication-tx:${containerTxId}`;
}

function containerClaimSuccessResponse(result: ContainerClaimOpResult): Response {
  return new Response(JSON.stringify({ ...result, ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function containerClaimFailureResponse(result: ContainerClaimOpResult, status = 409): Response {
  return new Response(JSON.stringify({ ...result, ok: false }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Atomic "create-if-absent / claim exactly once" for a container
 * publication.
 *
 * Atomicity model
 * ---------------
 * `container-publication:<capsuleId>` in KV cannot express create-if-absent:
 * Cloudflare KV has no compare-and-set, so a KV get followed by a KV put is
 * two independent round-trips. Two concurrent conflicting container claims
 * could both observe "absent", both write, and both report success while
 * only one record survived.
 *
 * This operation moves the authoritative decision into Durable Object
 * storage, which is strongly consistent and transactional, and executes it
 * inside ONE serialized DO request: the read -> decide -> write sequence is
 * separated by no non-storage await, so the DO input gate keeps every other
 * request out (the same argument the payment-tx and grant claims rely on).
 *
 * Both records — the per-capsule claim and the per-tx binding — are written
 * inside a SINGLE storage transaction, so a crash cannot leave one without
 * the other.
 *
 * Outcomes:
 *   CONTAINER_PUBLICATION_CLAIMED        — no claim existed; established now
 *   CONTAINER_PUBLICATION_ALREADY_CLAIMED — byte-equal exact replay; idempotent
 *   TX_ALREADY_CLAIMED                   — this txId owns a DIFFERENT capsule
 *   CONTAINER_ALREADY_PUBLISHED          — this capsule owns a DIFFERENT claim
 *
 * KV is NOT atomic and is never claimed to be: the KV container record is a
 * durable PROJECTION of this authoritative claim.
 */
async function handleContainerPublicationClaim(
  state: DurableObjectState,
  request: Operation & { op: "container-publication-claim" }
): Promise<Response> {
  const { capsuleId, lifecycleId, creatorIdentityId, containerTxId, layoutDigest, chunkIds } = request;

  if (
    typeof capsuleId !== "string" || !capsuleId ||
    typeof lifecycleId !== "string" || !lifecycleId ||
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof containerTxId !== "string" || !containerTxId ||
    typeof layoutDigest !== "string" || !layoutDigest ||
    !Array.isArray(chunkIds) ||
    chunkIds.length === 0 ||
    chunkIds.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    return containerClaimFailureResponse(
      { ok: false, outcome: "INVALID_FIELDS", error: "INVALID_FIELDS", capsuleId: "", containerTxId: "" },
      400
    );
  }

  const txKey = containerTxBindingKey(containerTxId);
  const claimKey = containerClaimKey(capsuleId);

  /* --- read (no non-storage await until the write below) --- */

  const txBinding = (await state.storage.get<ContainerPublicationTxBinding>(txKey)) ?? null;
  if (txBinding && txBinding.capsuleId !== capsuleId) {
    // Cross-capsule txId reuse: the tx is already spent. Deterministic
    // conflict — the loser never receives success.
    return containerClaimFailureResponse(
      { ok: false, outcome: "TX_ALREADY_CLAIMED", error: "TX_ALREADY_CLAIMED", capsuleId, containerTxId },
      409
    );
  }

  const existing = (await state.storage.get<ContainerPublicationClaimRecord>(claimKey)) ?? null;

  if (existing) {
    const sameChunkSet =
      existing.chunkIds.length === chunkIds.length &&
      existing.chunkIds.every((id, i) => id === chunkIds[i]);

    if (
      existing.lifecycleId === lifecycleId &&
      existing.creatorIdentityId === creatorIdentityId &&
      existing.containerTxId === containerTxId &&
      existing.layoutDigest === layoutDigest &&
      sameChunkSet
    ) {
      // Exact replay: same authority, same tx, same ordered chunk set, same
      // layout digest. Idempotent success. Repair a missing tx binding so a
      // previously interrupted attempt converges.
      if (!txBinding) {
        await state.storage.put(txKey, { capsuleId, lifecycleId });
      }
      return containerClaimSuccessResponse({
        ok: true,
        outcome: "CONTAINER_PUBLICATION_ALREADY_CLAIMED",
        capsuleId,
        containerTxId,
      });
    }

    // A capsule publishes exactly ONE container. Any other claim conflicts.
    return containerClaimFailureResponse(
      { ok: false, outcome: "CONTAINER_ALREADY_PUBLISHED", error: "CONTAINER_ALREADY_PUBLISHED", capsuleId, containerTxId },
      409
    );
  }

  /* --- write: both records, atomically, or neither --- */

  const record: ContainerPublicationClaimRecord = {
    capsuleId,
    lifecycleId,
    creatorIdentityId,
    containerTxId,
    layoutDigest,
    chunkIds: [...chunkIds],
  };

  await state.storage.transaction(async (txn) => {
    await txn.put(claimKey, record);
    await txn.put(txKey, { capsuleId, lifecycleId });
  });

  return containerClaimSuccessResponse({
    ok: true,
    outcome: "CONTAINER_PUBLICATION_CLAIMED",
    capsuleId,
    containerTxId,
  });
}

async function handleFinalize(state: DurableObjectState, env: CoordinatorEnv, request: Operation & { op: "finalize" }): Promise<Response> {
  const { creatorCreditId, creatorIdentityId, lifecycleId, capsuleId, publicationVerified, sealVerified } = request;

  const credit = await getCreditRecord(state, creatorCreditId);
  if (!credit) {
    return failureResponse("LIFECYCLE_NOT_FOUND", 409, creatorCreditId, lifecycleId, "AVAILABLE", 0);
  }

  const idempotencyKey = opKey(creatorCreditId, "finalize", lifecycleId);
  const idempotent = await getOpResult(state, idempotencyKey);
  if (idempotent && idempotent.ok) {
    return successResponse({
      ok: true,
      outcome: idempotent.outcome,
      status: "CONSUMED",
      creatorCreditId,
      lifecycleId: null,
      revision: credit.revision,
    });
  }

  if (credit.status === "CONSUMED") {
    await setOpResult(state, idempotencyKey, {
      ok: true,
      outcome: "ALREADY_CONSUMED",
      status: "CONSUMED",
      creatorCreditId,
      lifecycleId: null,
      revision: credit.revision,
    });
    return successResponse({
      ok: true,
      outcome: "ALREADY_CONSUMED",
      status: "CONSUMED",
      creatorCreditId,
      lifecycleId: null,
      revision: credit.revision,
    });
  }

  if (credit.status !== "CONSUMING") {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "CREDIT_NOT_CONSUMING",
      status: credit.status,
      creatorCreditId,
      lifecycleId: credit.lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("CREDIT_NOT_CONSUMING", 409, creatorCreditId, credit.lifecycleId, credit.status, credit.revision);
  }

  if (credit.creatorIdentityId !== creatorIdentityId || credit.lifecycleId !== lifecycleId) {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "LIFECYCLE_NOT_FOUND",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("LIFECYCLE_NOT_FOUND", 409, creatorCreditId, lifecycleId, credit.status, credit.revision);
  }

  if (credit.capsuleId !== capsuleId) {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "CAPSULE_MISMATCH",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("CAPSULE_MISMATCH", 409, creatorCreditId, lifecycleId, credit.status, credit.revision);
  }

  if (!publicationVerified || !sealVerified) {
    const outcome = publicationVerified ? "SEAL_NOT_VERIFIED" : "PUBLICATION_NOT_VERIFIED";
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome,
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return failureResponse(outcome, 409, creatorCreditId, lifecycleId, credit.status, credit.revision);
  }

  const updated: CreditRecord = {
    ...credit,
    status: "CONSUMED",
    lifecycleId: null,
    revision: credit.revision + 1,
    updatedAt: Date.now(),
  };
  await setCreditRecord(state, updated);
  await writeCreditRecord(env, updated);
  await deleteLifecycleIndex(env, creatorIdentityId, lifecycleId);

  await setOpResult(state, idempotencyKey, {
    ok: true,
    outcome: "CONSUMED",
    status: "CONSUMED",
    creatorCreditId,
    lifecycleId: null,
    revision: updated.revision,
  });

  return successResponse({
    ok: true,
    outcome: "CONSUMED",
    status: "CONSUMED",
    creatorCreditId,
    lifecycleId: null,
    revision: updated.revision,
  });
}

async function handleRecover(state: DurableObjectState, env: CoordinatorEnv, request: Operation & { op: "recover" }): Promise<Response> {
  const { creatorCreditId, creatorIdentityId, lifecycleId, capsuleId } = request;

  const credit = await getCreditRecord(state, creatorCreditId);
  if (!credit) {
    return failureResponse("LIFECYCLE_NOT_FOUND", 409, creatorCreditId, lifecycleId, "AVAILABLE", 0);
  }

  const idempotencyKey = opKey(creatorCreditId, "recover", lifecycleId);
  const idempotent = await getOpResult(state, idempotencyKey);
  if (idempotent) {
    return successResponse({
      ok: idempotent.ok,
      outcome: idempotent.outcome,
      status: idempotent.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
  }

  if (credit.status === "CONSUMED") {
    await setOpResult(state, idempotencyKey, {
      ok: true,
      outcome: "RETURN_EXISTING",
      status: "CONSUMED",
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return successResponse({
      ok: true,
      outcome: "RETURN_EXISTING",
      status: "CONSUMED",
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
  }

  if (credit.creatorIdentityId !== creatorIdentityId || credit.capsuleId !== capsuleId) {
    await setOpResult(state, idempotencyKey, {
      ok: true,
      outcome: "RETURN_EXISTING",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return successResponse({
      ok: true,
      outcome: "RETURN_EXISTING",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
  }

  /**
   * Authoritative verification state is read INSIDE the DO, immediately
   * before the recovery decision. Request-supplied publication/seal
   * states are never authority (canonical §11.2, §7.1): reading here
   * closes the race where verification completes between an
   * endpoint-side read and this mutation.
   */
  const authoritative = await readAuthoritativeState(env, lifecycleId);

  // A VERIFIED publication/seal owns the credit toward finalization:
  // recovery MUST NOT restore it to AVAILABLE (canonical §7.1).
  if (authoritative.publicationState === "VERIFIED") {
    await setOpResult(state, idempotencyKey, {
      ok: true,
      outcome: "PUBLICATION_VERIFIED_AWAITING_FINALIZATION",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return successResponse({
      ok: true,
      outcome: "PUBLICATION_VERIFIED_AWAITING_FINALIZATION",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
  }

  if (authoritative.sealState === "VERIFIED") {
    await setOpResult(state, idempotencyKey, {
      ok: true,
      outcome: "SEAL_VERIFIED_AWAITING_FINALIZATION",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return successResponse({
      ok: true,
      outcome: "SEAL_VERIFIED_AWAITING_FINALIZATION",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
  }

  const claimKey = opKey(creatorCreditId, "vault-publication-claim", lifecycleId);
  const claim = await getOpResult(state, claimKey);
  const hasExplicitPublicationFailure = !!claim && claim.outcome === "VAULT_PUBLICATION_EXPLICIT_FAILURE";

  if (!hasExplicitPublicationFailure && !!claim) {
    await setOpResult(state, idempotencyKey, {
      ok: false,
      outcome: "PUBLICATION_CLAIM_IN_FLIGHT",
      status: credit.status,
      creatorCreditId,
      lifecycleId,
      revision: credit.revision,
    });
    return failureResponse("PUBLICATION_CLAIM_IN_FLIGHT", 409, creatorCreditId, lifecycleId, credit.status, credit.revision);
  }

  if (credit.status === "CONSUMING") {
    const updated: CreditRecord = {
      ...credit,
      status: "AVAILABLE",
      lifecycleId: null,
      revision: credit.revision + 1,
      updatedAt: Date.now(),
    };
    await setCreditRecord(state, updated);
    await writeCreditRecord(env, updated);
    await deleteLifecycleIndex(env, creatorIdentityId, lifecycleId);

    await setOpResult(state, idempotencyKey, {
      ok: true,
      outcome: "ABORT_AND_RESTORE_AVAILABLE",
      status: "AVAILABLE",
      creatorCreditId,
      lifecycleId: null,
      revision: updated.revision,
    });

    return successResponse({
      ok: true,
      outcome: "ABORT_AND_RESTORE_AVAILABLE",
      status: "AVAILABLE",
      creatorCreditId,
      lifecycleId: null,
      revision: updated.revision,
    });
  }

  await setOpResult(state, idempotencyKey, {
    ok: true,
    outcome: "RESUME",
    status: credit.status,
    creatorCreditId,
    lifecycleId,
    revision: credit.revision,
  });

  return successResponse({
    ok: true,
    outcome: "RESUME",
    status: credit.status,
    creatorCreditId,
    lifecycleId,
    revision: credit.revision,
  });
}

function paymentTxClaimKey(network: string, transactionId: string): string {
  return `payment-tx-unique:${network}:${transactionId}`;
}

async function getPaymentTxClaim(
  state: DurableObjectState,
  network: string,
  transactionId: string
): Promise<PaymentTxClaimRecord | null> {
  const raw = await state.storage.get<PaymentTxClaimRecord>(
    paymentTxClaimKey(network, transactionId)
  );
  return raw ?? null;
}

function paymentTxSuccessResponse(result: PaymentTxOpResult): Response {
  return new Response(JSON.stringify({ ...result, ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function paymentTxFailureResponse(result: PaymentTxOpResult, status = 409): Response {
  return new Response(JSON.stringify({ ...result, ok: false }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Atomic global claim for one successful payment transaction.
 *
 * The read below and the conditional write are separated by NO other
 * await: under the Durable Object input gate, the get -> (synchronous
 * decision) -> put sequence is atomic with respect to every other
 * request, so at most ONE concurrent claim can win for a given
 * network + transactionId.
 *
 * The binding is only ever created here — and the caller is required
 * to invoke this op only AFTER the transaction passed all existing
 * payment validity checks — so a failed/invalid transaction can never
 * poison the global key. A claim is never deleted: once a valid
 * successful transaction owns the key, no later failure can allow a
 * second Credit from the same transaction under a different quote.
 */
async function handlePaymentTxClaim(
  state: DurableObjectState,
  request: Operation & { op: "payment-tx-claim" }
): Promise<Response> {
  const { network, transactionId, paymentIntentId, evidenceId, creatorIdentityId, claimedAt } = request;

  if (
    typeof network !== "string" || !network ||
    typeof transactionId !== "string" || !transactionId ||
    typeof paymentIntentId !== "string" || !paymentIntentId ||
    typeof evidenceId !== "string" || !evidenceId ||
    typeof creatorIdentityId !== "string" || !creatorIdentityId
  ) {
    return paymentTxFailureResponse({ ok: false, outcome: "INVALID_FIELDS", error: "INVALID_FIELDS" }, 400);
  }

  const existing = await getPaymentTxClaim(state, network, transactionId);

  if (existing) {
    if (existing.network !== network || existing.transactionId !== transactionId) {
      return paymentTxFailureResponse(
        { ok: false, outcome: "PAYMENT_TX_IDENTITY_MISMATCH", error: "PAYMENT_TX_IDENTITY_MISMATCH", claim: existing },
        409
      );
    }
    if (existing.paymentIntentId === paymentIntentId) {
      // Same payment replay (same paymentIntentId, possibly a new
      // evidenceId): idempotent, the caller keeps its existing flow.
      return paymentTxSuccessResponse({ ok: true, outcome: "ALREADY_CLAIMED", claim: existing });
    }
    // A DIFFERENT paymentIntentId is attempting to reuse this
    // transaction. This is exactly the second-credit attack path.
    return paymentTxFailureResponse(
      { ok: false, outcome: "ALREADY_CLAIMED_OTHER_PAYMENT", error: "ALREADY_CLAIMED_OTHER_PAYMENT", claim: existing },
      409
    );
  }

  const claim: PaymentTxClaimRecord = {
    network,
    transactionId,
    paymentIntentId,
    evidenceId,
    creatorIdentityId,
    claimedAt: typeof claimedAt === "number" && Number.isFinite(claimedAt) ? claimedAt : Date.now(),
  };
  await state.storage.put(paymentTxClaimKey(network, transactionId), claim);

  return paymentTxSuccessResponse({ ok: true, outcome: "CLAIMED", claim });
}

/**
 * Read-only validation of the global binding. Used at the Creator
 * Credit minting boundary (grant-credit): a verified payment record
 * may only mint a Credit when the transaction's global binding exists
 * and belongs to the SAME paymentIntentId.
 */
async function handlePaymentTxCheck(
  state: DurableObjectState,
  request: Operation & { op: "payment-tx-check" }
): Promise<Response> {
  const { network, transactionId, paymentIntentId } = request;

  if (
    typeof network !== "string" || !network ||
    typeof transactionId !== "string" || !transactionId ||
    typeof paymentIntentId !== "string" || !paymentIntentId
  ) {
    return paymentTxFailureResponse({ ok: false, outcome: "INVALID_FIELDS", error: "INVALID_FIELDS" }, 400);
  }

  const existing = await getPaymentTxClaim(state, network, transactionId);

  if (!existing) {
    return paymentTxSuccessResponse({ ok: true, outcome: "NOT_CLAIMED" });
  }

  if (existing.network !== network || existing.transactionId !== transactionId) {
    return paymentTxFailureResponse(
      { ok: false, outcome: "PAYMENT_TX_IDENTITY_MISMATCH", error: "PAYMENT_TX_IDENTITY_MISMATCH", claim: existing },
      409
    );
  }

  if (existing.paymentIntentId === paymentIntentId) {
    return paymentTxSuccessResponse({ ok: true, outcome: "CLAIMED", claim: existing });
  }

  return paymentTxFailureResponse(
    { ok: false, outcome: "ALREADY_CLAIMED_OTHER_PAYMENT", error: "ALREADY_CLAIMED_OTHER_PAYMENT", claim: existing },
    409
  );
}

/* ================= CREATOR CREDIT GRANT (mint claim) ================= */

/**
 * AETERNA — Creator Credit grant claim.
 *
 * Canonical invariant: ONE verified AETERNA service payment, identified by
 * creatorIdentityId + quoteId, produces EXACTLY ONE Creator Credit.
 *
 * One CreditOperationCoordinator instance is addressed per
 * creatorIdentityId + quoteId, so the single-threaded execution model
 * serializes concurrent grants for the same verified payment, and the claim
 * survives in Durable Object storage.
 *
 * The claim is deliberately NOT subject to the VERIFIED_PAYMENTS KV TTL.
 */
export interface GrantClaimRecord {
  creatorIdentityId: string;
  quoteId: string;
  creatorCreditId: string;
  createdAt: number;
}

function grantClaimKey(creatorIdentityId: string, quoteId: string): string {
  return `credit-grant:${creatorIdentityId}:${quoteId}`;
}

async function getGrantClaim(
  state: DurableObjectState,
  creatorIdentityId: string,
  quoteId: string
): Promise<GrantClaimRecord | null> {
  const raw = await state.storage.get<GrantClaimRecord>(
    grantClaimKey(creatorIdentityId, quoteId)
  );
  return raw ?? null;
}

/**
 * Credit id generator.
 *
 * Deliberately inlined rather than imported from
 * src/lib/creator/creatorCreditStore.ts: this Durable Object worker declares no
 * path-alias configuration, and this module has always been import-free. The
 * output shape (32 lowercase hex chars) matches generateCreditId() there.
 */
function generateGrantCreditId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** The existing quote-keyed credit index consumed by grant-credit lookups. */
function quoteCreditIndexKey(creatorIdentityId: string, quoteId: string): string {
  return `creator:credit:index:${creatorIdentityId}:${quoteId}`;
}

/**
 * Ensure the KV credit record and the quote-keyed credit index exist for a
 * claim.
 *
 * This is NOT a distributed transaction: Durable Object storage and KV are
 * separate systems. The DO claim is the serialization point, and this repair
 * step is what makes replay converge on the same externally visible state —
 * whichever KV artifact is missing is rewritten with the SAME
 * creatorCreditId.
 *
 * Durable Object storage is deliberately NOT written here: the credit record
 * in DO storage is established lazily by handleReserve(), which is also what
 * binds capsuleId. Writing it here would make a later reserve fail with
 * CAPSULE_MISMATCH.
 */
async function repairCreditArtifacts(
  env: CoordinatorEnv,
  claim: GrantClaimRecord
): Promise<void> {
  await env.CREATOR_CREDITS.put(
    `creator:credit:${claim.creatorCreditId}`,
    JSON.stringify({
      id: claim.creatorCreditId,
      creatorIdentityId: claim.creatorIdentityId,
      status: "AVAILABLE",
      quoteId: claim.quoteId,
      createdAt: claim.createdAt,
      updatedAt: claim.createdAt,
    })
  );

  await env.CREATOR_CREDITS.put(
    quoteCreditIndexKey(claim.creatorIdentityId, claim.quoteId),
    claim.creatorCreditId
  );
}

/**
 * Atomic Creator Credit grant for one verified service payment.
 *
 * The read below and the conditional write are separated by NO other await:
 * under the Durable Object input gate the get -> (synchronous decision) -> put
 * sequence is atomic with respect to every other request, so at most ONE
 * concurrent grant can win for a given creatorIdentityId + quoteId.
 *
 * Replay never mints a second id. Every replay reuses the stored
 * creatorCreditId and repairs missing KV artifacts, so the operation is
 * idempotent-repairing across the two storage systems.
 */
async function handleGrant(
  state: DurableObjectState,
  env: CoordinatorEnv,
  request: Operation & { op: "grant" }
): Promise<Response> {
  const { creatorIdentityId, quoteId, paymentIntentId, transactionId, evidenceId } = request;

  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof quoteId !== "string" || !quoteId ||
    typeof paymentIntentId !== "string" || !paymentIntentId ||
    typeof transactionId !== "string" || !transactionId ||
    typeof evidenceId !== "string" || !evidenceId
  ) {
    return failureResponse("INVALID_FIELDS", 400);
  }

  /**
   * Optional server-injected id (identity coordinator authorization).
   * Validated as a bounded id shape; a malformed value fails closed
   * instead of silently minting a different credit.
   */
  const injectedCreditId =
    typeof request.creatorCreditId === "string" &&
    /^[a-z0-9]{8,64}$/.test(request.creatorCreditId)
      ? request.creatorCreditId
      : null;
  if (typeof request.creatorCreditId === "string" && !injectedCreditId) {
    return failureResponse("INVALID_FIELDS", 400);
  }

  const existing = await getGrantClaim(state, creatorIdentityId, quoteId);

  if (existing) {
    if (
      existing.creatorIdentityId !== creatorIdentityId ||
      existing.quoteId !== quoteId
    ) {
      return failureResponse("GRANT_CLAIM_IDENTITY_MISMATCH", 409);
    }

    // Replay: reuse the SAME creatorCreditId and repair KV state.
    await repairCreditArtifacts(env, existing);

    return successResponse({
      ok: true,
      outcome: "ALREADY_GRANTED",
      status: "AVAILABLE",
      creatorCreditId: existing.creatorCreditId,
      lifecycleId: null,
      revision: 1,
    });
  }

  const claim: GrantClaimRecord = {
    creatorIdentityId,
    quoteId,
    // The identity coordinator mints the id when it authorizes the
    // grant; a legacy/unauthenticated caller (no coordinator) still
    // gets a locally generated id.
    creatorCreditId: injectedCreditId ?? generateGrantCreditId(),
    createdAt: Date.now(),
  };

  // Atomic claim — no await between the read above and this write.
  await state.storage.put(grantClaimKey(creatorIdentityId, quoteId), claim);

  await repairCreditArtifacts(env, claim);

  return successResponse({
    ok: true,
    outcome: "GRANTED",
    status: "AVAILABLE",
    creatorCreditId: claim.creatorCreditId,
    lifecycleId: null,
    revision: 1,
  });
}

/* ================= IDENTITY-SCOPED ENTITLEMENT COORDINATOR ================= */

/**
 * AETERNA — Identity-scoped entitlement coordination.
 *
 * One CreditOperationCoordinator instance is addressed per
 * `identity:<creatorIdentityId>` and owns the AUTHORITATIVE, strongly
 * consistent view of every Creator Credit and every payment attempt of
 * ONE creator identity. It complements — never replaces — the
 * per-credit coordinators (which stay the authority for a single
 * credit's transitions).
 *
 * Why this exists: the KV credit index is eventually consistent, so a
 * KV-only enumeration can miss a credit that was written seconds ago.
 * That missed credit is exactly what allowed a second $1 purchase. The
 * identity index below is written INSIDE the Durable Object
 * transactionally with the decision it supports, so "no live right" can
 * never be concluded from a stale projection.
 *
 * Maintenance contract (endpoint-side, AFTER the authoritative
 * per-credit op succeeded):
 *   grant    -> identity-note-grant    (credit AVAILABLE, attempt fulfilled)
 *   reserve  -> identity-note-reserve  (credit CONSUMING + lifecycleId)
 *   finalize -> identity-note-finalize (credit CONSUMED)
 *   recover  -> identity-note-recover  (credit AVAILABLE again)
 * Every transition to a "less live" state is written only AFTER the
 * per-credit coordinator accepted it, so an index entry can never call
 * a dead right alive — the only possible staleness is "alive when
 * actually dead", which is the fail-closed direction (it blocks a new
 * purchase instead of allowing one).
 */

interface IdentityIndexEntry {
  id: string;
  creatorIdentityId: string;
  status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
  capsuleId: string | null;
  lifecycleId: string | null;
  quoteId: string | null;
  revision: number;
  updatedAt: number;
}

interface PaymentAttemptRecord {
  paymentIntentId: string;
  quoteId: string;
  creatorIdentityId: string;
  state: "reserved" | "granting" | "fulfilled";
  creatorCreditId: string | null;
  transactionId: string | null;
  /**
   * The Solana transaction signature whose bytes were validated and
   * authorised for broadcast for THIS attempt.
   *
   * Exactly one signature may ever be bound: two tabs or two devices can
   * therefore never broadcast two different transactions for one
   * purchase. Bound BEFORE the network call, so a lost HTTP response is
   * an idempotent replay of the same signature rather than a second
   * transfer.
   */
  broadcastSignature: string | null;
  createdAt: number;
  updatedAt: number;
}

interface IdentityBackfillRecord {
  complete: boolean;
  completedAt: number;
  unresolved: string[];
}

function identityIndexKey(creatorIdentityId: string, creatorCreditId: string): string {
  return `idindex:${creatorIdentityId}:${creatorCreditId}`;
}

function identityIndexPrefix(creatorIdentityId: string): string {
  return `idindex:${creatorIdentityId}:`;
}

function attemptKey(creatorIdentityId: string, paymentIntentId: string): string {
  return `attempt:${creatorIdentityId}:${paymentIntentId}`;
}

function activeAttemptKey(creatorIdentityId: string): string {
  return `attempt-active:${creatorIdentityId}`;
}

function backfillKey(creatorIdentityId: string): string {
  return `backfill:${creatorIdentityId}`;
}

function isLiveStatus(status: string): boolean {
  return status === "AVAILABLE" || status === "CONSUMING";
}

function identityFailure(error: string, status = 409): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function identitySuccess(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * All identity index entries of one creator.
 *
 * The credit-id set is maintained explicitly (`creditset:`) instead of
 * using storage.list(), so the identity coordinator depends on exactly
 * the same storage primitives (get/put/delete) as the rest of this
 * module and every existing fake storage keeps working unchanged.
 */
function creditSetKey(creatorIdentityId: string): string {
  return `creditset:${creatorIdentityId}`;
}

async function readIdentityEntries(
  state: DurableObjectState,
  creatorIdentityId: string
): Promise<IdentityIndexEntry[]> {
  const ids =
    (await state.storage.get<string[]>(creditSetKey(creatorIdentityId))) ?? [];
  const entries: IdentityIndexEntry[] = [];
  for (const id of ids) {
    const entry = await state.storage.get<IdentityIndexEntry>(
      identityIndexKey(creatorIdentityId, id)
    );
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      entries.push(entry);
    }
  }
  return entries;
}

async function rememberCreditId(
  state: DurableObjectState,
  creatorIdentityId: string,
  creatorCreditId: string
): Promise<void> {
  const ids =
    (await state.storage.get<string[]>(creditSetKey(creatorIdentityId))) ?? [];
  if (!ids.includes(creatorCreditId)) {
    ids.push(creatorCreditId);
    await state.storage.put(creditSetKey(creatorIdentityId), ids);
  }
}

/**
 * One-time backfill of the identity index from the existing KV
 * projections, for credits that existed BEFORE the identity
 * coordinator.
 *
 * Both existing index shapes are read:
 *   creator:credit:index:{identity}:{capsuleId} -> credit id pointer
 *   creator:credit:lifecycle:{identity}:{lifecycleId} -> full record JSON
 * and every resolved record is re-validated for ownership against the
 * SERVER-DERIVED identity (a client-supplied id is never trusted).
 * De-duplication is by creatorCreditId, because one credit can be
 * reachable through both shapes.
 *
 * Completeness requires KV's own `list_complete !== false` AND full
 * resolution of every pointer. Anything else leaves the backfill
 * INCOMPLETE, and an incomplete backfill can never authorise the
 * absence of a right: every decision path then fails closed.
 *
 * Existing index entries are NEVER overwritten by the backfill — they
 * were written by the transactional maintenance contract and are newer
 * than any KV projection.
 */
async function ensureIdentityBackfilled(
  state: DurableObjectState,
  env: CoordinatorEnv,
  creatorIdentityId: string
): Promise<{ complete: boolean; reason?: string }> {
  const flag = await state.storage.get<IdentityBackfillRecord>(
    backfillKey(creatorIdentityId)
  );
  if (flag && flag.complete) return { complete: true };

  const listFn = env.CREATOR_CREDITS?.list;
  if (typeof listFn !== "function") {
    // Without a list() the existing rights of this identity cannot be
    // enumerated: unknown state, never "absent".
    return { complete: false, reason: "ENUMERATION_UNAVAILABLE" };
  }

  const resolved = new Map<string, IdentityIndexEntry>();
  const unresolved: string[] = [];

  const prefixes = [
    `creator:credit:index:${creatorIdentityId}:`,
    `creator:credit:lifecycle:${creatorIdentityId}:`,
  ];

  for (const prefix of prefixes) {
    let listed: { keys: Array<{ name: string }>; list_complete?: boolean };
    try {
      listed = await listFn.call(env.CREATOR_CREDITS, { prefix });
    } catch {
      return { complete: false, reason: "ENUMERATION_FAILED" };
    }
    if (listed.list_complete === false) {
      return { complete: false, reason: "ENUMERATION_INCOMPLETE" };
    }

    for (const key of listed.keys) {
      let raw: string | null = null;
      try {
        raw = await env.CREATOR_CREDITS.get(key.name);
      } catch {
        unresolved.push(key.name);
        continue;
      }
      if (typeof raw !== "string" || !raw) continue; // dangling pointer

      // The lifecycle index stores the full record; the capsule index
      // stores a credit id pointer. Normalise both into a record.
      let record: Record<string, unknown> | null = null;
      let creditId: string | null = null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && "id" in (parsed as object)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        record = null;
      }
      if (!record) {
        creditId = raw.trim();
        const recordRaw = await env.CREATOR_CREDITS.get(`creator:credit:${creditId}`);
        if (typeof recordRaw !== "string" || !recordRaw) {
          unresolved.push(key.name);
          continue;
        }
        try {
          record = JSON.parse(recordRaw) as Record<string, unknown>;
        } catch {
          unresolved.push(key.name);
          continue;
        }
      }
      if (!record) {
        unresolved.push(key.name);
        continue;
      }

      const id = typeof record["id"] === "string" ? record["id"] : creditId;
      if (!id || id !== (creditId ?? id)) {
        unresolved.push(key.name);
        continue;
      }
      if (record["creatorIdentityId"] !== creatorIdentityId) {
        // A foreign record reachable through this identity's prefix is
        // an index inconsistency — never silently ignored.
        unresolved.push(key.name);
        continue;
      }
      if (record["status"] !== "AVAILABLE" && record["status"] !== "CONSUMING" && record["status"] !== "CONSUMED") {
        unresolved.push(key.name);
        continue;
      }
      if (!resolved.has(id)) {
        resolved.set(id, {
          id,
          creatorIdentityId,
          status: record["status"] as IdentityIndexEntry["status"],
          capsuleId: typeof record["capsuleId"] === "string" ? record["capsuleId"] : null,
          lifecycleId: typeof record["lifecycleId"] === "string" ? record["lifecycleId"] : null,
          quoteId: typeof record["quoteId"] === "string" ? record["quoteId"] : null,
          revision: typeof record["revision"] === "number" ? record["revision"] : 1,
          updatedAt: typeof record["updatedAt"] === "number" ? record["updatedAt"] : Date.now(),
        });
      }
    }
  }

  if (unresolved.length > 0) {
    // Do NOT mark the backfill complete: an old right whose state could
    // not be determined blocks new purchases until it is resolved.
    await state.storage.put(backfillKey(creatorIdentityId), {
      complete: false,
      completedAt: 0,
      unresolved,
    } satisfies IdentityBackfillRecord);
    return { complete: false, reason: "ENTITLEMENT_STATE_UNKNOWN" };
  }

  // Merge: existing (newer) entries win; add only what is missing.
  const existing = await readIdentityEntries(state, creatorIdentityId);
  const known = new Set(existing.map((e) => e.id));
  for (const [id, entry] of resolved) {
    if (!known.has(id)) {
      await state.storage.put(identityIndexKey(creatorIdentityId, id), entry);
      await rememberCreditId(state, creatorIdentityId, id);
    }
  }

  await state.storage.put(backfillKey(creatorIdentityId), {
    complete: true,
    completedAt: Date.now(),
    unresolved: [],
  } satisfies IdentityBackfillRecord);
  return { complete: true };
}

/**
 * Read-through refresh of LIVE index entries from the per-credit
 * coordinators (op "read"), which are the strongly consistent
 * authorities for each credit's transitions.
 *
 * Why: a note-reserve/note-finalize call can fail after the
 * authoritative per-credit transition already happened. The index then
 * overstates liveness ("AVAILABLE" for a credit that is actually
 * CONSUMING/CONSUMED). Refreshing before a purchase decision replaces
 * that overstatement with the per-credit coordinator's own answer.
 *
 * Direction is fail-closed by construction:
 *  - FOUND      -> the snapshot is replaced by the authoritative record
 *  - NOT_FOUND  -> a granted-but-never-reserved credit has no DO record
 *                  (handleReserve creates it lazily); the snapshot is
 *                  KEPT (still live), never cleared
 *  - error      -> the snapshot is kept
 * No entry can ever become "less live" than the index already claims
 * unless the authoritative record says so.
 */
async function refreshIdentityEntries(
  state: DurableObjectState,
  env: CoordinatorEnv,
  creatorIdentityId: string
): Promise<void> {
  const binding = env.CREDIT_OP_COORDINATOR;
  if (!binding) return;

  const entries = await readIdentityEntries(state, creatorIdentityId);
  for (const entry of entries) {
    if (!isLiveStatus(entry.status)) continue;
    try {
      const stub = binding.get(binding.idFromName(entry.id));
      const res = await stub.fetch(
        new Request("https://aeterna-credit-coordinator.invalid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "read", creatorCreditId: entry.id }),
        })
      );
      if (!res.ok) continue;
      const read = (await res.json()) as {
        outcome?: string;
        status?: string;
        lifecycleId?: string | null;
        capsuleId?: string | null;
        revision?: number;
        creatorIdentityId?: string;
      };
      if (read.outcome !== "FOUND") continue;
      if (
        read.status !== "AVAILABLE" &&
        read.status !== "CONSUMING" &&
        read.status !== "CONSUMED"
      ) {
        continue;
      }
      if (read.creatorIdentityId && read.creatorIdentityId !== creatorIdentityId) {
        continue;
      }
      const refreshed: IdentityIndexEntry = {
        ...entry,
        status: read.status,
        lifecycleId: read.lifecycleId ?? null,
        capsuleId: read.capsuleId ?? entry.capsuleId,
        revision: typeof read.revision === "number" ? read.revision : entry.revision,
        updatedAt: Date.now(),
      };
      await state.storage.put(identityIndexKey(creatorIdentityId, entry.id), refreshed);
    } catch {
      // Unreachable per-credit coordinator: keep the conservative snapshot.
    }
  }
}

/**
 * Shared decision core: backfill (once) + read-through refresh.
 * Returns the LIVE entries (AVAILABLE/CONSUMING) and the active
 * attempt, or a fail-closed error when the state is not fully known.
 */
async function computeIdentityState(
  state: DurableObjectState,
  env: CoordinatorEnv,
  creatorIdentityId: string
): Promise<
  | { ok: true; entries: IdentityIndexEntry[]; activeAttempt: PaymentAttemptRecord | null }
  | { ok: false; error: string }
> {
  const backfill = await ensureIdentityBackfilled(state, env, creatorIdentityId);
  if (!backfill.complete) {
    return { ok: false, error: backfill.reason ?? "ENTITLEMENT_STATE_UNKNOWN" };
  }
  await refreshIdentityEntries(state, env, creatorIdentityId);

  const entries = await readIdentityEntries(state, creatorIdentityId);
  const activePointer = await state.storage.get<{
    paymentIntentId: string;
    state: string;
  }>(activeAttemptKey(creatorIdentityId));

  let activeAttempt: PaymentAttemptRecord | null = null;
  if (
    activePointer &&
    (activePointer.state === "reserved" || activePointer.state === "granting")
  ) {
    activeAttempt =
      (await state.storage.get<PaymentAttemptRecord>(
        attemptKey(creatorIdentityId, activePointer.paymentIntentId)
      )) ?? null;
  }
  return { ok: true, entries, activeAttempt: activeAttempt ?? null };
}

function liveEntries(entries: IdentityIndexEntry[]): IdentityIndexEntry[] {
  return entries.filter((entry) => isLiveStatus(entry.status));
}

async function handleIdentitySummary(
  state: DurableObjectState,
  env: CoordinatorEnv,
  request: Operation & { op: "identity-summary" }
): Promise<Response> {
  const { creatorIdentityId } = request;
  if (typeof creatorIdentityId !== "string" || !creatorIdentityId) {
    return identityFailure("INVALID_FIELDS", 400);
  }

  const stateResult = await computeIdentityState(state, env, creatorIdentityId);
  if (!stateResult.ok) {
    return identityFailure(stateResult.error, 409);
  }

  const available = stateResult.entries.filter((e) => e.status === "AVAILABLE");
  const consuming = stateResult.entries.filter((e) => e.status === "CONSUMING");
  const consumedCount = stateResult.entries.filter((e) => e.status === "CONSUMED").length;

  return identitySuccess({
    creatorIdentityId,
    available: available.map((e) => ({
      creatorCreditId: e.id,
      capsuleId: e.capsuleId,
      lifecycleId: e.lifecycleId,
      updatedAt: e.updatedAt,
    })),
    consuming: consuming.map((e) => ({
      creatorCreditId: e.id,
      lifecycleId: e.lifecycleId,
      capsuleId: e.capsuleId,
      updatedAt: e.updatedAt,
    })),
    summary: {
      availableCount: available.length,
      consumingCount: consuming.length,
      consumedCount,
      total: stateResult.entries.length,
      enumerationComplete: true,
    },
    activeAttempt: stateResult.activeAttempt
      ? {
          paymentIntentId: stateResult.activeAttempt.paymentIntentId,
          quoteId: stateResult.activeAttempt.quoteId,
          state: stateResult.activeAttempt.state,
          createdAt: stateResult.activeAttempt.createdAt,
          /**
           * Read-through of the EXISTING record: the signature already
           * bound for this attempt, if any. Reported so a caller that
           * lost its local pointer can resume VERIFYING that same
           * transaction instead of signing a new one.
           */
          broadcastSignature: stateResult.activeAttempt.broadcastSignature,
          transactionId: stateResult.activeAttempt.transactionId,
        }
      : null,
  });
}

/**
 * Atomic purchase-attempt reservation (called by create-quote BEFORE
 * any payment intent is minted).
 *
 * Under the Durable Object input gate this get -> decide -> put
 * sequence is atomic for this identity: two concurrent create-quote
 * requests (two tabs, two devices) can never both reserve. The winner
 * gets a fresh attempt; the loser is told to CONTINUE the winner's
 * attempt instead of creating a second purchase.
 */
async function handleIdentityReserveAttempt(
  state: DurableObjectState,
  env: CoordinatorEnv,
  request: Operation & { op: "identity-reserve-attempt" }
): Promise<Response> {
  const { creatorIdentityId, quoteId, paymentIntentId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof quoteId !== "string" || !quoteId ||
    typeof paymentIntentId !== "string" || !paymentIntentId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }

  const stateResult = await computeIdentityState(state, env, creatorIdentityId);
  if (!stateResult.ok) {
    return identityFailure(stateResult.error, 409);
  }

  const live = liveEntries(stateResult.entries);
  if (live.length > 0) {
    // A right already exists: a new purchase is not merely unnecessary,
    // it is refused. The existing rights are returned so the caller can
    // route the creator to creation (AVAILABLE) or to recovery
    // (CONSUMING) instead of to a second $1.
    return identityFailure("CREATOR_ALREADY_HAS_LIVE_RIGHT", 409);
  }

  if (stateResult.activeAttempt) {
    // An unfinished purchase exists: continue THAT attempt, never mint a
    // second independent one. The active attempt is returned so the
    // caller can resume the SAME payment intent (and its quote).
    return new Response(
      JSON.stringify({
        ok: false,
        error: "PAYMENT_ATTEMPT_ACTIVE",
        activeAttempt: {
          paymentIntentId: stateResult.activeAttempt.paymentIntentId,
          quoteId: stateResult.activeAttempt.quoteId,
          state: stateResult.activeAttempt.state,
          createdAt: stateResult.activeAttempt.createdAt,
          /**
           * READ-ONLY read-through of the existing record. This is the
           * discovery path for a client whose local pending pointer was
           * lost: the already-bound transaction signature is reported so
           * the SAME transaction can be verified — never a new one.
           * Nothing is written here.
           */
          broadcastSignature: stateResult.activeAttempt.broadcastSignature,
          transactionId: stateResult.activeAttempt.transactionId,
        },
      }),
      {
        status: 409,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }
    );
  }

  const now = Date.now();
  const attempt: PaymentAttemptRecord = {
    paymentIntentId,
    quoteId,
    creatorIdentityId,
    state: "reserved",
    creatorCreditId: null,
    transactionId: null,
    broadcastSignature: null,
    createdAt: now,
    updatedAt: now,
  };
  await state.storage.put(attemptKey(creatorIdentityId, paymentIntentId), attempt);
  await state.storage.put(activeAttemptKey(creatorIdentityId), {
    paymentIntentId,
    state: "reserved",
  });

  return identitySuccess({ paymentIntentId, quoteId, state: "reserved" });
}

/**
 * Atomic grant authorization (called by grant-credit BEFORE the credit
 * is minted, AFTER the payment was verified server-side).
 *
 * The credit id is minted HERE, inside the identity coordinator, so a
 * crash between authorization and the per-quote grant can be retried
 * safely: a re-authorization for the same attempt returns the SAME id,
 * and a note-grant for any other id is refused.
 */
async function handleIdentityAuthorizeGrant(
  state: DurableObjectState,
  env: CoordinatorEnv,
  request: Operation & { op: "identity-authorize-grant" }
): Promise<Response> {
  const { creatorIdentityId, quoteId, paymentIntentId, transactionId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof quoteId !== "string" || !quoteId ||
    typeof paymentIntentId !== "string" || !paymentIntentId ||
    typeof transactionId !== "string" || !transactionId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }

  const attempt = await state.storage.get<PaymentAttemptRecord>(
    attemptKey(creatorIdentityId, paymentIntentId)
  );
  if (!attempt) {
    return identityFailure("GRANT_NOT_RESERVED", 409);
  }
  if (attempt.creatorIdentityId !== creatorIdentityId || attempt.quoteId !== quoteId) {
    return identityFailure("GRANT_ATTEMPT_MISMATCH", 409);
  }

  if (attempt.state === "fulfilled") {
    if (!attempt.creatorCreditId) {
      return identityFailure("GRANT_STATE_UNKNOWN", 409);
    }
    // Idempotent re-authorization of an already recorded grant.
    return identitySuccess({
      creatorCreditId: attempt.creatorCreditId,
      state: "fulfilled",
    });
  }
  if (attempt.state !== "reserved") {
    // "granting": the first authorization interrupted — resume it with
    // the SAME credit id (safe retry of the same payment).
    if (!attempt.creatorCreditId) {
      return identityFailure("GRANT_STATE_UNKNOWN", 409);
    }
    return identitySuccess({
      creatorCreditId: attempt.creatorCreditId,
      state: attempt.state,
    });
  }

  const stateResult = await computeIdentityState(state, env, creatorIdentityId);
  if (!stateResult.ok) {
    return identityFailure(stateResult.error, 409);
  }
  const live = liveEntries(stateResult.entries);
  if (live.length > 0) {
    // A live right appeared between reservation and grant (e.g. a
    // recovery restored an unfinished one). Refuse a SECOND credit:
    // the payment stays recorded as an unfinished grant, recoverable
    // by the existing replay path — never a new purchase.
    return identityFailure("CREATOR_ALREADY_HAS_LIVE_RIGHT", 409);
  }

  const creatorCreditId = generateGrantCreditId();
  const updated: PaymentAttemptRecord = {
    ...attempt,
    state: "granting",
    creatorCreditId,
    transactionId,
    updatedAt: Date.now(),
  };
  await state.storage.put(attemptKey(creatorIdentityId, paymentIntentId), updated);
  await state.storage.put(activeAttemptKey(creatorIdentityId), {
    paymentIntentId,
    state: "granting",
  });

  return identitySuccess({ creatorCreditId, state: "granting" });
}

/**
 * Records the minted credit in the identity index and fulfils the
 * attempt. Idempotent: a replay of the SAME (attempt, creditId) is a
 * no-op success; a different creditId for the same attempt is refused.
 */
async function handleIdentityNoteGrant(
  state: DurableObjectState,
  env: CoordinatorEnv,
  request: Operation & { op: "identity-note-grant" }
): Promise<Response> {
  const { creatorIdentityId, quoteId, paymentIntentId, creatorCreditId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof quoteId !== "string" || !quoteId ||
    typeof paymentIntentId !== "string" || !paymentIntentId ||
    typeof creatorCreditId !== "string" || !creatorCreditId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }

  const attempt = await state.storage.get<PaymentAttemptRecord>(
    attemptKey(creatorIdentityId, paymentIntentId)
  );
  if (!attempt) {
    return identityFailure("GRANT_NOT_RESERVED", 409);
  }
  if (attempt.creatorIdentityId !== creatorIdentityId || attempt.quoteId !== quoteId) {
    return identityFailure("GRANT_ATTEMPT_MISMATCH", 409);
  }

  if (attempt.state === "fulfilled") {
    if (attempt.creatorCreditId === creatorCreditId) {
      return identitySuccess({ outcome: "ALREADY_RECORDED", creatorCreditId });
    }
    return identityFailure("GRANT_CREDIT_MISMATCH", 409);
  }

  if (attempt.creatorCreditId !== creatorCreditId) {
    return identityFailure("GRANT_CREDIT_MISMATCH", 409);
  }

  const stateResult = await computeIdentityState(state, env, creatorIdentityId);
  if (!stateResult.ok) {
    return identityFailure(stateResult.error, 409);
  }
  const live = liveEntries(stateResult.entries);
  if (live.length > 0) {
    return identityFailure("CREATOR_ALREADY_HAS_LIVE_RIGHT", 409);
  }

  const now = Date.now();
  await state.storage.put(identityIndexKey(creatorIdentityId, creatorCreditId), {
    id: creatorCreditId,
    creatorIdentityId,
    status: "AVAILABLE",
    capsuleId: null,
    lifecycleId: null,
    quoteId,
    revision: 1,
    updatedAt: now,
  } satisfies IdentityIndexEntry);
  await rememberCreditId(state, creatorIdentityId, creatorCreditId);

  await state.storage.put(attemptKey(creatorIdentityId, paymentIntentId), {
    ...attempt,
    state: "fulfilled",
    updatedAt: now,
  } satisfies PaymentAttemptRecord);
  await state.storage.put(activeAttemptKey(creatorIdentityId), {
    paymentIntentId,
    state: "fulfilled",
  });

  return identitySuccess({ outcome: "RECORDED", creatorCreditId });
}

/**
 * Index maintenance for the remaining credit transitions. Each runs
 * AFTER the authoritative per-credit coordinator accepted the
 * transition, so the index can only ever follow reality.
 *
 * A missing entry is inserted (repair of a lost note) rather than
 * failing: the credit demonstrably exists in the per-credit
 * coordinator, and an absent index entry would understate liveness —
 * the unsafe direction.
 */
async function noteCreditTransition(
  state: DurableObjectState,
  creatorIdentityId: string,
  creatorCreditId: string,
  next: {
    status: IdentityIndexEntry["status"];
    lifecycleId: string | null;
    capsuleId?: string | null;
    bumpRevision?: boolean;
  }
): Promise<Response> {
  const existing = await state.storage.get<IdentityIndexEntry>(
    identityIndexKey(creatorIdentityId, creatorCreditId)
  );
  if (existing && existing.creatorIdentityId !== creatorIdentityId) {
    return identityFailure("IDENTITY_MISMATCH", 409);
  }

  const now = Date.now();
  const entry: IdentityIndexEntry = {
    id: creatorCreditId,
    creatorIdentityId,
    status: next.status,
    capsuleId:
      next.capsuleId !== undefined
        ? next.capsuleId
        : existing?.capsuleId ?? null,
    lifecycleId: next.lifecycleId,
    quoteId: existing?.quoteId ?? null,
    revision: (existing?.revision ?? 0) + (next.bumpRevision ? 1 : 1),
    updatedAt: now,
  };
  await state.storage.put(identityIndexKey(creatorIdentityId, creatorCreditId), entry);
  await rememberCreditId(state, creatorIdentityId, creatorCreditId);
  return identitySuccess({
    outcome: "RECORDED",
    creatorCreditId,
    status: next.status,
  });
}

async function handleIdentityNoteReserve(
  state: DurableObjectState,
  request: Operation & { op: "identity-note-reserve" }
): Promise<Response> {
  const { creatorIdentityId, creatorCreditId, lifecycleId, capsuleId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof creatorCreditId !== "string" || !creatorCreditId ||
    typeof lifecycleId !== "string" || !lifecycleId ||
    typeof capsuleId !== "string" || !capsuleId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }
  return noteCreditTransition(state, creatorIdentityId, creatorCreditId, {
    status: "CONSUMING",
    lifecycleId,
    capsuleId,
  });
}

async function handleIdentityNoteFinalize(
  state: DurableObjectState,
  request: Operation & { op: "identity-note-finalize" }
): Promise<Response> {
  const { creatorIdentityId, creatorCreditId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof creatorCreditId !== "string" || !creatorCreditId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }
  return noteCreditTransition(state, creatorIdentityId, creatorCreditId, {
    status: "CONSUMED",
    lifecycleId: null,
    bumpRevision: true,
  });
}

async function handleIdentityNoteRecover(
  state: DurableObjectState,
  request: Operation & { op: "identity-note-recover" }
): Promise<Response> {
  const { creatorIdentityId, creatorCreditId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof creatorCreditId !== "string" || !creatorCreditId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }
  return noteCreditTransition(state, creatorIdentityId, creatorCreditId, {
    status: "AVAILABLE",
    lifecycleId: null,
    bumpRevision: true,
  });
}

/**
 * Read-only resolution of one purchase attempt, scoped to a candidate
 * identity. The caller (the broadcast endpoint) uses it to learn the
 * AUTHORITATIVE attempt state; the candidate identity is only a hint —
 * the endpoint independently requires the transaction's payer account
 * to belong to that identity, so a wrong hint cannot authorise anything.
 */
async function handleIdentityResolveIntent(
  state: DurableObjectState,
  request: Operation & { op: "identity-resolve-intent" }
): Promise<Response> {
  const { creatorIdentityId, paymentIntentId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof paymentIntentId !== "string" || !paymentIntentId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }

  const attempt = await state.storage.get<PaymentAttemptRecord>(
    attemptKey(creatorIdentityId, paymentIntentId)
  );
  if (!attempt || attempt.creatorIdentityId !== creatorIdentityId) {
    return identityFailure("INTENT_UNKNOWN", 409);
  }

  return identitySuccess({
    creatorIdentityId: attempt.creatorIdentityId,
    paymentIntentId: attempt.paymentIntentId,
    quoteId: attempt.quoteId,
    state: attempt.state,
    creatorCreditId: attempt.creatorCreditId,
    transactionId: attempt.transactionId,
    broadcastSignature: attempt.broadcastSignature,
  });
}

/**
 * Atomically binds ONE transaction signature to one purchase attempt,
 * BEFORE any broadcast.
 *
 * Under the Durable Object input gate the get -> decide -> put sequence
 * is atomic for this identity, so concurrent requests carrying two
 * different signatures can never both be authorised: the first wins and
 * the second is refused. The same signature is an idempotent replay
 * (a lost HTTP response must not become a second transfer).
 */
async function handleIdentityBindBroadcastSignature(
  state: DurableObjectState,
  request: Operation & { op: "identity-bind-broadcast-signature" }
): Promise<Response> {
  const { creatorIdentityId, paymentIntentId, transactionId } = request;
  if (
    typeof creatorIdentityId !== "string" || !creatorIdentityId ||
    typeof paymentIntentId !== "string" || !paymentIntentId ||
    typeof transactionId !== "string" || !transactionId
  ) {
    return identityFailure("INVALID_FIELDS", 400);
  }

  const attempt = await state.storage.get<PaymentAttemptRecord>(
    attemptKey(creatorIdentityId, paymentIntentId)
  );
  if (!attempt || attempt.creatorIdentityId !== creatorIdentityId) {
    return identityFailure("INTENT_UNKNOWN", 409);
  }

  if (attempt.state === "granting" || attempt.state === "fulfilled") {
    // A payment is already recorded for this attempt: broadcasting a
    // transaction here would be a second transfer.
    return identityFailure("INTENT_ALREADY_PAID", 409);
  }
  if (attempt.state !== "reserved") {
    return identityFailure("INTENT_NOT_PAYABLE", 409);
  }

  const bound = attempt.broadcastSignature;
  if (bound) {
    if (bound === transactionId) {
      return identitySuccess({ outcome: "ALREADY_BOUND", transactionId });
    }
    return identityFailure("SIGNATURE_ALREADY_BOUND", 409);
  }

  const updated: PaymentAttemptRecord = {
    ...attempt,
    broadcastSignature: transactionId,
    updatedAt: Date.now(),
  };
  await state.storage.put(attemptKey(creatorIdentityId, paymentIntentId), updated);

  return identitySuccess({ outcome: "BOUND", transactionId });
}

export class CreditOperationCoordinator {
  constructor(private state: DurableObjectState, private env: CoordinatorEnv) {}

  async fetch(request: Request): Promise<Response> {
    let body: Operation;
    try {
      body = (await request.json()) as Operation;
    } catch {
      return failureResponse("INVALID_JSON", 400);
    }

    if (!body || typeof body !== "object" || !("op" in body)) {
      return failureResponse("INVALID_REQUEST", 400);
    }

    switch (body.op) {
      case "reserve":
        return handleReserve(this.state, this.env, body);
      case "finalize":
        return handleFinalize(this.state, this.env, body);
      case "recover":
        return handleRecover(this.state, this.env, body);
      case "vault-publication-claim":
        return handleVaultPublicationClaim(this.state, this.env, body);
      case "container-publication-claim":
        return handleContainerPublicationClaim(this.state, body);
      case "payment-tx-claim":
        return handlePaymentTxClaim(this.state, body);
      case "payment-tx-check":
        return handlePaymentTxCheck(this.state, body);
      case "grant":
        return handleGrant(this.state, this.env, body);
      case "identity-summary":
        return handleIdentitySummary(this.state, this.env, body);
      case "identity-reserve-attempt":
        return handleIdentityReserveAttempt(this.state, this.env, body);
      case "identity-authorize-grant":
        return handleIdentityAuthorizeGrant(this.state, this.env, body);
      case "identity-note-grant":
        return handleIdentityNoteGrant(this.state, this.env, body);
      case "identity-note-reserve":
        return handleIdentityNoteReserve(this.state, body);
      case "identity-note-finalize":
        return handleIdentityNoteFinalize(this.state, body);
      case "identity-note-recover":
        return handleIdentityNoteRecover(this.state, body);
      case "identity-resolve-intent":
        return handleIdentityResolveIntent(this.state, body);
      case "identity-bind-broadcast-signature":
        return handleIdentityBindBroadcastSignature(this.state, body);
      case "read": {
        const credit = await getCreditRecord(this.state, body.creatorCreditId);
        if (!credit) {
          return creditReadResponse({
            ok: true,
            outcome: "NOT_FOUND",
            status: "AVAILABLE",
            creatorCreditId: body.creatorCreditId,
            creatorIdentityId: "",
            capsuleId: "",
            lifecycleId: null,
            paymentIntentId: null,
            revision: 0,
          });
        }
        return creditReadResponse({
          ok: true,
          outcome: "FOUND",
          status: credit.status,
          creatorCreditId: credit.id,
          creatorIdentityId: credit.creatorIdentityId,
          capsuleId: credit.capsuleId,
          lifecycleId: credit.lifecycleId,
          paymentIntentId: credit.paymentIntentId ?? null,
          revision: credit.revision,
        });
      }
      default:
        return failureResponse("UNKNOWN_OPERATION", 400);
    }
  }
}
