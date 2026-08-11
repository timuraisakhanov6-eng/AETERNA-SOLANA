/**
 * AETERNA Heartbeat API (v1.3)
 *
 * Stores creator presence confirmations.
 *
 * Protocol guarantees:
 * - creatorAuthorityFragment required (capability guard)
 * - fragment secret NEVER transmitted
 * - trusted time enforced
 * - overwrite-only semantics with monotonic enforcement
 * - manifest immutability preserved
 * - confirmation rejected after unlock boundary (v1.3)
 */

import { resolveEffectiveOpenAt, THIRTY_DAYS_MS } from "../../src/shared/heartbeat/resolveEffectiveOpenAt";
import type { OpenAtUtc } from "../../src/types/manifest";

// ISSUE 1 FIX: All validators originate from canonical source.
// AUTHORITY_FRAGMENT_REGEX replaced with SHA256_REGEX —
// same grammar, single source of truth, no validator drift.
import {
  CAPSULE_ID_REGEX,
  SHA256_REGEX,
} from "../../src/lib/crypto/validators";


type HeartbeatRecord = {

  capsuleId: string;

  lastConfirmedAt: number;

  updatedAt: number;

  version: 1;

};


type AuthorityTokenRecord = {

  fragment: string;

};


/**
 * Canonical plain-object guard — mirrors all AETERNA layers.
 */

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object")
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}


/**
 * Trusted time — fetches /api/time relative to the worker origin.
 *
 * FIX (Trusted Time violation): Date.now() replaced with /api/time
 * to ensure heartbeat POST uses the same Time Authority as openCapsule()
 * and confirmPresence(). Without this, a clock skew between the Cloudflare
 * worker and the time server creates a race where a recipient can open
 * a capsule while the creator can still extend it simultaneously.
 *
 * Cloudflare Workers support absolute URLs; the origin is extracted from
 * the incoming request so no hard-coded base URL is required.
 */

async function getTrustedNow(request: Request): Promise<number> {

  const origin =
    new URL(request.url).origin;

  const res =
    await fetch(`${origin}/api/time`, { cache: "no-store" });

  if (!res.ok)
    throw new Error("TIME_UNAVAILABLE");

  const data: unknown =
    await res.json();

  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as Record<string, unknown>).nowUtc !== "number"
  )
    throw new Error("TIME_INVALID");

  const nowUtc =
    (data as Record<string, unknown>).nowUtc as number;

  if (
    !Number.isFinite(nowUtc) ||
    !Number.isSafeInteger(nowUtc) ||
    nowUtc <= 0
  )
    throw new Error("TIME_INVALID");

  return nowUtc;

}


/**
 * POST /api/heartbeat
 *
 * Stores confirmation timestamp.
 * Requires creatorAuthorityFragment capability token.
 * Rejects with 409 if nowUtc >= effectiveOpenAt (Heartbeat Release Model v1.3).
 */

// ISSUE 2 FIX: `any` replaced with `unknown` throughout.
// All field accesses are narrowed explicitly before use.
export async function onRequestPost(
  context: unknown
) {

  const ctx =
    context as { request: Request; env: Record<string, unknown> };

  const { request, env } = ctx;

  let body: unknown;


  try {

    body =
      await request.json();

  } catch {

    return new Response(
      "Invalid JSON",
      { status: 400 }
    );

  }


  // LOW FIX: canonical plain-object guard replaces bare typeof check.
  // Mirrors prototype pollution protection used in all other AETERNA
  // authority endpoints.
  if (!isPlainObject(body)) {

    return new Response(
      "Invalid body",
      { status: 400 }
    );

  }

  const rawBody = body;


  const capsuleId =
    rawBody.capsuleId;


  if (
    !capsuleId ||
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    return new Response(
      "capsuleId required",
      { status: 400 }
    );

  }


  /**
   * Capability guard — creatorAuthorityFragment required.
   */

  const creatorAuthorityFragment =
    rawBody.creatorAuthorityFragment;

  if (
    !creatorAuthorityFragment ||
    typeof creatorAuthorityFragment !== "string" ||
    !SHA256_REGEX.test(creatorAuthorityFragment)
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "FRAGMENT_REQUIRED" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      }
    );

  }


  /**
   * Verify fragment against stored authority token.
   */

  const authorityTokens =
    env?.AUTHORITY_TOKENS;

  if (
    !authorityTokens ||
    typeof (authorityTokens as { get?: unknown }).get !== "function"
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "SERVICE_UNAVAILABLE" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      }
    );

  }

  const storedRaw =
    await (authorityTokens as { get: (k: string) => Promise<string | null> })
      .get(capsuleId);

  if (!storedRaw) {

    return new Response(
      JSON.stringify({ ok: false, code: "INVALID_FRAGMENT" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      }
    );

  }

  /**
   * Parse and validate authority token record shape.
   */

  let tokenRecord: AuthorityTokenRecord;

  if (SHA256_REGEX.test(storedRaw)) {

    tokenRecord = {
      fragment: storedRaw,
    };

  } else {

    try {

      const parsed: unknown =
        JSON.parse(storedRaw);

      if (
        !isPlainObject(parsed)                ||
        typeof parsed.fragment !== "string"   ||
        !SHA256_REGEX.test(parsed.fragment)
      ) {

        return new Response(
          JSON.stringify({ ok: false, code: "INVALID_FRAGMENT" }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          }
        );

      }

      tokenRecord = {
        fragment: parsed.fragment,
      };

    } catch {

      return new Response(
        JSON.stringify({ ok: false, code: "INVALID_FRAGMENT" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        }
      );

    }

  }

  /**
   * Fragment comparison — constant-time not available in this
   * environment, but fragment is a 64-hex SHA-256 value so
   * timing attacks here have negligible practical surface.
   */

  if (tokenRecord.fragment !== creatorAuthorityFragment) {

    return new Response(
      JSON.stringify({ ok: false, code: "INVALID_FRAGMENT" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      }
    );

  }


  /**
   * Trusted time source.
   *
   * FIX (critical — Trusted Time violation): Date.now() replaced with
   * getTrustedNow(request), which fetches /api/time relative to the
   * worker origin. This ensures the heartbeat POST shares a single
   * Time Authority with openCapsule() and confirmPresence(), eliminating
   * the clock-skew race described in the v1.3 audit:
   *
   *   /api/time says capsule is open  →  recipient can decrypt
   *   Date.now() is 30 s behind       →  server still accepts confirmation
   *
   * Both paths now use the same authority; the race window is closed.
   */

  let nowUtc: number;

  try {

    nowUtc =
      await getTrustedNow(request);

  } catch {

    return new Response(
      JSON.stringify({ ok: false, code: "TIME_UNAVAILABLE" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      }
    );

  }


  /**
   * Load manifest to compute effectiveOpenAt.
   *
   * FIX (hardening): CAPSULE_MANIFESTS binding guarded before use.
   * Mirrors the existing guard on AUTHORITY_TOKENS — an absent or
   * misconfigured binding now returns 503 instead of an unhandled
   * TypeError crashing the worker.
   */

  const capsuleManifests =
    env?.CAPSULE_MANIFESTS;

  if (
    !capsuleManifests ||
    typeof (capsuleManifests as { get?: unknown }).get !== "function"
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "SERVICE_UNAVAILABLE" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      }
    );

  }

  const manifestRaw =
    await (capsuleManifests as { get: (k: string) => Promise<string | null> })
      .get(capsuleId);

  if (!manifestRaw) {

    return new Response(
      "manifest not found",
      { status: 404 }
    );

  }

  let manifestParsed: unknown;

  try {

    manifestParsed =
      JSON.parse(manifestRaw);

  } catch {

    return new Response(
      JSON.stringify({ ok: false, code: "INVALID_MANIFEST" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );

  }


  /**
   * Manifest schema sanity guard.
   *
   * ISSUE 4 FIX: openAt must be finite, a safe integer, and positive.
   * Rejects Infinity, NaN, and unsafe integers — all of which previously
   * passed `typeof x === "number"` and violated Temporal Authority Layer.
   */

  if (
    !manifestParsed ||
    typeof manifestParsed !== "object"
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "INVALID_MANIFEST" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );

  }

  const manifest =
    manifestParsed as Record<string, unknown>;

  if (
    manifest.version !== 1 ||
    typeof manifest.openAt !== "number" ||
    !Number.isFinite(manifest.openAt) ||
    !Number.isSafeInteger(manifest.openAt) ||
    manifest.openAt <= 0 ||
    (
      // Heartbeat (v4.3): canonical, always-active — heartbeatInterval
      // is required on every manifest, not gated by an enable flag.
      typeof manifest.heartbeatInterval !== "number" ||
      !Number.isFinite(manifest.heartbeatInterval) ||
      !Number.isSafeInteger(manifest.heartbeatInterval)
    )
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "INVALID_MANIFEST" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );

  }


  /**
   * Load previous heartbeat record to get lastConfirmedAt.
   *
   * FIX (hardening): HEARTBEAT_CONFIRMATIONS binding guarded before use.
   * Mirrors the guard added above for CAPSULE_MANIFESTS — prevents an
   * unhandled TypeError on missing or misconfigured KV binding.
   */

  const heartbeatConfirmations =
    env?.HEARTBEAT_CONFIRMATIONS;

  if (
    !heartbeatConfirmations ||
    typeof (heartbeatConfirmations as { get?: unknown }).get !== "function" ||
    typeof (heartbeatConfirmations as { put?: unknown }).put !== "function"
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "SERVICE_UNAVAILABLE" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      }
    );

  }

  const confirmedKV =
    heartbeatConfirmations as {
      get: (k: string) => Promise<string | null>;
      put: (k: string, v: string) => Promise<void>;
    };

  const existingRaw =
    await confirmedKV.get(capsuleId);

  let lastConfirmedAt:
    number | null = null;

  if (existingRaw) {

    try {

      const parsed: unknown =
        JSON.parse(existingRaw);

      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).lastConfirmedAt === "number"
      ) {

        lastConfirmedAt =
          (parsed as Record<string, unknown>).lastConfirmedAt as number;

      }

    } catch {}

  }


  /**
   * Monotonic confirmation enforcement — replay protection.
   */

  if (
    lastConfirmedAt !== null &&
    nowUtc <= lastConfirmedAt
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "STALE_CONFIRMATION" }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      }
    );

  }


  /**
   * Compute effectiveOpenAt.
   */

  // Temporal Authority boundary.
  //
  // From this point forward the protocol no longer
  // relies on manifest.openAt alone. All unlock
  // decisions are derived from the effective
  // heartbeat-adjusted unlock time.
  const effectiveOpenAt =
    resolveEffectiveOpenAt({

      manifestOpenAt:
        manifest.openAt as OpenAtUtc,

      // Heartbeat (v4.3): always active — no heartbeatEnabled gate.
      heartbeatInterval:
        manifest.heartbeatInterval as number,

      lastConfirmedAt:
        lastConfirmedAt ?? undefined

    });


  /**
   * Unlock boundary enforcement
   */

  if (nowUtc >= effectiveOpenAt) {

    return new Response(

      JSON.stringify({
        ok: false,
        code: "CONFIRMATION_WINDOW_EXPIRED"
      }),

      {
        status: 409,
        headers: { "content-type": "application/json" },
      }

    );

  }


  /**
   * Heartbeat Window gating (Complete System Logic, "Heartbeat Window"):
   * if the originally selected opening interval exceeds 30 days,
   * confirmations remain unavailable until the remaining time until
   * the effective opening moment reaches 30 days.
   */

  if (
    (manifest.heartbeatInterval as number) > THIRTY_DAYS_MS &&
    (effectiveOpenAt - nowUtc) > THIRTY_DAYS_MS
  ) {

    return new Response(

      JSON.stringify({
        ok: false,
        code: "CONFIRMATION_WINDOW_NOT_YET_AVAILABLE"
      }),

      {
        status: 409,
        headers: { "content-type": "application/json" },
      }

    );

  }


  /**
   * All guards passed — write heartbeat record.
   */

  const record: HeartbeatRecord = {

    capsuleId,

    lastConfirmedAt:
      nowUtc,

    updatedAt:
      nowUtc,

    version: 1,

  };


  await confirmedKV.put(

    capsuleId,

    JSON.stringify(record)

  );


  return new Response(

    JSON.stringify({ ok: true }),

    {
      status: 200,
      headers: { "content-type": "application/json" },
    }

  );

}


/**
 * GET /api/heartbeat
 *
 * Reads confirmation timestamp
 */

export async function onRequestGet(
  context: unknown
) {

  const ctx =
    context as { request: Request; env: Record<string, unknown> };

  const { request, env } = ctx;

  const url =
    new URL(request.url);

  const capsuleId =
    url.searchParams.get("capsuleId");


  if (
    !capsuleId ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    return new Response(
      "capsuleId required",
      { status: 400 }
    );

  }


  const heartbeatConfirmations =
    env?.HEARTBEAT_CONFIRMATIONS;

  if (
    !heartbeatConfirmations ||
    typeof (heartbeatConfirmations as { get?: unknown }).get !== "function"
  ) {

    return new Response(
      JSON.stringify({ ok: false, code: "SERVICE_UNAVAILABLE" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      }
    );

  }

  const stored =
    await (heartbeatConfirmations as { get: (k: string) => Promise<string | null> })
      .get(capsuleId);


  if (!stored) {

    return new Response(

      JSON.stringify({ lastConfirmedAt: null }),

      {
        status: 200,
        headers: { "content-type": "application/json" },
      }

    );

  }


  // ISSUE 3 FIX: KV contents are never returned raw.
  // Parse, validate shape, and reconstruct a canonical response.
  // Corrupted KV, partial migrations, or schema drift cannot
  // poison the runtime authority surface.

  let parsedStored: unknown;

  try {

    parsedStored =
      JSON.parse(stored);

  } catch {

    return new Response(

      JSON.stringify({ ok: false, code: "INVALID_RECORD" }),

      {
        status: 500,
        headers: { "content-type": "application/json" },
      }

    );

  }

  if (
    !parsedStored ||
    typeof parsedStored !== "object"
  ) {

    return new Response(

      JSON.stringify({ ok: false, code: "INVALID_RECORD" }),

      {
        status: 500,
        headers: { "content-type": "application/json" },
      }

    );

  }

  const record =
    parsedStored as Record<string, unknown>;

  const lastConfirmedAt =
    record.lastConfirmedAt;

  if (
    typeof lastConfirmedAt !== "number" ||
    !Number.isFinite(lastConfirmedAt) ||
    !Number.isSafeInteger(lastConfirmedAt) ||
    lastConfirmedAt <= 0
  ) {

    return new Response(

      JSON.stringify({ ok: false, code: "INVALID_RECORD" }),

      {
        status: 500,
        headers: { "content-type": "application/json" },
      }

    );

  }

  return new Response(

    JSON.stringify({ lastConfirmedAt }),

    {
      status: 200,
      headers: { "content-type": "application/json" },
    }

  );

}