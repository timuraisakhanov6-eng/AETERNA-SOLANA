/**
 * AETERNA — Service Payment Verification
 *
 * POST /api/service-payment/verify
 *
 * Canonical payment verification boundary.
 *
 * Security invariant:
 * - client-supplied evidence is NON-AUTHORITATIVE
 * - server must independently verify payment facts
 * - no verified payment -> no Creator Credit
 *
 * Provider is a trusted network data source only.
 * AETERNA server logic remains the verification authority.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  getBusinessQuote,
} from "../../lib/business/businessQuoteStore";

/* ================= ENV ================= */

export interface ServicePaymentVerifyEnv {
  BUSINESS_QUOTES: {
    get(key: string): Promise<string | null>;
  };
  CREATOR_IDENTITIES?: {
    get(key: string): Promise<string | null>;
  };
  VERIFIED_PAYMENTS: {
    get(key: string): Promise<string | null>;
    put(
      key: string,
      value: string,
      options?: { expirationTtl?: number }
    ): Promise<void>;
    delete(key: string): Promise<void>;
  };
  ALCHEMY_BASE_RPC_URL?: string;
  CHAINSTACK_BASE_RPC_URL?: string;
  CHAINSTACK_BASE_RPC_USERNAME?: string;
  CHAINSTACK_BASE_RPC_PASSWORD?: string;
}

/* ================= CONSTANTS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;
const NEW_PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-solana-btt\.pages\.dev$/;

const QUOTE_TTL_MS = 30 * 60 * 1000;

const VERIFIED_PAYMENT_TTL_MS = 60 * 60 * 1000;
const VERIFIED_PAYMENT_TTL_SEC = Math.max(60, Math.ceil(VERIFIED_PAYMENT_TTL_MS / 1000));

const VERIFIED_PAYMENT_PREFIX = "verified-payment:";
const QUOTE_PREFIX = "quote:";

const BASE_CHAIN_ID = "0x2105";
const BASE_CHAIN_ID_NUM = 8453;

const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const SETTLEMENT_WALLET = "0xb0d9e5d93c1fecfa78479f23d283eaa652ee3755";

const USDC_DECIMALS = 6;
const EXPECTED_ATOMIC_AMOUNT = 1_000_000n;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const MIN_CONFIRMATIONS = 1n;

const RPC_TIMEOUT_MS = 10_000;

/* ================= HELPERS ================= */

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && (PAGES_PREVIEW_REGEX.test(url.hostname) || NEW_PAGES_PREVIEW_REGEX.test(url.hostname)))
      return true;
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
    "X-Aeterna-Service-Payment-Verify-Version": "v1",
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

function quoteKey(paymentIntentId: string): string {
  return `${QUOTE_PREFIX}${paymentIntentId}`;
}

function verifiedPaymentKey(
  paymentIntentId: string,
  evidenceId: string
): string {
  return `${VERIFIED_PAYMENT_PREFIX}${paymentIntentId}:${evidenceId}`;
}

interface VerifiedPaymentRecord {
  ok: true;
  paymentIntentId: string;
  quoteId: string;
  creatorIdentityId: string;
  evidenceId: string;
  transactionId?: string;
  verifiedAt: number;
  expiresAt: number;
  consumed?: boolean;
}

/* ================= RPC ================= */

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
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`RPC HTTP error ${res.status}`);
    }

    const json = (await res.json()) as {
      result?: unknown;
      error?: { message: string };
    };

    if (json.error) {
      throw new Error(json.error.message);
    }

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

interface ProviderResult {
  provider: "primary" | "secondary";
  chainId?: string;
  receipt?: {
    status?: string;
    blockNumber?: string;
    logs?: Array<{
      address?: string;
      topics?: string[];
      data?: string;
    }>;
  };
  latestBlock?: string;
  disagreement?: boolean;
}

async function queryPrimary(env: ServicePaymentVerifyEnv, txHash: string): Promise<ProviderResult> {
  const url = env.ALCHEMY_BASE_RPC_URL;
  if (!url) {
    return { provider: "primary" };
  }

  const [chainId, receipt, latestBlock] = await Promise.all([
    rpcCall(url, "eth_chainId", []),
    rpcCall(url, "eth_getTransactionReceipt", [txHash]),
    rpcCall(url, "eth_blockNumber", []),
  ]) as [string, unknown, string];

  return {
    provider: "primary",
    chainId: typeof chainId === "string" ? chainId : undefined,
    receipt: receipt as ProviderResult["receipt"],
    latestBlock: typeof latestBlock === "string" ? latestBlock : undefined,
  };
}

async function querySecondary(env: ServicePaymentVerifyEnv, txHash: string): Promise<ProviderResult> {
  const baseUrl = env.CHAINSTACK_BASE_RPC_URL;
  if (!baseUrl) {
    return { provider: "secondary" };
  }

  const username = env.CHAINSTACK_BASE_RPC_USERNAME;
  const password = env.CHAINSTACK_BASE_RPC_PASSWORD;

  const authHeader =
    typeof username === "string" &&
    typeof password === "string" &&
    username.length > 0 &&
    password.length > 0
      ? `Basic ${btoa(`${username}:${password}`)}`
      : undefined;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  let chainId: unknown;
  let receipt: unknown;
  let latestBlock: unknown;

  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    const res = await fetch(baseUrl, { method: "POST", headers, body, signal: controller.signal });
    const json = (await res.json()) as { result?: unknown };
    chainId = json.result;
  } catch {
    chainId = undefined;
  }

  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [txHash] });
    const res = await fetch(baseUrl, { method: "POST", headers, body, signal: controller.signal });
    const json = (await res.json()) as { result?: unknown };
    receipt = json.result;
  } catch {
    receipt = undefined;
  }

  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] });
    const res = await fetch(baseUrl, { method: "POST", headers, body, signal: controller.signal });
    const json = (await res.json()) as { result?: unknown };
    latestBlock = json.result;
  } catch {
    latestBlock = undefined;
  }

  clearTimeout(timeout);

  return {
    provider: "secondary",
    chainId: typeof chainId === "string" ? chainId : undefined,
    receipt: receipt as ProviderResult["receipt"],
    latestBlock: typeof latestBlock === "string" ? latestBlock : undefined,
  };
}

/* ================= VERIFICATION LOGIC ================= */

function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
}

function findTransferLog(receipt: ProviderResult["receipt"]) {
  if (!receipt?.logs?.length) {
    return { found: false as const, reason: "No logs in receipt" };
  }

  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== USDC_CONTRACT) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;

    const toTopic = log.topics?.[2]?.toLowerCase() ?? "";
    if (!toTopic.endsWith(SETTLEMENT_WALLET.slice(2))) continue;

    const dataHex = log.data;
    if (!dataHex) {
      return { found: false as const, reason: "Empty data" };
    }

    let transferred: bigint;
    try {
      transferred = BigInt(dataHex);
    } catch {
      return { found: false as const, reason: "Parse failed" };
    }

    if (transferred !== EXPECTED_ATOMIC_AMOUNT) {
      return { found: false as const, reason: "Amount mismatch" };
    }

    return { found: true as const };
  }

  return { found: false as const, reason: "Transfer not found" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/* ================= ENDPOINT ================= */

export async function onRequestOptions(
  context: EventContext<Record<string, unknown>, string, ServicePaymentVerifyEnv>
): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, ServicePaymentVerifyEnv>
): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";

  if (!isAllowedOrigin(origin)) {
    return fail(origin, 403, "INVALID_ORIGIN");
  }

  const ip = getClientIp(request);
  if (!ip || !rateLimit(ip)) {
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
  const evidenceId =
    typeof body.evidenceId === "string" ? body.evidenceId.trim() : "";
  const transactionId =
    typeof body.transactionId === "string" ? body.transactionId.trim() : "";

  if (
    typeof paymentIntentId !== "string" ||
    typeof creatorIdentityId !== "string" ||
    !paymentIntentId ||
    !creatorIdentityId ||
    !evidenceId
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now =
    typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  /* ================= QUOTE ================= */

  const quoteRaw = await env.BUSINESS_QUOTES.get(quoteKey(paymentIntentId));
  if (!quoteRaw) {
    return fail(origin, 402, "BUSINESS_QUOTE_NOT_FOUND");
  }

  let quote: {
    paymentIntentId: string;
    expectedAmount: number;
    currency: string;
    expiresAt: number;
  };
  try {
    quote = JSON.parse(quoteRaw) as {
      paymentIntentId: string;
      expectedAmount: number;
      currency: string;
      expiresAt: number;
    };
  } catch {
    return fail(origin, 500, "QUOTE_CORRUPT");
  }

  if (quote.paymentIntentId !== paymentIntentId) {
    return fail(origin, 400, "QUOTE_MISMATCH");
  }

  if (now > quote.expiresAt) {
    return fail(origin, 402, "QUOTE_EXPIRED");
  }

  /* ================= CREATOR IDENTITY ================= */

  let identityOk = true;
  if (env?.CREATOR_IDENTITIES) {
    const identityRaw = await env.CREATOR_IDENTITIES.get(
      `creator:identity:${creatorIdentityId}`
    );
    if (!identityRaw) {
      identityOk = false;
    } else {
      try {
        const identity = JSON.parse(identityRaw) as Record<string, unknown>;
        if (
          typeof identity.id !== "string" ||
          identity.id !== creatorIdentityId
        ) {
          identityOk = false;
        }
      } catch {
        identityOk = false;
      }
    }
  }

  if (!identityOk) {
    return fail(origin, 403, "CREATOR_IDENTITY_NOT_FOUND");
  }

  /* ================= IDEMPOTENCY / REPLAY ================= */

  const evidenceKey = verifiedPaymentKey(paymentIntentId, evidenceId);
  const existingRaw = await env.VERIFIED_PAYMENTS.get(evidenceKey);
  if (existingRaw) {
    let existing: VerifiedPaymentRecord;
    try {
      existing = JSON.parse(existingRaw) as VerifiedPaymentRecord;
    } catch {
      return fail(origin, 500, "VERIFIED_PAYMENT_CORRUPT");
    }

    if (existing.consumed) {
      return fail(origin, 409, "VERIFIED_PAYMENT_ALREADY_CONSUMED");
    }

    if (existing.creatorIdentityId !== creatorIdentityId) {
      return fail(origin, 409, "VERIFIED_PAYMENT_IDENTITY_MISMATCH");
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: "VERIFIED",
        verifiedAt: existing.verifiedAt,
        creatorIdentityId: existing.creatorIdentityId,
        paymentIntentId: existing.paymentIntentId,
      }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  /* ================= PAYMENT EVIDENCE ================= */

  const txHash =
    typeof transactionId === "string" && transactionId.length === 66 && transactionId.startsWith("0x")
      ? transactionId
      : typeof body.txHash === "string" && body.txHash.length === 66 && body.txHash.startsWith("0x")
        ? body.txHash
        : "";

  if (!txHash) {
    return fail(origin, 400, "INVALID_TX_HASH");
  }

  if (quote.expectedAmount !== 1 || quote.currency !== "USD") {
    return fail(origin, 402, "QUOTE_NOT_1_USD");
  }

  /* ================= PROVIDER QUERY ================= */

  const primary = await queryPrimary(env, txHash);
  const secondary = await querySecondary(env, txHash);

  const providers = [primary, secondary].filter((p) => !!p.chainId || !!p.receipt);

  if (providers.length === 0) {
    return fail(origin, 503, "PROVIDERS_UNAVAILABLE");
  }

  const uniqueChainIds = new Set(
    providers
      .map((p) => typeof p.chainId === "string" ? p.chainId.toLowerCase() : "")
      .filter(Boolean)
  );

  if (uniqueChainIds.size > 1) {
    return fail(origin, 503, "PROVIDER_DISAGREEMENT");
  }

  const agreedChainId = providers[0]?.chainId?.toLowerCase();
  if (agreedChainId !== BASE_CHAIN_ID.toLowerCase()) {
    return fail(origin, 503, "WRONG_CHAIN");
  }

  const receiptResults = providers
    .map((p) => findTransferLog(p.receipt))
    .filter((r) => r.found);

  if (receiptResults.length === 0) {
    const reasons = providers
      .map((p) => findTransferLog(p.receipt).reason)
      .filter(Boolean);
    return fail(origin, 402, `TRANSFER_NOT_FOUND: ${reasons[0] ?? "unknown"}`);
  }

  const receipt = providers.find((p) => findTransferLog(p.receipt).found)?.receipt;

  if (!receipt || receipt.status !== "0x1") {
    return fail(origin, 402, "TX_NOT_SUCCESSFUL");
  }

  if (!receipt.blockNumber || typeof receipt.blockNumber !== "string") {
    return fail(origin, 503, "INVALID_BLOCK_NUMBER");
  }

  const latestBlocks = providers
    .map((p) => p.latestBlock)
    .filter((b): b is string => typeof b === "string");

  if (latestBlocks.length === 0) {
    return fail(origin, 503, "CHAIN_HEAD_UNAVAILABLE");
  }

  const latestBlock = latestBlocks[0];
  if (!/^0x[0-9a-f]+$/i.test(latestBlock) || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber)) {
    return fail(origin, 503, "INVALID_BLOCK_HEX");
  }

  const confirmationCount =
    hexToBigInt(latestBlock) - hexToBigInt(receipt.blockNumber);

  if (confirmationCount < MIN_CONFIRMATIONS) {
    return fail(origin, 202, "PENDING");
  }

  /* ================= PERSIST VERIFIED PAYMENT ================= */

  const verifiedAt = now;
  const expiresAt = now + VERIFIED_PAYMENT_TTL_MS;

  const record: VerifiedPaymentRecord = {
    ok: true,
    paymentIntentId,
    quoteId: quote.paymentIntentId,
    creatorIdentityId,
    evidenceId,
    transactionId: txHash,
    verifiedAt,
    expiresAt,
  };

  try {
    await env.VERIFIED_PAYMENTS.put(
      evidenceKey,
      JSON.stringify(record),
      { expirationTtl: VERIFIED_PAYMENT_TTL_SEC }
    );

    await env.VERIFIED_PAYMENTS.put(
      `payment-intent:${paymentIntentId}`,
      JSON.stringify({
        paymentIntentId,
        transactionId: txHash,
        ok: true,
        creatorIdentityId,
        expiresAt,
      }),
      { expirationTtl: VERIFIED_PAYMENT_TTL_SEC }
    );
  } catch {
    return fail(origin, 503, "VERIFIED_PAYMENT_WRITE_FAILED");
  }

  return new Response(
    JSON.stringify({
      ok: true,
      status: "VERIFIED",
      verifiedAt,
      creatorIdentityId,
      paymentIntentId,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
