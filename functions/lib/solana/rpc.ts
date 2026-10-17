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
 * Classifies a Solana RPC failure as TEMPORARY (worth one bounded retry
 * inside the existing lookup window) or definitive.
 *
 * Transient means the request either never produced a response (timeout /
 * network) or the edge/provider answered with a "try again later" signal
 * (HTTP 429, HTTP 5xx, rate-limit / overload / maintenance JSON-RPC error).
 *
 * Everything else — a malformed request, a refused method, a bad
 * parameter, a genuine provider error — is NOT transient: retrying it
 * would only repeat the same refusal, so it must propagate at once.
 *
 * This classifier NEVER decides anything about a payment; it only decides
 * whether a READ is repeated. An error is never converted into a
 * successful result.
 */
export function isTransientSolanaRpcError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return false;

  // HTTP status surfaced by solanaJsonRpc (`RPC_HTTP_ERROR_<status>`).
  if (/\bRPC_HTTP_ERROR_(429|5\d\d)\b/.test(message)) return true;

  // The adapter's own timeout signal.
  if (message === "RPC_TIMEOUT") return true;

  // Transport-level failure (no HTTP response at all).
  if (
    /timeout|timed out|aborted|AbortError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|Failed to fetch|connection lost/i.test(
      message
    )
  ) {
    return true;
  }

  // Provider JSON-RPC "try again" signals only.
  if (
    /too many requests|rate.?limit|overload|temporarily unavailable|try again|service unavailable|-32005|-32429/i.test(
      message
    )
  ) {
    return true;
  }

  return false;
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
 *
 * BOUNDED TRANSIENT RETRY: a failure classified as TRANSIENT (timeout /
 * network / HTTP 429 / HTTP 5xx) consumes another attempt from the SAME
 * bounded budget instead of aborting on the first blip — the deadline and
 * the attempt cap are unchanged, so the worst case is still ~20s. A
 * definitive failure still propagates immediately, and a window that ends
 * while the last observation was an error THROWS that error: an error is
 * never downgraded to `null` (which the verifier reads as "not found").
 */
export async function getSolanaTransaction(
  url: string,
  signature: string
): Promise<unknown> {
  const deadline = Date.now() + SOLANA_LOOKUP_GLOBAL_DEADLINE_MS;
  let lastTransientError: unknown = null;

  for (let attempt = 0; attempt < SOLANA_LOOKUP_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(SOLANA_LOOKUP_RETRY_DELAY_MS, remaining));
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const perRequestTimeout = Math.max(0, Math.min(RPC_TIMEOUT_MS, remaining));

    let result: unknown;
    try {
      result = await solanaJsonRpc(url, "getTransaction", [
        signature,
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ], perRequestTimeout);
    } catch (err) {
      // A definitive failure propagates at once; only a TEMPORARY one may
      // consume another bounded attempt.
      if (!isTransientSolanaRpcError(err)) throw err;
      lastTransientError = err;
      continue;
    }

    // A successful observation SUPERSEDES any earlier transient failure.
    lastTransientError = null;

    if (result !== null && result !== undefined) {
      return result;
    }
  }

  // The window ended while the last observation was an ERROR: report the
  // error, never a fabricated `null` absence.
  if (lastTransientError) throw lastTransientError;
  return null;
}
