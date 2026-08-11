import type { EventContext } from "@cloudflare/workers-types";
import { getTrustedTime } from "../time";
import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
  STORAGE_POINTER_REGEX,
} from "../../../src/lib/crypto/validators";
import {
  MAX_ENCRYPTED_VAULT_SIZE
} from "../../../src/lib/crypto/constants";

/**
 * Canonical plain-object guard.
 * Accepts both Object.prototype and null-prototype objects —
 * mirrors usage across the AETERNA runtime.
 */
function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/* ================= ENV BINDINGS ================= */

interface ManifestEnv {
  CAPSULE_MANIFESTS: KVNamespace;
}

/**
 * Time bounds
 */

const MIN_TIME =
  1577836800000;

const MAX_TIME =
  4102444800000;

/**
 * Encrypted vault size bounds
 */

const MIN_ENCRYPTED_SIZE =
  1;

/**
 * Heartbeat interval bounds
 * Mirrors seal.ts HEARTBEAT_INTERVAL_MIN / HEARTBEAT_INTERVAL_MAX.
 */

const HEARTBEAT_INTERVAL_MIN =
  86400000;

const HEARTBEAT_INTERVAL_MAX =
  3153600000000;

/**
 * Top-level manifest field whitelist
 * Mirrors seal endpoint — prevents unknown field leakage.
 */

const ALLOWED_MANIFEST_FIELDS = Object.freeze(new Set([
  "version",
  "capsuleId",
  "saltBase",
  "vaultTxId",
  "openAt",
  "sealedAt",
  "encryptedSizeBytes",
  "ext",
  "description",

  "heartbeatInterval",
]));

/**
 * ext field whitelist
 * Mirrors seal endpoint — prevents schema confusion / future-field spoofing.
 */

const ALLOWED_EXT_FIELDS = Object.freeze(new Set([
  "vaultSha256",
  "chunkPointers",
]));

/**
 * RFC-001 §4, §7 — structural validation of chunkPointers on read.
 *
 * Mirrors validateChunkPointers() in src/lib/capsule/loadManifest.ts:
 * a plain object, not an array, every value a well-formed StoragePointer.
 * Absent on older manifests sealed before chunkPointers existed — those
 * are treated as capsules with no media chunks ({}).
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

/**
 * Allowed origins
 */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/**
 * Headers
 *
 * Manifest is immutable after sealing.
 * Safe to cache long-term.
 *
 * NOTE: when the request Origin is absent or not in ALLOWED_ORIGINS,
 * we omit Access-Control-Allow-Origin / Timing-Allow-Origin entirely
 * rather than echoing back the literal string "null". Sending the
 * literal "null" would match browsers that send `Origin: null`
 * (sandboxed iframes, `data:`/`file:` contexts), which is a known
 * CORS foot-gun — it would let such untrusted contexts read the
 * response via fetch. Omitting the header keeps the request same-origin
 * only, matching intent.
 */

function baseHeaders(
  origin?: string,
  cache = false
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

    "Referrer-Policy":
      "no-referrer",

    "Cross-Origin-Resource-Policy":
      "cross-origin",

    "Access-Control-Allow-Methods":
      "GET, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Cache-Control":
      cache
        ? "public, max-age=31536000, immutable"
        : "no-store",

  };

  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
    headers["Timing-Allow-Origin"] = allowed;
  }

  return headers;

}

/**
 * Error helper
 */

function fail(
  status = 400,
  message = "error",
  origin?: string
): Response {

  return new Response(

    JSON.stringify({
      ok: false,
      error: message,
    }),

    {
      status,
      headers: baseHeaders(origin),
    }

  );

}

/**
 * OPTIONS handler
 */

export const onRequestOptions = async (
  context: EventContext<ManifestEnv, any, any>
): Promise<Response> => {

  const origin =
    context.request.headers.get("origin") ?? "";

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
 */

export const onRequestGet = async (
  context: EventContext<ManifestEnv, any, any>
): Promise<Response> => {

  const { request, env, params } =
    context;

  /**
   * Snapshot time once — all temporal checks use the same reference.
   * Prevents micro-race conditions from multiple Date.now() calls
   * within a single request, ensuring deterministic validation.
   */

  const { nowUtc } =
    await getTrustedTime();

  const origin =
    request.headers.get("origin") ?? "";

  /**
   * capsuleId validation
   */

  const capsuleId =
    params?.capsuleId;

  if (
    !capsuleId ||
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    return fail(
      400,
      "INVALID_CAPSULE_ID",
      origin
    );

  }

  /**
   * KV binding required
   */

  if (!env?.CAPSULE_MANIFESTS) {

    return fail(
      503,
      "STORAGE_UNAVAILABLE",
      origin
    );

  }

  /**
   * Load manifest
   */

  let raw:
    | string
    | null = null;

  try {

    raw =
      await env.CAPSULE_MANIFESTS.get(
        capsuleId
      );

  } catch {

    return fail(
      503,
      "STORAGE_ERROR",
      origin
    );

  }

  if (!raw) {

    return fail(
      404,
      "CAPSULE_NOT_FOUND",
      origin
    );

  }

  /**
   * Size sanity guard
   */

  if (raw.length > 20000) {

    return fail(
      500,
      "MANIFEST_TOO_LARGE",
      origin
    );

  }

  /**
   * Parse JSON
   */

  let manifest:
    unknown;

  try {

    manifest =
      JSON.parse(raw);

  } catch {

    return fail(
      500,
      "MANIFEST_CORRUPT",
      origin
    );

  }

  /**
   * Prototype poisoning guard
   */

  if (!isPlainObject(manifest)) {

    return fail(
      500,
      "MANIFEST_INVALID",
      origin
    );

  }

  const m =
    manifest as Record<
      string,
      unknown
    >;

  /**
   * Top-level field whitelist
   * Prevents unknown fields from leaking to clients and
   * mirrors the seal endpoint's canonical field set.
   */

  for (const k of Object.keys(m)) {
    if (!ALLOWED_MANIFEST_FIELDS.has(k)) {
      return fail(500, "MANIFEST_INVALID", origin);
    }
  }

  /**
   * Schema validation
   */

  if (m.version !== 1) {

    return fail(
      500,
      "MANIFEST_INVALID_VERSION",
      origin
    );

  }

  if (
    typeof m.capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(m.capsuleId) ||
    m.capsuleId !== capsuleId
  ) {

    return fail(
      500,
      "MANIFEST_ID_MISMATCH",
      origin
    );

  }

  if (
    typeof m.saltBase !== "string" ||
    !SALT_BASE_REGEX.test(m.saltBase)
  ) {

    return fail(
      500,
      "MANIFEST_INVALID_SALT",
      origin
    );

  }

  if (
    typeof m.vaultTxId !== "string" ||
    !STORAGE_POINTER_REGEX.test(m.vaultTxId)
  ) {

    return fail(
      500,
      "MANIFEST_INVALID_VAULT_TXID",
      origin
    );

  }

  // ISSUE A fix: isSafeInteger enforces precise temporal semantics
  if (
    typeof m.openAt !== "number" ||
    !Number.isSafeInteger(m.openAt) ||
    m.openAt < MIN_TIME ||
    m.openAt > MAX_TIME
  ) {

    return fail(
      500,
      "MANIFEST_INVALID_OPEN_AT",
      origin
    );

  }

  // ISSUE A fix: isSafeInteger enforces precise temporal semantics
  if (
    typeof m.sealedAt !== "number" ||
    !Number.isSafeInteger(m.sealedAt) ||
    m.sealedAt < MIN_TIME ||
    m.sealedAt > MAX_TIME
  ) {

    return fail(
      500,
      "MANIFEST_INVALID_SEALED_AT",
      origin
    );

  }

  if (m.openAt <= m.sealedAt) {

    return fail(
      500,
      "MANIFEST_INVALID",
      origin
    );

  }

  /**
   * sealedAt MUST NOT be in the future.
   *
   * Protects against:
   * — clock drift issues
   * — corrupted KV writes
   * — malformed manifests
   */

  if (m.sealedAt > nowUtc) {

    return fail(
      500,
      "MANIFEST_INVALID",
      origin
    );

  }

  // ISSUE B fix: isSafeInteger rejects fractional byte counts
  if (
    typeof m.encryptedSizeBytes !== "number" ||
    !Number.isSafeInteger(m.encryptedSizeBytes) ||
    m.encryptedSizeBytes < MIN_ENCRYPTED_SIZE ||
    m.encryptedSizeBytes > MAX_ENCRYPTED_VAULT_SIZE
  ) {

    return fail(
      500,
      "MANIFEST_INVALID_ENCRYPTED_SIZE",
      origin
    );

  }

  if (
    m.description !== undefined &&
    (
      typeof m.description !== "string" ||
      m.description.length > 500
    )
  ) {

    return fail(
      500,
      "MANIFEST_INVALID",
      origin
    );

  }

  /**
   * Heartbeat schedule field — REQUIRED on every manifest.
   *
   * Canonical model (v4.3, mirrors seal.ts / ManifestV1):
   * Heartbeat is a canonical, always-active capability — there is no
   * per-capsule enable flag. `heartbeatInterval` records the originally
   * selected opening interval, fixed at sealing, and is mandatory.
   */

  if (
    typeof m.heartbeatInterval !== "number" ||
    !Number.isSafeInteger(m.heartbeatInterval) ||
    m.heartbeatInterval < HEARTBEAT_INTERVAL_MIN ||
    m.heartbeatInterval > HEARTBEAT_INTERVAL_MAX
  ) {

    return fail(
      500,
      "MANIFEST_INVALID",
      origin
    );

  }

  /**
   * ext validation
   */

  // ISSUE C fix: Object.isExtensible removed — frozen/sealed objects are valid
  // MINOR ISSUE 3 fix: isPlainObject accepts null-prototype objects — canonical style
  if (!isPlainObject(m.ext)) {

    return fail(
      500,
      "MANIFEST_INVALID_EXT",
      origin
    );

  }

  const ext =
    m.ext as Record<
      string,
      unknown
    >;

  for (const k of Object.keys(ext)) {

    if (!ALLOWED_EXT_FIELDS.has(k)) {

      return fail(
        500,
        "MANIFEST_INVALID_EXT",
        origin
      );

    }

  }

  /**
   * REQUIRED integrity scaffold:
   * vaultSha256 MUST exist.
   */

  if (
    typeof ext.vaultSha256 !== "string" ||
    !SHA256_REGEX.test(ext.vaultSha256)
  ) {

    return fail(
      500,
      "MANIFEST_INVALID_VAULT_SHA256",
      origin
    );

  }

  if (!isValidChunkPointers(ext.chunkPointers)) {

    return fail(
      500,
      "MANIFEST_INVALID_CHUNK_POINTERS",
      origin
    );

  }

  /**
   * ISSUE F fix: reconstruct normalized output from validated fields only.
   * Prevents unknown fields from leaking and locks the response shape.
   */

  const normalized: Record<string, unknown> = {
    version:             m.version,
    capsuleId:           m.capsuleId,
    saltBase:            m.saltBase,
    vaultTxId:           m.vaultTxId,
    openAt:              m.openAt,
    sealedAt:            m.sealedAt,
    encryptedSizeBytes:  m.encryptedSizeBytes,
    // Heartbeat (v4.3): canonical, always-active — heartbeatInterval
    // is required on every manifest, not conditional on an enable flag.
    heartbeatInterval:   m.heartbeatInterval,
    ext: {
      vaultSha256: ext.vaultSha256,
      chunkPointers: ext.chunkPointers ?? {},
    },
  };

  if (m.description !== undefined) {
    normalized.description = m.description;
  }

  /**
   * Success
   */

  return new Response(

    JSON.stringify(normalized),

    {
      status: 200,
      headers: {
        ...baseHeaders(origin, true),
        "X-Aeterna-Manifest-Version":   "1",
        "X-Aeterna-Manifest-Immutable": "true",
      },
    }

  );

};