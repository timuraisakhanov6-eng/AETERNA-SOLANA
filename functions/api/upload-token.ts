/**
 * AETERNA — Upload Token Issuer (Cloudflare Pages Functions)
 *
 * Canonical entitlement-bound upload authorization.
 *
 * Invariants:
 * - pre-capsule authorization does NOT require capsuleId
 * - upload token is issued only on valid entitlement/lifecycle linkage
 * - payment authority is NOT consumed here
 * - executor balance safety and TTL semantics are preserved
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../lib/rateLimit";
import { getTrustedTime } from "./time";
import {
  assertExecutorHasBalance,
  getExecutorAddress,
  ExecutorUnavailableError,
} from "../lib/executorHot";

/** Allowed origins */
const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
  "https://aeterna-solana-btt.pages.dev",
  ...(process.env.NODE_ENV === "development"
    ? ["http://localhost:5173", "http://127.0.0.1:5173"]
    : []),
];

const MIN_TIME = 1_577_836_800_000; // 2020-01-01 UTC
const MAX_TIME = 4_102_444_800_000; // 2100-01-01 UTC

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_SEC = TOKEN_TTL_MS / 1000;

const ALLOWED_BODY_FIELDS = [
  "canonicalLifecycleId",
  "creatorIdentityId",
  "paymentIntentId",
  "correlationTransactionId",
];

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, no-transform",
    "CDN-Cache-Control": "no-store",
    "Surrogate-Control": "no-store",
    "Pragma": "no-cache",
    "Expires": "0",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Timing-Allow-Origin": origin,
    "X-Content-Type-Options": "nosniff",
    "X-Aeterna-Upload-Token-Version": "v2",
    "X-Aeterna-Upload-Token-TTL": String(TOKEN_TTL_SEC),
    "X-Aeterna-Upload-Authority": "entitlement",
  };
}

function fail(origin: string, status = 400): Response {
  return new Response(
    JSON.stringify({ ok: false }),
    { status, headers: baseHeaders(origin) }
  );
}

export const onRequestOptions = async (
  context: EventContext<unknown, unknown, unknown>
): Promise<Response> => {
  const origin = context.request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
};

export const onRequestPost = async (
  context: EventContext<unknown, unknown, unknown>
): Promise<Response> => {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ ok: false }), { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415);
  }

  const ip = getClientIp(request);
  if (!rateLimit(ip)) {
    return fail(origin, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return fail(origin, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    return fail(origin, 400);
  }

  if (!Object.keys(body).every(k => ALLOWED_BODY_FIELDS.includes(k))) {
    return fail(origin, 400);
  }

  const {
    canonicalLifecycleId,
    creatorIdentityId,
    paymentIntentId,
    correlationTransactionId,
  } = body;

  if (
    !canonicalLifecycleId ||
    typeof canonicalLifecycleId !== "string"
  ) {
    return fail(origin, 400);
  }

  if (
    !creatorIdentityId ||
    typeof creatorIdentityId !== "string"
  ) {
    return fail(origin, 400);
  }

  if (
    !env?.UPLOAD_TOKENS ||
    !env?.CREATOR_CREDITS
  ) {
    console.error("[AETERNA][upload-token] Missing KV bindings");
    return fail(origin, 503);
  }

  const { nowUtc: now } = await getTrustedTime();
  if (
    !Number.isSafeInteger(now) ||
    now < MIN_TIME ||
    now > MAX_TIME
  ) {
    return fail(origin, 500);
  }

  const lifecycleKey = `creator:credit:lifecycle:${creatorIdentityId}:${canonicalLifecycleId}`;
  let creditRaw: string | null = null;
  try {
    creditRaw = await env.CREATOR_CREDITS.get(lifecycleKey);
  } catch {
    return fail(origin, 503);
  }

  if (!creditRaw) {
    return fail(origin, 403);
  }

  let credit: Record<string, unknown> | null = null;
  try {
    credit = JSON.parse(creditRaw) as Record<string, unknown>;
  } catch {
    return fail(origin, 503);
  }

  if (
    !credit ||
    credit.status !== "CONSUMING" ||
    credit.creatorIdentityId !== creatorIdentityId
  ) {
    return fail(origin, 403);
  }

  if (
    typeof paymentIntentId === "string" &&
    paymentIntentId.trim().length > 0 &&
    typeof credit.paymentIntentId === "string" &&
    credit.paymentIntentId !== paymentIntentId.trim()
  ) {
    return fail(origin, 403);
  }

  try {
    const executorAddress = await getExecutorAddress(env);
    await assertExecutorHasBalance(env, executorAddress, now);
  } catch (error) {
    if (error instanceof ExecutorUnavailableError) {
      return new Response(
        JSON.stringify({ ok: false, error: "EXECUTOR_TEMPORARILY_UNAVAILABLE" }),
        { status: 503, headers: baseHeaders(origin) }
      );
    }
    console.error("EXECUTOR_BALANCE_CHECK_FAILED", String(error));
    return fail(origin, 503);
  }

  let uploadToken: string | null = null;
  for (let i = 0; i < 3; i++) {
    const candidate = generateToken();
    const exists = await env.UPLOAD_TOKENS.get(candidate);
    if (!exists) {
      uploadToken = candidate;
      break;
    }
  }
  if (!uploadToken) {
    return fail(origin, 500);
  }

  const expiresAt = now + TOKEN_TTL_MS;

  try {
    await env.UPLOAD_TOKENS.put(
      uploadToken,
      JSON.stringify({
        canonicalLifecycleId,
        creatorIdentityId,
        paymentIntentId: paymentIntentId
          ? String(paymentIntentId).trim()
          : credit.paymentIntentId ?? null,
        correlationTransactionId: correlationTransactionId ?? "",
        issuedAt: now,
        expiresAt,
        tokenVersion: 2,
        permissions: {
          uploadChunks: true,
          uploadVault: true,
        },
      }),
      { expirationTtl: TOKEN_TTL_SEC }
    );
  } catch {
    return fail(origin, 503);
  }

  return new Response(
    JSON.stringify({ ok: true, uploadToken }),
    { status: 200, headers: baseHeaders(origin) }
  );
};
