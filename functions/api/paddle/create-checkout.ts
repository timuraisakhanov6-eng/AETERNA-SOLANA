/**
 * AETERNA — Paddle Checkout Creation (Cloudflare Pages Functions)
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { calculateBlocks, calculatePrice, MAX_CAPSULE_SIZE } from "../../../src/lib/pricing";
import { CAPSULE_ID_REGEX } from "../../../src/lib/crypto/validators";
import { getTrustedTime } from "../../lib/getTrustedTime";
import {
  createBusinessQuote,
  deleteBusinessQuote,
} from "../../lib/business/businessQuoteStore";

import type {
  BusinessQuote,
} from "../../../src/types/business";

/**
 * Environment bindings for this handler.
 */
interface CheckoutEnv {
  PADDLE_ENV: "live" | "sandbox";

  PADDLE_API_KEY: string;
  PADDLE_PRICE_BASE_ID: string;
  PADDLE_PRICE_EXTRA_ID: string;

  BUSINESS_QUOTES: KVNamespace;
}

/**
 * Paddle API endpoint selection
 */

function getPaddleApi(bindings: CheckoutEnv): string {

  return bindings.PADDLE_ENV === "live"
    ? "https://api.paddle.com/transactions"
    : "https://sandbox-api.paddle.com/transactions";

}

/**
 * Allowed origins (strict same-origin enforcement)
 */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/**
 * Canonical Cloudflare Pages preview hostname pattern.
 * Accepts only {hash}-{slug}.aeterna-capsule.pages.dev format.
 * Prevents arbitrary subdomain trust (e.g. evil.aeterna-capsule.pages.dev).
 */

const PAGES_PREVIEW_REGEX =
  /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {

  if (ALLOWED_ORIGINS.includes(origin))
    return true;

  // ISSUE 2 fix: regex-bounded preview matching instead of endsWith()
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

type PaddleTransactionResponse = {
  data?: {
    id?: string;
    checkout?: {
      url?: string;
    };
  };
};

/**
 * Canonical Paddle checkout URL domains.
 * Defense-in-depth against upstream compromise or middleware injection.
 */

const PADDLE_CHECKOUT_HOSTNAMES = [
  "paddle.com",
  "buy.paddle.com",
  "checkout.paddle.com",
  "sandbox-buy.paddle.com",
];

function isPaddleCheckoutUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:")
      return false;
    return PADDLE_CHECKOUT_HOSTNAMES.some(
      h =>
        url.hostname === h ||
        url.hostname.endsWith(`.${h}`)
    );
  } catch {
    return false;
  }
}

/**
 * Headers
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
      "default-src 'self' https://cdn.paddle.com 'unsafe-inline' 'unsafe-eval'; connect-src https://sandbox-api.paddle.com https://api.paddle.com",

  };

}

/**
 * Error helper
 */

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
  context: EventContext<Record<string, unknown>, string, CheckoutEnv>
): Promise<Response> => {

  const origin =
    context.request.headers.get("origin") ?? "";

  if (!isAllowedOrigin(origin)) {

    console.error("[create-checkout] INVALID_ORIGIN (OPTIONS)", { origin });

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
  context: EventContext<Record<string, unknown>, string, CheckoutEnv>
): Promise<Response> => {

  const { request, env } = context;
  const bindings = env as unknown as CheckoutEnv;

  const origin =
    request.headers.get("origin") ?? "";

  /**
   * Strict origin allowlist enforcement
   */

  if (!isAllowedOrigin(origin)) {

    console.error("[create-checkout] INVALID_ORIGIN", { origin });

    return fail(403, "INVALID_ORIGIN", origin);

  }

  /**
   * Rate limit protection
   */

  const ip = getClientIp(request);

  if (!rateLimit(ip)) {

    console.error("[create-checkout] RATE_LIMIT", { ip });

    return fail(429, "TOO_MANY_REQUESTS", origin);

  }

  /**
   * Content-type validation
   */

  const contentType =
    request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {

    console.error("[create-checkout] INVALID_CONTENT_TYPE", { contentType });

    return fail(415, "UNSUPPORTED_MEDIA_TYPE", origin);

  }

  /**
   * Required secrets
   */

  const apiKey       = bindings.PADDLE_API_KEY;
  const basePriceId  = bindings.PADDLE_PRICE_BASE_ID;
  const extraPriceId = bindings.PADDLE_PRICE_EXTRA_ID;

  if (!apiKey || !basePriceId || !extraPriceId) {

    console.error("[create-checkout] CONFIG_MISSING");

    return fail(500, "PADDLE_CONFIG_MISSING", origin);

  }

  /**
   * Parse request body
   */

  let body: RequestBody;

  try {
    body = await request.json();
  } catch {
    console.error("[create-checkout] INVALID_JSON");
    return fail(400, "INVALID_JSON", origin);
  }

  // Prototype guard — mirrors seal / verify / webhook layers
  if (!isPlainObject(body)) {

    console.error("[create-checkout] INVALID_BODY_PROTOTYPE");

    return fail(400, "INVALID_BODY", origin);

  }

  const { billableSizeBytes, capsuleId, expectedAmount } = body;

  /**
   * Validate vault size.
   * isSafeInteger rejects floats, NaN, and unsafe integers —
   * mirrors verify.ts and webhook.ts integer discipline.
   */

  const parsedSize = Number(billableSizeBytes);

  if (
    !Number.isSafeInteger(parsedSize) ||
    parsedSize <= 0                   ||
    parsedSize > MAX_CAPSULE_SIZE
  ) {

    console.error("[create-checkout] INVALID_SIZE", { billableSizeBytes });

    return fail(400, "INVALID_SIZE", origin);

  }

  /**
   * Validate capsuleId — canonical import, no inline regex.
   * ISSUE 1 fix: prevents silent divergence if canonical validator evolves.
   */

  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    console.error("[create-checkout] INVALID_CAPSULE_ID", { capsuleId });

    return fail(400, "INVALID_CAPSULE_ID", origin);

  }

  /**
   * Server-side price authority.
   */

  const price =
    calculatePrice(parsedSize);

  /**
   * Validate UI-supplied expectedAmount against canonical server price
   * BEFORE any Business Quote is created.
   * Tolerance expressed in integer cents to avoid float drift surface.
   *
   * ISSUE 3 fix: Math.round(... * 100) comparison instead of raw float delta.
   */

  const parsedExpected =
    Number(expectedAmount);

  const priceCents    = Math.round(price * 100);
  const expectedCents = Math.round(parsedExpected * 100);

  if (
    !Number.isFinite(parsedExpected) ||
    Math.abs(expectedCents - priceCents) > 1
  ) {

    console.error("[create-checkout] PRICE_MISMATCH", {
      expectedAmount,
      calculated: price,
    });

    return fail(400, "PRICE_MISMATCH", origin);

  }

  /**
   * Canonical Business Quote.
   * Business Authority begins here — only after expectedAmount is validated.
   *
   * Uses the Trusted Time Authority, not process-local Date.now(),
   * to stay consistent with upload-token.ts / verify.ts / seal.ts / heartbeat.
   *
   * Idempotent: if a Quote already exists for this capsuleId, the existing
   * Quote is returned unchanged (created === false). Callers must not
   * delete a Quote they did not create.
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

  const { quote, created } =
    await createBusinessQuote(
      bindings,
      businessQuote
    );

  /**
   * Canonical return_url by environment.
   * Hardcoded — prevents preview-deploy or spoofed-origin redirect.
   */

  const returnUrl =
     bindings.PADDLE_ENV === "live"
       ? `https://aeternacapsule.com/create/hold?capsuleId=${capsuleId}`
       : `https://aeterna-capsule.pages.dev/create/hold?capsuleId=${capsuleId}`;

  /**
   * Build canonical items array using catalog price_id.
   * base block   = first 20 MB  → PADDLE_PRICE_BASE_ID  × 1
   * extra blocks = each +20 MB  → PADDLE_PRICE_EXTRA_ID × N
   */

  const blocks      = calculateBlocks(parsedSize);
  const extraBlocks = Math.max(0, blocks - 1);

  const items: { price_id: string; quantity: number }[] = [
    { price_id: basePriceId, quantity: 1 },
  ];

  if (extraBlocks > 0) {
    items.push({ price_id: extraPriceId, quantity: extraBlocks });
  }

  /**
   * Create Paddle transaction.
   *
   * If anything fails past this point, roll back the Quote — but ONLY
   * if this request is the one that actually created it. A Quote
   * returned by idempotent replay (created === false) must survive
   * a transient Paddle failure on this request.
   */

  let paddleData: PaddleTransactionResponse;
  let paddleOk:   boolean;

  try {

    const paddleRes = await fetch(getPaddleApi(bindings), {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items,
        checkout: {
          url: { return_url: returnUrl },
        },
        custom_data: {
          capsuleId,
          billableSizeBytes: parsedSize,
          expectedAmount:    quote.expectedAmount,   // canonical quote amount, not client value
          currency:          quote.currency,         // canonical quote currency — single source of
                                                       // truth, not a second hardcoded literal
        },
      }),
    });

    paddleOk = paddleRes.ok;

    const paddleText = await paddleRes.text();

    try {
      paddleData = JSON.parse(paddleText);
    } catch {
      console.error("[create-checkout] INVALID_PADDLE_JSON", paddleText);
      if (created) {
        await deleteBusinessQuote(bindings, capsuleId);
      }
      return fail(502, "INVALID_PADDLE_RESPONSE", origin);
    }

  } catch (err) {

    console.error("[create-checkout] PADDLE_UNREACHABLE", err);

    if (created) {
      await deleteBusinessQuote(bindings, capsuleId);
    }

    return fail(502, "PADDLE_UNREACHABLE", origin);

  }

  if (!paddleOk) {

    console.error("[create-checkout] PADDLE_TRANSACTION_FAILED", paddleData!);

    if (created) {
      await deleteBusinessQuote(bindings, capsuleId);
    }

    return fail(502, "PADDLE_TRANSACTION_FAILED", origin);

  }

  /**
   * Extract and validate checkout URL and transaction ID.
   * ISSUE 4 fix: checkoutUrl validated as HTTPS Paddle domain —
   * defense-in-depth against upstream compromise or middleware injection.
   */

  const checkoutUrl   = paddleData?.data?.checkout?.url;
  const transactionId = paddleData?.data?.id;

  if (
    typeof checkoutUrl !== "string" ||
    !isPaddleCheckoutUrl(checkoutUrl)
  ) {

    console.error("[create-checkout] CHECKOUT_URL_INVALID", { checkoutUrl });

    if (created) {
      await deleteBusinessQuote(bindings, capsuleId);
    }

    return fail(502, "PADDLE_CHECKOUT_URL_MISSING", origin);

  }

  if (typeof transactionId !== "string") {

    console.error("[create-checkout] TRANSACTION_ID_MISSING");

    if (created) {
      await deleteBusinessQuote(bindings, capsuleId);
    }

    return fail(502, "PADDLE_TRANSACTION_ID_MISSING", origin);

  }

  /**
   * Success — return checkoutUrl for redirect + transactionId
   * for webhook reconciliation and audit trail.
   */

  return new Response(
    JSON.stringify({ ok: true, checkoutUrl, transactionId }),
    { status: 200, headers: baseHeaders(origin) }
  );

};