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
  PUBLICATION_VERIFICATIONS?: KVNamespace;

  DEBUG?: "true" | "false";
}

/* ================= RECORD SHAPES ================= */

type UploadTokenRecord = {
  canonicalLifecycleId: string;
  creatorIdentityId: string;
  paymentIntentId: string | null;
  permissions: {
    uploadVault: boolean;
  };
};

type VerifiedPaymentRecord = {
  ok: boolean;
  paymentIntentId: string;
  transactionId: string;
  expiresAt: number;
};

/* ================= REGEX ================= */

const ARWEAVE_TXID_RE =
  /^[a-zA-Z0-9_-]{43}$/;

const UPLOAD_TOKEN_REGEX =
  /^[a-zA-Z0-9_-]{32,}$/;

/* ================= MANIFEST WHITELIST ================= */

const ALLOWED_MANIFEST_FIELDS =
  Object.freeze(new Set([
    "version",
    "capsuleId",
    "sealedAt",
    "openAt",
    "saltBase",
    "vaultTxId",
    "encryptedSizeBytes",
    "description",
    "heartbeatInterval",
    "ext",
  ]));

/* ================= EXT WHITELIST ================= */

const ALLOWED_EXT_FIELDS =
  Object.freeze(new Set([
    "vaultSha256",
    "chunkPointers",
  ]));

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

  /* ── Retry-safe idempotency check ──
   *
   * Executed BEFORE upload-token / payment / time enforcement so a
   * retry of an already-sealed capsule is accepted idempotently even
   * though the original seal consumed the Upload Token and payment
   * authority. The manifest is public and immutable: a byte-identical
   * canonical manifest returns the existing sealed result, while a
   * different manifest for the same capsuleId stays fail-closed
   * (409 — seal-once).
   */

  const existing = await env.CAPSULE_MANIFESTS.get(capsuleId);
  const normalized = canonicalStringify(manifest);

  if (existing !== null) {

    let existingCanonical: string;
    try {
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
    !tokenData ||
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

  /* ── Entitlement/lifecycle authority enforcement ──
   *
   * Seal authorization no longer depends on pre-capsule capsuleId-bound
   * payment keys. It depends on:
   *   - valid upload token issued after entitlement verification
   *   - optional payment linkage metadata for audit/reconciliation
   */

  const paymentIntentId =
    typeof tokenData.paymentIntentId === "string"
      ? tokenData.paymentIntentId.trim()
      : null;

  let verifiedPayment: VerifiedPaymentRecord | null = null;
  let boundEvidenceId: string | null = null;

  if (paymentIntentId) {
    boundEvidenceId = await env.VERIFIED_PAYMENTS.get(
      `payment-intent:${paymentIntentId}:latest`
    );
    if (typeof boundEvidenceId === "string") {
      const paymentRaw = await env.VERIFIED_PAYMENTS.get(
        `verified-payment:${paymentIntentId}:${boundEvidenceId}`
      );
      if (paymentRaw) {
        try {
          verifiedPayment = JSON.parse(paymentRaw) as VerifiedPaymentRecord;
        } catch {
          verifiedPayment = null;
        }
      }
    }
  }

  if (
    !verifiedPayment ||
    !boundEvidenceId ||
    verifiedPayment.ok !== true ||
    !Number.isSafeInteger(verifiedPayment.expiresAt) ||
    verifiedPayment.expiresAt <= trustedNow
  ) {
    return fail(402, "PAYMENT_REQUIRED", origin);
  }

  if (
    verifiedPayment.paymentIntentId !== paymentIntentId
  ) {
    return fail(402, "PAYMENT_INVALID", origin);
  }

  /* ── Publication verification gate ──
   *
   * Seal authorization now requires server-authoritative publication
   * verification. Client manifest values are consistency assertions
   * only; the authoritative source is PUBLICATION_VERIFICATIONS.
   */

  const lifecycleId =
    typeof tokenData.canonicalLifecycleId === "string"
      ? tokenData.canonicalLifecycleId.trim()
      : "";

  if (!lifecycleId) {
    return fail(403, "LIFECYCLE_MISSING", origin);
  }

  const publicationRecordRaw = env.PUBLICATION_VERIFICATIONS
    ? await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${lifecycleId}`)
    : null;

  if (!publicationRecordRaw) {
    return fail(403, "PUBLICATION_NOT_VERIFIED", origin);
  }

  let publicationRecord: {
    state?: string;
    expectedTxId?: string;
    expectedVaultSha256?: string | null;
  };

  try {
    publicationRecord = JSON.parse(publicationRecordRaw);
  } catch {
    return fail(503, "PUBLICATION_STORAGE_CORRUPTED", origin);
  }

  if (
    !publicationRecord ||
    publicationRecord.state !== "VERIFIED" ||
    typeof publicationRecord.expectedTxId !== "string" ||
    publicationRecord.expectedTxId.trim().length === 0 ||
    typeof publicationRecord.expectedVaultSha256 !== "string" ||
    publicationRecord.expectedVaultSha256.trim().length === 0
  ) {
    return fail(403, "PUBLICATION_NOT_VERIFIED", origin);
  }

  if (
    typeof vaultTxId !== "string" ||
    vaultTxId.trim().length === 0 ||
    vaultTxId !== publicationRecord.expectedTxId
  ) {
    return fail(409, "PUBLICATION_ID_MISMATCH", origin);
  }

  if (
    typeof ext.vaultSha256 !== "string" ||
    ext.vaultSha256.trim().length === 0 ||
    ext.vaultSha256 !== publicationRecord.expectedVaultSha256
  ) {
    return fail(409, "PUBLICATION_HASH_MISMATCH", origin);
  }

  /* ── Commit ──
   *
   * Write order:
   *   1. CAPSULE_MANIFESTS.put   — manifest persisted (irreversible event)
   *   2. VERIFIED_PAYMENTS.delete x2 — payment authority consumed
   *   3. BUSINESS_QUOTES.delete  — commercial authority consumed
   *   4. UPLOAD_TOKENS.delete     — token revoked
   *
   * Payment authority is consumed HERE, not at upload-token issuance.
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
  if (boundEvidenceId && paymentIntentId) {
    await env.VERIFIED_PAYMENTS.delete(
      `verified-payment:${paymentIntentId}:${boundEvidenceId}`
    ).catch(() => {});
    await env.VERIFIED_PAYMENTS.delete(
      `payment-intent:${paymentIntentId}:latest`
    ).catch(() => {});
  }

  // Business Quote lifecycle ends here — the commercial authority has
  // been fully consumed by a committed manifest.
  await deleteBusinessQuote(env, paymentIntentId ?? "").catch(() => {});

  await env.UPLOAD_TOKENS.delete(uploadToken).catch(() => {});

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: baseHeaders(origin) }
  );

};
