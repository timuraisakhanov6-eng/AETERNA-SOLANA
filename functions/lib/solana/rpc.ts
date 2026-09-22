/**
 * AETERNA — Solana JSON-RPC wrapper
 *
 * Server-only helper for storage-payment verification.
 *
 * Uses the configured Solana mainnet RPC URL.
 * getTransaction uses confirmed commitment with maxSupportedTransactionVersion = 0.
 *
 * COMMITMENT POLICY (payment reliability):
 * A freshly submitted payment is observable at `confirmed` within a slot or two,
 * but is not `finalized` for a further ~6-15s. Verification runs immediately
 * after the wallet returns a signature, so a `finalized`-only lookup reports a
 * legitimate, landed payment as missing. Lookups therefore use `confirmed`
 * (which also returns transactions that have since finalized, since finalized
 * is a subset of confirmed) and poll for a bounded window rather than ~3s.
 */

const RPC_TIMEOUT_MS = 10_000;
const SOLANA_LOOKUP_RETRY_DELAY_MS = 1_000;
const SOLANA_LOOKUP_MAX_ATTEMPTS = 20;
const SOLANA_LOOKUP_GLOBAL_DEADLINE_MS = 20_000;

let requestId = 1;

export async function solanaJsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = RPC_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded polling lookup for a submitted transaction signature.
 *
 * Returns the transaction once it is observable at `confirmed` (which includes
 * already-finalized transactions), or null if it never becomes observable
 * within the bounded window.
 *
 * FAIL-CLOSED: RPC errors are never converted into success. `solanaJsonRpc`
 * throws on transport/RPC failure and that error propagates to the caller, so
 * an unverifiable transaction is reported as an error, never as a payment.
 * A null result is retried; it is never treated as a successful lookup.
 */
export async function getSolanaTransaction(
  url: string,
  signature: string
): Promise<unknown> {
  const deadline = Date.now() + SOLANA_LOOKUP_GLOBAL_DEADLINE_MS;

  for (let attempt = 0; attempt < SOLANA_LOOKUP_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(SOLANA_LOOKUP_RETRY_DELAY_MS, remaining));
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const perRequestTimeout = Math.max(0, Math.min(RPC_TIMEOUT_MS, remaining));
    const result = await solanaJsonRpc(url, "getTransaction", [
      signature,
      {
        commitment: "confirmed",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      },
    ], perRequestTimeout);

    if (result !== null && result !== undefined) {
      return result;
    }
  }

  return null;
}
