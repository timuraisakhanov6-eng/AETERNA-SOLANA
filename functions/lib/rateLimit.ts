/**
 * AETERNA — Edge Rate Limiter for Cloudflare Pages Functions
 *
 * Abuse-mitigation layer only.
 * Not protocol-authoritative.
 *
 * Guarantees:
 * - isolate-local limiter
 * - fail-open safety
 * - CF-Connecting-IP canonical usage
 * - opportunistic cleanup
 * - safe timestamp validation
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

type Entry = {
  count: number;
  expires: number;
};

const store = new Map<string, Entry>();

/**
 * IMPORTANT:
 * We type STRUCTURALLY rather than as `Request`: this keeps support for
 * Cloudflare IncomingRequestCfProperties typing (any object with `.headers.get`),
 * while property access stays type-checked — typing it as `unknown` made it
 * unusable under strict mode.
 */

export function getClientIp(request: {
  headers?: { get(name: string): string | null } | null;
}): string {

  const ip =
    request.headers?.get("CF-Connecting-IP");

  if (!ip) {

    return "unknown";

  }

  /**
   * whitespace normalization guard
   */

  return ip.trim();

}

/**
 * Opportunistic cleanup
 */

function cleanup(now: number) {

  for (const [key, entry] of store.entries()) {

    if (now > entry.expires) {

      store.delete(key);

    }

  }

}

/**
 * Fixed-window limiter
 *
 * Guarantees:
 * - fail-open behaviour
 * - safe timestamp usage
 * - isolate-safe storage
 */

export function rateLimit(ip: string): boolean {

  if (ip === "unknown") {

    return true;

  }

  /**
   * normalization guard
   */

  ip = ip.trim();

  const now = Date.now();

  /**
   * runtime timestamp integrity guard
   */

  if (!Number.isSafeInteger(now)) {

    return true;

  }

  /**
   * opportunistic cleanup trigger (~1/256 calls)
   */

  if ((now & 0xff) === 0) {

    cleanup(now);

  }

  const entry = store.get(ip);

  if (!entry || now > entry.expires) {

    store.set(ip, {

      count: 1,

      expires: now + WINDOW_MS

    });

    return true;

  }

  if (entry.count >= MAX_REQUESTS) {

    return false;

  }

  entry.count++;

  return true;

}