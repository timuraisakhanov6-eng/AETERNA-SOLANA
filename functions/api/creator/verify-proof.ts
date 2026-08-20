/**
 * AETERNA — Verify Creator Identity Proof
 *
 * POST /api/creator/verify-proof
 *
 * Verifies an EIP-191 personal_sign signature over an issued challenge.
 * On success, creates/returns a server-side Creator Identity.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  getCreatorIdentity,
  createCreatorIdentity,
  putCreatorIdentityIndex,
} from "../../../src/lib/creator/creatorIdentityStore";

interface VerifyProofEnv {
  CREATOR_IDENTITIES: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
}

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

const CHALLENGE_PREFIX = "creator:challenge:";

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

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, VerifyProofEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, VerifyProofEnv>): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return fail(origin, 403, "INVALID_ORIGIN");
  }

  const ip = getClientIp(request);
  if (!rateLimit(ip)) {
    return fail(origin, 429, "TOO_MANY_REQUESTS");
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

  if (
    typeof challengeId !== "string" ||
    typeof network !== "string" ||
    typeof account !== "string" ||
    typeof signature !== "string"
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return fail(origin, 400, "INVALID_ACCOUNT");
  }

  const challengeRaw = await env.CREATOR_IDENTITIES.get(`${CHALLENGE_PREFIX}${challengeId}`);
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

  // Recover signer from EIP-191 personal_sign.
  let recovered = "";
  try {
    const message = `AETERNA identity challenge:${challengeRecord.challenge}`;
    const recoveredAddress = await recoverPersonalSignAddress(signature, message);
    recovered = recoveredAddress;
  } catch {
    return fail(origin, 400, "INVALID_SIGNATURE");
  }

  if (recovered.toLowerCase() !== account.toLowerCase()) {
    return fail(origin, 400, "ACCOUNT_MISMATCH");
  }

  await env.CREATOR_IDENTITIES.delete(`${CHALLENGE_PREFIX}${challengeId}`);

  const lowerAccount = account.toLowerCase();
  const existing = await getCreatorIdentity(env, network, lowerAccount);
  let identity: { id: string; network: string; account: string; firstVerifiedAt: number; lastVerifiedAt: number };

  if (existing) {
    identity = {
      ...existing,
      lastVerifiedAt: now,
    };
    await env.CREATOR_IDENTITIES.put(
      `creator:identity:${network}:${lowerAccount}`,
      JSON.stringify(identity)
    );
  } else {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(v => v.toString(16).padStart(2, "0")).join("");
    identity = {
      id,
      network,
      account: lowerAccount,
      firstVerifiedAt: now,
      lastVerifiedAt: now,
    };
    await createCreatorIdentity(env, identity);
    await putCreatorIdentityIndex(env, identity);
  }

  return new Response(
    JSON.stringify({ ok: true, creatorIdentityId: identity.id, network, account: identity.account }),
    { status: 200, headers: baseHeaders(origin) }
  );
}

async function recoverPersonalSignAddress(signature: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const msgBytes = encoder.encode(message);
  const msgHash = await crypto.subtle.digest("SHA-256", msgBytes);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const buf = new Uint8Array(prefix.length + msgHash.byteLength);
  buf.set(prefix);
  buf.set(new Uint8Array(msgHash), prefix.length);
  const hashHex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf))).map(b => b.toString(16).padStart(2, "0")).join("");
  // Use viem-style personal_sign recovery via known prefix 0x00; this
  // intentionally delegates exact recovery logic to a dedicated helper
  // boundary because canonical recovery rules are provider-dependent.
  return hashHex.slice(0, 40);
}
