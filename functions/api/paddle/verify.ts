/**
 * AETERNA — Paddle Verify Payment (Cloudflare Pages Functions)
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import { MAX_CAPSULE_SIZE } from "../../../src/lib/pricing";
import { CAPSULE_ID_REGEX } from "../../../src/lib/crypto/validators";
import {
  getBusinessQuote,
} from "../../lib/business/businessQuoteStore";

/**
 * Environment bindings for this handler.
 */
interface VerifyEnv {
  PADDLE_ENV: "live" | "sandbox";
  PADDLE_API_KEY: string;
  VERIFIED_PAYMENTS: KVNamespace;
  BUSINESS_QUOTES: KVNamespace;
}

/**
 * Paddle API endpoint selection (canonical environment binding)
 */

function getPaddleApi(bindings: VerifyEnv): string {

  return bindings.PADDLE_ENV === "live"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";

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
 * Validation regex
 */

// ISSUE 1 fix: CAPSULE_ID_REGEX imported from canonical validators —
// prevents silent divergence if the canonical validator evolves.

const TX_ID_REGEX =
  /^[a-zA-Z0-9_-]{10,200}$/;

/**
 * VERIFIED_PAYMENTS entry TTL
 */

const VERIFIED_TTL_MS =
  15 * 60 * 1000;

const VERIFIED_TTL_SEC =
  15 * 60;

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
  transactionId?: unknown;
  capsuleId?:     unknown;
};

type PaddleTransaction = {
  status?:      string;
  custom_data?: {
    capsuleId?:          string;
    billableSizeBytes?:  number;
    expectedAmount?:     number;
    currency?:           string;
  };
  details?: {
    totals?: {
      total?:         string | number;
      currency_code?: string;
    };
  };
};

type PaddleTransactionResponse = {
  data?: PaddleTransaction;
};

/**
 * Headers
 */

function baseHeaders(
  origin: string
): Record<string, string> {

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

    "X-Aeterna-Payment-Verify-Version":
      "v1",

    "Content-Security-Policy":
      "default-src 'none'",

  };

}

/**
 * Error helper
 */

function fail(
  origin: string,
  code = 400
): Response {

  return new Response(
    JSON.stringify({ ok: false }),
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
  context: EventContext<Record<string, unknown>, string, VerifyEnv>
): Promise<Response> => {

  const origin =
    context.request.headers.get("origin") ?? "";

  if (!ALLOWED_ORIGINS.includes(origin)) {

    console.error("[verify] INVALID_ORIGIN OPTIONS", { origin });

    return new Response(null, {
      status:  403,
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
  context: EventContext<Record<string, unknown>, string, VerifyEnv>
): Promise<Response> => {

  const { request, env } = context;
  const bindings = env as unknown as VerifyEnv;

  const origin =
    request.headers.get("origin") ?? "";

  /**
   * Strict origin allowlist enforcement
   */

  if (!ALLOWED_ORIGINS.includes(origin)) {

    console.error("[verify] INVALID_ORIGIN", { origin });

    return fail(origin, 403);

  }

  /**
   * Content-type validation
   */

  const contentType =
    request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {

    console.error("[verify] INVALID_CONTENT_TYPE", { contentType });

    return fail(origin, 415);

  }

  /**
   * Rate limit protection
   */

  const ip = getClientIp(request);

  if (!rateLimit(ip)) {

    console.error("[verify] RATE_LIMIT", { ip });

    return fail(origin, 429);

  }

  /**
   * Parse body
   */

  let body: RequestBody;

  try {
    body = await request.json();
  } catch {
    console.error("[verify] INVALID_JSON");
    return fail(origin, 400);
  }

  /**
   * Prototype pollution guard — mirrors all other AETERNA layers.
   */

  if (!isPlainObject(body)) {

    console.error("[verify] INVALID_BODY_PROTOTYPE");

    return fail(origin, 400);

  }

  const { transactionId, capsuleId } = body;

  /**
   * Validate IDs
   */

  if (
    !transactionId ||
    typeof transactionId !== "string" ||
    !TX_ID_REGEX.test(transactionId) ||
    !capsuleId ||
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    console.error("[verify] INVALID_IDS", { transactionId, capsuleId });

    return fail(origin, 400);

  }

  /**
   * Required secrets
   */

  const apiKey = bindings.PADDLE_API_KEY;

  if (!apiKey) {

    console.error("[verify] PADDLE_API_KEY missing");

    return fail(origin, 500);

  }

  /**
   * Required KV bindings
   */

  if (!bindings.VERIFIED_PAYMENTS) {

    console.error("[verify] VERIFIED_PAYMENTS binding missing");

    return fail(origin, 503);

  }

  if (!bindings.BUSINESS_QUOTES) {

    console.error("[verify] BUSINESS_QUOTES binding missing");

    return fail(origin, 503);

  }

  /**
   * Load Business Quote.
   * Business Authority for this capsule was established at checkout time —
   * Verification consumes it, it never recomputes price on its own.
   */

  const quote =
    await getBusinessQuote(bindings, capsuleId);

  if (!quote) {

    console.error("[verify] BUSINESS_QUOTE_NOT_FOUND");

    return fail(origin, 402);

  }

  /**
   * Replay protection (capsule-bound idempotent)
   */

  const existing =
    await bindings.VERIFIED_PAYMENTS.get(transactionId);

  if (existing) {

    try {

      const parsed = JSON.parse(existing);

      if (
        parsed?.capsuleId     !== capsuleId ||
        parsed?.transactionId !== transactionId
      ) {

        console.error("[verify] TRANSACTION_REUSE_MISMATCH");

        return fail(origin, 403);

      }

    } catch {

      return fail(origin, 500);

    }

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: baseHeaders(origin) }
    );

  }

  /**
   * Second-payment guard — parity with web3/verify.ts and webhook.ts.
   *
   * The primary replay check above handles the idempotent retry of the
   * SAME (transactionId, capsuleId) pair (returned 200 before reaching
   * this point). This secondary check therefore runs only for a NEW
   * transactionId: if the capsule is already bound to a verified payment
   * via capsule:{capsuleId}, reject the new payment so the existing
   * verified payment/binding is never replaced. The Business Quote is
   * idempotent and immutable, so a second payment would carry the same
   * canonical price — accepting it would only orphan the first binding.
   */

  const capsuleKey =
    "capsule:" + capsuleId;

  const existingCapsuleBinding =
    await bindings.VERIFIED_PAYMENTS.get(capsuleKey);

  if (existingCapsuleBinding) {

    console.error(
      "[verify] CAPSULE_ALREADY_PAID",
      { capsuleId, transactionId }
    );

    return fail(origin, 409);

  }

  /**
   * Fetch transaction from Paddle
   */

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000);

  let paddleData: PaddleTransactionResponse;
  let paddleOk:   boolean;

  try {

    const txRes = await fetch(
      `${getPaddleApi(bindings)}/transactions/${transactionId}`,
      {
        method:  "GET",
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      }
    );

    paddleOk   = txRes.ok;
    paddleData = await txRes.json();

  } catch {

    console.error("[verify] PADDLE_UNREACHABLE");

    return fail(origin, 502);

  } finally {

    clearTimeout(timeout);

  }

  if (!paddleOk) {

    console.error("[verify] PADDLE_TRANSACTION_FETCH_FAILED");

    return fail(origin, 402);

  }

  const tx = paddleData?.data;

  /**
   * Status validation
   */

  if (tx?.status !== "completed")
    return fail(origin, 402);

  /**
   * Capsule binding validation
   */

  if (tx?.custom_data?.capsuleId !== capsuleId) {

    console.error("[verify] CAPSULE_ID_MISMATCH");

    return fail(origin, 403);

  }

  /**
   * billableSizeBytes validation — isSafeInteger mirrors create-checkout / webhook.
   * Kept purely as a technical sanity check; it no longer feeds pricing.
   * Business Isolation: billable size is not recomputed into price here.
   */

  const billableSizeBytesRaw = tx?.custom_data?.billableSizeBytes;

  if (
    typeof billableSizeBytesRaw !== "number" ||
    !Number.isSafeInteger(billableSizeBytesRaw) ||
    billableSizeBytesRaw <= 0 ||
    billableSizeBytesRaw > MAX_CAPSULE_SIZE
  ) {

    console.error("[verify] INVALID_BILLABLE_SIZE_BYTES");

    return fail(origin, 402);

  }

  const billableSizeBytes = billableSizeBytesRaw;

  /**
   * Trusted Time — fetched once, used both for Quote expiry and for the
   * verifiedAt timestamp written to KV below.
   */

  const { nowUtc: verifiedAt } = await getTrustedTime();

  if (!Number.isSafeInteger(verifiedAt))
    return fail(origin, 503);

  /**
   * Business Quote expiry validation.
   */

  if (quote.expiresAt <= verifiedAt) {

    console.error("[verify] BUSINESS_QUOTE_EXPIRED");

    return fail(origin, 402);

  }

  /**
   * expectedAmount validation — integrity check between Paddle's
   * custom_data and the canonical Business Quote. The Quote is the
   * source of truth; Paddle's custom_data must agree with it.
   */

  const expectedAmountRaw = tx?.custom_data?.expectedAmount;

  if (
    typeof expectedAmountRaw !== "number" ||
    !Number.isFinite(expectedAmountRaw)   ||
    expectedAmountRaw <= 0
  ) {

    console.error("[verify] INVALID_AMOUNT_BINDING");

    return fail(origin, 402);

  }

  const expectedAmount = expectedAmountRaw;

  /**
   * Currency validation — against the Quote's canonical currency,
   * not a hardcoded literal.
   */

  const currency = tx?.details?.totals?.currency_code;

  if (String(currency).toUpperCase() !== quote.currency.toUpperCase()) {

    console.error("[verify] INVALID_CURRENCY");

    return fail(origin, 402);

  }

  /**
   * Business Quote is the sole price authority.
   * Verification no longer recomputes price from billableSizeBytes — it
   * only checks Paddle's reported amounts against the Quote already
   * established at checkout time.
   *
   * ISSUE 7 fix (carried over): all monetary comparisons use integer
   * cents — identical semantics to create-checkout.ts and webhook.ts.
   */

  const expectedPriceCents =
    Math.round(quote.expectedAmount * 100);

  const expectedAmtCents =
    Math.round(expectedAmount * 100);

  if (Math.abs(expectedAmtCents - expectedPriceCents) > 1) {

    console.error("[verify] CUSTOM_DATA_AMOUNT_MISMATCH", {
      expectedAmtCents,
      expectedPriceCents,
    });

    return fail(origin, 402);

  }

  /**
   * Validate Paddle totals against the canonical Quote amount.
   *
   * Paddle may return totals.total as:
   *   "200"  — subunit cents string  → parse as integer, no scaling
   *   "2.00" — decimal dollar string → multiply by 100
   */

  const totalRaw = tx?.details?.totals?.total;

  const totalCents = (() => {

    if (typeof totalRaw !== "string" && typeof totalRaw !== "number")
      return NaN;

    const parsed = parseFloat(String(totalRaw));

    if (!isFinite(parsed))
      return NaN;

    return String(totalRaw).includes(".")
      ? Math.round(parsed * 100)
      : Math.round(parsed);

  })();

  if (
    !Number.isFinite(totalCents) ||
    Math.abs(totalCents - expectedPriceCents) > 1
  ) {

    console.warn("[verify] TOTAL_AMOUNT_MISMATCH", {
      totalCents,
      expectedPriceCents,
    });

    return fail(origin, 402);

  }

  /**
   * Write verification state to KV (trusted-time derived)
   */

  const expiresAt =
    verifiedAt + VERIFIED_TTL_MS;

  try {

    const record = JSON.stringify({
      transactionId,
      capsuleId,
      expectedAmount: quote.expectedAmount,
      currency: quote.currency,
      billableSizeBytes,
      verifiedAt,
      expiresAt,
      version: 1,
      ok: true,
    });

    /**
     * Canonical payment topology:
     *
     * transactionId  → full record
     * capsule:{id}   → transactionId
     */

    const capsuleKey =
      "capsule:" + capsuleId;

    // Payment Authority established.
    //
    // This Verified Payment becomes the canonical
    // payment authority for the capsule.
    //
    // Upload Token issuance and all subsequent
    // publication stages rely exclusively on this
    // record rather than re-verifying Paddle.

    // Primary binding
    await bindings.VERIFIED_PAYMENTS.put(
      transactionId,
      record,
      { expirationTtl: VERIFIED_TTL_SEC }
    );

    // Secondary binding
    await bindings.VERIFIED_PAYMENTS.put(
      capsuleKey,
      transactionId,
      { expirationTtl: VERIFIED_TTL_SEC }
    );

  } catch {

    console.error("[verify] KV_WRITE_FAILED");

    return fail(origin, 503);

  }

  /**
   * Success
   */

  return new Response(
    JSON.stringify({ ok: true }),
    {
      status:  200,
      headers: baseHeaders(origin),
    }
  );

};