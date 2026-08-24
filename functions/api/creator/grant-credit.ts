/**
 * AETERNA — Grant Creator Credit
 *
 * POST /api/creator/grant-credit
 *
 * Hard invariant:
 * - ONLY independently VERIFIED payment may grant Creator Credit.
 *
 * Quote existence alone is NOT sufficient.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  getBusinessQuote,
} from "../../lib/business/businessQuoteStore";
import {
  getCreatorCreditByIndex,
  createCreatorCredit,
  generateCreditId,
} from "../../../src/lib/creator/creatorCreditStore";

interface GrantCreditEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
  BUSINESS_QUOTES: {
    get(key: string): Promise<string | null>;
  };
  VERIFIED_PAYMENTS: {
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: baseHeaders(origin) });
}

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, GrantCreditEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, GrantCreditEnv>): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
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
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const paymentIntentId =
    typeof body.paymentIntentId === "string" ? body.paymentIntentId.trim() : "";
  const creatorIdentityId =
    typeof body.creatorIdentityId === "string" ? body.creatorIdentityId.trim() : "";
  const verifiedPaymentId =
    typeof body.verifiedPaymentId === "string" ? body.verifiedPaymentId.trim() : "";
  const transactionId =
    typeof body.transactionId === "string" ? body.transactionId.trim() : "";

  if (
    typeof paymentIntentId !== "string" ||
    typeof creatorIdentityId !== "string" ||
    typeof verifiedPaymentId !== "string" ||
    typeof transactionId !== "string"
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  /* ================= QUOTE ================= */

  const quote = await getBusinessQuote(env as { BUSINESS_QUOTES: { get(key: string): Promise<string | null> } }, paymentIntentId);
  if (!quote) {
    return fail(origin, 402, "BUSINESS_QUOTE_NOT_FOUND");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  /* ================= VERIFIED PAYMENT ================= */

  const verifiedPaymentRaw =
    await env.VERIFIED_PAYMENTS.get(`verified-payment:${paymentIntentId}:${verifiedPaymentId}`);

  if (!verifiedPaymentRaw) {
    return fail(origin, 402, "VERIFIED_PAYMENT_NOT_FOUND");
  }

  let verifiedPayment: {
    ok: true;
    paymentIntentId: string;
    quoteId: string;
    creatorIdentityId: string;
    evidenceId: string;
    consumed?: boolean;
  };

  try {
    verifiedPayment = JSON.parse(verifiedPaymentRaw) as {
      ok: true;
      paymentIntentId: string;
      quoteId: string;
      creatorIdentityId: string;
      evidenceId: string;
      consumed?: boolean;
    };
  } catch {
    return fail(origin, 500, "VERIFIED_PAYMENT_CORRUPT");
  }

  if (verifiedPayment.consumed) {
    return fail(origin, 409, "VERIFIED_PAYMENT_ALREADY_CONSUMED");
  }

  if (verifiedPayment.paymentIntentId !== paymentIntentId) {
    return fail(origin, 409, "VERIFIED_PAYMENT_INTENT_MISMATCH");
  }

  if (verifiedPayment.creatorIdentityId !== creatorIdentityId) {
    return fail(origin, 403, "CREATOR_IDENTITY_MISMATCH");
  }

  if (verifiedPayment.quoteId !== quote.paymentIntentId) {
    return fail(origin, 409, "QUOTE_MISMATCH");
  }

  /* ================= IDEMPOTENCY ================= */

  const existing = await getCreatorCreditByIndex(
    env as { CREATOR_CREDITS: { get(key: string): Promise<string | null> } },
    creatorIdentityId,
    quote.paymentIntentId
  );

  if (existing) {
    return new Response(
      JSON.stringify({ ok: true, creatorCreditId: existing.id, status: existing.status }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  /* ================= GRANT CREDIT ================= */

  const id = generateCreditId();
  const record = {
    id,
    creatorIdentityId,
    status: "AVAILABLE" as const,
    quoteId: quote.paymentIntentId,
    createdAt: now,
    updatedAt: now,
  };

  await createCreatorCredit(env as { CREATOR_CREDITS: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } }, record);

  return new Response(
    JSON.stringify({ ok: true, creatorCreditId: id, status: "AVAILABLE" }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
