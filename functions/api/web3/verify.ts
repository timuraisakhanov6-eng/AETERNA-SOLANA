/**
 * AETERNA — Web3 Payment Verify (Cloudflare Pages Function)
 * POST /api/web3/verify
 *
 * Verifies USDC payment on Base via Alchemy RPC.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import { MAX_CAPSULE_SIZE } from "../../../src/lib/pricing";
import {
  CAPSULE_ID_REGEX,
  TX_HASH_REGEX
} from "../../../src/lib/crypto/validators";
import {
  getBusinessQuote,
} from "../../lib/business/businessQuoteStore";

/* ─────────────────────────────────────────────
   Environment bindings
───────────────────────────────────────────── */

interface Web3VerifyEnv {
  ALCHEMY_BASE_URL: string;

  VERIFIED_PAYMENTS: KVNamespace;

  BUSINESS_QUOTES: KVNamespace;
}

/* ─────────────────────────────────────────────
   Constants
───────────────────────────────────────────── */

const BASE_CHAIN_ID = "0x2105";

import { CONTRACTS }
  from "../../../src/config/contracts";

const USDC_CONTRACT =
  CONTRACTS.BASE.USDC.toLowerCase();

const RECIPIENT =
  CONTRACTS.BASE.EXECUTOR_HOT.toLowerCase();

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const USDC_DECIMALS = 6;

const AMOUNT_TOLERANCE = 1n;

const VERIFIED_TTL_MS  = 15 * 60 * 1000;
const VERIFIED_TTL_SEC = 15 * 60;

/**
 * Minimum confirmations required before accepting a tx.
 * Protects against temporary fork rollback on Base.
 */

const MIN_CONFIRMATIONS = 2n;

/**
 * Canonical hex block number pattern.
 * Used to validate RPC-returned block numbers before BigInt conversion.
 */

const HEX_BLOCK_REGEX = /^0x[0-9a-f]+$/i;

/**
 * KV key prefix for capsuleId → txHash binding.
 *
 * Written alongside the primary txHash → record entry to create a
 * second axis of replay defense. Allows the seal layer to verify
 * that the txHash it receives was issued for the correct capsuleId.
 */

const CAPSULE_PAYMENT_KEY_PREFIX = "capsule:";

/**
 * Allowed origins — mirrors seal / upload-token / manifest endpoints.
 */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/* ─────────────────────────────────────────────
   Pricing helpers
───────────────────────────────────────────── */

/**
 * ISSUE 3 FIX: deterministic USDC unit conversion.
 *
 * Previous implementation used float multiplication:
 *   Math.round(amountUSD * 10 ** USDC_DECIMALS)
 *
 * The frontend uses viem's parseUnits(String(amountUSD), USDC_DECIMALS)
 * which performs string-based decimal arithmetic. Direct IEEE-754 float
 * multiplication can diverge from string-based parsing for edge decimal
 * representations, creating a backend/frontend amount mismatch that
 * silently rejects valid payments.
 *
 * Fix: toFixed(2) normalizes to cents precision before expanding to
 * USDC units. toFixed(USDC_DECIMALS) would silently round sub-cent
 * float noise (e.g. 1.0000009 → "1.000001") and diverge from the
 * frontend's parseUnits(String(x), 6) for the same input.
 *
 * Since AETERNA pricing authority is defined in whole cents, toFixed(2)
 * is the canonical normalization boundary: it matches the pricing
 * model, eliminates sub-cent float drift, and produces the same unit
 * value as parseUnits on any input the pricing layer emits.
 */

function usdToUsdcUnits(amountUSD: number): bigint {
  // Normalize to cents first, then expand to USDC micro-units.
  // toFixed(2) → e.g. "5.99" → "599000" → 599000n
  const cents = amountUSD.toFixed(2);            // canonical cent boundary
  const [whole, frac = "00"] = cents.split(".");
  const padded = frac.padEnd(USDC_DECIMALS, "0"); // "99" → "990000"
  return BigInt(whole + padded);
}

/* ─────────────────────────────────────────────
   Types
───────────────────────────────────────────── */

type RequestBody = {
  txHash?:             unknown;
  capsuleId?:          unknown;
  billableSizeBytes?:  unknown;
};

type EthLog = {
  address?: string;
  topics?:  string[];
  data?:    string;
};

type TxReceipt = {
  status?:      string;
  logs?:        EthLog[];
  blockNumber?: string;
};

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */

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

function baseHeaders(
  origin: string
): Record<string, string> {

  return {
    "Content-Type":             "application/json",
    "Cache-Control":            "no-store",
    "X-Content-Type-Options":   "nosniff",
    "Content-Security-Policy":  "default-src 'none'",
    "Timing-Allow-Origin":      origin,
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(
  code = 400,
  msg?: string,
  origin?: string
): Response {
  return new Response(
    JSON.stringify({ ok: false, error: msg ?? "error" }),
    { status: code, headers: baseHeaders(origin ?? "") }
  );
}

/* JSON-RPC call */

/**
 * ISSUE 4 FIX: RPC timeout classified as distinct error type.
 *
 * Previously AbortError was indistinguishable from RPC malformed
 * response, network outage, or provider failure — all collapsed into
 * a generic 500. Operational visibility was lost and retry semantics
 * became nondeterministic.
 *
 * RpcTimeoutError is now thrown on AbortController signal, caught in
 * the main handler, and returned as 504 GATEWAY_TIMEOUT — a distinct
 * status that callers and monitoring can treat as retriable.
 */

class RpcTimeoutError extends Error {
  constructor() {
    super("RPC_TIMEOUT");
    this.name = "RpcTimeoutError";
  }
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<unknown> {

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    if (!res.ok)
      throw new Error(`RPC HTTP error ${res.status}`);

    const json = await res.json() as {
      result?: unknown;
      error?:  { message: string };
    };

    if (json.error)
      throw new Error(json.error.message);

    return json.result;

  } catch (err) {

    if (
      err instanceof Error &&
      err.name === "AbortError"
    ) {
      throw new RpcTimeoutError();
    }

    throw err;

  } finally {

    clearTimeout(timeout);

  }
}

/* Transfer verification */

function findTransferLog(
  receipt:           TxReceipt,
  expectedUsdcUnits: bigint
) {

  if (!receipt.logs?.length)
    return { found: false, reason: "No logs in receipt" };

  for (const log of receipt.logs) {

    if (log.address?.toLowerCase() !== USDC_CONTRACT)
      continue;

    if (log.topics?.[0] !== TRANSFER_TOPIC)
      continue;

    const toTopic = log.topics?.[2]?.toLowerCase() ?? "";

    if (!toTopic.endsWith(RECIPIENT.slice(2)))
      continue;

    const dataHex = log.data;

    if (!dataHex)
      return { found: false, reason: "Empty data" };

    let transferred: bigint;

    try {
      transferred = BigInt(dataHex);
    } catch {
      return { found: false, reason: "Parse failed" };
    }

    if (transferred < expectedUsdcUnits - AMOUNT_TOLERANCE)
      return { found: false, reason: "Amount too low" };

    return { found: true };

  }

  return { found: false, reason: "Transfer not found" };
}

/* ─────────────────────────────────────────────
   OPTIONS
───────────────────────────────────────────── */

export const onRequestOptions = async (
  context: EventContext<Record<string, unknown>, string, Web3VerifyEnv>
): Promise<Response> => {

  const origin = context.request.headers.get("origin") ?? "";

  if (!ALLOWED_ORIGINS.includes(origin)) {

    console.error("[web3/verify] INVALID_ORIGIN OPTIONS", { origin });

    return new Response(null, {
      status:  403,
      headers: { "Content-Type": "application/json" },
    });

  }

  return new Response(null, { status: 204, headers: baseHeaders(origin) });

};

/* ─────────────────────────────────────────────
   POST
───────────────────────────────────────────── */

export const onRequestPost = async (
  context: EventContext<Record<string, unknown>, string, Web3VerifyEnv>
): Promise<Response> => {

  const { request, env } = context;
  const bindings = env as unknown as Web3VerifyEnv;

  const origin = request.headers.get("origin") ?? "";

  /**
   * Strict origin allowlist enforcement — mirrors create-checkout /
   * verify / webhook. Rejected before any body parsing or RPC work.
   */

  if (!ALLOWED_ORIGINS.includes(origin)) {

    console.error("[web3/verify] INVALID_ORIGIN", { origin });

    return fail(403, "INVALID_ORIGIN", origin);

  }

  /* content-type */

  if (!request.headers.get("content-type")?.includes("application/json"))
    return fail(415, undefined, origin);

  /* rate limit */

  const ip = getClientIp(request);

  if (!rateLimit(ip))
    return fail(429, undefined, origin);

  /* parse body */

  let body: RequestBody;

  try {
    body = await request.json();
  } catch {
    return fail(400, undefined, origin);
  }

  if (!isPlainObject(body)) {
    return fail(400, "Invalid body", origin);
  }

  const { txHash, capsuleId, billableSizeBytes } = body;

  /* validation */

  if (
    typeof txHash !== "string" ||
    !TX_HASH_REGEX.test(txHash)
  )
    return fail(400, "Invalid txHash", origin);

  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  )
    return fail(400, "Invalid capsuleId", origin);

  if (
    typeof billableSizeBytes !== "number" ||
    !Number.isSafeInteger(billableSizeBytes) ||
    billableSizeBytes <= 0 ||
    billableSizeBytes > MAX_CAPSULE_SIZE
  )
    return fail(400, "Invalid billableSizeBytes", origin);

  /* env */

  const rpc = bindings.ALCHEMY_BASE_URL;

  if (!rpc)
    return fail(503, "RPC not configured", origin);

  if (!bindings.VERIFIED_PAYMENTS)
    return fail(503, "KV missing", origin);

  if (!bindings.BUSINESS_QUOTES)
    return fail(503, "BUSINESS_QUOTES_MISSING", origin);

  try {

    /**
     * Load Business Quote.
     * Business Authority for this capsule was established at checkout
     * time — Web3 Verification consumes it, it never recomputes price
     * on its own. billableSizeBytes remains only a technical sanity
     * check.
     */

    const quote =
      await getBusinessQuote(
        bindings,
        capsuleId
      );

    if (!quote)
      return fail(402, "BUSINESS_QUOTE_NOT_FOUND", origin);

    /* chainId verification */

    const chainId = await rpcCall(rpc, "eth_chainId", []);

    if (chainId !== BASE_CHAIN_ID)
      return fail(503, "Wrong network", origin);

    /**
     * ISSUE 1 PARTIAL FIX: dual-key replay binding.
     *
     * KV is non-transactional, so a true TOCTOU race cannot be
     * eliminated here alone. However, writing two keys per
     * verification creates a second axis of defense:
     *
     *   txHash        → { capsuleId, ok, ... }   (primary)
     *   capsule:{id}  → txHash                   (secondary binding)
     *
     * This enables:
     *   1. Safe retry: same (txHash, capsuleId) pair → 200
     *   2. Cross-capsule reuse detection: txHash used for different
     *      capsuleId → 409
     *   3. Capsule-level replay: different txHash for same capsuleId
     *      → 409 (secondary key already set)
     *   4. Seal layer can independently verify the capsuleId → txHash
     *      binding before accepting payment authority.
     *
     * Note: concurrent requests that both pass the GET checks before
     * either PUT completes remain a theoretical race. Full elimination
     * requires a transactional store or a distributed lock — out of
     * scope for this layer. The seal layer MUST perform its own
     * binding verification as the final authority checkpoint.
     */

    // Primary replay check: has this txHash been used before?
    const existingByTx =
      await bindings.VERIFIED_PAYMENTS.get(txHash);

    if (existingByTx) {

      try {

        const parsed = JSON.parse(existingByTx);

        if (
          parsed?.capsuleId === capsuleId &&
          parsed?.ok === true
        ) {
          return new Response(
            JSON.stringify({ ok: true }),
            { status: 200, headers: baseHeaders(origin) }
          );
        }

      } catch {}

      return fail(409, "TX_ALREADY_USED", origin);

    }

    // Secondary replay check: has this capsuleId already been paid?
    const capsuleKey =
      CAPSULE_PAYMENT_KEY_PREFIX + capsuleId;

    const existingByCapsule =
      await bindings.VERIFIED_PAYMENTS.get(capsuleKey);

    if (existingByCapsule) {
      // capsuleId already bound to a different txHash — reject to
      // prevent the same capsule being funded twice.
      return fail(409, "CAPSULE_ALREADY_PAID", origin);
    }

    /* receipt */

    const receipt = await rpcCall(
      rpc,
      "eth_getTransactionReceipt",
      [txHash]
    ) as TxReceipt | null;

    /**
     * FIX: 202 instead of 404.
     *
     * null receipt means the transaction is not yet mined —
     * this is a transient state, not "not found". 404 caused the
     * frontend polling loop to treat it as a hard failure and abort.
     * 202 Accepted signals "try again later" and keeps the loop alive.
     */
    if (!receipt)
      return fail(202, "Pending", origin);

    if (receipt.status !== "0x1")
      return fail(402, "Reverted", origin);

    if (
      typeof receipt.blockNumber !== "string" ||
      !HEX_BLOCK_REGEX.test(receipt.blockNumber)
    ) {
      return fail(503, "INVALID_BLOCK_NUMBER", origin);
    }

    /**
     * Confirmation depth guard.
     */

    const latestBlock =
      await rpcCall(rpc, "eth_blockNumber", []) as string;

    if (
      typeof latestBlock !== "string" ||
      !HEX_BLOCK_REGEX.test(latestBlock)
    ) {
      return fail(503, "INVALID_CHAIN_HEAD", origin);
    }

    /**
     * FIX: 202 instead of 409.
     *
     * Transaction is mined but hasn't reached MIN_CONFIRMATIONS yet —
     * also a transient state. 409 Conflict caused the frontend to treat
     * this as a hard failure. 202 + "Pending" keeps the polling loop
     * alive until confirmations accumulate.
     */
    if (
      BigInt(latestBlock) - BigInt(receipt.blockNumber) <
      MIN_CONFIRMATIONS
    ) {
      return fail(202, "Pending", origin);
    }

    /* trusted time */

    const { nowUtc } = await getTrustedTime();

    if (!Number.isSafeInteger(nowUtc))
      return fail(503, "TIME_UNAVAILABLE", origin);

    /**
     * Business Quote expiry validation.
     */

    if (quote.expiresAt <= nowUtc)
      return fail(402, "BUSINESS_QUOTE_EXPIRED", origin);

    /**
     * verify transfer
     *
     * Business Quote is the sole price authority. Web3 Verification no
     * longer recomputes price from billableSizeBytes — it only checks
     * the on-chain transfer against the Quote already established at
     * checkout time.
     */

    const expected = usdToUsdcUnits(
      quote.expectedAmount
    );

    const { found } = findTransferLog(receipt, expected);

    if (!found)
      return fail(402, "Transfer missing", origin);

    /* store KV — write primary then secondary binding */

    const record = JSON.stringify({
      capsuleId,
      transactionId: txHash,
      ok:            true,
      method:        "web3",
      expectedAmount: quote.expectedAmount,
      currency:       quote.currency,
      expiresAt:     nowUtc + VERIFIED_TTL_MS,
      billableSizeBytes,
    });

    // Primary: txHash → full record

    // Payment Authority established.
    //
    // This Verified Payment becomes the canonical
    // payment authority for the capsule.
    //
    // Upload Token issuance and all subsequent
    // publication stages rely exclusively on this
    // record rather than re-verifying the payment.
    await bindings.VERIFIED_PAYMENTS.put(
      txHash,
      record,
      { expirationTtl: VERIFIED_TTL_SEC }
    );

    // Secondary: capsule:{capsuleId} → txHash binding
    // Allows seal layer and replay guard to verify capsuleId ownership.
    await bindings.VERIFIED_PAYMENTS.put(
      capsuleKey,
      txHash,
      { expirationTtl: VERIFIED_TTL_SEC }
    );

    /* success */

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: baseHeaders(origin) }
    );

  } catch (err) {

    // ISSUE 4 FIX: RpcTimeoutError surfaces as 504 — retriable and
    // distinguishable from hard failures (400/402/503).
    if (err instanceof RpcTimeoutError) {
      return fail(504, "RPC_TIMEOUT", origin);
    }

    return fail(503, "INTERNAL_ERROR", origin);

  }

};