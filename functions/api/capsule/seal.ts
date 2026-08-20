/**
 * AETERNA — Seal Capsule Manifest
 * POST /api/capsule/seal
 *
 * Canonical Spec v1.1 compliant version (Layer 8 fixed)
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
  STORAGE_POINTER_REGEX,
} from "../../../src/lib/crypto/validators";
import {
  deleteBusinessQuote,
} from "../../lib/business/businessQuoteStore";
import {
  MAX_ENCRYPTED_VAULT_SIZE
} from "../../../src/lib/crypto/constants";

/* ================= ENV BINDINGS ================= */

interface SealEnv {
  CAPSULE_MANIFESTS: KVNamespace;
  VERIFIED_PAYMENTS: KVNamespace;
  UPLOAD_TOKENS: KVNamespace;
  AUTHORITY_TOKENS: KVNamespace;
  BUSINESS_QUOTES: KVNamespace;

  DEBUG?: "true" | "false";
}

/* ================= RECORD SHAPES ================= */

type UploadTokenRecord = {
  capsuleId: string;
  permissions: {
    uploadVault: boolean;
  };
};

type VerifiedPaymentRecord = {
  ok: boolean;
  capsuleId: string;
  transactionId: string;
  expiresAt: number;
  billableSizeBytes: number;
};

/* ================= REGEX ================= */

const ARWEAVE_TXID_RE =
  /^[a-zA-Z0-9_-]{43}$/;

const UPLOAD_TOKEN_REGEX =
  /^[a-zA-Z0-9_-]{32,}$/;

/* ================= MANIFEST WHITELIST ================= */

// Canonical Manifest fields per Complete System Logic (v4.3.1):
// capsuleId, sealedAt, openAt, vaultTxId, encryptedSizeBytes, saltBase,
// heartbeatInterval, ext.vaultSha256. Heartbeat is a canonical,
// always-active capability (v4.3) — there is no heartbeatEnabled flag.
// "version" and "description" are NOT canonical Manifest fields — they
// are implementation-level extensions kept for forward-compat / UX and
// carry no protocol authority (they never participate in Ciphertext,
// Open, Business, or Storage Authority).
const ALLOWED_MANIFEST_FIELDS =
  Object.freeze(new Set([
    "version",           // implementation extension, not canonical
    "capsuleId",
    "sealedAt",
    "openAt",
    "saltBase",
    "vaultTxId",
    "encryptedSizeBytes",
    "description",        // implementation extension, not canonical

    "heartbeatInterval",

    "ext",
  ]));

/* ================= EXT WHITELIST ================= */

const ALLOWED_EXT_FIELDS =
  Object.freeze(new Set([
    "vaultSha256",
    "chunkPointers",
  ]));

/**
 * RFC-001 §4, §7 — structural validation of chunkPointers on ingest.
 *
 * Mirrors the client-side check in src/lib/capsule/loadManifest.ts
 * (validateChunkPointers): a plain object, not an array, every value
 * a well-formed StoragePointer. chunkPointers is optional on input —
 * capsules with no media chunks omit it or send {}. When present it
 * must be structurally valid; malformed content is rejected here so
 * a corrupt manifest can never reach CAPSULE_MANIFESTS.
 */
function isValidChunkPointers(
  value: unknown
): boolean {

  if (value === undefined) return true;

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }

  for (const pointer of Object.values(value)) {
    if (
      typeof pointer !== "string" ||
      !STORAGE_POINTER_REGEX.test(pointer)
    ) {
      return false;
    }
  }

  return true;

}

/* ================= SIZE LIMITS ================= */


/* ================= TIME LIMITS ================= */

const MIN_TIME =
  1577836800000;

const MAX_TIME =
  4102444800000;

const SEALED_AT_TOLERANCE =
  2 * 60 * 1000;

/* ================= HEARTBEAT LIMITS ================= */

const HEARTBEAT_INTERVAL_MIN =
  86400000;

const HEARTBEAT_INTERVAL_MAX =
  3153600000000;

/* ================= ORIGINS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/* ================= HELPERS ================= */

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object")
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deterministic (key-order independent) serialization.
 *
 * Manifest sealing must be idempotent: a creator retrying the same
 * seal request after a network interruption must never be rejected
 * as MANIFEST_ALREADY_EXISTS_DIFFERENT just because JSON.stringify()
 * happened to serialize object keys in a different order on the
 * client. This recursively sorts object keys before stringifying, so
 * two logically identical manifests always canonicalize to the same
 * string, regardless of client-side key ordering.
 *
 * This does not change Manifest content or authority — it only fixes
 * the storage/comparison representation.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Dev-only diagnostics — gated by the Worker's DEBUG env var, not
 * import.meta.env.DEV (a Vite-only construct that does not exist in
 * the Cloudflare Pages Functions / Workers runtime). Silent unless
 * env.DEBUG === "true".
 */
function debugLog(
  env: SealEnv,
  ...args: unknown[]
): void {
  if (env.DEBUG === "true") {
    console.log(...args);
  }
}

/* ================= HEADERS ================= */

function baseHeaders(origin?: string) {

  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : undefined;

  const headers: Record<string, string> = {
    "Content-Type":                    "application/json",
    "Cache-Control":                   "no-store",
    "Surrogate-Control":               "no-store",
    "Cross-Origin-Resource-Policy":    "same-site",
    "X-Aeterna-Seal-Version":         "v1",
    "X-Content-Type-Options":          "nosniff",
    "Referrer-Policy":                 "no-referrer",
    "Access-Control-Allow-Methods":    "POST, OPTIONS",
    "Access-Control-Allow-Headers":    "Content-Type",
  };

  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
  }

  return headers;

}

function fail(
  status = 400,
  error  = "error",
  origin?: string
) {
  return new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: baseHeaders(origin) }
  );
}

/* ================= OPTIONS ================= */

export const onRequestOptions =
async (context: EventContext<SealEnv, unknown, unknown>) => {
  const origin = context.request.headers.get("origin") ?? "";
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
};

/* ================= POST ================= */

export const onRequestPost =
async (context: EventContext<SealEnv, unknown, unknown>) => {

  const { request, env } = context;

  const origin = request.headers.get("origin") ?? "";

  if (!ALLOWED_ORIGINS.includes(origin))
    return fail(403, "INVALID_ORIGIN", origin);

  const ip = getClientIp(request);
  if (!rateLimit(ip))
    return fail(429, "TOO_MANY_REQUESTS", origin);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json"))
    return fail(415, "UNSUPPORTED_MEDIA_TYPE", origin);

  if (
    !env?.CAPSULE_MANIFESTS ||
    !env?.UPLOAD_TOKENS ||
    !env?.AUTHORITY_TOKENS
  )
    return fail(503, "STORAGE_UNAVAILABLE", origin);

  if (!env?.VERIFIED_PAYMENTS)
    return fail(503, "STORAGE_UNAVAILABLE", origin);

  if (!env?.BUSINESS_QUOTES)
    return fail(503, "STORAGE_UNAVAILABLE", origin);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "INVALID_JSON", origin);
  }

  if (!isPlainObject(body))
    return fail(400, "INVALID_BODY", origin);

  const {
    uploadToken,
    manifest,
    creatorAuthorityFragment
  } =
    body as Record<string, unknown>;

  if (
    typeof uploadToken !== "string" ||
    !UPLOAD_TOKEN_REGEX.test(uploadToken)
  ) {
    return fail(400, "INVALID_UPLOAD_TOKEN", origin);
  }

  if (!isPlainObject(manifest))
    return fail(400, "INVALID_MANIFEST", origin);

  if (
    typeof creatorAuthorityFragment !== "string" ||
    !SHA256_REGEX.test(creatorAuthorityFragment)
  ) {
    return fail(
      400,
      "INVALID_CREATOR_AUTHORITY",
      origin
    );
  }

  if (
    !Object.keys(manifest).every(k =>
      ALLOWED_MANIFEST_FIELDS.has(k)
    )
  ) {
    return fail(400, "INVALID_MANIFEST", origin);
  }

  const m = manifest as Record<string, unknown>;

  if (
    m.version !== 1                                          ||
    typeof m.capsuleId !== "string"                          ||
    !CAPSULE_ID_REGEX.test(m.capsuleId)                      ||
    typeof m.saltBase !== "string"                           ||
    !SALT_BASE_REGEX.test(m.saltBase)                        ||
    typeof m.vaultTxId !== "string"                          ||
    !ARWEAVE_TXID_RE.test(m.vaultTxId)                       ||
    !Number.isSafeInteger(m.openAt)                          ||
    !Number.isSafeInteger(m.sealedAt)                        ||
    (m.openAt as number) <= (m.sealedAt as number)           ||
    (m.openAt as number)   < MIN_TIME || (m.openAt as number)   > MAX_TIME ||
    (m.sealedAt as number) < MIN_TIME || (m.sealedAt as number) > MAX_TIME ||
    !Number.isSafeInteger(m.encryptedSizeBytes)               ||
    (m.encryptedSizeBytes as number) <= 0                     ||
    (m.encryptedSizeBytes as number) > MAX_ENCRYPTED_VAULT_SIZE
  ) {
    return fail(400, "INVALID_MANIFEST", origin);
  }

  // From this point, the fields validated above are narrowed and safe
  // to treat as their expected primitive types.
  const capsuleId          = m.capsuleId as string;
  const saltBase           = m.saltBase as string;
  const vaultTxId          = m.vaultTxId as string;
  const openAt             = m.openAt as number;
  const sealedAt           = m.sealedAt as number;
  const encryptedSizeBytes = m.encryptedSizeBytes as number;

  if (
    m.description !== undefined &&
    (
      typeof m.description !== "string" ||
      m.description.length > 500
    )
  ) {
    return fail(400, "INVALID_DESCRIPTION", origin);
  }

  // Heartbeat (v4.3): canonical, always-active capability — no
  // per-capsule enable flag. heartbeatInterval is required on every
  // sealed manifest.
  if (
    !Number.isSafeInteger(m.heartbeatInterval) ||
    (m.heartbeatInterval as number) < HEARTBEAT_INTERVAL_MIN ||
    (m.heartbeatInterval as number) > HEARTBEAT_INTERVAL_MAX
  ) {
    return fail(400, "INVALID_HEARTBEAT", origin);
  }

  if (!isPlainObject(m.ext))
    return fail(400, "INVALID_MANIFEST_EXT", origin);

  const ext = m.ext as Record<string, unknown>;

  if (!("vaultSha256" in ext))
    return fail(400, "INVALID_MANIFEST_EXT", origin);

  if (
    !Object.keys(ext).every(k =>
      ALLOWED_EXT_FIELDS.has(k)
    )
  ) {
    return fail(400, "INVALID_MANIFEST_EXT", origin);
  }

  if (
    typeof ext.vaultSha256 !== "string" ||
    !SHA256_REGEX.test(ext.vaultSha256)
  ) {
    return fail(400, "INVALID_VAULT_HASH", origin);
  }

  if (!isValidChunkPointers(ext.chunkPointers)) {
    return fail(400, "INVALID_MANIFEST_EXT", origin);
  }

  /* ── Retry-safe idempotency check (Finding 2) ──
   *
   * Executed BEFORE upload-token / payment / time enforcement so a
   * retry of an already-sealed capsule (e.g. after a lost network
   * response) is accepted idempotently even though the original seal
   * consumed the Upload Token and payment authority. The manifest is
   * public and immutable: a byte-identical canonical manifest returns
   * the existing sealed result, while a different manifest for the
   * same capsuleId stays fail-closed (409 — seal-once).
   */

  const existing = await env.CAPSULE_MANIFESTS.get(capsuleId);
  const normalized = canonicalStringify(manifest);

  if (existing !== null) {

    let existingCanonical: string;
    try {
      // Stored manifests were themselves written via canonicalStringify()
      // going forward, but guard against any pre-migration records that
      // were stored via plain JSON.stringify() with a different key order.
      existingCanonical = canonicalStringify(JSON.parse(existing));
    } catch {
      return fail(503, "MANIFEST_STORAGE_CORRUPTED", origin);
    }

    if (existingCanonical !== normalized)
      return fail(409, "MANIFEST_ALREADY_EXISTS_DIFFERENT", origin);

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  /* ── Upload-token enforcement boundary ── */

  const storedToken = await env.UPLOAD_TOKENS.get(uploadToken);
  if (!storedToken)
    return fail(403, "INVALID_UPLOAD_TOKEN", origin);

  let tokenData: UploadTokenRecord;
  try {
    tokenData = JSON.parse(storedToken);
  } catch {
    return fail(503, "TOKEN_STORAGE_CORRUPTED", origin);
  }

  if (
    !tokenData                                ||
    tokenData.capsuleId !== capsuleId         ||
    tokenData?.permissions?.uploadVault !== true
  ) {
    return fail(403, "UPLOAD_TOKEN_MISMATCH", origin);
  }

  /* ── Trusted time ── */

  let trustedNow: number;
  try {
    const { nowUtc } = await getTrustedTime();
    if (!Number.isSafeInteger(nowUtc))
      return fail(503, "TIME_UNAVAILABLE", origin);
    trustedNow = nowUtc;
  } catch {
    return fail(503, "TIME_UNAVAILABLE", origin);
  }

  /* ── Payment authority enforcement ──
   *
   * Dual-key topology written by webhook.ts / verify.ts:
   *   "capsule:{id}" → transactionId   (capsuleId → payment binding)
   *   transactionId  → full record     (payment record with metadata)
   *
   * Seal reads via the capsule key, then loads the full record via the
   * bound transactionId.
   */

  const capsulePaymentKey = "capsule:" + capsuleId;

  const boundTxHash =
    await env.VERIFIED_PAYMENTS.get(capsulePaymentKey);

  if (!boundTxHash || typeof boundTxHash !== "string")
    return fail(402, "PAYMENT_REQUIRED", origin);

  const paymentRecord =
    await env.VERIFIED_PAYMENTS.get(boundTxHash);

  if (!paymentRecord)
    return fail(402, "PAYMENT_RECORD_MISSING", origin);

  let payment: VerifiedPaymentRecord;
  try {
    payment = JSON.parse(paymentRecord);
  } catch {
    return fail(503, "PAYMENT_RECORD_CORRUPTED", origin);
  }

  if (
    !payment                              ||
    payment.ok !== true                   ||
    payment.capsuleId !== capsuleId       ||
    payment.transactionId !== boundTxHash
  ) {
    return fail(402, "PAYMENT_INVALID", origin);
  }

  if (
    !Number.isSafeInteger(payment.expiresAt) ||
    payment.expiresAt <= trustedNow
  ) {
    return fail(402, "PAYMENT_EXPIRED", origin);
  }

  if (
    !Number.isSafeInteger(payment.billableSizeBytes) ||
    payment.billableSizeBytes < encryptedSizeBytes
  ) {
    return fail(402, "PAYMENT_SIZE_MISMATCH", origin);
  }

  if (Math.abs(trustedNow - sealedAt) > SEALED_AT_TOLERANCE)
    return fail(400, "INVALID_SEALED_AT", origin);

  if (openAt <= trustedNow)
    return fail(400, "INVALID_OPEN_AT", origin);

  /* ── Vault pointer verification ── */

  let verified = false;

  for (let attempt = 0; attempt < 10; attempt++) {

    try {

      const verify = await fetch(
        `https://gateway.irys.xyz/${vaultTxId}`,
        {
          method: "GET",
          redirect: "follow",

          cf: {
            cacheTtl: 0,
            cacheEverything: false,
          },

        }
      );

      debugLog(
        env,
        "[AETERNA] Seal verify",
        attempt,
        verify.status,
        verify.url
      );

      if (verify.ok) {

        const contentLength =
          verify.headers.get("content-length");

        if (
          contentLength !== null &&
          Number(contentLength) !==
            encryptedSizeBytes
        ) {

          return fail(
            400,
            "VAULT_SIZE_MISMATCH",
            origin
          );

        }

        verified = true;
        break;

      }

    }

    catch (error) {
      debugLog(
        env,
        "[AETERNA] Seal verify error",
        attempt,
        error
      );
    }

    await new Promise(resolve =>
      setTimeout(
        resolve,
        1500 * (attempt + 1)
      )
    );

  }

  if (!verified) {

    return fail(
      400,
      "VAULT_NOT_AVAILABLE",
      origin
    );

  }



  /* ── Commit ──
   *
   * Write order:
   *   1. CAPSULE_MANIFESTS.put   — manifest persisted (irreversible event)
   *   2. VERIFIED_PAYMENTS.delete x2 — payment authority consumed
   *   3. BUSINESS_QUOTES.delete  — commercial authority consumed
   *   4. UPLOAD_TOKENS.delete    — token revoked
   *
   * Payment authority is consumed HERE, not at upload-token issuance.
   *
   * Lifecycle reasoning:
   * The irreversible event in AETERNA is manifest issuance, not
   * upload-token issuance. Deleting payment authority before seal
   * creates a real failure window (browser crash, Arweave failure,
   * network interruption) where the creator has no token, no payment
   * record, and no recovery path. By keeping both payment keys alive
   * until this point, any failure before manifest.put() leaves the
   * creator able to retry the full upload → seal flow.
   *
   * The Business Quote follows the same reasoning: it exists only for
   * the duration of the payment lifecycle (Create → Immutable →
   * Payment → Verification → Consumed). That lifecycle only truly ends
   * once the manifest is durably committed. Deleting the Quote earlier
   * — e.g. right after Verification or after Upload — would strand a
   * creator who crashes mid-flow with no Quote to recover against, for
   * the same reason payment keys are kept alive until this point.
   *
   * Dual-key deletion:
   * Both keys of the converged topology must be deleted together.
   * Leaving capsule:{id} alive after transactionId is gone would
   * produce a dangling pointer — a future seal attempt would resolve
   * the capsule key, find the transactionId, then fail with
   * PAYMENT_RECORD_MISSING on a legitimately paid capsule.
   *
   * If payment/quote deletes fail after manifest.put() succeeds: the
   * keys will be evicted by KV TTL. The idempotency check above
   * prevents any manifest overwrite on a retry — so payment/quote
   * authority expiry is the only consequence, not data loss.
   */

   /* ───────────────────────────────────────────────
    STEP — Manifest Authority Established

    Storage Authority has already been verified.

    The immutable Manifest is now being committed.

    This is the irreversible protocol event.

    After this point the capsule is considered SEALED.
    ─────────────────────────────────────────────── */

  await env.CAPSULE_MANIFESTS.put(capsuleId, normalized);

  await env.AUTHORITY_TOKENS.put(

    capsuleId,

    JSON.stringify({
      fragment: creatorAuthorityFragment
    })

  );

  // Best-effort: failures here are non-fatal. The manifest is already
  // committed. Keys expire via TTL if these deletes don't execute.
  await env.VERIFIED_PAYMENTS.delete(boundTxHash).catch(() => {});
  await env.VERIFIED_PAYMENTS.delete(capsulePaymentKey).catch(() => {});

  // Business Quote lifecycle ends here — the commercial authority has
  // been fully consumed by a committed manifest.
  await deleteBusinessQuote(env, capsuleId).catch(() => {});

  await env.UPLOAD_TOKENS.delete(uploadToken).catch(() => {});

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: baseHeaders(origin) }
  );

};