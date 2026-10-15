/**
 * AETERNA — Lifecycle Recovery Authority
 *
 * POST /api/creator/recover-lifecycle
 *
 * Recovery delegates the Credit state decision to the
 * CreditOperationCoordinator.
 *
 * Recovery MUST rely on authoritative state only.
 * It MUST NOT restore Credit if authoritative publication + Seal finalization exists.
 *
 * D3 — OWNER AUTHORIZATION
 * ------------------------
 * Knowing `creatorIdentityId` / `lifecycleId` / `capsuleId`, being on an
 * allowed Origin, and passing the rate limit are NOT authority. The request
 * must additionally carry a SIGNED owner proof produced with the EXISTING
 * identity scheme (the same SIWS / EIP-191 challenge + wallet signature the
 * payment flow already uses — no new password, secret or ownership model):
 *
 *   { challengeId, network, account, signature }
 *
 * The endpoint verifies that signature, resolves the server-side creator
 * identity for that account, and requires it to equal BOTH the claimed
 * `creatorIdentityId` AND the owner recorded on the lifecycle index. Only
 * then is the DO asked to decide. The Durable Object remains the sole
 * authority for the Credit state itself.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { noteIdentityTransition } from "../../lib/identityIndexMaintenance";
import { getTrustedTime } from "../time";
import { verifyMessage } from "ethers";
import { getCreatorIdentity } from "../../../src/lib/creator/creatorIdentityStore";
import {
  base58Decode,
  buildSolanaMessage,
  verifySolanaSignature,
} from "../../lib/solanaIdentityProof";

/* ================= ENV ================= */

interface RecoverLifecycleEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
  };
  CREATOR_IDENTITIES: {
    get(key: string): Promise<string | null>;
  };
  CREDIT_OP_COORDINATOR: {
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
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: baseHeaders(origin) });
}

function lifecycleIdKey(creatorIdentityId: string, lifecycleId: string): string {
  return `creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`;
}

type RecoveryOutcome =
  | "RETURN_EXISTING"
  | "RESUME"
  | "ABORT_AND_RESTORE_AVAILABLE";

interface RecoveryResult {
  outcome: RecoveryOutcome;
  lifecycleId: string;
  creatorCreditId: string;
  status: string;
}

/* ================= ENDPOINT ================= */

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, RecoverLifecycleEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, RecoverLifecycleEnv>): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return fail(origin, 403, "INVALID_ORIGIN");

  const ip = getClientIp(request);
  if (!rateLimit(ip)) return fail(origin, 429, "TOO_MANY_REQUESTS");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const creatorIdentityId = typeof body.creatorIdentityId === "string" ? body.creatorIdentityId.trim() : "";
  const lifecycleId = typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";
  const capsuleId = typeof body.capsuleId === "string" ? body.capsuleId.trim() : "";

  if (!creatorIdentityId || !lifecycleId || !capsuleId) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  /* ================= OWNER PROOF (D3) ================= */

  const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  const network = typeof body.network === "string" ? body.network.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";

  if (!challengeId || !network || !account || !signature) {
    // Identifiers alone are not authority.
    return fail(origin, 403, "OWNER_PROOF_REQUIRED");
  }

  const isSolanaRequest = network === "solana";
  if (isSolanaRequest) {
    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = base58Decode(account);
    } catch {
      return fail(origin, 400, "INVALID_ACCOUNT");
    }
    if (publicKeyBytes.length !== 32) {
      return fail(origin, 400, "INVALID_ACCOUNT");
    }
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return fail(origin, 400, "INVALID_ACCOUNT");
  }

  const challengeRaw = await env.CREATOR_IDENTITIES.get(`creator:challenge:${challengeId}`);
  if (!challengeRaw) {
    return fail(origin, 401, "CHALLENGE_NOT_FOUND");
  }

  let challengeRecord: Record<string, unknown>;
  try {
    challengeRecord = JSON.parse(challengeRaw) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "CHALLENGE_CORRUPT");
  }

  if (challengeRecord.network !== network) {
    return fail(origin, 401, "NETWORK_MISMATCH");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();
  if (now > (challengeRecord.expiresAt as number)) {
    return fail(origin, 401, "CHALLENGE_EXPIRED");
  }

  if (isSolanaRequest) {
    // Ed25519 verification binds the signer to the claimed account: the
    // verification key is imported from `account` itself (fail-closed on
    // any mismatch or malformation).
    const message = buildSolanaMessage(
      challengeRecord as unknown as Parameters<typeof buildSolanaMessage>[0]
    );
    const valid = await verifySolanaSignature(account, signature, message);
    if (!valid) {
      return fail(origin, 401, "INVALID_SIGNATURE");
    }
  } else {
    try {
      const message = `AETERNA identity challenge:${challengeRecord.challenge}`;
      const recoveredAddress = await verifyMessage(message, signature);
      if (recoveredAddress.toLowerCase() !== account.toLowerCase()) {
        return fail(origin, 401, "ACCOUNT_MISMATCH");
      }
    } catch {
      return fail(origin, 401, "INVALID_SIGNATURE");
    }
  }

  const identityRecord = await getCreatorIdentity(env, network, account);
  if (!identityRecord) {
    return fail(origin, 403, "CREATOR_IDENTITY_NOT_FOUND");
  }

  // The signed proof must belong to the identity that CLAIMS the right...
  if (identityRecord.id !== creatorIdentityId) {
    return fail(origin, 403, "CREATOR_MISMATCH");
  }

  /* ================= LIFECYCLE OWNERSHIP ================= */

  const lifecycleRaw = await env.CREATOR_CREDITS.get(lifecycleIdKey(creatorIdentityId, lifecycleId));
  if (!lifecycleRaw) {
    return fail(origin, 409, "LIFECYCLE_NOT_FOUND");
  }
  const lifecycle = JSON.parse(lifecycleRaw) as {
    id: string;
    status: string;
    creatorIdentityId?: string;
  };

  // ...and to the identity the lifecycle index itself records as owner.
  if (
    typeof lifecycle.creatorIdentityId === "string" &&
    lifecycle.creatorIdentityId !== identityRecord.id
  ) {
    return fail(origin, 403, "CREATOR_MISMATCH");
  }

  /**
   * Authoritative publication/seal state is established INSIDE the
   * Durable Object immediately before the recovery decision. The
   * endpoint deliberately does NOT pre-read verification state or
   * accept client-derived state as authority.
   */

  const coordinatorId = env.CREDIT_OP_COORDINATOR.idFromName(lifecycle.id);
  const coordinator = env.CREDIT_OP_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(
    new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "recover",
        creatorCreditId: lifecycle.id,
        creatorIdentityId,
        lifecycleId,
        capsuleId,
      }),
    })
  );

  const payload = await response.json().catch(() => ({}));
  const normalized = {
    ok: typeof payload?.ok === "boolean" ? payload.ok : false,
    outcome: typeof payload?.outcome === "string" ? payload.outcome : undefined,
    status: typeof payload?.outcome === "string" ? payload.outcome : String(response.status ?? "ERROR"),
    creatorCreditId: typeof payload?.creatorCreditId === "string" ? payload.creatorCreditId : lifecycle.id,
    lifecycleId: typeof payload?.lifecycleId === "string" ? payload.lifecycleId : lifecycleId,
    revision: typeof payload?.revision === "number" ? payload.revision : 0,
  };

  // Identity index maintenance (after the authoritative recover). Only a
  // restored right changes liveness; blocked/resolved outcomes leave it.
  if (normalized.ok && normalized.outcome === "ABORT_AND_RESTORE_AVAILABLE") {
    await noteIdentityTransition(env, "recover", {
      creatorIdentityId,
      creatorCreditId: lifecycle.id,
    });
  }

  return new Response(JSON.stringify(normalized), {
    status: response.status,
    headers: baseHeaders(origin),
  });
}
