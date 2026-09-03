/**
 * AETERNA — Credit Status
 *
 * POST /api/creator/credit-status
 *
 * Requires fresh identity proof.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import { verifyMessage } from "ethers";
import { getCreatorIdentity } from "../../../src/lib/creator/creatorIdentityStore";

interface CreditStatusEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
  };
  CREATOR_IDENTITIES: {
    get(key: string): Promise<string | null>;
  };
}

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

function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: baseHeaders(origin) });
}

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, CreditStatusEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

/* ================= POST challenge-bound entitlement ================= */

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, CreditStatusEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return fail(origin, 403, "INVALID_ORIGIN");
  }

  const ip = getClientIp(context.request);
  if (!ip || !rateLimit(ip)) {
    return fail(origin, 429, "TOO_MANY_REQUESTS");
  }

  const contentType = context.request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  let body: Record<string, unknown>;
  try {
    body = await context.request.json() as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  const network = typeof body.network === "string" ? body.network.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const creatorCreditId = typeof body.creatorCreditId === "string" ? body.creatorCreditId.trim() : "";
  const lifecycleId = typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";

  if (
    typeof challengeId !== "string" ||
    typeof network !== "string" ||
    typeof account !== "string" ||
    typeof signature !== "string" ||
    typeof creatorCreditId !== "string"
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return fail(origin, 400, "INVALID_ACCOUNT");
  }

  if (!creatorCreditId) {
    return fail(origin, 400, "CREATOR_CREDIT_ID_REQUIRED");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  /* ================= Challenge verification ================= */

  const challengeRaw = await context.env.CREATOR_IDENTITIES.get(`creator:challenge:${challengeId}`);
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

  if (now > (challengeRecord.expiresAt as number)) {
    return fail(origin, 401, "CHALLENGE_EXPIRED");
  }

  let recovered = "";
  try {
    const message = `AETERNA identity challenge:${challengeRecord.challenge}`;
    const recoveredAddress = await verifyMessage(message, signature);
    recovered = recoveredAddress;
  } catch {
    return fail(origin, 401, "INVALID_SIGNATURE");
  }

  if (recovered.toLowerCase() !== account.toLowerCase()) {
    return fail(origin, 401, "ACCOUNT_MISMATCH");
  }

  /* ================= Creator identity resolution ================= */

  const identityRecord = await getCreatorIdentity(context.env, network, account);
  if (!identityRecord) {
    return fail(origin, 403, "CREATOR_IDENTITY_NOT_FOUND");
  }

  const authenticatedCreatorIdentityId = identityRecord.id;

  /* ================= Creator Credit lookup ================= */

  const creditRaw = await context.env.CREATOR_CREDITS.get(`creator:credit:${creatorCreditId}`);
  if (!creditRaw) {
    return new Response(
      JSON.stringify({ ok: true, status: "none", creatorCreditId, lifecycleId: lifecycleId || null }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  let creditRecord: {
    id: string;
    creatorIdentityId: string;
    status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
    quoteId: string;
    createdAt: number;
    updatedAt: number;
    lifecycleId?: string;
  };

  try {
    creditRecord = JSON.parse(creditRaw) as {
      id: string;
      creatorIdentityId: string;
      status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
      quoteId: string;
      createdAt: number;
      updatedAt: number;
      lifecycleId?: string;
    };
  } catch {
    return fail(origin, 500, "CREATOR_CREDIT_CORRUPT");
  }

  if (creditRecord.id !== creatorCreditId) {
    return fail(origin, 403, "CREATOR_CREDIT_MISMATCH");
  }

  if (creditRecord.creatorIdentityId !== authenticatedCreatorIdentityId) {
    return fail(origin, 403, "CREATOR_MISMATCH");
  }

  /* ================= Lifecycle binding check ================= */

  let boundLifecycleId: string | null = null;
  if (lifecycleId) {
    const lifecycleRaw = await context.env.CREATOR_CREDITS.get(`creator:credit:lifecycle:${authenticatedCreatorIdentityId}:${lifecycleId}`);
    if (lifecycleRaw) {
      boundLifecycleId = lifecycleRaw;
    }

    if (!boundLifecycleId || boundLifecycleId !== creatorCreditId) {
      return fail(origin, 403, "LIFECYCLE_MISMATCH");
    }
  }

  /* ================= Status mapping ================= */

  let status: "available" | "consuming" | "consumed" | "none";

  if (creditRecord.status === "AVAILABLE") {
    status = "available";
  } else if (creditRecord.status === "CONSUMING") {
    status = lifecycleId && boundLifecycleId === creatorCreditId ? "consuming" : "none";
  } else if (creditRecord.status === "CONSUMED") {
    status = "none";
  } else {
    status = "none";
  }

  return new Response(
    JSON.stringify({
      ok: true,
      status,
      creatorCreditId: creditRecord.id,
      lifecycleId: lifecycleId || creditRecord.lifecycleId || null,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}

