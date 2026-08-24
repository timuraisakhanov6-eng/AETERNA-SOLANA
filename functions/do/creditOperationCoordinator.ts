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
  | { op: "reserve"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string }
  | { op: "finalize"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string; publicationVerified: boolean; sealVerified: boolean }
  | { op: "recover"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string; publicationState: string; sealState: string }
  | { op: "vault-publication-claim"; creatorCreditId: string; creatorIdentityId: string; lifecycleId: string; capsuleId: string }
  | { op: "read"; creatorCreditId: string };

interface CoordinatorEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
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

async function handleReserve(state: DurableObjectState, env: CoordinatorEnv, request: Operation & { op: "reserve" }): Promise<Response> {
  const { creatorCreditId, creatorIdentityId, lifecycleId, capsuleId } = request;

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

async function handleVaultPublicationClaim(state: DurableObjectState, env: CoordinatorEnv, request: Operation & { op: "vault-publication-claim" }): Promise<Response> {
  const { creatorCreditId, creatorIdentityId, lifecycleId, capsuleId } = request;

  const idempotencyKey = opKey(creatorCreditId, "vault-publication-claim", lifecycleId);
  const existing = await getOpResult(state, idempotencyKey);

  if (existing && existing.creatorCreditId === creatorCreditId && existing.lifecycleId === lifecycleId) {
    if (existing.outcome === "VAULT_PUBLICATION_EXPLICIT_FAILURE") {
      return failureResponse(
        existing.outcome,
        409,
        creatorCreditId,
        lifecycleId,
        existing.status,
        existing.revision
      );
    }

    return successResponse({
      ok: true,
      outcome: existing.outcome,
      status: existing.status,
      creatorCreditId,
      lifecycleId,
      revision: existing.revision,
    });
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
  const { creatorCreditId, creatorIdentityId, lifecycleId, capsuleId, publicationState, sealState } = request;

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

  if (publicationState === "VERIFIED" && sealState === "VERIFIED") {
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
      case "read": {
        const credit = await getCreditRecord(this.state, body.creatorCreditId);
        if (!credit) {
          return successResponse({
            ok: true,
            outcome: "NOT_FOUND",
            status: "AVAILABLE",
            creatorCreditId: body.creatorCreditId,
            lifecycleId: null,
            revision: 0,
          });
        }
        return successResponse({
          ok: true,
          outcome: "FOUND",
          status: credit.status,
          creatorCreditId: credit.id,
          lifecycleId: credit.lifecycleId,
          revision: credit.revision,
        });
      }
      default:
        return failureResponse("UNKNOWN_OPERATION", 400);
    }
  }
}
