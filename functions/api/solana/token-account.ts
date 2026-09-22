/**
 * AETERNA — Server-side Solana account-existence proxy
 *
 * GET /api/solana/token-account?address=<base58>
 *
 * Reports whether a Solana account currently exists (and, when it does, the
 * program that owns it). The browser uses this to decide whether the $1 USDC
 * settlement transaction must first create the destination associated token
 * account.
 *
 * This endpoint exists for the same reason as /api/solana/blockhash: the
 * browser must not call public Solana RPC directly (CORS / browser fetch
 * restrictions). It is strictly READ-ONLY — no state is changed.
 *
 * Payment authority remains /api/service-payment/verify.
 */

import { solanaJsonRpc } from "../../lib/solana/rpc";

export interface SolanaTokenAccountEnv {
  SOLANA_MAINNET_RPC_URL?: string;
}

/** Base58-encoded Solana public key shape. */
const BASE58_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestGet(context: unknown): Promise<Response> {
  try {
    const ctx = context as {
      request: Request;
      env: SolanaTokenAccountEnv;
    };

    const url =
      typeof ctx.env?.SOLANA_MAINNET_RPC_URL === "string"
        ? ctx.env.SOLANA_MAINNET_RPC_URL
        : "";

    if (!url) {
      return jsonResponse({ ok: false as const, error: "RPC_UNAVAILABLE" }, 502);
    }

    const address = new URL(ctx.request.url).searchParams.get("address") ?? "";

    if (!BASE58_ADDRESS_REGEX.test(address)) {
      return jsonResponse(
        { ok: false as const, error: "INVALID_ADDRESS" },
        400
      );
    }

    const result = await solanaJsonRpc<{ value: { owner?: string } | null }>(
      url,
      "getAccountInfo",
      [address, { encoding: "base64", commitment: "confirmed" }]
    );

    const value = result?.value ?? null;

    return jsonResponse(
      {
        ok: true as const,
        exists: value !== null,
        owner: typeof value?.owner === "string" ? value.owner : null,
      },
      200
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "TOKEN_ACCOUNT_FETCH_FAILED";

    return jsonResponse({ ok: false as const, error: message }, 502);
  }
}
