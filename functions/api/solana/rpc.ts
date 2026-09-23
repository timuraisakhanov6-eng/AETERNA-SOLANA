/**
 * AETERNA — Server-side Solana JSON-RPC transport (READ-ONLY)
 *
 * POST /api/solana/rpc
 *
 * Irys's `@solana/web3.js` Connection performs its Solana READS through a
 * JSON-RPC endpoint. The browser must not call a public Solana RPC directly:
 * `api.mainnet-beta.solana.com` answers any request carrying a browser Origin
 * with `403 {"code":403,"message":"Access forbidden"}`. This endpoint supplies
 * the same JSON-RPC transport server-side, using the configured provider.
 *
 * READ-ONLY BY CONSTRUCTION. Only the allow-listed read methods below are
 * forwarded; every state-changing method is rejected BEFORE any RPC call.
 * Irys sends its funding transaction through the connected wallet
 * (`token.js: sendTx(data) { return this.wallet.sendTransaction(...) }`),
 * never through this transport — so no write method is needed, and none is
 * exposed.
 *
 * The upstream RPC URL is never echoed to the caller.
 *
 * Payment authority remains /api/service-payment/verify.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { solanaJsonRpc } from "../../lib/solana/rpc";

export interface SolanaRpcEnv {
  SOLANA_MAINNET_RPC_URL?: string;
}

/**
 * The complete set of Solana methods the installed Irys Solana token
 * (`@irys/web-upload-solana`) reaches through its Connection:
 *   getParsedAccountInfo  -> getAccountInfo
 *   getParsedTransaction  -> getTransaction
 *   getEstimatedFee       -> getFeeForMessage
 * plus the blockhash/slot/epoch/rent reads below.
 *
 * Anything absent from this set — in particular every write method
 * (sendTransaction, sendRawTransaction, simulateTransaction, requestAirdrop)
 * — is rejected.
 */
const ALLOWED_READ_METHODS = new Set<string>([
  "getAccountInfo",
  "getLatestBlockhash",
  "getTransaction",
  "getSlot",
  "getEpochInfo",
  "getTokenAccountBalance",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees",
]);

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
    if (url.protocol === "https:" && PAGES_PREVIEW_REGEX.test(url.hostname))
      return true;
  } catch {
    // ignore
  }
  return false;
}

/**
 * Access-Control-Allow-Origin is only echoed for an ALLOWED origin. Echoing an
 * arbitrary value (including the literal "null" sent by sandboxed frames and
 * file:// contexts) would grant untrusted cross-origin read access — this
 * mirrors the canonical pattern in time.ts / manifest.ts.
 */
function baseHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

/**
 * JSON-RPC-shaped failure. `new Connection()` expects JSON-RPC semantics, so
 * errors are returned in-band as `{jsonrpc, id, error}` rather than as a bare
 * application object.
 */
function jsonRpcError(
  origin: string,
  id: unknown,
  code: number,
  message: string,
  status: number
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    }),
    { status, headers: baseHeaders(origin) }
  );
}

export async function onRequestOptions(
  context: EventContext<Record<string, unknown>, string, SolanaRpcEnv>
): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, SolanaRpcEnv>
): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return jsonRpcError(origin, null, -32600, "INVALID_ORIGIN", 403);
  }

  // Abuse mitigation (edge limiter, isolate-local, fail-open for an unknown
  // IP). Placed after the origin check and BEFORE any upstream forwarding, so
  // a throttled caller never reaches the RPC provider.
  const ip = getClientIp(context.request);
  if (!ip || !rateLimit(ip)) {
    return jsonRpcError(origin, null, -32603, "TOO_MANY_REQUESTS", 429);
  }

  const rpcUrl =
    typeof context.env?.SOLANA_MAINNET_RPC_URL === "string"
      ? context.env.SOLANA_MAINNET_RPC_URL
      : "";

  if (!rpcUrl) {
    return jsonRpcError(origin, null, -32603, "RPC_UNAVAILABLE", 502);
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return jsonRpcError(origin, null, -32700, "PARSE_ERROR", 400);
  }

  const record = (body ?? {}) as {
    method?: unknown;
    params?: unknown;
    id?: unknown;
  };

  const id = record.id ?? null;
  const method = typeof record.method === "string" ? record.method : "";

  if (!method) {
    return jsonRpcError(origin, id, -32600, "INVALID_REQUEST", 400);
  }

  if (!ALLOWED_READ_METHODS.has(method)) {
    return jsonRpcError(origin, id, -32601, "METHOD_NOT_ALLOWED", 400);
  }

  const params = Array.isArray(record.params) ? record.params : [];

  try {
    const result = await solanaJsonRpc<unknown>(rpcUrl, method, params);

    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: baseHeaders(origin),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "RPC_ERROR";
    // Fail closed, and never surface the upstream endpoint itself.
    const message = raw.includes(rpcUrl) ? "RPC_ERROR" : raw;

    return jsonRpcError(origin, id, -32603, message, 502);
  }
}
