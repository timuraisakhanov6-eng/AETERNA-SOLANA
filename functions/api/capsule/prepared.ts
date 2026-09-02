/**
 * AETERNA — Capsule Prepared Projection
 *
 * POST /api/capsule/prepared
 *
 * Creates a server-authoritative metadata-only projection
 * for a PREPARED capsule. This projection is used by the
 * Storage Quote endpoint to establish authoritative size
 * and ciphertext identity without exposing secrets.
 *
 * This projection is NOT a new authority domain.
 * It belongs to Business/Storage Authority.
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
  getPreparedProjection,
  putPreparedProjection,
  type PreparedProjection,
} from "../../lib/storage/preparedProjectionStore";

/* ================= ENV BINDINGS ================= */

interface PreparedEnv {
  PREPARED_PROJECTIONS: {
    get(key: string): Promise<string | null>;
    put(
      key: string,
      value: string,
      options?: { expirationTtl?: number }
    ): Promise<void>;
  };
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
  };
}

/* ================= CONSTANTS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;

const PROJECTION_TTL_SECONDS = 600; // 10 minutes

const MIN_ENCRYPTED_SIZE = 1;
const MAX_ENCRYPTED_SIZE = 50 * 1024 * 1024; // 50 MB

/* ================= HELPERS ================= */

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && PAGES_PREVIEW_REGEX.test(url.hostname))
      return true;
  } catch {
    // ignore
  }
  return false;
}

function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(
  origin: string,
  status = 400,
  error = "error"
): Response {
  return new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: baseHeaders(origin) }
  );
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validateChunkMetadata(
  chunkMetadata: unknown
): { valid: true; count: number; totalSize: number } | { valid: false; error: string } {
  if (!Array.isArray(chunkMetadata)) {
    return { valid: false, error: "INVALID_CHUNK_METADATA_ARRAY" };
  }

  const chunks = chunkMetadata as unknown[];
  if (chunks.length === 0) {
    return { valid: false, error: "CHUNK_METADATA_EMPTY" };
  }

  let totalSize = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (
      !isPlainObject(chunk) ||
      typeof chunk.chunkId !== "string" ||
      typeof chunk.mediaId !== "string" ||
      typeof chunk.index !== "number" ||
      typeof chunk.size !== "number"
    ) {
      return {
        valid: false,
        error: `INVALID_CHUNK_METADATA_ITEM_${i}`,
      };
    }

    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) {
      return {
        valid: false,
        error: `INVALID_CHUNK_INDEX_${i}`,
      };
    }

    if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0) {
      return {
        valid: false,
        error: `INVALID_CHUNK_SIZE_${i}`,
      };
    }

    totalSize += chunk.size;
  }

  return { valid: true, count: chunks.length, totalSize };
}

/* ================= LIFECYCLE VALIDATION ================= */

async function validateLifecycleBinding(
  env: PreparedEnv,
  creatorIdentityId: string,
  lifecycleId: string
): Promise<{ ok: boolean; error?: string }> {
  const lifecycleKey = `creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`;
  const lifecycleRaw = await env.CREATOR_CREDITS.get(lifecycleKey);

  if (!lifecycleRaw) {
    return { ok: false, error: "LIFECYCLE_NOT_RESERVED" };
  }

  let creditRecord: { id?: string; status?: string; creatorIdentityId?: string } | null = null;
  try {
    creditRecord = JSON.parse(lifecycleRaw) as typeof creditRecord;
  } catch {
    return { ok: false, error: "CREDIT_STORAGE_CORRUPTED" };
  }

  if (
    typeof creditRecord?.creatorIdentityId === "string" &&
    creditRecord.creatorIdentityId.trim() !== creatorIdentityId.trim()
  ) {
    return { ok: false, error: "CREATOR_IDENTITY_MISMATCH" };
  }

  return { ok: true };
}

/* ================= ENDPOINT ================= */

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, PreparedEnv>
): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";

  if (!isAllowedOrigin(origin)) {
    return fail(origin, 403, "INVALID_ORIGIN");
  }

  const ip = getClientIp(request);
  if (!rateLimit(ip)) {
    return fail(origin, 429, "TOO_MANY_REQUESTS");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }

  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  /* ================= PARSE FIELDS ================= */

  const creatorIdentityId =
    typeof body.creatorIdentityId === "string" ? body.creatorIdentityId.trim() : "";

  const lifecycleId =
    typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";

  const capsuleId =
    typeof body.capsuleId === "string" ? body.capsuleId.trim() : "";

  const encryptedSizeBytes =
    typeof body.encryptedSizeBytes === "number" ? body.encryptedSizeBytes : Number.NaN;

  const vaultSha256 =
    typeof body.vaultSha256 === "string" ? body.vaultSha256.trim() : "";

  const saltBase =
    typeof body.saltBase === "string" ? body.saltBase.trim() : "";

  const encryptedVaultPointer =
    typeof body.encryptedVaultPointer === "string" ? body.encryptedVaultPointer.trim() : "";

  const chunkMetadata = body.chunkMetadata;

  if (
    !creatorIdentityId ||
    !lifecycleId ||
    !capsuleId ||
    !Number.isSafeInteger(encryptedSizeBytes) ||
    !vaultSha256 ||
    !saltBase ||
    !encryptedVaultPointer ||
    !Array.isArray(chunkMetadata)
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  /* ================= TRUSTED TIME ================= */

  const timeSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof timeSource.nowUtc === "number" ? timeSource.nowUtc : Date.now();

  if (!Number.isSafeInteger(now)) {
    return fail(origin, 500, "INVALID_TIME");
  }

  const expiresAt = now + PROJECTION_TTL_SECONDS * 1000;

  /* ================= FORMAT VALIDATIONS ================= */

  if (!CAPSULE_ID_REGEX.test(capsuleId)) {
    return fail(origin, 400, "INVALID_CAPSULE_ID");
  }

  if (!SALT_BASE_REGEX.test(saltBase)) {
    return fail(origin, 400, "INVALID_SALT_BASE");
  }

  if (!SHA256_REGEX.test(vaultSha256)) {
    return fail(origin, 400, "INVALID_VAULT_SHA256");
  }

  if (!STORAGE_POINTER_REGEX.test(encryptedVaultPointer)) {
    return fail(origin, 400, "INVALID_ENCRYPTED_VAULT_POINTER");
  }

  if (
    !Number.isSafeInteger(encryptedSizeBytes) ||
    encryptedSizeBytes < MIN_ENCRYPTED_SIZE ||
    encryptedSizeBytes > MAX_ENCRYPTED_SIZE
  ) {
    return fail(origin, 400, "INVALID_ENCRYPTED_SIZE");
  }

  const chunkValidation = validateChunkMetadata(chunkMetadata);
  if (!chunkValidation.valid) {
    return fail(origin, 400, chunkValidation.error);
  }

  if (chunkValidation.totalSize !== encryptedSizeBytes) {
    return fail(origin, 400, "CHUNK_SIZE_MISMATCH");
  }

  /* ================= LIFECYCLE BINDING ================= */

  const lifecycleResult = await validateLifecycleBinding(env, creatorIdentityId, lifecycleId);
  if (!lifecycleResult.ok) {
    return fail(origin, 403, lifecycleResult.error ?? "LIFECYCLE_INVALID");
  }

  /* ================= DUPLICATE PROJECTION ================= */

  const existing = await getPreparedProjection(env, capsuleId);

  if (existing) {
    if (existing.state === "ACTIVE" && existing.expiresAt > now) {
      return fail(origin, 409, "PREPARED_PROJECTION_EXISTS");
    }

    if (existing.state === "CONSUMED") {
      return fail(origin, 409, "PREPARED_PROJECTION_CONSUMED");
    }
  }

  /* ================= CREATE PROJECTION ================= */

  const preparedProjectionId = `prep-${crypto.randomUUID()}`;

  const projection: PreparedProjection = {
    preparedProjectionId,
    creatorIdentityId,
    lifecycleId,
    capsuleId,
    encryptedSizeBytes,
    vaultSha256,
    saltBase,
    encryptedVaultPointer,
    chunkCount: chunkValidation.count,
    totalChunkSizeBytes: chunkValidation.totalSize,
    createdAt: now,
    expiresAt,
    state: "ACTIVE",
  };

  await putPreparedProjection(env, {
    ...projection,
    expiresAt,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      preparedProjection: {
        ...projection,
        expiresAt,
      },
    }),
    {
      status: 200,
      headers: baseHeaders(origin),
    }
  );
}
