/**
 * AETERNA — Capsule Storage Quote
 *
 * POST /api/storage/quote
 *
 * Creates an immutable Capsule Storage Quote based on an
 * authoritative PREPARED projection and current Irys
 * usdc-solana pricing.
 *
 * This endpoint does NOT execute storage payment.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  getPreparedProjection,
  type PreparedProjection,
} from "../../lib/storage/preparedProjectionStore";
import {
  getIrysUsdcSolanaPrice,
  getIrysUsdcDestination,
} from "../../lib/irys/storageQuoteIrys";
import {
  getStorageQuote,
  putStorageQuote,
} from "../../lib/storage/storageQuoteStore";
import type { StorageQuote } from "../../../src/types/storageQuote";

/* ================= ENV BINDINGS ================= */

interface StorageQuoteEnv {
  PREPARED_PROJECTIONS: {
    get(key: string): Promise<string | null>;
  };
  STORAGE_QUOTES: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
}

/* ================= CONSTANTS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;
const NEW_PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-solana-btt\.pages\.dev$/;
const LOCALHOST_REGEX = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

const QUOTE_TTL_SECONDS = 300; // 5 minutes

const USDC_DECIMALS = 1_000_000;

const EXPECTED_IRYS_TOKEN = "usdc-solana";

const EXPECTED_NETWORK = "solana-mainnet";

const EXPECTED_TOKEN_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/* ================= HELPERS ================= */

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

function fail(
  origin: string,
  status = 400,
  error = "error"
): Response {
  return new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: baseHeaders(origin) }
  );
}

function toAtomicUsdc(displayAmount: number): string {
  const atomic = Math.round(displayAmount * USDC_DECIMALS);
  return String(atomic);
}

/* ================= ENDPOINT ================= */

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, StorageQuoteEnv>
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

  /* ================= PARSE FIELDS ================= */

  const creatorIdentityId =
    typeof body.creatorIdentityId === "string" ? body.creatorIdentityId.trim() : "";

  const lifecycleId =
    typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";

  const capsuleId =
    typeof body.capsuleId === "string" ? body.capsuleId.trim() : "";

  const preparedProjectionId =
    typeof body.preparedProjectionId === "string"
      ? body.preparedProjectionId.trim()
      : "";

  const clientExpectedAmountAtomic =
    typeof body.expectedAmountAtomic === "string"
      ? body.expectedAmountAtomic.trim()
      : "";

  const clientIrysDestination =
    typeof body.irysDestination === "string"
      ? body.irysDestination.trim()
      : "";

  const clientIrysToken =
    typeof body.irysToken === "string" ? body.irysToken.trim() : "";

  const clientNetwork =
    typeof body.network === "string" ? body.network.trim() : "";

  const clientTokenMint =
    typeof body.tokenMint === "string" ? body.tokenMint.trim() : "";

  if (
    !creatorIdentityId ||
    !lifecycleId ||
    !capsuleId ||
    !preparedProjectionId ||
    clientExpectedAmountAtomic !== "" ||
    clientIrysDestination !== "" ||
    clientIrysToken !== "" ||
    clientNetwork !== "" ||
    clientTokenMint !== ""
  ) {
    return fail(origin, 400, "CLIENT_PRICE_AND_DESTINATION_MUST_BE_OMITTED");
  }

  /* ================= LOAD PROJECTION ================= */

  const projection = await getPreparedProjection(env, capsuleId);

  if (!projection) {
    return fail(origin, 404, "PREPARED_PROJECTION_NOT_FOUND");
  }

  /* ================= AUTHORITATIVE FIELD BINDING ================= */

  if (projection.creatorIdentityId !== creatorIdentityId) {
    return fail(origin, 403, "CREATOR_IDENTITY_MISMATCH");
  }

  if (projection.lifecycleId !== lifecycleId) {
    return fail(origin, 403, "LIFECYCLE_MISMATCH");
  }

  if (projection.capsuleId !== capsuleId) {
    return fail(origin, 403, "CAPSULE_ID_MISMATCH");
  }

  if (projection.state !== "ACTIVE") {
    return fail(origin, 409, "PREPARED_PROJECTION_NOT_ACTIVE");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  if (!Number.isSafeInteger(now) || now >= projection.expiresAt) {
    return fail(origin, 409, "PREPARED_PROJECTION_EXPIRED");
  }

  /* ================= IRYS DATA ================= */

  let priceAtomic: string;
  let irysDestination: string;

  try {
    priceAtomic = await getIrysUsdcSolanaPrice(projection.encryptedSizeBytes);
  } catch {
    return fail(origin, 502, "IRYS_STORAGE_PRICE_UNAVAILABLE");
  }

  try {
    irysDestination = await getIrysUsdcDestination();
  } catch {
    return fail(origin, 502, "IRYS_USDC_DESTINATION_UNAVAILABLE");
  }

  if (!/^\d+$/.test(priceAtomic)) {
    return fail(origin, 502, "IRYS_STORAGE_PRICE_INVALID");
  }

  const displayAmountUSDC = Number.parseFloat(
    `${Number(priceAtomic) / USDC_DECIMALS}`
  );

  if (!Number.isFinite(displayAmountUSDC) || displayAmountUSDC <= 0) {
    return fail(origin, 502, "IRYS_STORAGE_PRICE_INVALID");
  }

  /* ================= QUOTE TTL ================= */

  const expiresAt = now + QUOTE_TTL_SECONDS * 1000;

  /* ================= IDEMPOTENCY ================= */

  const existing = await getStorageQuote(
    env,
    creatorIdentityId,
    lifecycleId,
    capsuleId
  );

  if (existing && existing.state === "CREATED" && now < existing.expiresAt) {
    return new Response(
      JSON.stringify(existing),
      {
        status: 200,
        headers: baseHeaders(origin),
      }
    );
  }

  /* ================= QUOTE CONSTRUCTION ================= */

  const storagePaymentId = `storage-pay-${crypto.randomUUID()}`;
  const createdAt = now;

  const quote: StorageQuote = {
    storagePaymentId,
    preparedProjectionId: projection.preparedProjectionId,
    creatorIdentityId: projection.creatorIdentityId,
    lifecycleId: projection.lifecycleId,
    capsuleId: projection.capsuleId,
    billableSizeBytes: projection.encryptedSizeBytes,
    vaultSha256: projection.vaultSha256,
    expectedAmountAtomic: priceAtomic,
    displayAmountUSDC: displayAmountUSDC.toFixed(6),
    currency: "USDC",
    network: EXPECTED_NETWORK,
    tokenMint: EXPECTED_TOKEN_MINT,
    irysToken: EXPECTED_IRYS_TOKEN,
    irysDestination,
    createdAt,
    expiresAt,
    state: "CREATED",
  };

  await putStorageQuote(env, quote);

  return new Response(
    JSON.stringify({ ok: true, ...quote }),
    {
      status: 200,
      headers: baseHeaders(origin),
    }
  );
}
