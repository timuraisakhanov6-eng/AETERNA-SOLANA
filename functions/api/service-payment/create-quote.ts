/**
 * AETERNA — Service Payment Quote
 *
 * POST /api/service-payment/create-quote
 *
 * Canonical fixed-fee service payment quote.
 *
 * Security invariants:
 * - server-side expectedAmount is authoritative
 * - client-provided expectedAmount is only a display hint
 * - quote is bound to a single payment intent lifecycle
 * - a new purchase may only start after the identity-scoped Durable
 *   Object atomically confirmed that NO live right and NO active
 *   purchase attempt exists for the cryptographically proven creator
 *   identity (one payment -> one capsule; a lost localStorage hint,
 *   a second tab or a second device can never authorise a second $1)
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import { verifyIdentityProof } from "../../lib/creatorIdentityProof";
import {
  createBusinessQuote,
  getBusinessQuote,
  renewBusinessQuote,
  type BusinessQuoteKVNamespace,
} from "../../lib/business/businessQuoteStore";

interface ServicePaymentCreateQuoteEnv {
  BUSINESS_QUOTES: BusinessQuoteKVNamespace;
  CREATOR_IDENTITIES: {
    get(key: string): Promise<string | null>;
  };
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(request: Request): Promise<Response>;
    };
  };
}

interface PurchaseGuardResult {
  ok?: boolean;
  error?: string;
  paymentIntentId?: string;
  activeAttempt?: {
    paymentIntentId: string;
    quoteId: string;
    /** Authoritative attempt state: reserved | granting | fulfilled. */
    state: string;
    createdAt: number;
    /**
     * The transaction signature ALREADY bound to this attempt, if any.
     * Read-only read-through from the identity coordinator's record —
     * reported so a client that lost its local pending pointer resumes
     * VERIFYING this transaction instead of signing a new one.
     */
    broadcastSignature?: string | null;
    /** The verified payment transaction id, when one is recorded. */
    transactionId?: string | null;
  };
}

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;
const LOCALHOST_REGEX = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && PAGES_PREVIEW_REGEX.test(url.hostname)) return true;
    if (LOCALHOST_REGEX.test(origin)) return true;
  } catch {
    // ignore
  }
  return false;
}

/**
 * Canonical AETERNA service fee.
 *
 * Natively denominated and settled in USDC — this is NOT a USD amount
 * and is NOT derived from any USD→USDC conversion, exchange rate,
 * oracle, or price source. 1 USDC = 1,000,000 atomic units.
 */
const SERVICE_FEE_USDC = 1;
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

function fail(origin: string, status = 400, error = "error", extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error, ...(extra ?? {}) }), {
    status,
    headers: baseHeaders(origin),
  });
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
  const bindings = env as unknown as ServicePaymentCreateQuoteEnv;
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

  /* ================= CREATOR IDENTITY (cryptographic) ================= */

  /**
   * The purchase guard is keyed by the SERVER-DERIVED creator identity:
   * a fresh challenge/signature proof is verified here exactly like the
   * credit-status endpoint, and the identity is resolved from
   * (network, account) server-side. A client-supplied creatorIdentityId
   * is never read by this endpoint.
   */
  const proofResult = await verifyIdentityProof(
    bindings,
    {
      challengeId: typeof body.challengeId === "string" ? body.challengeId : "",
      network: typeof body.network === "string" ? body.network : "",
      account: typeof body.account === "string" ? body.account : "",
      signature: typeof body.signature === "string" ? body.signature : "",
    },
    now
  );
  if (!proofResult.ok) {
    return fail(origin, proofResult.status, proofResult.error);
  }
  const authenticatedCreatorIdentityId = proofResult.creatorIdentityId;

  /* ================= ATOMIC PURCHASE GUARD ================= */

  const coordinatorBinding = bindings.CREDIT_OP_COORDINATOR;
  if (!coordinatorBinding) {
    // Without the identity coordinator a new purchase cannot be proven
    // safe — fail closed (no quote, no payment intent).
    console.error("[service-payment/create-quote] CREDIT_COORDINATOR_MISSING");
    return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE");
  }

  let guardData: PurchaseGuardResult | null = null;
  try {
    const stub = coordinatorBinding.get(
      coordinatorBinding.idFromName(`identity:${authenticatedCreatorIdentityId}`)
    );
    const guardResponse = await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "identity-reserve-attempt",
          creatorIdentityId: authenticatedCreatorIdentityId,
          quoteId: paymentIntentId,
          paymentIntentId,
        }),
      })
    );
    guardData = (await guardResponse.json()) as PurchaseGuardResult | null;
  } catch (err) {
    console.error("[service-payment/create-quote] CREDIT_COORDINATOR_ERROR", err);
    return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE");
  }

  /**
   * CONTINUE an unfinished purchase: the identity already has an active
   * attempt (its own earlier tab/device, or a retry after a lost
   * paymentIntentId). The SAME attempt is resumed — a second
   * independent purchase is never created.
   *
   * WHAT may be resumed depends on the AUTHORITATIVE attempt state kept
   * by the identity coordinator — never on the mere absence of a KV
   * key (KV is eventually consistent and can hide a fresh write):
   *
   *   fulfilled             → the credit was already minted. Do NOT
   *                           re-open a payment window; the caller goes
   *                           to creation.
   *   granting              → a verified payment exists and its grant is
   *                           unfinished. Do NOT re-open a payment
   *                           window; the caller resumes THAT grant.
   *   reserved              → no verified payment is recorded for this
   *                           attempt, so the payment window may be
   *                           renewed FOR THE SAME INTENT. A previously
   *                           sent-but-unverified transaction stays
   *                           creditable (same intent ⇒ at most one
   *                           verified payment ⇒ at most one credit),
   *                           and the client additionally refuses to
   *                           send a second transfer while its own
   *                           previous outcome is unknown.
   *
   * An UNKNOWN attempt state (no attempt record, unreadable state) is
   * never turned into "reserved": the caller gets a fail-closed answer
   * and no payment window.
   */
  if (guardData?.error === "PAYMENT_ATTEMPT_ACTIVE" && guardData.activeAttempt) {
    const active = guardData.activeAttempt;
    const existingQuote = await getBusinessQuote(bindings, active.paymentIntentId).catch(
      () => null
    );

    if (active.state === "fulfilled" || active.state === "granting") {
      return new Response(
        JSON.stringify({
          ok: true,
          continued: true,
          paymentState: active.state === "fulfilled" ? "granted" : "verified_pending_grant",
          paymentIntentId: active.paymentIntentId,
          expectedAmount: existingQuote?.expectedAmount ?? SERVICE_FEE_USDC,
          currency: existingQuote?.currency ?? "USDC",
          // Deliberately NO fresh window: a payment is already recorded
          // for this attempt, so there is nothing left to send.
          expiresAt: existingQuote?.expiresAt ?? active.createdAt,
        }),
        { status: 200, headers: baseHeaders(origin) }
      );
    }

    if (active.state !== "reserved") {
      // Unknown/unsupported attempt state: fail closed, no window.
      return fail(origin, 503, "ENTITLEMENT_STATE_UNKNOWN");
    }

    let quote = existingQuote;
    if (!quote) {
      const created = await createBusinessQuote(bindings, {
        paymentIntentId: active.paymentIntentId,
        expectedAmount: SERVICE_FEE_USDC,
        currency: "USDC" as const,
        createdAt: now,
        expiresAt: now + QUOTE_TTL_MS,
      }).catch(() => null);
      quote = created ? created.quote : null;
    } else {
      // Same intent, renewed window — idempotent (a live quote is
      // returned untouched, so two tabs converge on one expiry).
      quote = await renewBusinessQuote(
        bindings,
        active.paymentIntentId,
        now,
        QUOTE_TTL_MS
      ).catch(() => quote);
    }

    if (!quote) {
      return fail(origin, 500, "QUOTE_RENEWAL_FAILED");
    }

    return new Response(
      JSON.stringify({
        ok: true,
        continued: true,
        paymentState: "ready_to_pay",
        paymentIntentId: quote.paymentIntentId,
        expectedAmount: quote.expectedAmount,
        currency: quote.currency,
        expiresAt: quote.expiresAt,
        /**
         * DISCOVERY of an already-bound transaction signature for this
         * SAME intent (read-only read-through of the identity
         * coordinator's record). The caller is authenticated by the
         * cryptographic identity proof above and the attempt is scoped
         * to that identity, so this can only ever be the caller's own
         * attempt. A non-null value means: VERIFY THIS transaction, do
         * NOT sign a new one.
         */
        resumeTransactionId:
          typeof active.broadcastSignature === "string" && active.broadcastSignature
            ? active.broadcastSignature
            : null,
      }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  /**
   * A live right already exists: no new purchase is created at all.
   * The caller (Home Gate) switches to the right it already owns.
   */
  if (guardData?.error === "CREATOR_ALREADY_HAS_LIVE_RIGHT") {
    return fail(origin, 409, "CREATOR_ALREADY_HAS_LIVE_RIGHT");
  }

  /**
   * Unknown / unresolvable state (unresolved old credit, unenumerable
   * index): an absence can NOT be established — no payment intent.
   */
  if (!guardData?.ok) {
    const error =
      guardData?.error && guardData.error !== "INVALID_FIELDS"
        ? guardData.error
        : "ENTITLEMENT_STATE_UNKNOWN";
    return fail(origin, 503, error);
  }

  /* ================= QUOTE ================= */

  const existing = await getBusinessQuote(bindings, paymentIntentId);
  if (existing) {
    return new Response(
      JSON.stringify({
        ok: true,
        paymentState: "ready_to_pay",
        paymentIntentId: existing.paymentIntentId,
        expectedAmount: existing.expectedAmount,
        currency: existing.currency,
        expiresAt: existing.expiresAt,
        // A freshly reserved intent has no bound transaction yet.
        resumeTransactionId: null,
      }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  const quote = {
    paymentIntentId,
    expectedAmount: SERVICE_FEE_USDC,
    currency: "USDC" as const,
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
      paymentState: "ready_to_pay",
      paymentIntentId: quote.paymentIntentId,
      expectedAmount: quote.expectedAmount,
      currency: quote.currency,
      expiresAt: quote.expiresAt,
      // A brand-new intent has no bound transaction.
      resumeTransactionId: null,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
