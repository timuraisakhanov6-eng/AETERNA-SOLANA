/**
 * AETERNA — Service Payment Quote
 *
 * POST /api/service-payment/create-quote
 *
 * Canonical fixed-fee service payment quote.
 *
 * Security invariant:
 * - server-side expectedAmount is authoritative
 * - client-provided expectedAmount is only a display hint
 * - quote is bound to a single payment intent lifecycle
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  createBusinessQuote,
  getBusinessQuote,
} from "../../lib/business/businessQuoteStore";

interface ServicePaymentCreateQuoteEnv {
  BUSINESS_QUOTES: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
}

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;
const NEW_PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-solana-btt\.pages\.dev$/;
const LOCALHOST_REGEX = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (
      url.protocol === "https:" &&
      (PAGES_PREVIEW_REGEX.test(url.hostname) || NEW_PAGES_PREVIEW_REGEX.test(url.hostname))
    )
      return true;
    if (LOCALHOST_REGEX.test(origin)) return true;
  } catch {
    // ignore
  }
  return false;
}

const SERVICE_FEE_USD = 1.0;
const QUOTE_TTL_MS = 30 * 60 * 1000;

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
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Timing-Allow-Origin": origin,
    "X-Content-Type-Options": "nosniff",
    "X-Aeterna-Service-Payment-Version": "v1",
    "Content-Security-Policy": "default-src 'none'",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: baseHeaders(origin) });
}

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, ServicePaymentCreateQuoteEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, ServicePaymentCreateQuoteEnv>): Promise<Response> {
  const { request, env } = context;
  const bindings = env as ServicePaymentCreateQuoteEnv;
  const origin = request.headers.get("origin") ?? "";

  if (!isAllowedOrigin(origin)) {
    console.error("[service-payment/create-quote] INVALID_ORIGIN");
    return fail(origin, 403, "INVALID_ORIGIN");
  }

  const ip = getClientIp(request);
  if (!rateLimit(ip)) {
    console.error("[service-payment/create-quote] RATE_LIMIT");
    return fail(origin, 429, "TOO_MANY_REQUESTS");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  if (!bindings.BUSINESS_QUOTES) {
    console.error("[service-payment/create-quote] BUSINESS_QUOTES_MISSING");
    return fail(origin, 503, "BUSINESS_QUOTES_MISSING");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    console.error("[service-payment/create-quote] INVALID_JSON");
    return fail(origin, 400, "INVALID_JSON");
  }

  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const paymentIntentId =
    typeof body.paymentIntentId === "string" && body.paymentIntentId.trim().length > 0
      ? body.paymentIntentId.trim()
      : crypto.randomUUID();

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  const existing = await getBusinessQuote(bindings, paymentIntentId);
  if (existing) {
    return new Response(
      JSON.stringify({
        ok: true,
        paymentIntentId: existing.paymentIntentId,
        expectedAmount: existing.expectedAmount,
        currency: existing.currency,
        expiresAt: existing.expiresAt,
      }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  const quote = {
    paymentIntentId,
    expectedAmount: SERVICE_FEE_USD,
    currency: "USD" as const,
    createdAt: now,
    expiresAt: now + QUOTE_TTL_MS,
  };

  try {
    await createBusinessQuote(bindings, quote);
  } catch (err) {
    console.error("[service-payment/create-quote] QUOTE_CREATE_FAILED", err);
    return fail(origin, 500, "QUOTE_CREATE_FAILED");
  }

  return new Response(
    JSON.stringify({
      ok: true,
      paymentIntentId: quote.paymentIntentId,
      expectedAmount: quote.expectedAmount,
      currency: quote.currency,
      expiresAt: quote.expiresAt,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
