/**
 * AETERNA — Web3 Business Quote Creation (Cloudflare Pages Function)
 * POST /api/web3/create-quote
 *
 * Establishes the canonical Business Quote for the USDC / Base payment
 * path — the exact counterpart of what create-checkout.ts does for
 * Paddle, minus the Paddle transaction call itself.
 *
 * Without this endpoint, web3/verify.ts has no Business Quote to read
 * (BUSINESS_QUOTE_NOT_FOUND), because the web3 payment flow sends the
 * on-chain transfer directly and never otherwise talks to the server
 * before verification.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { calculatePrice, MAX_CAPSULE_SIZE } from "../../../src/lib/pricing";
import { CAPSULE_ID_REGEX } from "../../../src/lib/crypto/validators";
import { getTrustedTime } from "../time";
import {
  createBusinessQuote,
} from "../../lib/business/businessQuoteStore";

import type {
  BusinessQuote,
} from "../../../src/types/business";

/**
 * Environment bindings for this handler.
 */
interface CreateQuoteEnv {
  BUSINESS_QUOTES: KVNamespace;
}

/**
 * Allowed origins — mirrors create-checkout / verify / webhook.
 */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/**
 * Canonical Cloudflare Pages preview hostname pattern.
 * Mirrors create-checkout.ts exactly.
 */

const PAGES_PREVIEW_REGEX =
  /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {

  if (ALLOWED_ORIGINS.includes(origin))
    return true;

  try {
    const url = new URL(origin);
    if (
      url.protocol === "https:" &&
      PAGES_PREVIEW_REGEX.test(url.hostname)
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;

}

/**
 * Canonical plain-object guard — mirrors all other AETERNA layers.
 */

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object")
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type RequestBody = {
  billableSizeBytes?: unknown;
  capsuleId?:         unknown;
  expectedAmount?:    unknown;
};

/**
 * Headers — mirrors create-checkout.ts, minus the Paddle-specific CSP.
 */

function baseHeaders(origin: string): Record<string, string> {

  return {

    "Content-Type":
      "application/json",

    "Cache-Control":
      "no-store, no-cache, must-revalidate, proxy-revalidate, no-transform",

    "CDN-Cache-Control":
      "no-store",

    "Surrogate-Control":
      "no-store",

    "Pragma":
      "no-cache",

    "Expires":
      "0",

    "Access-Control-Allow-Origin":
      origin,

    "Access-Control-Allow-Methods":
      "POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Cross-Origin-Resource-Policy":
      "cross-origin",

    "Timing-Allow-Origin":
      origin,

    "X-Content-Type-Options":
      "nosniff",

    "X-Aeterna-Payment-Version":
      "v1",

    "Content-Security-Policy":
      "default-src 'none'",

  };

}

function fail(
  code:   number,
  error:  string,
  origin: string
): Response {

  return new Response(
    JSON.stringify({ ok: false, error }),
    {
      status:  code,
      headers: baseHeaders(origin),
    }
  );

}

/**
 * OPTIONS handler
 */

export const onRequestOptions = async (
  context: EventContext<Record<string, unknown>, string, CreateQuoteEnv>
): Promise<Response> => {

  const origin =
    context.request.headers.get("origin") ?? "";

  if (!isAllowedOrigin(origin)) {

    console.error("[web3/create-quote] INVALID_ORIGIN (OPTIONS)", { origin });

    return new Response(null, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

  }

  return new Response(null, {
    status:  204,
    headers: baseHeaders(origin),
  });

};

/**
 * POST handler
 */

export const onRequestPost = async (
  context: EventContext<Record<string, unknown>, string, CreateQuoteEnv>
): Promise<Response> => {

  const { request, env } = context;
  const bindings = env as unknown as CreateQuoteEnv;

  const origin =
    request.headers.get("origin") ?? "";

  if (!isAllowedOrigin(origin)) {

    console.error("[web3/create-quote] INVALID_ORIGIN", { origin });

    return fail(403, "INVALID_ORIGIN", origin);

  }

  const ip = getClientIp(request);

  if (!rateLimit(ip)) {

    console.error("[web3/create-quote] RATE_LIMIT", { ip });

    return fail(429, "TOO_MANY_REQUESTS", origin);

  }

  const contentType =
    request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {

    console.error("[web3/create-quote] INVALID_CONTENT_TYPE", { contentType });

    return fail(415, "UNSUPPORTED_MEDIA_TYPE", origin);

  }

  if (!bindings.BUSINESS_QUOTES) {

    console.error("[web3/create-quote] BUSINESS_QUOTES_MISSING");

    return fail(503, "BUSINESS_QUOTES_MISSING", origin);

  }

  let body: RequestBody;

  try {
    body = await request.json();
  } catch {
    console.error("[web3/create-quote] INVALID_JSON");
    return fail(400, "INVALID_JSON", origin);
  }

  if (!isPlainObject(body)) {

    console.error("[web3/create-quote] INVALID_BODY_PROTOTYPE");

    return fail(400, "INVALID_BODY", origin);

  }

  const { billableSizeBytes, capsuleId, expectedAmount } = body;

  /**
   * Validate vault size — mirrors create-checkout.ts integer discipline.
   */

  const parsedSize = Number(billableSizeBytes);

  if (
    !Number.isSafeInteger(parsedSize) ||
    parsedSize <= 0                   ||
    parsedSize > MAX_CAPSULE_SIZE
  ) {

    console.error("[web3/create-quote] INVALID_SIZE", { billableSizeBytes });

    return fail(400, "INVALID_SIZE", origin);

  }

  /**
   * Validate capsuleId — canonical import, no inline regex.
   */

  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    console.error("[web3/create-quote] INVALID_CAPSULE_ID", { capsuleId });

    return fail(400, "INVALID_CAPSULE_ID", origin);

  }

  /**
   * Server-side price authority.
   */

  const price =
    calculatePrice(parsedSize);

  /**
   * Validate UI-supplied expectedAmount against canonical server price
   * BEFORE any Business Quote is created — mirrors create-checkout.ts.
   */

  const parsedExpected =
    Number(expectedAmount);

  const priceCents    = Math.round(price * 100);
  const expectedCents = Math.round(parsedExpected * 100);

  if (
    !Number.isFinite(parsedExpected) ||
    Math.abs(expectedCents - priceCents) > 1
  ) {

    console.error("[web3/create-quote] PRICE_MISMATCH", {
      expectedAmount,
      calculated: price,
    });

    return fail(400, "PRICE_MISMATCH", origin);

  }

  /**
   * Canonical Business Quote — identical shape and TTL to create-checkout.ts.
   * Idempotent: if a Quote already exists for this capsuleId (e.g. the
   * user retried after a transient wallet failure), the existing Quote
   * is returned unchanged.
   */

  const { nowUtc: now } =
    await getTrustedTime();

  const businessQuote: BusinessQuote = {
    capsuleId,

    billableSizeBytes: parsedSize,

    expectedAmount: price,

    currency: "USD",

    createdAt: now,

    expiresAt: now + 30 * 60 * 1000,
  };

  let quote: BusinessQuote;

  try {

    const result =
      await createBusinessQuote(
        bindings,
        businessQuote
      );

    quote = result.quote;

  } catch (err) {

    console.error("[web3/create-quote] QUOTE_CREATE_FAILED", err);

    return fail(500, "QUOTE_CREATE_FAILED", origin);

  }

  return new Response(
    JSON.stringify({
      ok: true,
      expectedAmount: quote.expectedAmount,
      currency:       quote.currency,
      expiresAt:      quote.expiresAt,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );

};