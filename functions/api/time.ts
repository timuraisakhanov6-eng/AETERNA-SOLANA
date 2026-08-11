/**
 * Internal trusted-time helper
 *
 * Used by:
 * - heartbeat.ts
 * - seal.ts
 * - future protocol modules
 *
 * Trusted Time Authority (Temporal Authority Layer v1.3)
 */

import type {
  EventContext
} from "@cloudflare/workers-types";


/**
 * Allowed epoch window
 * Protects against rollback and forward drift attacks
 */

const MIN_TIME =
  1577836800000; // 2020-01-01

const MAX_TIME =
  4102444800000; // 2100-01-01


/**
 * Canonical origin allowlist
 * Mirrors all other AETERNA API layers.
 *
 * Single-origin restriction removed: time authority must be
 * reachable from www, pages.dev, and preview runtimes —
 * otherwise heartbeat, seal, and emergency runtimes break.
 */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];


export async function getTrustedTime(): Promise<{
  nowUtc: number;
}> {

  /**
   * FIX #2 — Date.now integrity guard
   * Detects hostile runtime global corruption
   * before any call is made
   */

  if (typeof Date.now !== "function") {

    throw new Error(
      "[AETERNA] Trusted time violation"
    );

  }
  
  // Trusted Time Authority establishes the canonical
  // protocol time for this request.
  //
  // All downstream protocol modules must derive
  // temporal decisions exclusively from this value.
  const now = Date.now();

  /**
   * runtime integrity guard
   */

  if (typeof now !== "number") {

    throw new Error(
      "[AETERNA] Trusted time violation"
    );

  }

  /**
   * sanity bounds enforcement
   */

  if (

    !Number.isFinite(now) ||

    !Number.isSafeInteger(now) ||

    now < MIN_TIME ||

    now > MAX_TIME

  ) {

    throw new Error(
      "[AETERNA] Trusted time violation"
    );

  }

  return {
    nowUtc: now
  };

}


/**
 * Trusted time headers
 *
 * NOTE: when the request Origin is absent or not in ALLOWED_ORIGINS,
 * Access-Control-Allow-Origin / Timing-Allow-Origin are omitted
 * entirely rather than set to the literal string "null". The literal
 * "null" is itself a valid Origin value — sent by sandboxed iframes,
 * `file://`/`data:` contexts, and some WebViews — so echoing it back
 * would grant those untrusted contexts cross-origin read access.
 * Omitting the headers is the canonical pattern already adopted in
 * manifest.ts; this mirrors it so CORS behavior is consistent across
 * every AETERNA API layer.
 */

function baseHeaders(
  origin?: string
): Record<string, string> {

  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : undefined;

  const headers: Record<string, string> = {

    "Content-Type":
      "application/json",

    "X-Content-Type-Options":
      "nosniff",

    "X-Frame-Options":
      "DENY",

    "Referrer-Policy":
      "no-referrer",

    "Cache-Control":
      "no-store",

    "CDN-Cache-Control":
      "no-store",

    "Surrogate-Control":
      "no-store",

    "Pragma":
      "no-cache",

    "Expires":
      "0",

    "Access-Control-Allow-Methods":
      "GET, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    /**
     * resource isolation
     */

    "Cross-Origin-Resource-Policy":
      "same-origin",

    /**
     * authority metadata
     */

    "X-Aeterna-Time-Trusted":
      "true",

    "X-Aeterna-Time-Authority":
      "primary",

    "X-Aeterna-Time-Version":
      "v1",

  };

  /**
   * timing exposure allowed only to the requesting origin.
   *
   * Timing-Allow-Origin does not support CSV lists — only a
   * single origin or "*" is valid per spec. Reflecting the
   * already-validated allowed origin mirrors the same pattern
   * used for Access-Control-Allow-Origin above. Both are only
   * set when the origin actually matched the allowlist.
   */

  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
    headers["Timing-Allow-Origin"] = allowed;
  }

  return headers;

}


/**
 * OPTIONS handler
 */

export const onRequestOptions =
async (
  context: EventContext<
    unknown,
    string,
    unknown
  >
): Promise<Response> => {

  const origin =
    context.request.headers.get("origin") ?? "";

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {

    return new Response(
      null,
      { status: 403 }
    );

  }

  return new Response(
    null,
    {
      status: 204,
      headers: baseHeaders(origin),
    }
  );

};


/**
 * GET handler
 *
 * Trusted Time Authority endpoint
 */

export const onRequestGet =
async (
  context: EventContext<
    unknown,
    string,
    unknown
  >
): Promise<Response> => {

  try {

    /**
     * origin binding enforcement
     */

    const origin =
      context.request.headers.get("origin") ?? "";

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {

      return new Response(
        JSON.stringify({ ok: false }),
        { status: 403 }
      );

    }


    /**
     * obtain trusted time
     */

    const {
      nowUtc: now
    } = await getTrustedTime();


    return new Response(

      JSON.stringify({
        nowUtc: now
      }),

      {

        status: 200,

        headers: {

          ...baseHeaders(origin),

          /**
           * RFC-compliant Date header
           */

          Date:
            new Date(now)
              .toUTCString(),

        },

      }

    );

  }

  catch {

    return new Response(

      JSON.stringify({
        ok: false
      }),

      {

        status: 500,

        headers:
          baseHeaders(),

      }

    );

  }

};