/**
 * AETERNA — Publication Claim (Creator-paid Irys architecture)
 *
 * POST /api/publication/claim
 *
 * Canonical chain:
 *   PAYMENT_VERIFIED (storage payment)
 *   → creator-paid Irys publication (client evidence: txId)
 *   → server-side Irys Node confirmation
 *   → server-authored publication authority
 *      (vault: PUBLICATION_VERIFICATIONS = PENDING,
 *       container: PUBLICATION_VERIFICATIONS container record)
 *   → existing /api/publication/verify → VERIFIED
 *
 * Executor Hot is NOT part of this flow: no keys, no funding, no
 * server-side upload. The client txId is upload EVIDENCE only — the
 * server independently confirms it against the Irys Node before any
 * authority record is written. Client state/hash/destination/payer
 * fields are never accepted.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { confirmTxOnIrysNode } from "../../lib/irys/node";
import { getStoragePayment } from "../../lib/storage/storagePaymentStore";
import {
  assertContainerPublicationRecord,
  buildContainerPublicationRecord,
  containerPublicationKey,
  putContainerPublication,
  type ContainerPublicationRecord,
} from "../../../src/lib/storage/container/containerPublication";
import { claimContainerPublication } from "../../lib/containerPublicationClaim";
import { SHA256_REGEX, STORAGE_POINTER_REGEX } from "../../../src/lib/crypto/validators";

/* ================= ENV ================= */

interface PublicationClaimEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
  };
  PREPARED_PROJECTIONS: {
    get(key: string): Promise<string | null>;
  };
  STORAGE_PAYMENTS: {
    get(key: string): Promise<string | null>;
  };
  PUBLICATION_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
  /**
   * Authoritative serialization boundary for the container publication
   * claim (Stage 4.1). Optional at the type level so a misconfigured
   * environment fails CLOSED rather than silently falling back to a
   * non-atomic KV read/check/put.
   */
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): DurableObjectStub;
  };
  DEBUG?: "true" | "false";
}

/* ================= ORIGINS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && PAGES_PREVIEW_REGEX.test(url.hostname)) return true;
  } catch {
    // ignore
  }
  return false;
}

/* ================= HELPERS ================= */

function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: baseHeaders(origin),
  });
}

function parseInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Establish the AUTHORITATIVE vault-publication claim in the per-credit
 * CreditOperationCoordinator, BEFORE any KV publication projection exists.
 *
 * WHY: the coordinator's rebind decision must never rest on a missing KV
 * record (KV is eventually consistent and a read can hide a record). This
 * claim is strongly consistent evidence that the lifecycle reached the
 * publication stage, so it is written FIRST and a failure here prevents the
 * KV publication record from being created at all.
 *
 * ADDRESSING: `idFromName(creatorCreditId)` — that instance owns the
 * authoritative per-credit record (reserve / recover / finalize and the
 * lazily created credit record all live there). The identity instance
 * (`identity:<creatorIdentityId>`) and the grant instance
 * (`<creatorIdentityId>:<quoteId>`) hold no credit record and would answer
 * LIFECYCLE_NOT_FOUND.
 *
 * The payload carries exactly the fields the coordinator handler consumes
 * (`op`, `creatorCreditId`, `creatorIdentityId`, `lifecycleId`,
 * `capsuleId`); the transaction id and the storage payment were already
 * validated above, and the handler's own idempotency key is
 * (creatorCreditId, lifecycleId).
 *
 * FAILS CLOSED on any refusal, transport error or unverifiable answer: the
 * caller must not write the KV publication projection in that case, and no
 * outcome here ever records an explicit publication failure.
 */
async function requestVaultPublicationClaim(
  env: PublicationClaimEnv,
  input: {
    creatorCreditId: string;
    creatorIdentityId: string;
    lifecycleId: string;
    capsuleId: string;
  }
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const binding = env.CREDIT_OP_COORDINATOR;
  if (!binding) {
    return { ok: false, status: 503, error: "CREDIT_COORDINATOR_UNAVAILABLE" };
  }

  let response: Response;
  try {
    const stub = binding.get(binding.idFromName(input.creatorCreditId));
    response = await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "vault-publication-claim",
          creatorCreditId: input.creatorCreditId,
          creatorIdentityId: input.creatorIdentityId,
          lifecycleId: input.lifecycleId,
          capsuleId: input.capsuleId,
        }),
      })
    );
  } catch {
    return { ok: false, status: 503, error: "CREDIT_COORDINATOR_UNAVAILABLE" };
  }

  let data: { ok?: unknown; error?: unknown } | null = null;
  try {
    data = (await response.json()) as { ok?: unknown; error?: unknown };
  } catch {
    data = null;
  }

  if (response.status === 200 && data?.ok === true) {
    return { ok: true };
  }

  /**
   * Fail closed. A 200 WITHOUT `ok: true` is an unverifiable answer, never a
   * success; a refusal keeps the coordinator's own reason.
   */
  const error =
    typeof data?.error === "string" && data.error
      ? data.error
      : "PUBLICATION_CLAIM_UNVERIFIED";
  const status =
    response.status === 400
      ? 400
      : response.status >= 500 || response.status === 200
      ? 503
      : 409;
  return { ok: false, status, error };
}

/**
 * R9-A92 F1 — authoritative lifecycle verification through the EXISTING
 * `op: "read"` coordinator operation (the exact precedent is
 * upload-token's authoritative-read path).
 *
 * WHY THIS IS SAFE
 * ----------------
 * • The read creates, reserves, repairs or mutates NOTHING — it is the
 *   coordinator's pure read of its own persisted credit record.
 * • Every authorizing field is taken from the SERVER-PERSISTED record
 *   and re-validated against THIS request. Request fields alone never
 *   authorize publication; a wrong creatorCreditId address can only
 *   reach a record whose identity cannot match, which fails closed.
 * • The coordinator is the same strongly-consistent authority that
 *   WROTE the reservation, so a positive answer here cannot be a stale
 *   KV observation.
 * • Every failure shape fails closed: missing binding, transport error,
 *   non-200, malformed body, NOT_FOUND, non-CONSUMING state, and any
 *   identity/capsule/lifecycle mismatch — each with the SAME error code
 *   the KV path would have produced.
 */
async function readLifecycleFromCoordinator(
  env: PublicationClaimEnv,
  input: {
    creatorCreditId: string;
    creatorIdentityId: string;
    lifecycleId: string;
    capsuleId: string;
  }
): Promise<
  | {
      ok: true;
      lifecycle: {
        id: string;
        status: string;
        creatorIdentityId: string;
        capsuleId: string;
      };
    }
  | { ok: false; status: number; error: string }
> {
  const binding = env.CREDIT_OP_COORDINATOR;
  if (!binding) {
    return { ok: false, status: 503, error: "CREDIT_COORDINATOR_UNAVAILABLE" };
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
    return { ok: false, status: 503, error: "CREDIT_COORDINATOR_UNAVAILABLE" };
  }

  if (!response.ok) {
    return { ok: false, status: 503, error: "CREDIT_COORDINATOR_UNAVAILABLE" };
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

  // An unverifiable answer is never a success and never a repair.
  if (!data || data.ok !== true || data.outcome !== "FOUND") {
    return { ok: false, status: 409, error: "LIFECYCLE_NOT_RESERVED" };
  }

  const canonicalIdentity =
    typeof data.creatorIdentityId === "string" ? data.creatorIdentityId : "";
  const canonicalCapsuleId =
    typeof data.capsuleId === "string" ? data.capsuleId : "";
  const canonicalCreditId =
    typeof data.creatorCreditId === "string" && data.creatorCreditId.length > 0
      ? data.creatorCreditId
      : input.creatorCreditId;

  /**
   * R9-A92.1 — IDENTITY FIRST, then state.
   *
   * `creatorCreditId` is only an ADDRESS, so a caller may point it at any
   * credit. With the state check first, a foreign record answered
   * CREDIT_NOT_CONSUMING (and later CAPSULE_MISMATCH / LIFECYCLE_NOT_RESERVED),
   * which disclosed whether that credit exists and is reserved. Comparing
   * the AUTHORITATIVE identity before revealing any state collapses every
   * foreign record — whatever its status — into the same IDENTITY_MISMATCH.
   *
   * Authorization is unchanged: all four checks still run, and the values
   * compared are still the ones taken from the server-persisted record.
   */
  if (canonicalIdentity !== input.creatorIdentityId) {
    return { ok: false, status: 409, error: "IDENTITY_MISMATCH" };
  }
  if (data.status !== "CONSUMING") {
    return { ok: false, status: 409, error: "CREDIT_NOT_CONSUMING" };
  }
  if (canonicalCapsuleId !== input.capsuleId) {
    return { ok: false, status: 409, error: "CAPSULE_MISMATCH" };
  }
  if (data.lifecycleId !== input.lifecycleId) {
    return { ok: false, status: 409, error: "LIFECYCLE_NOT_RESERVED" };
  }

  /**
   * CANONICAL values from the authoritative record drive every
   * subsequent publication check — the request supplied only the address.
   */
  return {
    ok: true,
    lifecycle: {
      id: canonicalCreditId,
      status: "CONSUMING",
      creatorIdentityId: canonicalIdentity,
      capsuleId: canonicalCapsuleId,
    },
  };
}

/* ================= ENDPOINT ================= */

export async function onRequestOptions(
  context: EventContext<Record<string, unknown>, string, PublicationClaimEnv>
): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, PublicationClaimEnv>
): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return fail(origin, 403, "INVALID_ORIGIN");

  const ip = getClientIp(request);
  if (!rateLimit(ip)) return fail(origin, 429, "TOO_MANY_REQUESTS");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  /* ================= CLIENT EVIDENCE (identifiers + txId only) ================= */

  const creatorIdentityId = parseInput(body.creatorIdentityId);
  const lifecycleId = parseInput(body.lifecycleId);
  const capsuleId = parseInput(body.capsuleId);
  const storagePaymentId = parseInput(body.storagePaymentId);
  const txId = parseInput(body.txId);
  const kind = parseInput(body.kind);
  const layoutDigest = parseInput(body.layoutDigest);
  const chunkIdsRaw = body.chunkIds;
  /**
   * R9-A92 F1 — OPTIONAL authoritative-read ADDRESS (precedent:
   * upload-token). Never an authority field: it only addresses which
   * coordinator instance is consulted when the KV projection is absent.
   */
  const creatorCreditId = parseInput(body.creatorCreditId);

  if (!creatorIdentityId || !lifecycleId || !capsuleId || !storagePaymentId || !txId) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  if (kind !== "vault" && kind !== "container") {
    return fail(origin, 400, "INVALID_KIND");
  }

  /**
   * Container claims carry the canonical ORDERED logical chunk identity and
   * a digest over the canonical layout descriptor. Both are client EVIDENCE
   * (like txId) — the server records them authoritatively only after node
   * confirmation, and never treats them as capsule authority.
   */
  let containerChunkIds: string[] | null = null;

  if (kind === "container") {
    if (!Array.isArray(chunkIdsRaw) || chunkIdsRaw.length === 0) {
      return fail(origin, 400, "CONTAINER_CHUNK_IDS_REQUIRED");
    }

    const seen = new Set<string>();
    const collected: string[] = [];

    for (const entry of chunkIdsRaw) {
      if (typeof entry !== "string" || !SHA256_REGEX.test(entry)) {
        return fail(origin, 400, "INVALID_CONTAINER_CHUNK_ID");
      }
      if (seen.has(entry)) {
        return fail(origin, 400, "DUPLICATE_CONTAINER_CHUNK_ID");
      }
      seen.add(entry);
      collected.push(entry);
    }

    if (!layoutDigest || !SHA256_REGEX.test(layoutDigest)) {
      return fail(origin, 400, "INVALID_CONTAINER_LAYOUT_DIGEST");
    }

    containerChunkIds = collected;
  }

  if (!STORAGE_POINTER_REGEX.test(txId)) {
    return fail(origin, 400, "INVALID_TX_ID");
  }

  /* ================= 1. LIFECYCLE / IDENTITY / CAPSULE AUTHORITY ================= */

  /**
   * R9-A92 F1 — the KV lifecycle projection is an eventually-consistent
   * PROJECTION of the reservation the CreditOperationCoordinator wrote
   * (handleReserve → writeLifecycleIndex). A projection written seconds
   * ago can legitimately be invisible at this edge (default read
   * cacheTtl 60 s, negative lookups included), which used to fail a
   * legitimate, DO-confirmed reservation with 409 LIFECYCLE_NOT_RESERVED.
   *
   * Fallback: when the projection is ABSENT and the request carries a
   * creatorCreditId ADDRESS, the EXISTING `op: "read"` coordinator
   * operation (the same one upload-token uses) is consulted. The DO is
   * the authoritative author of the reservation. Every authorizing field
   * is taken from the server-persisted record and re-validated against
   * this request; request fields alone never authorize anything, the
   * read creates/reserves nothing, and any mismatch, non-CONSUMING
   * state or unverifiable answer fails closed exactly as before.
   *
   * When the projection IS present, the original KV path runs unchanged.
   */

  const lifecycleRaw = await env.CREATOR_CREDITS.get(
    `creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`
  );

  let lifecycle: { id?: string; status?: string; creatorIdentityId?: string; capsuleId?: string } | null = null;

  if (lifecycleRaw !== null) {
    try {
      lifecycle = JSON.parse(lifecycleRaw);
    } catch {
      return fail(origin, 503, "CREDIT_STORAGE_CORRUPTED");
    }
  } else if (creatorCreditId !== null) {
    const fallback = await readLifecycleFromCoordinator(env, {
      creatorCreditId,
      creatorIdentityId,
      lifecycleId,
      capsuleId,
    });
    if (!fallback.ok) {
      return fail(origin, fallback.status, fallback.error);
    }
    lifecycle = fallback.lifecycle;
  } else {
    return fail(origin, 409, "LIFECYCLE_NOT_RESERVED");
  }

  if (lifecycle?.status !== "CONSUMING") {
    return fail(origin, 409, "CREDIT_NOT_CONSUMING");
  }
  if (lifecycle.creatorIdentityId !== creatorIdentityId) {
    return fail(origin, 409, "IDENTITY_MISMATCH");
  }
  if (lifecycle.capsuleId !== capsuleId) {
    return fail(origin, 409, "CAPSULE_MISMATCH");
  }

  /* ================= 2. STORAGE PAYMENT AUTHORITY ================= */

  const paymentRaw = await env.STORAGE_PAYMENTS.get(`storage-payment:${storagePaymentId}`);
  if (!paymentRaw) {
    return fail(origin, 409, "STORAGE_PAYMENT_NOT_VERIFIED");
  }

  let payment: {
    state?: string;
    quote?: {
      creatorIdentityId?: string;
      lifecycleId?: string;
      capsuleId?: string;
    };
  } | null = null;
  try {
    payment = JSON.parse(paymentRaw);
  } catch {
    return fail(origin, 503, "STORAGE_PAYMENT_CORRUPTED");
  }

  if (payment?.state !== "PAYMENT_VERIFIED") {
    return fail(origin, 409, "STORAGE_PAYMENT_NOT_VERIFIED");
  }
  if (
    payment.quote?.creatorIdentityId !== creatorIdentityId ||
    payment.quote?.lifecycleId !== lifecycleId ||
    payment.quote?.capsuleId !== capsuleId
  ) {
    return fail(origin, 409, "STORAGE_PAYMENT_BINDING_MISMATCH");
  }

  /* ================= 3. TX DUPLICATE PROTECTION (secondary index) ================= */

  /**
   * The secondary index answers one question: "has this txId already been
   * claimed, and by whom?".
   *
   * It is an EXACT-REPLAY idempotency signal ONLY when the whole logical
   * identity matches — same lifecycle, same capsule, same kind.
   *
   * `kind` is already persisted on every index write, so no migration is
   * required to make this comparison exact.
   */
  const txIndexKey = `publication-tx:${txId}`;
  const txIndexRaw = await env.PUBLICATION_VERIFICATIONS.get(txIndexKey);
  if (txIndexRaw) {
    let txIndex: {
      lifecycleId?: string;
      capsuleId?: string;
      kind?: string;
    } | null = null;
    try {
      txIndex = JSON.parse(txIndexRaw);
    } catch {
      txIndex = null;
    }

    const sameOwner =
      txIndex !== null &&
      txIndex.lifecycleId === lifecycleId &&
      txIndex.capsuleId === capsuleId;

    // Cross-lifecycle / cross-capsule reuse is always forbidden.
    if (!sameOwner) {
      return fail(origin, 409, "TX_ALREADY_CLAIMED");
    }

    // Vault: an index hit for the same owner is an exact replay.
    if (kind === "vault" && txIndex.kind === "vault") {
      return new Response(
        JSON.stringify({ ok: true, claimed: true, state: "PENDING", lifecycleId, capsuleId, txId }),
        { status: 200, headers: baseHeaders(origin) }
      );
    }

    // Container: deliberately NOT short-circuited to 200 here. The tx index
    // does not carry the ordered chunk set, so it cannot prove an exact
    // replay. The container branch below owns the full identity comparison
    // (txId + ordered chunk set + layout digest) and returns 200 only for a
    // genuine replay, 409 CONTAINER_ALREADY_PUBLISHED otherwise.
  }

  /* ================= 4. NODE-FIRST CONFIRMATION ================= */

  const nodeConfirmation = await confirmTxOnIrysNode(txId);
  if (nodeConfirmation === "ABSENT") {
    return fail(origin, 409, "PUBLICATION_NOT_CONFIRMED");
  }
  if (nodeConfirmation === "UNAVAILABLE") {
    // No authority record is written before Node confirmation; the
    // claim is retryable.
    return fail(origin, 503, "PUBLICATION_NODE_UNAVAILABLE"); // details: nodeConfirmation via debug below
  }

  /* ================= 5. AUTHORITATIVE WRITE ================= */

  const now = Date.now();

  if (kind === "vault") {
    const publicationKey = `creator:publication:${lifecycleId}`;
    const existingRaw = await env.PUBLICATION_VERIFICATIONS.get(publicationKey);

    if (existingRaw) {
      let existing: { state?: string; expectedTxId?: string } | null = null;
      try {
        existing = JSON.parse(existingRaw);
      } catch {
        existing = null;
      }

      // Terminal replay: already-claimed lifecycle returns its state.
      if (existing?.state === "VERIFIED" || existing?.state === "REJECTED") {
        return new Response(
          JSON.stringify({ ok: true, state: existing.state, lifecycleId, capsuleId, txId }),
          { status: 200, headers: baseHeaders(origin) }
        );
      }

      // Same lifecycle claiming a DIFFERENT tx is forbidden.
      if (existing?.expectedTxId !== txId) {
        return fail(origin, 409, "PUBLICATION_ALREADY_BOUND");
      }

      // Same lifecycle + same tx (re-claim after partial claim) — idempotent.
      return new Response(
        JSON.stringify({ ok: true, claimed: true, state: existing.state ?? "PENDING", lifecycleId, capsuleId, txId }),
        { status: 200, headers: baseHeaders(origin) }
      );
    }

    // expectedVaultSha256 is NOT accepted from the client: it is
    // computed by /api/publication/verify from the gateway-fetched
    // bytes (server-side), exactly like the legacy upload path.

    /**
     * AUTHORITATIVE CLAIM FIRST, KV PROJECTION SECOND.
     *
     * Everything above validated ownership, lifecycle, capsule and the
     * storage payment, and the Irys node positively confirmed this exact
     * transaction. The strongly consistent coordinator claim is recorded
     * NOW, before the KV publication record exists: if it fails, times out
     * or comes back unverifiable, NO KV publication record is written and
     * the caller fails closed — so a coordinator that later finds no claim
     * for a MARKED right knows the attempt never reached this stage.
     *
     * This path is only reached when no publication record exists yet
     * (terminal replays and the different-tx conflict returned above), and
     * the coordinator call is idempotent on (creatorCreditId, lifecycleId),
     * so a retry safely completes a projection that an earlier crash left
     * unwritten without creating a second claim.
     */
    const publicationCreatorCreditId =
      typeof lifecycle.id === "string" ? lifecycle.id.trim() : "";
    if (!publicationCreatorCreditId) {
      return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE");
    }
    const vaultClaim = await requestVaultPublicationClaim(env, {
      creatorCreditId: publicationCreatorCreditId,
      creatorIdentityId,
      lifecycleId,
      capsuleId,
    });
    if (!vaultClaim.ok) {
      return fail(origin, vaultClaim.status, vaultClaim.error);
    }

    const record = {
      lifecycleId,
      capsuleId,
      creatorIdentityId,
      state: "PENDING",
      expectedTxId: txId,
      expectedVaultSha256: null,
      evidenceIds: [txId],
      createdAt: now,
      updatedAt: now,
    };
    await env.PUBLICATION_VERIFICATIONS.put(publicationKey, JSON.stringify(record));
    await env.PUBLICATION_VERIFICATIONS.put(
      txIndexKey,
      JSON.stringify({ lifecycleId, capsuleId, creatorIdentityId, kind })
    );

    return new Response(
      JSON.stringify({ ok: true, claimed: true, state: "PENDING", lifecycleId, capsuleId, txId }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  /* kind === "container": ONE authoritative container publication record.

     Model 3. The physical container is one DataItem holding N logical
     chunks; the record binds the capsule/lifecycle to that single txId and
     to the canonical ORDERED chunk identity list. Offsets are NOT stored —
     they are derived at read time from the Vault's own chunk metadata.

     Container mode writes exactly ONE KV record plus the shared tx index.
     It NEVER writes N per-chunk registry entries: that would re-create the
     per-chunk authority model the container exists to replace.

     Stage 4.1 — RACE SAFETY. The claim itself is NOT decided here. KV has
     no compare-and-set, so a KV get/check/put could not establish
     "exactly one claim" for two concurrent conflicting claims. The
     authoritative decision is made inside the CreditOperationCoordinator
     Durable Object (see functions/lib/containerPublicationClaim.ts); the
     KV record below is a durable PROJECTION of that decision. */

  if (kind === "container") {
    const chunkIds = containerChunkIds;
    if (!chunkIds || !layoutDigest) {
      return fail(origin, 400, "INVALID_FIELDS");
    }

    /**
     * Atomic create-if-absent / claim-exactly-once.
     *
     * Exactly one of two concurrent conflicting claims can be told
     * "claimed"; the other receives a deterministic conflict. A replay of
     * the winner is idempotent. If coordination is unavailable the claim
     * FAILS CLOSED — no authority is written and no success is returned.
     */
    const claimResult = await claimContainerPublication(env, {
      capsuleId,
      lifecycleId,
      creatorIdentityId,
      containerTxId: txId,
      layoutDigest,
      chunkIds,
    });

    if (!claimResult.ok) {
      if (claimResult.reason === "UNAVAILABLE") {
        return fail(origin, 503, "CONTAINER_CLAIM_UNAVAILABLE");
      }
      return fail(origin, 409, claimResult.reason);
    }

    /**
     * The authoritative transition succeeded. Project it into the KV read
     * surface.
     *
     * The projection is CREATE-IF-ABSENT and is never regressed: `state` is
     * advanced to VERIFIED/REJECTED by /api/publication/verify (KV-only), so
     * rewriting an existing record here would push a verified container back
     * to PENDING.
     */
    const key = containerPublicationKey(capsuleId);
    let state: string = "PENDING";

    try {
      const existingRaw = await env.PUBLICATION_VERIFICATIONS.get(key);

      if (existingRaw === null || existingRaw === undefined) {
        await putContainerPublication(
          env,
          buildContainerPublicationRecord({
            capsuleId,
            lifecycleId,
            creatorIdentityId,
            containerTxId: txId,
            chunkIds,
            layoutDigest,
            now,
          })
        );
      } else {
        let existing: ContainerPublicationRecord;
        try {
          existing = assertContainerPublicationRecord(JSON.parse(existingRaw), capsuleId);
        } catch {
          return fail(origin, 503, "CONTAINER_PUBLICATION_CORRUPTED");
        }

        const sameChunkSet =
          existing.chunkIds.length === chunkIds.length &&
          existing.chunkIds.every((id, i) => id === chunkIds[i]);

        // The projection must agree with the authoritative claim. A
        // divergence is never reported as success.
        if (
          existing.lifecycleId !== lifecycleId ||
          existing.containerTxId !== txId ||
          existing.layoutDigest !== layoutDigest ||
          !sameChunkSet
        ) {
          return fail(origin, 503, "CONTAINER_PUBLICATION_INCONSISTENT");
        }

        state = existing.state;
      }

      await env.PUBLICATION_VERIFICATIONS.put(
        txIndexKey,
        JSON.stringify({ lifecycleId, capsuleId, creatorIdentityId, kind })
      );
    } catch {
      // The authoritative DO claim stands; the projection is retryable and a
      // replay re-attempts it. Never report success without it.
      return fail(origin, 503, "CONTAINER_PUBLICATION_PROJECTION_FAILED");
    }

    return new Response(
      JSON.stringify({
        ok: true,
        claimed: true,
        state,
        capsuleId,
        containerTxId: txId,
      }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  /* Unreachable: `kind` is validated to be "vault" | "container" above and
     both branches return. Fail closed rather than fall through. */
  return fail(origin, 400, "INVALID_KIND");
}
