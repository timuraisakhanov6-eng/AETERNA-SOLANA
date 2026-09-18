/**
 * AETERNA — Grant Creator Credit
 *
 * POST /api/creator/grant-credit
 *
 * Hard invariant:
 * - ONLY independently VERIFIED payment may grant Creator Credit.
 * - ONE verified service payment -> EXACTLY ONE Creator Credit.
 *
 * Post-verification authority:
 * - Business Quote expiry gates payment verification ONLY
 *   (enforced in /api/service-payment/verify).
 * - After successful verification the VerifiedPayment record is sufficient
 *   authority for Creator Credit issuance, so a later Business Quote expiry
 *   cannot invalidate the verified payment or its Credit.
 *
 * Quote existence alone is NOT sufficient.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import {
  checkPaymentTransactionBinding,
  resolvePaymentNetwork,
} from "../../lib/paymentTxUniqueness";

interface GrantCreditEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
  VERIFIED_PAYMENTS: {
    get(key: string): Promise<string | null>;
  };
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): DurableObjectStub;
  };
}

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
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

  /* ================= POST-VERIFICATION AUTHORITY =================

  The Business Quote is deliberately NOT read here. Its TTL gates payment
  verification only (enforced in /api/service-payment/verify). After
  successful verification the VerifiedPayment record — identity, quoteId and
  transactionId — is sufficient authority for Creator Credit issuance, so a
  later Business Quote expiry cannot strand an already-verified payment. */

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
    transactionId?: string;
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

  if (typeof verifiedPayment.quoteId !== "string" || !verifiedPayment.quoteId) {
    return fail(origin, 409, "VERIFIED_PAYMENT_QUOTE_ID_MISSING");
  }

  /* ================= GLOBAL TRANSACTION UNIQUENESS ================= */

  /**
   * Defense in depth at the Credit minting boundary: the verified
   * payment must carry the SAME transactionId as this request, and the
   * transaction's global uniqueness binding (network + transactionId,
   * established atomically by /api/service-payment/verify) must exist
   * and belong to THIS paymentIntentId. This makes
   * ONE successful transaction -> MAXIMUM ONE Creator Credit hold
   * independently of the (creatorIdentityId, quoteId) idempotency
   * index below.
   */
  const recordedTransactionId =
    typeof verifiedPayment.transactionId === "string" ? verifiedPayment.transactionId : "";
  if (!recordedTransactionId || recordedTransactionId !== transactionId) {
    return fail(origin, 409, "VERIFIED_PAYMENT_TX_MISMATCH");
  }

  const paymentNetwork = resolvePaymentNetwork(recordedTransactionId);
  if (!paymentNetwork) {
    return fail(origin, 409, "VERIFIED_PAYMENT_TX_MISMATCH");
  }

  const txBinding = await checkPaymentTransactionBinding(
    {
      CREDIT_OP_COORDINATOR: env.CREDIT_OP_COORDINATOR as
        GrantCreditEnv["CREDIT_OP_COORDINATOR"],
    },
    {
      network: paymentNetwork,
      transactionId: recordedTransactionId,
      paymentIntentId,
    }
  );
  if (!txBinding.ok) {
    return fail(
      origin,
      txBinding.reason === "CONFLICT" ? 409 : txBinding.reason === "UNVERIFIED" ? 409 : 503,
      txBinding.reason === "CONFLICT"
        ? "TRANSACTION_ALREADY_VERIFIED"
        : txBinding.reason === "UNVERIFIED"
        ? "PAYMENT_TX_UNIQUENESS_UNVERIFIED"
        : "PAYMENT_TX_UNIQUENESS_UNAVAILABLE"
    );
  }

  /* ================= ATOMIC GRANT (single-writer) =================

  The mint is serialized by the CREDIT_OP_COORDINATOR Durable Object,
  addressed per creatorIdentityId + quoteId. The DO owns the grant claim,
  generates the single creatorCreditId for this verified payment, and writes
  the KV credit record plus the quote-keyed credit index. Replay reuses the
  stored id and repairs any missing KV artifact, so concurrent or repeated
  grants can never mint a second Credit.

  The verified-payment identity used here is verifiedPayment.quoteId, which
  /api/service-payment/verify records from the Business Quote at verification
  time — so no live Business Quote read is required after verification. */

  const coordinatorBinding = env.CREDIT_OP_COORDINATOR;
  if (!coordinatorBinding) {
    return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE");
  }

  const quoteId = verifiedPayment.quoteId;
  const coordinatorId = coordinatorBinding.idFromName(`${creatorIdentityId}:${quoteId}`);
  const coordinator = coordinatorBinding.get(coordinatorId);

  let grantResponse: Response;
  try {
    grantResponse = await coordinator.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "grant",
          creatorIdentityId,
          quoteId,
          paymentIntentId,
          transactionId: recordedTransactionId,
          evidenceId: verifiedPaymentId,
        }),
      })
    );
  } catch {
    return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE");
  }

  let grantData: {
    ok?: boolean;
    outcome?: string;
    status?: string;
    creatorCreditId?: string;
    error?: string;
  } | null = null;
  try {
    grantData = (await grantResponse.json()) as typeof grantData;
  } catch {
    grantData = null;
  }

  if (
    !grantResponse.ok ||
    !grantData?.ok ||
    typeof grantData.creatorCreditId !== "string" ||
    !grantData.creatorCreditId
  ) {
    return fail(
      origin,
      grantResponse.status === 400 ? 400 : 409,
      grantData?.error || "CREDIT_GRANT_FAILED"
    );
  }

  return new Response(
    JSON.stringify({ ok: true, creatorCreditId: grantData.creatorCreditId, status: "AVAILABLE" }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
