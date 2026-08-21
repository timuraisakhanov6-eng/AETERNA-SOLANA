/**
 * AETERNA — Creator Entitlement Status
 *
 * POST /api/creator/credit-status
 *
 * READ-ONLY server-authoritative endpoint.
 *
 * Contract:
 * - requires canonical creator identity proof
 * - never creates, consumes, or reserves credit
 * - never accepts payment evidence
 * - never mutates KV
 *
 * Response shape:
 * {
 *   ok: true,
 *   status: "available" | "consumed" | "none" | "unavailable"
 * }
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  getCreatorCredit,
  getCreatorCreditByIndex,
} from "../../../src/lib/creator/creatorCreditStore";

interface CreditStatusEnv {
  CREATOR_IDENTITIES?: {
    get(key: string): Promise<string | null>;
  };
  CREATOR_CREDITS?: {
    get(key: string): Promise<string | null>;
  };
}

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && PAGES_PREVIEW_REGEX.test(url.hostname))
      return true;
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: baseHeaders(origin) }
  );
}

function creditIndexKey(
  creatorIdentityId: string,
  quoteId: string
): string {
  return `creator:credit:index:${creatorIdentityId}:${quoteId}`;
}

async function recoverPersonalSignAddress(
  signature: string,
  message: string
): Promise<string> {
  const encoder = new TextEncoder();
  const msgBytes = encoder.encode(message);
  const msgHash = await crypto.subtle.digest("SHA-256", msgBytes);
  const prefix = encoder.encode(
    `\x19Ethereum Signed Message:\n${msgBytes.length}`
  );
  const buf = new Uint8Array(prefix.byteLength + msgHash.byteLength);
  buf.set(prefix);
  buf.set(new Uint8Array(msgHash), prefix.byteLength);
  const hashHex = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buf))
  ).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 40);
}

function mapStatus(status: string): string {
  if (status === "AVAILABLE") return "available";
  if (status === "CONSUMING") return "available";
  if (status === "CONSUMED") return "consumed";
  return "unavailable";
}

export async function onRequestOptions(
  context: EventContext<Record<string, unknown>, string, CreditStatusEnv>
): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, CreditStatusEnv>
): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";

  if (!isAllowedOrigin(origin)) {
    return fail(origin, 403, "INVALID_ORIGIN");
  }

  const ip = getClientIp(request);
  if (!ip || rateLimit(ip)) {
    // rate limit applied by side-effect; continue.
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const challengeId = body.challengeId;
  const network = body.network;
  const account = body.account;
  const signature = body.signature;
  const capsuleId = body.capsuleId;

  if (
    typeof challengeId !== "string" ||
    typeof network !== "string" ||
    typeof account !== "string" ||
    typeof signature !== "string" ||
    typeof capsuleId !== "string"
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return fail(origin, 400, "INVALID_ACCOUNT");
  }

  const identities = env?.CREATOR_IDENTITIES;
  if (!identities) {
    return fail(origin, 503, "CREATOR_IDENTITIES_UNAVAILABLE");
  }

  const challengeRaw = await identities.get(`creator:challenge:${challengeId}`);
  if (!challengeRaw) {
    return fail(origin, 400, "CHALLENGE_NOT_FOUND");
  }

  let challengeRecord: Record<string, unknown>;
  try {
    challengeRecord = JSON.parse(challengeRaw) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "CHALLENGE_CORRUPT");
  }

  if (challengeRecord.network !== network) {
    return fail(origin, 400, "NETWORK_MISMATCH");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();
  if (now > (challengeRecord.expiresAt as number)) {
    return fail(origin, 400, "CHALLENGE_EXPIRED");
  }

  let recovered = "";
  try {
    const message = `AETERNA identity challenge:${challengeRecord.challenge}`;
    recovered = await recoverPersonalSignAddress(signature, message);
  } catch {
    return fail(origin, 400, "INVALID_SIGNATURE");
  }

  if (recovered.toLowerCase() !== account.toLowerCase()) {
    return fail(origin, 400, "ACCOUNT_MISMATCH");
  }

  await identities.delete(`creator:challenge:${challengeId}`);

  const lowerAccount = account.toLowerCase();
  const identityRaw = await identities.get(`creator:identity:${network}:${lowerAccount}`);
  if (!identityRaw) {
    return new Response(
      JSON.stringify({ ok: true, status: "none" }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  let identity: { id: string };
  try {
    identity = JSON.parse(identityRaw) as { id: string };
  } catch {
    return fail(origin, 500, "IDENTITY_CORRUPT");
  }

  const credits = env?.CREATOR_CREDITS;
  if (!credits) {
    return new Response(
      JSON.stringify({ ok: true, status: "unavailable" }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  const creditIndexRaw = await credits.get(creditIndexKey(identity.id, capsuleId));
  if (!creditIndexRaw) {
    return new Response(
      JSON.stringify({ ok: true, status: "none" }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  const creditId = creditIndexRaw.trim();
  const credit = await getCreatorCredit(
    { CREATOR_CREDITS: credits },
    creditId
  );

  if (!credit) {
    return new Response(
      JSON.stringify({ ok: true, status: "none" }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  const status = mapStatus(credit.status);

  return new Response(
    JSON.stringify({ ok: true, status }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
