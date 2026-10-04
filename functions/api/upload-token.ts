/**
 * AETERNA — Upload Token Issuer (Cloudflare Pages Functions)
 *
 * Canonical entitlement-bound upload authorization.
 *
 * Invariants:
 * - pre-capsule authorization does NOT require capsuleId
 * - upload token is issued only on valid entitlement/lifecycle linkage
 * - payment authority is NOT consumed here
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../lib/rateLimit";
import { getTrustedTime } from "./time";
import { getStorageQuote } from "../lib/storage/storageQuoteStore";
import { getStoragePayment } from "../lib/storage/storagePaymentStore";


/** Allowed origins */
const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
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
  "creatorCreditId",
  "paymentIntentId",
  "correlationTransactionId",
];

/**
 * Bindings this endpoint may touch. Declared explicitly (mirroring
 * reserve-lifecycle.ts) so the authoritative Durable Object read is typed;
 * the handler's own generics are left untouched.
 */
interface UploadTokenEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
  };
  UPLOAD_TOKENS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): DurableObjectStub;
  };
}

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

function fail(origin: string, status = 400, error?: string): Response {
  return new Response(
    JSON.stringify({ ok: false, ...(error ? { error } : {}) }),
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
    return fail(origin, 403, "ORIGIN_NOT_ALLOWED");
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
    creatorCreditId,
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

  /**
   * OPTIONAL authoritative-read address.
   *
   * When present, the Creator Credit is read from the Durable Object — the
   * strongly consistent store that AUTHORED the reserve — instead of the KV
   * lifecycle projection. KV reads are eventually consistent (default read
   * cacheTtl 60s) and cache negative lookups, so a KV read issued
   * immediately after reserve-lifecycle can observe a stale "absent" result
   * and fail closed with LIFECYCLE_CREDIT_NOT_FOUND.
   *
   * The value is an ADDRESS only: every field that authorizes the token is
   * taken from the server-persisted record and re-validated below. Absent
   * (legacy client) => the unchanged KV path is used.
   */
  if (
    creatorCreditId !== undefined &&
    (typeof creatorCreditId !== "string" || creatorCreditId.trim().length === 0)
  ) {
    return fail(origin, 400);
  }

  const authoritativeCreditId =
    typeof creatorCreditId === "string" ? creatorCreditId.trim() : "";

  const bindings = env as unknown as UploadTokenEnv;

  if (
    !bindings?.UPLOAD_TOKENS ||
    !bindings?.CREATOR_CREDITS
  ) {
    console.error("[AETERNA][upload-token] Missing KV bindings");
    return fail(origin, 503);
  }

  if (authoritativeCreditId && !bindings?.CREDIT_OP_COORDINATOR) {
    console.error("[AETERNA][upload-token] Missing credit coordinator binding");
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

  /**
   * Resolve the Creator Credit.
   *
   * Authoritative path: the Durable Object's own record (strongly
   * consistent, same instance that performed the reserve). This path does
   * NOT read the lifecycle key from KV.
   *
   * Legacy path: the KV lifecycle projection, retained unchanged for
   * backward compatibility with clients that do not send creatorCreditId.
   */
  let credit: Record<string, unknown> | null = null;

  if (authoritativeCreditId) {

    let readResponse: Response;
    try {
      const coordinatorId =
        bindings.CREDIT_OP_COORDINATOR!.idFromName(authoritativeCreditId);
      const coordinator = bindings.CREDIT_OP_COORDINATOR!.get(coordinatorId);
      readResponse = await coordinator.fetch(
        new Request("https://aeterna-credit-coordinator.invalid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "read",
            creatorCreditId: authoritativeCreditId,
          }),
        })
      );
    } catch {
      return fail(origin, 503);
    }

    if (!readResponse.ok) {
      return fail(origin, 503);
    }

    let readResult: Record<string, unknown> | null = null;
    try {
      readResult = (await readResponse.json()) as Record<string, unknown>;
    } catch {
      readResult = null;
    }

    if (!readResult || readResult.outcome !== "FOUND") {
      return fail(origin, 403, "LIFECYCLE_CREDIT_NOT_FOUND");
    }

    credit = readResult;

  } else {

    const lifecycleKey = `creator:credit:lifecycle:${creatorIdentityId}:${canonicalLifecycleId}`;
    let creditRaw: string | null = null;
    try {
      creditRaw = await bindings.CREATOR_CREDITS.get(lifecycleKey);
    } catch {
      return fail(origin, 503);
    }

    if (!creditRaw) {
      return fail(origin, 403, "LIFECYCLE_CREDIT_NOT_FOUND");
    }

    try {
      credit = JSON.parse(creditRaw) as Record<string, unknown>;
    } catch {
      return fail(origin, 503);
    }

  }

  if (!credit) {
    return fail(origin, 403, "CREDIT_NOT_CONSUMING");
  }

  if (credit.status !== "CONSUMING") {
    return fail(origin, 403, "CREDIT_NOT_CONSUMING");
  }

  if (credit.creatorIdentityId !== creatorIdentityId) {
    return fail(origin, 403, "CREDIT_IDENTITY_MISMATCH");
  }

  /**
   * Lifecycle binding — AUTHORITATIVE PATH ONLY.
   *
   * The Durable Object record carries the lifecycleId that reserve-lifecycle
   * wrote, so it must be the lifecycle THIS request asks for; a mismatch
   * fails closed exactly like a missing record. The legacy KV path is keyed
   * by lifecycleId and is left byte-for-byte unchanged.
   */
  if (authoritativeCreditId && credit.lifecycleId !== canonicalLifecycleId) {
    return fail(origin, 403, "LIFECYCLE_CREDIT_NOT_FOUND");
  }

  /**
   * Canonical payment binding (server-authoritative).
   *
   * The intent is derived EXCLUSIVELY from the server-persisted credit
   * record's payment binding (Credit Record carries "quote/payment binding
   * identifiers" — Finalization/Publication/Seal/Recovery Runtime Interface
   * Spec §5.1). A client-supplied paymentIntentId is a HINT only: it is
   * accepted only when it MATCHES the server value, and any mismatch fails
   * closed. The server value — never the client value — is what is persisted
   * on the upload token, so /api/capsule/seal resolves the SAME
   * server-persisted VerifiedPayment evidence without trusting client input.
   */
  const serverPaymentIntentId =
    typeof credit.paymentIntentId === "string" &&
    credit.paymentIntentId.trim().length > 0
      ? credit.paymentIntentId.trim()
      : null;

  if (
    typeof paymentIntentId === "string" &&
    paymentIntentId.trim().length > 0 &&
    paymentIntentId.trim() !== serverPaymentIntentId
  ) {
    return fail(origin, 403, "PAYMENT_INTENT_MISMATCH");
  }

  /* ================= STORAGE PAYMENT GATE (Phase D1) =================

     Canonical: the creator pays Irys storage directly. Permanent
     upload authorization requires a PAYMENT_VERIFIED creator storage
     payment bound to THIS identity/lifecycle/capsule. The wallet
     account is server-derived (ed76080); the storage payment state is
     server-persisted - neither is accepted from the client. */
  const creditCapsuleId =
    typeof credit.capsuleId === "string" ? credit.capsuleId : "";
  if (!creditCapsuleId) {
    return fail(origin, 409, "STORAGE_PAYMENT_NOT_VERIFIED");
  }

  const storageQuote = await getStorageQuote(
    env,
    creatorIdentityId,
    canonicalLifecycleId,
    creditCapsuleId
  );
  if (!storageQuote) {
    return fail(origin, 409, "STORAGE_PAYMENT_NOT_VERIFIED");
  }

  const storagePayment = await getStoragePayment(
    env,
    storageQuote.storagePaymentId
  );
  if (
    !storagePayment ||
    storagePayment.state !== "PAYMENT_VERIFIED" ||
    storagePayment.quote?.creatorIdentityId !== creatorIdentityId ||
    storagePayment.quote?.lifecycleId !== canonicalLifecycleId ||
    storagePayment.quote?.capsuleId !== creditCapsuleId
  ) {
    return fail(origin, 409, "STORAGE_PAYMENT_NOT_VERIFIED");
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
        paymentIntentId: serverPaymentIntentId,
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
