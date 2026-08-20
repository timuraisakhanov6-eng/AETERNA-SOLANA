/**
 * AETERNA — Upload Token Issuer (Cloudflare Pages Functions)
 * Protocol-safe hardened version (v6.4 canonical-compatibility)
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../lib/rateLimit";
import { getTrustedTime } from "./time";
import { CAPSULE_ID_REGEX } from "../../src/lib/crypto/validators";
import {
  assertExecutorHasBalance,
  getExecutorAddress,
  ExecutorUnavailableError,
} from "../lib/executorHot";

/**
 * Allowed origins
 */
const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/**
 * Canonical-safe transactionId validator
 * Prevents KV namespace poisoning / unicode injection
 */
const TRANSACTION_ID_REGEX = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Allowed request schema whitelist
 */
const ALLOWED_BODY_FIELDS = ["capsuleId", "canonicalLifecycleId", "correlationTransactionId"];

/**
 * Canonical payment authority key prefix — must mirror webhook.ts and seal.ts.
 *
 * Payment topology:
 *   capsule:{capsuleId}  →  transactionId
 *   {transactionId}      →  full record
 *
 * Both keys must be consumed together after upload-token issuance.
 */
const CAPSULE_KEY_PREFIX = "capsule:";

/**
 * Protocol-safe time bounds
 */
const MIN_TIME = 1_577_836_800_000; // 2020-01-01 UTC
const MAX_TIME = 4_102_444_800_000; // 2100-01-01 UTC

/**
 * Upload token lifetime
 */
const TOKEN_TTL_MS  = 5 * 60 * 1000;
const TOKEN_TTL_SEC = TOKEN_TTL_MS / 1000;

/**
 * Executor wallet address is intentionally NOT a local constant here.
 * It is derived from EXECUTOR_PRIVATE_KEY by executorHot.ts
 * (getExecutorAddress) — the same function Executor Hot itself uses
 * to know which address it is signing from. A hardcoded address
 * string would silently diverge the moment the key is rotated in
 * Cloudflare Secrets, letting this preflight check pass against a
 * wallet Executor Hot no longer controls. Balance checking, RPC
 * fallback, caching, and the minimum-balance threshold are likewise
 * owned exclusively by executorHot.ts — see
 * AETERNA_EXECUTOR_PUBLICATION_SPEC_v1, Section 5: "this check is a
 * single shared capability, not duplicated logic scattered across
 * endpoints."
 */

/**
 * Generate secure token
 */
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

/**
 * Headers
 */
function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type":                    "application/json",
    "Cache-Control":                   "no-store, no-cache, must-revalidate, proxy-revalidate, no-transform",
    "CDN-Cache-Control":               "no-store",
    "Surrogate-Control":               "no-store",
    "Pragma":                          "no-cache",
    "Expires":                         "0",
    "Access-Control-Allow-Origin":     origin,
    "Access-Control-Allow-Methods":    "POST, OPTIONS",
    "Access-Control-Allow-Headers":    "Content-Type",
    "Cross-Origin-Resource-Policy":    "same-origin",
    "Timing-Allow-Origin":             origin,
    "X-Content-Type-Options":          "nosniff",
    "X-Aeterna-Upload-Token-Version":  "v1",
    "X-Aeterna-Upload-Token-TTL":      String(TOKEN_TTL_SEC),
    "X-Aeterna-Upload-Authority":      "primary",
  };
}

function fail(origin: string, status = 400): Response {
  return new Response(
    JSON.stringify({ ok: false }),
    { status, headers: baseHeaders(origin) }
  );
}

/**
 * OPTIONS handler
 */
export const onRequestOptions = async (
  context: EventContext<unknown, unknown, unknown>
): Promise<Response> => {

  const origin = context.request.headers.get("origin") ?? "";

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, { status: 204, headers: baseHeaders(origin) });

};

/**
 * POST handler
 */
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

  // FIX (LOW): explicit type instead of `any` — runtime guards remain the
  // source of truth, but typing surfaces accidental property access sooner.
  let body: Record<string, unknown>;

  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return fail(origin, 400);
  }

  /**
   * Prototype guard
   */
  if (
    !body ||
    typeof body !== "object" ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    return fail(origin, 400);
  }

  /**
   * Schema whitelist
   */
  if (!Object.keys(body).every(k => ALLOWED_BODY_FIELDS.includes(k))) {
    return fail(origin, 400);
  }

  const { capsuleId, canonicalLifecycleId, correlationTransactionId } = body;

  if (
    !capsuleId ||
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    return fail(origin, 400);
  }

  if (
    !canonicalLifecycleId ||
    typeof canonicalLifecycleId !== "string"
  ) {
    return fail(origin, 400);
  }

  if (!env?.UPLOAD_TOKENS || !env?.VERIFIED_PAYMENTS) {
    console.error("[AETERNA][upload-token] Missing KV bindings", {
      hasUploadTokens: !!env?.UPLOAD_TOKENS,
      hasVerifiedPayments: !!env?.VERIFIED_PAYMENTS,
    });
    return fail(origin, 503);
  }

  let verifiedEntry: Record<string, unknown> | null = null;

  try {
    const raw = await env.VERIFIED_PAYMENTS.get(`capsule:${capsuleId}`);
    if (raw) {
      verifiedEntry = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
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

  if (
    !verifiedEntry ||
    typeof verifiedEntry !== "object" ||
    Object.getPrototypeOf(verifiedEntry) !== Object.prototype ||
    verifiedEntry.ok !== true ||
    verifiedEntry.capsuleId !== capsuleId ||
    !Number.isSafeInteger(verifiedEntry.expiresAt as number) ||
    (verifiedEntry.expiresAt as number) <= now
  ) {
    return fail(origin, 403);
  }

  const creatorIdentityId =
    typeof verifiedEntry.creatorIdentityId === "string"
      ? verifiedEntry.creatorIdentityId
      : null;

  if (!creatorIdentityId) {
    return fail(origin, 403);
  }

  /**
   * Executor gas safety invariant.
   * Prevent sealing pipeline start if executor cannot pay gas.
   * NO GAS → NO SEAL
   *
   * Balance check itself (RPC fallback, caching, minimum threshold)
   * and the executor address itself (derived from EXECUTOR_PRIVATE_KEY)
   * are owned exclusively by executorHot.ts — see the note above.
   */
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

    console.error(
      "EXECUTOR_BALANCE_CHECK_FAILED",
      String(error)
    );

    return fail(origin, 503);

  }

  let uploadToken: string | null = null;

  for (let i = 0; i < 3; i++) {
    const candidate = generateToken();
    const exists    = await env.UPLOAD_TOKENS.get(candidate);
    if (!exists) {
      uploadToken = candidate;
      break;
    }
  }

  if (!uploadToken) {
    return fail(origin, 500);
  }

  const expiresAt = now + TOKEN_TTL_MS;

  /**
   * Issue upload token FIRST.
   * Token must be live before payment authority is consumed —
   * prevents a permanent-brick window where the creator has neither.
   */

  // Upload Authority established.
  //
  // The creator now owns a valid Upload Token.
  //
  // Payment Authority remains intact until
  // Manifest Authority is successfully
  // established during seal().
  try {
    await env.UPLOAD_TOKENS.put(
      uploadToken,
      JSON.stringify({
        capsuleId,
        canonicalLifecycleId,
        correlationTransactionId: correlationTransactionId ?? "",
        issuedAt:  now,
        expiresAt,
        tokenVersion: 1,
        permissions: {
          uploadChunks: true,
          uploadVault:  true,
        },
      }),
      { expirationTtl: TOKEN_TTL_SEC }
    );
  } catch {
    return fail(origin, 503);
  }

  /**
   * Payment authority is NOT consumed here.
   *
   * Lifecycle reasoning:
   * The irreversible event in AETERNA is manifest issuance (seal), not
   * upload-token issuance. Between upload-token issuance and seal there
   * is a real failure window: browser crash, mobile suspend, Arweave
   * failure, network interruption. If payment authority were deleted here,
   * any of those failures would leave the creator with no token, no
   * payment record, and no recovery path — permanently bricked.
   *
   * Payment authority (both keys of the dual-key topology) is consumed
   * by seal.ts immediately after CAPSULE_MANIFESTS.put() succeeds.
   * That is the only point where deletion is safe.
   */

  /**
   * Success response
   */
  return new Response(
    JSON.stringify({ ok: true, uploadToken }),
    { status: 200, headers: baseHeaders(origin) }
  );

};