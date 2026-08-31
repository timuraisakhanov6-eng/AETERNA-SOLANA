/**
 * AETERNA — Server-side Solana blockhash proxy
 *
 * GET /api/solana/blockhash
 *
 * Returns a fresh recent blockhash from the authoritative
 * server-side Solana RPC provider.
 *
 * This endpoint exists so the browser does not need to call
 * public Solana RPC directly, which can fail due to CORS or
 * browser fetch restrictions.
 *
 * Payment authority remains /api/service-payment/verify.
 */

import { solanaJsonRpc } from "../../lib/solana/rpc";

export interface SolanaBlockhashEnv {
  SOLANA_MAINNET_RPC_URL?: string;
}

export async function onRequestGet(
  _context: {
    env: SolanaBlockhashEnv;
  }
): Promise<Response> {
  try {
    const url =
      typeof _context.env.SOLANA_MAINNET_RPC_URL === "string"
        ? _context.env.SOLANA_MAINNET_RPC_URL
        : "";

    if (!url) {
      return new Response(
        JSON.stringify({ ok: false as const, error: "RPC_UNAVAILABLE" }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const result = (await solanaJsonRpc<
      {
        value: {
          blockhash: string;
          lastValidBlockHeight: number;
        };
      }
    >(url, "getLatestBlockhash", [{ commitment: "confirmed" }]));

    const blockhash = result?.value?.blockhash;
    const lastValidBlockHeight = result?.value?.lastValidBlockHeight;

    if (typeof blockhash !== "string" || blockhash.length === 0) {
      return new Response(
        JSON.stringify({ ok: false as const, error: "RPC_MISSING_BLOCKHASH" }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true as const,
        blockhash,
        lastValidBlockHeight:
          typeof lastValidBlockHeight === "number"
            ? lastValidBlockHeight
            : null,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "BLOCKHASH_FETCH_FAILED";

    return new Response(
      JSON.stringify({ ok: false as const, error: message }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
