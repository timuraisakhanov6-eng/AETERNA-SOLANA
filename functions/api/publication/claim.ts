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
 *       chunk: CHUNK_POINTER_REGISTRY entry)
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
  chunkPointerEntryKey,
} from "../../lib/storage/chunkPointerRegistryStore";
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
  CHUNK_POINTER_REGISTRY: {
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
  const chunkId = parseInput(body.chunkId);
  const layoutDigest = parseInput(body.layoutDigest);
  const chunkIdsRaw = body.chunkIds;

  if (!creatorIdentityId || !lifecycleId || !capsuleId || !storagePaymentId || !txId) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  if (kind !== "vault" && kind !== "chunk" && kind !== "container") {
    return fail(origin, 400, "INVALID_KIND");
  }

  if (kind === "chunk" && !chunkId) {
    return fail(origin, 400, "CHUNK_ID_REQUIRED");
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

  if (kind === "chunk" && !SHA256_REGEX.test(chunkId as string)) {
    return fail(origin, 400, "INVALID_CHUNK_ID");
  }

  /* ================= 1. LIFECYCLE / IDENTITY / CAPSULE AUTHORITY ================= */

  const lifecycleRaw = await env.CREATOR_CREDITS.get(
    `creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`
  );
  if (!lifecycleRaw) {
    return fail(origin, 409, "LIFECYCLE_NOT_RESERVED");
  }

  let lifecycle: { id?: string; status?: string; creatorIdentityId?: string; capsuleId?: string } | null = null;
  try {
    lifecycle = JSON.parse(lifecycleRaw);
  } catch {
    return fail(origin, 503, "CREDIT_STORAGE_CORRUPTED");
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
   * identity matches — same lifecycle, same capsule, same kind, and (for a
   * chunk claim) the SAME chunkId.
   *
   * PREVIOUS BEHAVIOUR (defect): the comparison used lifecycle + capsule
   * only. A SECOND chunk claiming the same txId under the same
   * lifecycle/capsule therefore matched, returned `200 claimed:true`, and
   * NEVER reached the chunk branch — so its pointer was never written and
   * no node confirmation ran. The caller was told the chunk was bound while
   * the registry had no entry for it. That is a silent partial publication,
   * and it is exactly the shape a naive "one container txId for N chunks"
   * implementation would have hit.
   *
   * `kind` and `chunkId` are already persisted on every index write, so no
   * migration is required to make this comparison exact.
   */
  const txIndexKey = `publication-tx:${txId}`;
  const txIndexRaw = await env.PUBLICATION_VERIFICATIONS.get(txIndexKey);
  if (txIndexRaw) {
    let txIndex: {
      lifecycleId?: string;
      capsuleId?: string;
      kind?: string;
      chunkId?: string;
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

    // Chunk: idempotent ONLY when the SAME chunkId was already bound.
    // A different chunkId under the same owner means the txId is spent.
    if (kind === "chunk") {
      if (txIndex.kind === "chunk" && txIndex.chunkId === chunkId) {
        return new Response(
          JSON.stringify({ ok: true, claimed: true, state: "PENDING", lifecycleId, capsuleId, txId }),
          { status: 200, headers: baseHeaders(origin) }
        );
      }
      return fail(origin, 409, "TX_ALREADY_CLAIMED");
    }

    // Container: deliberately NOT short-circuited to 200 here. The tx index
    // does not carry the ordered chunk set, so it cannot prove an exact
    // replay. The container branch below owns the full identity comparison
    // (txId + ordered chunk set + layout digest) and returns 200 only for a
    // genuine replay, 409 CONTAINER_ALREADY_PUBLISHED otherwise.
    if (kind !== "container") {
      return fail(origin, 409, "TX_ALREADY_CLAIMED");
    }
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

  /* kind === "chunk": CHUNK_POINTER_REGISTRY is the chunk authority.
     A publication verification record is NOT created for chunks.

     Per-chunk key model: this chunk owns its OWN KV entry
     (`chunk-pointer-entry:<capsuleId>:<chunkId>`). There is no shared
     capsule map and no read-modify-write, so two concurrent chunk
     claims cannot overwrite each other's pointer. */

  const entryKey = chunkPointerEntryKey(capsuleId, chunkId as string);

  const existingPointer = await env.CHUNK_POINTER_REGISTRY.get(entryKey);

  if (existingPointer !== null && existingPointer !== undefined) {
    if (existingPointer !== txId) {
      return fail(origin, 409, "CHUNK_ALREADY_BOUND");
    }
    return new Response(
      JSON.stringify({ ok: true, claimed: true, state: "PENDING", chunkId, txId: existingPointer }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  await env.CHUNK_POINTER_REGISTRY.put(entryKey, txId);
  await env.PUBLICATION_VERIFICATIONS.put(
    txIndexKey,
    JSON.stringify({ lifecycleId, capsuleId, creatorIdentityId, kind, chunkId })
  );

  return new Response(
    JSON.stringify({ ok: true, claimed: true, state: "PENDING", chunkId, txId }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
