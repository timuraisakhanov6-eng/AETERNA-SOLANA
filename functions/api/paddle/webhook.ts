import type { EventContext, KVNamespace } from "@cloudflare/workers-types";
import { getTrustedTime } from "../time";
import { CAPSULE_ID_REGEX } from "../../../src/lib/crypto/validators";
import {
  getBusinessQuote,
} from "../../lib/business/businessQuoteStore";
import {
  MAX_CAPSULE_SIZE,
} from "../../../src/lib/pricing";

const VERIFIED_TTL_SEC = 15 * 60;

/**
 * Canonical key prefixes — must mirror verify.ts and seal.ts exactly.
 *
 * TOPOLOGY (converged with Web3 path):
 *
 *   capsule:{capsuleId}  →  transactionId        (replay anchor + seal lookup)
 *   {transactionId}      →  full payment record  (authority source of truth)
 *
 * seal.ts reads capsule:{capsuleId} → transactionId → full record.
 * Both Web3 and Paddle paths must produce this exact shape.
 */
const CAPSULE_KEY_PREFIX = "capsule:";

/**
 * Canonical transactionId invariant — mirrors verify.ts
 */
const TX_ID_REGEX = /^[a-zA-Z0-9_-]{10,200}$/;

/**
 * Canonical hex string invariant — even-length, valid chars only.
 * Prevents parseInt(NaN) silently becoming 0 inside Uint8Array.
 */
const HEX_REGEX = /^[0-9a-f]*$/i;

/**
 * Environment bindings for this handler.
 */
interface WebhookEnv {
  PADDLE_ENV: "live" | "sandbox";
  PADDLE_API_KEY: string;
  PADDLE_WEBHOOK_SECRET: string;
  VERIFIED_PAYMENTS: KVNamespace;
  BUSINESS_QUOTES: KVNamespace;
}

/**
 * Canonical Paddle webhook event shape.
 * Covers both custom_data locations (data.custom_data and
 * data.checkout.custom_data) and both totals locations
 * (data.details.totals and data.totals) seen in the wild.
 */
type PaddleWebhookEvent = {
  event_type?: string;
  data?: {
    id?: string;
    status?: string;

    custom_data?: {
      capsuleId?:          string;
      expectedAmount?:     number;
      currency?:           string;
      billableSizeBytes?:  number;
    };

    checkout?: {
      custom_data?: {
        capsuleId?:          string;
        expectedAmount?:     number;
        currency?:           string;
        billableSizeBytes?:  number;
      };
    };

    details?: {
      totals?: {
        total?: string | number;
      };
    };

    totals?: {
      total?: string | number;
    };

    payments?: Array<{
      method_details?: {
        type?: string;
      };
    }>;
  };
};

/**
 * Canonical plain-object guard.
 * Accepts both Object.prototype and null-prototype objects —
 * mirrors isPlainObject() across manifest, storage, and verify layers.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical sealed response.
 * Webhook never reveals internal state to caller.
 */
function sealed(): Response {
  return new Response(
    JSON.stringify({ ok: true }),
    {
      status: 200,
      headers: {
        "Content-Type":                      "application/json",
        "Cache-Control":                     "no-store",
        "X-Content-Type-Options":            "nosniff",
        "X-Aeterna-Payment-Webhook-Version": "v1",
      },
    }
  );
}

/**
 * Strict hex → bytes.
 * Validates even length and character set before conversion.
 * Uses slice() — substr() is legacy and non-standard.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  if (!HEX_REGEX.test(hex)) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Paddle signature verification
 */
async function verifySignature(
  payload:   string,
  signature: string,
  secret:    string
): Promise<boolean> {

  const parts = signature.split(";");

  const ts  = parts.find(p => p.startsWith("ts="))?.replace("ts=", "");
  const sig = parts.find(p => p.startsWith("v1="))?.replace("v1=", "");

  if (!ts || !sig) return false;

  const tolerance = 300;
  const timestamp = Number(ts);

  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false;

  const { nowUtc } = await getTrustedTime();
  if (!Number.isSafeInteger(nowUtc)) return false;

  const now = Math.floor(nowUtc / 1000);
  if (Math.abs(now - timestamp) > tolerance) return false;
  if (timestamp > now + tolerance) return false;

  const signedPayload = `${ts}:${payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload)
  );

  const expected = new Uint8Array(digest);
  const received = hexToBytes(sig);

  if (!received) return false;
  if (expected.length !== received.length) return false;

  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected[i] ^ received[i];
  }
  return result === 0;
}

/**
 * Strict integer-safe cents parser.
 *
 * Paddle totals arrive in two documented formats:
 *   "200"  — subunit (cents) string, no decimal  → parse as integer directly
 *   "2.00" — decimal dollar string               → multiply by 100, round
 *
 * Avoids float arithmetic for the integer path to prevent representation
 * drift. Only falls back to parseFloat for the explicit decimal format.
 */
function parseTotalCents(raw: unknown): number {
  if (typeof raw !== "string" && typeof raw !== "number") return NaN;

  const str = String(raw).trim();

  if (str.includes(".")) {
    // Decimal dollar format — e.g. "2.00"
    const parsed = parseFloat(str);
    if (!isFinite(parsed) || parsed < 0) return NaN;
    return Math.round(parsed * 100);
  }

  // Integer subunit format — e.g. "200"
  // Use parseInt with explicit radix; reject any non-integer string.
  if (!/^\d+$/.test(str)) return NaN;
  const parsed = parseInt(str, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return NaN;
  return parsed;
}

/**
 * OPTIONS handler
 */
export const onRequestOptions = async (): Promise<Response> => {
  return new Response(null, { status: 204 });
};

/**
 * POST handler
 */
export const onRequestPost = async (
  context: EventContext<Record<string, unknown>, string, WebhookEnv>
): Promise<Response> => {

  const { request, env } = context;
  const bindings = env as unknown as WebhookEnv;

  try {

    const webhookSecret = bindings.PADDLE_WEBHOOK_SECRET;
    if (!webhookSecret) return sealed();
    if (!bindings.VERIFIED_PAYMENTS) return sealed();
    if (!bindings.BUSINESS_QUOTES) return sealed();

    const signature = request.headers.get("paddle-signature");
    if (!signature) return sealed();

    const rawBody = await request.text();

    const valid = await verifySignature(rawBody, signature, webhookSecret);
    if (!valid) return sealed();

    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return sealed();
    }

    if (!isPlainObject(event)) return sealed();

    const e = event as PaddleWebhookEvent;

    if (
      e.event_type !== "transaction.completed" ||
      e.data?.status !== "completed"
    ) {
      return sealed();
    }

    const transactionId = e.data?.id;

    if (
      typeof transactionId !== "string" ||
      !TX_ID_REGEX.test(transactionId)
    ) {
      return sealed();
    }

    /**
     * Support both metadata locations
     */
    let capsuleId:            unknown = e.data?.custom_data?.capsuleId           ?? e.data?.checkout?.custom_data?.capsuleId;
    let expectedAmountRaw:    unknown = e.data?.custom_data?.expectedAmount      ?? e.data?.checkout?.custom_data?.expectedAmount;
    let currencyRaw:          unknown = e.data?.custom_data?.currency           ?? e.data?.checkout?.custom_data?.currency;
    let billableSizeBytesRaw: unknown = e.data?.custom_data?.billableSizeBytes  ?? e.data?.checkout?.custom_data?.billableSizeBytes;
    let totalRaw:             unknown = e.data?.details?.totals?.total          ?? e.data?.totals?.total;

    /**
     * Environment-aware Paddle API fallback.
     * Triggers when custom_data is missing from webhook body.
     */
    if (
      (!capsuleId || !expectedAmountRaw || !billableSizeBytesRaw) &&
      typeof bindings.PADDLE_API_KEY === "string"
    ) {
      try {
        const paddleApiBase =
          bindings.PADDLE_ENV === "live"
            ? "https://api.paddle.com"
            : "https://sandbox-api.paddle.com";

        const txRes = await fetch(
          `${paddleApiBase}/transactions/${transactionId}`,
          { headers: { Authorization: `Bearer ${bindings.PADDLE_API_KEY}` } }
        );

        if (txRes.ok) {
          const tx = await txRes.json() as { data?: PaddleWebhookEvent["data"] };
          capsuleId            = tx?.data?.custom_data?.capsuleId;
          currencyRaw          = tx?.data?.custom_data?.currency;
          totalRaw             = tx?.data?.details?.totals?.total;
          expectedAmountRaw    = tx?.data?.custom_data?.expectedAmount;
          billableSizeBytesRaw = tx?.data?.custom_data?.billableSizeBytes;
        }
      } catch {
        console.warn("[webhook] fallback transaction fetch failed");
      }
    }

    /**
     * Normalize numeric metadata
     */
    const expectedAmount   = Number(expectedAmountRaw);
    const billableSizeBytes = Number(billableSizeBytesRaw);
    const totalCents       = parseTotalCents(totalRaw);

    if (
      typeof capsuleId !== "string"     ||
      !CAPSULE_ID_REGEX.test(capsuleId) ||
      typeof currencyRaw !== "string"   ||
      !Number.isFinite(totalCents)
    ) {
      return sealed();
    }

    const currency = currencyRaw;

    if (
      !Number.isSafeInteger(billableSizeBytes) ||
      billableSizeBytes <= 0                   ||
      billableSizeBytes > MAX_CAPSULE_SIZE
    ) {
      return sealed();
    }

    if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
      return sealed();
    }

    /**
     * Business Quote is the sole price authority — mirrors verify.ts.
     *
     * webhook.ts no longer recomputes price via calculatePrice(); it only
     * checks Paddle's reported amounts against the canonical Business
     * Quote established at checkout time. This keeps create-checkout.ts,
     * verify.ts, and webhook.ts on a single, converged pricing model.
     */
    const quote = await getBusinessQuote(bindings, capsuleId);

    if (!quote) {
      console.error("[webhook] BUSINESS_QUOTE_NOT_FOUND");
      return sealed();
    }

    const { nowUtc } = await getTrustedTime();
    if (!Number.isSafeInteger(nowUtc)) return sealed();

    if (quote.expiresAt <= nowUtc) {
      console.error("[webhook] BUSINESS_QUOTE_EXPIRED");
      return sealed();
    }

    if (currency.toUpperCase() !== quote.currency.toUpperCase()) {
      console.error("[webhook] INVALID_CURRENCY", { currency });
      return sealed();
    }

    const expectedPriceCents = Math.round(quote.expectedAmount * 100);
    const expectedAmtCents   = Math.round(expectedAmount * 100);

    if (Math.abs(expectedAmtCents - expectedPriceCents) > 1) {
      console.error("[webhook] CUSTOM_DATA_AMOUNT_MISMATCH", {
        expectedAmtCents,
        expectedPriceCents,
      });
      return sealed();
    }

    if (Math.abs(totalCents - expectedPriceCents) > 1) {
      console.error("[webhook] TOTAL_AMOUNT_MISMATCH", { totalCents, expectedPriceCents });
      return sealed();
    }

    /**
     * Replay protection — dual-binding, mirrors verify.ts.
     *
     * Check BOTH directions before writing:
     *   capsule:{capsuleId}  →  must not exist  (capsule not already paid)
     *   {transactionId}      →  must not exist  (tx not already recorded)
     *
     * This matches the Web3 path's binding semantics so replay detection
     * is equally strong regardless of payment method.
     */
    const capsuleKey = `${CAPSULE_KEY_PREFIX}${capsuleId}`;

    const [existingCapsule, existingTx] = await Promise.all([
      bindings.VERIFIED_PAYMENTS.get(capsuleKey),
      bindings.VERIFIED_PAYMENTS.get(transactionId),
    ]);

    if (existingCapsule || existingTx) return sealed();

    const expiresAt = nowUtc + VERIFIED_TTL_SEC * 1000;

    /**
     * Canonical payment record — converged with verify.ts schema.
     * billableSizeBytes is included so seal.ts can enforce payment↔manifest
     * size consistency without trusting client-supplied values.
     *
     * currency is written from the validated inbound value, not a
     * re-hardcoded literal — it has already been checked against
     * quote.currency above, so this is purely derivative.
     */
    const record = JSON.stringify({
      transactionId,
      capsuleId,
      expectedAmount: quote.expectedAmount,
      currency,
      billableSizeBytes,
      verifiedAt: nowUtc,
      expiresAt,
      version: 1,
      ok: true,
      method:
        e.data?.payments?.[0]?.method_details?.type ?? "paddle",
    });

    /**
     * CANONICAL TOPOLOGY WRITE — mirrors Web3 / verify.ts exactly:
     *
     *   capsule:{capsuleId}  →  transactionId   (seal.ts entry point)
     *   {transactionId}      →  full record     (authority source of truth)
     *
     * seal.ts resolves: capsule:{id} → transactionId → record.
     * Writing both keys atomically (via sequential puts) ensures
     * seal.ts never finds a capsule pointer with no backing record.
     *
     * Write the full record FIRST so the capsule pointer is never
     * live without its target.
     */

    /**
     * Payment Authority established.
     *
     * This Verified Payment becomes the canonical
     * payment authority for the capsule.
     *
     * Upload Token issuance and all subsequent
     * publication stages rely exclusively on this
     * record rather than reprocessing webhook events.
     */

    // Write the full record FIRST...
    await bindings.VERIFIED_PAYMENTS.put(
      transactionId,
      record,
      { expirationTtl: VERIFIED_TTL_SEC }
    );

    await bindings.VERIFIED_PAYMENTS.put(
      capsuleKey,
      transactionId,
      { expirationTtl: VERIFIED_TTL_SEC }
    );

    return sealed();

  } catch {
    return sealed();
  }
};