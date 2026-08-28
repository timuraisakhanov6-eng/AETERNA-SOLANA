/**
 * AETERNA — Solana JSON-RPC wrapper
 *
 * Server-only helper for Phase 2B storage-payment verification.
 *
 * Uses Alchemy Solana Mainnet as the primary RPC provider.
 */

const RPC_TIMEOUT_MS = 10_000;
let requestId = 1;

export async function solanaJsonRpc<T>(
  url: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId++,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`RPC_HTTP_ERROR_${res.status}`);
    }

    const data = (await res.json()) as {
      result?: T;
      error?: { message?: string };
    };

    if (data.error) {
      throw new Error(data.error.message ?? "RPC_ERROR");
    }

    if (!("result" in data)) {
      throw new Error("RPC_MISSING_RESULT");
    }

    return data.result as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("RPC_TIMEOUT");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getSolanaTransaction(
  url: string,
  signature: string
): Promise<unknown> {
  return solanaJsonRpc(url, "getTransaction", [
    signature,
    {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    },
  ]);
}
