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
  getChunkPointerMap,
  putChunkPointerEntries,
} from "../../lib/storage/chunkPointerRegistryStore";
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

  if (!creatorIdentityId || !lifecycleId || !capsuleId || !storagePaymentId || !txId) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  if (kind !== "vault" && kind !== "chunk") {
    return fail(origin, 400, "INVALID_KIND");
  }

  if (kind === "chunk" && !chunkId) {
    return fail(origin, 400, "CHUNK_ID_REQUIRED");
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

  const txIndexKey = `publication-tx:${txId}`;
  const txIndexRaw = await env.PUBLICATION_VERIFICATIONS.get(txIndexKey);
  if (txIndexRaw) {
    let txIndex: { lifecycleId?: string; capsuleId?: string } | null = null;
    try {
      txIndex = JSON.parse(txIndexRaw);
    } catch {
      txIndex = null;
    }
    if (
      txIndex &&
      txIndex.lifecycleId === lifecycleId &&
      txIndex.capsuleId === capsuleId
    ) {
      // Same tx, same lifecycle/capsule — idempotent replay.
      return new Response(
        JSON.stringify({ ok: true, claimed: true, state: "PENDING", lifecycleId, capsuleId, txId }),
        { status: 200, headers: baseHeaders(origin) }
      );
    }
    return fail(origin, 409, "TX_ALREADY_CLAIMED");
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

  /* kind === "chunk": CHUNK_POINTER_REGISTRY is the chunk authority.
     A publication verification record is NOT created for chunks. */

  const registryKey = `chunk-pointer-registry:${capsuleId}`;
  const registryRaw = await env.CHUNK_POINTER_REGISTRY.get(registryKey);
  let registry: Record<string, string> = {};
  if (registryRaw) {
    try {
      registry = JSON.parse(registryRaw) as Record<string, string>;
    } catch {
      return fail(origin, 503, "CHUNK_REGISTRY_CORRUPTED");
    }
  }

  const existingPointer = registry[chunkId as string];
  if (existingPointer !== undefined) {
    if (existingPointer !== txId) {
      return fail(origin, 409, "CHUNK_ALREADY_BOUND");
    }
    return new Response(
      JSON.stringify({ ok: true, claimed: true, state: "PENDING", chunkId, txId: existingPointer }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  registry[chunkId as string] = txId;
  await env.CHUNK_POINTER_REGISTRY.put(registryKey, JSON.stringify(registry));
  await env.PUBLICATION_VERIFICATIONS.put(
    txIndexKey,
    JSON.stringify({ lifecycleId, capsuleId, creatorIdentityId, kind, chunkId })
  );

  return new Response(
    JSON.stringify({ ok: true, claimed: true, state: "PENDING", chunkId, txId }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
