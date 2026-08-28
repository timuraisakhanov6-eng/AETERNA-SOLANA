import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";

interface IssueChallengeEnv {
  CREATOR_IDENTITIES?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
}

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

const CHALLENGE_TTL_SEC = 5 * 60;
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

function buildSolanaMessage(record: {
  network: string;
  challenge: string;
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
  id: string;
}): string {
  return [
    "AETERNA identity challenge",
    `network=${record.network}`,
    `address=${record.publicKey}`,
    `challenge=${record.challenge}`,
    `id=${record.id}`,
    `issuedAt=${record.issuedAt}`,
    `expiresAt=${record.expiresAt}`,
  ].join("\n");
}

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, IssueChallengeEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, IssueChallengeEnv>): Promise<Response> {
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

  const network = typeof body.network === "string" ? body.network.trim() : "";
  if (!network) {
    return fail(origin, 400, "INVALID_NETWORK");
  }

  const publicKey =
    typeof body.publicKey === "string" && body.publicKey.trim().length > 0
      ? body.publicKey.trim()
      : "";

  if (!publicKey) {
    return fail(origin, 400, "INVALID_PUBLIC_KEY");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  const challenge = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(v => v.toString(16).padStart(2, "0"))
    .join("");
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(v => v.toString(16).padStart(2, "0"))
    .join("");

  const record = {
    id,
    network,
    challenge,
    publicKey,
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL_SEC * 1000,
    consumed: false,
  };

  if (env?.CREATOR_IDENTITIES) {
    await env.CREATOR_IDENTITIES.put(challengeKey(id), JSON.stringify(record), { expirationTtl: CHALLENGE_TTL_SEC });
  }

  return new Response(
    JSON.stringify({ ok: true, id, challenge, network, publicKey, message: buildSolanaMessage(record), expiresAt: record.expiresAt }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
