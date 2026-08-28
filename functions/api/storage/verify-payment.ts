/**
 * AETERNA — Storage Payment Verification
 *
 * POST /api/storage/verify-payment
 *
 * Authoritatively verifies a Solana USDC storage payment against
 * an immutable Storage Quote using Alchemy Solana RPC.
 *
 * This endpoint does NOT perform Irys uploads.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  getStorageQuoteByPaymentId,
  putStorageQuote,
} from "../../lib/storage/storageQuoteStore";
import { getStoragePayment, putStoragePayment } from "../../lib/storage/storagePaymentStore";
import { verifySolanaUsdcStoragePayment } from "../../lib/storage/solanaUsdcVerifier";
import type { StorageQuote } from "../../../src/types/storageQuote";
import type { StoragePayment } from "../../../src/types/storagePayment";

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
  return new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: baseHeaders(origin) }
  );
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, Record<string, unknown>>
): Promise<Response> {
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

  const storagePaymentId =
    typeof body.storagePaymentId === "string" ? body.storagePaymentId.trim() : "";
  const transactionSignature =
    typeof body.transactionSignature === "string" ? body.transactionSignature.trim() : "";

  if (!storagePaymentId || !transactionSignature) {
    return fail(origin, 400, "MISSING_PAYMENT_EVIDENCE");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  const quote = await getStorageQuoteByPaymentId(
    env as Parameters<typeof getStorageQuoteByPaymentId>[0],
    storagePaymentId
  );

  if (!quote) {
    return fail(origin, 404, "STORAGE_QUOTE_NOT_FOUND");
  }

  if (quote.state === "EXPIRED" || now >= quote.expiresAt) {
    const expiredQuote: StorageQuote = { ...quote, state: "EXPIRED" };
    await putStorageQuote(
      env as Parameters<typeof putStorageQuote>[0],
      expiredQuote
    );
    return fail(origin, 409, "STORAGE_QUOTE_EXPIRED");
  }

  const existing = await getStoragePayment(
    env as Parameters<typeof getStoragePayment>[0],
    storagePaymentId
  );

  if (existing) {
    if (existing.state === "PAYMENT_VERIFIED") {
      return new Response(
        JSON.stringify({ ok: true, ...existing }),
        {
          status: 200,
          headers: baseHeaders(origin),
        }
      );
    }
    return fail(origin, 409, "STORAGE_PAYMENT_ALREADY_PROCESSED");
  }

  const rpcUrl =
    typeof (env as Record<string, unknown>)["SOLANA_MAINNET_RPC_URL"] === "string"
      ? ((env as Record<string, unknown>)["SOLANA_MAINNET_RPC_URL"] as string)
      : "";

  if (!rpcUrl) {
    return fail(origin, 502, "SOLANA_RPC_UNAVAILABLE");
  }

  const verification = await verifySolanaUsdcStoragePayment({
    rpcUrl,
    transactionSignature,
    expectedPayer: quote.creatorIdentityId,
    expectedMint: quote.tokenMint,
    expectedAmountAtomic: quote.expectedAmountAtomic,
    expectedDestination: quote.irysDestination,
  });

  if (!verification.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        state: "FAILED",
        reason: verification.reason,
        details: verification.details,
      }),
      {
        status: 400,
        headers: baseHeaders(origin),
      }
    );
  }

  const payment: StoragePayment = {
    storagePaymentId,
    quote: { ...quote },
    transactionSignature,
    payer: verification.payer,
    mint: verification.mint,
    destination: verification.destination,
    amountAtomic: verification.amountAtomic,
    network: "solana-mainnet",
    verifiedAt: now,
    state: "PAYMENT_VERIFIED",
  };

  await putStoragePayment(
    env as Parameters<typeof putStoragePayment>[0],
    payment
  );

  const verifiedQuote: StorageQuote = { ...quote, state: "EXPIRED" };
  await putStorageQuote(
    env as Parameters<typeof putStorageQuote>[0],
    verifiedQuote
  );

  return new Response(
    JSON.stringify({ ok: true, ...payment }),
    {
      status: 200,
      headers: baseHeaders(origin),
    }
  );
}
