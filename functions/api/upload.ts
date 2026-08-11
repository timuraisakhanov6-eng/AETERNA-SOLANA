/**
 * AETERNA — POST /api/upload
 *
 * Canonical Upload Law implementation per:
 *   AETERNA_EXECUTOR_PUBLICATION_SPEC_v1, Section 4 (Upload Law)
 *
 * This endpoint is Publication Authority's HTTP boundary. It performs
 * checks 1–10 (fail-closed, in order) before ever touching Executor
 * Hot, then funds/signs/uploads/confirms (11–13), then returns only
 * the Storage Pointer (14).
 *
 * This endpoint MUST NOT:
 *   - return decryption material of any kind
 *   - create or touch the Manifest
 *   - accept a request without a valid, unexpired, unused Upload Token
 *   - fund or sign anything before all checks 1–10 pass
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../lib/rateLimit";
import { getTrustedTime } from "./time";
import {
  CAPSULE_ID_REGEX,
  SHA256_REGEX,
} from "../../src/lib/crypto/validators";
import {
  MAX_ENCRYPTED_VAULT_SIZE,
  MAX_ENCRYPTED_CHUNK_SIZE,
} from "../../src/lib/crypto/constants";
import {
  publishCiphertext,
  ExecutorUnavailableError,
  type ExecutorEnv,
} from "../lib/executorHot";
import {
  getChunkPointerMap,
  putChunkPointerEntries,
  type ChunkPointerRegistryKVNamespace,
} from "../lib/storage/chunkPointerRegistryStore";
import { assertStoragePointer } from "../../src/lib/storage/storageAdapter";
import { assertCapsuleId } from "../../src/types/manifest";

/* ================= ENV ================= */

interface UploadEnv extends ExecutorEnv {
  VERIFIED_PAYMENTS: {
    get(key: string): Promise<string | null>;
  };
  CHUNK_POINTER_REGISTRY: ChunkPointerRegistryKVNamespace;
}

/* ================= ORIGINS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/* ================= SCHEMA WHITELIST (Section 2 + Section 4.4) ================= */

// Only ciphertext, uploadToken, capsuleId, chunkId, declared size,
// kind, and vaultSha256 (for verification, not derivation) may ever
// appear in the request body. Nothing resembling recipientSecret,
// creatorAuthority, saltBase, a vault key, plaintext, or a
// password/passphrase is a recognized field — see the Ciphertext
// Authority Law restated in Section 2 of the Freeze spec.
const ALLOWED_BODY_FIELDS = [
  "capsuleId",
  "uploadToken",
  "kind",
  "chunkId",
  "ciphertext",
  "declaredSize",
  "vaultSha256",
];

// The client-side storage.upload() interface (StorageAdapter) is
// intentionally left unchanged by this migration — per Switching Law
// (Section 8, condition 3), it still only carries `data` and
// `uploadToken`. capsuleId and kind are therefore OPTIONAL request
// fields: when present they are validated against the token's own
// bound capsuleId/permissions as an extra consistency check; when
// absent, this endpoint derives capsuleId from the Upload Token
// record itself (the token already scopes exactly one capsuleId —
// see upload-token.ts) and treats the object generically as anything
// the token is permitted to upload.
//
// Step 1C: the chunk upload path (StorageAdapter.uploadChunk) now
// additionally carries the canonical `chunkId` in the request body.
// It remains an OPTIONAL field here so the unchanged Vault upload
// path (storage.upload, no chunkId) keeps working; when present it
// is validated for shape only — the server never derives or
// generates a chunkId from ciphertext.

const UPLOAD_TOKEN_REGEX = /^[a-zA-Z0-9_-]{32,256}$/;

const MIN_TIME = 1_577_836_800_000; // 2020-01-01 UTC
const MAX_TIME = 4_102_444_800_000; // 2100-01-01 UTC

/* ================= HELPERS ================= */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, no-transform",
    "CDN-Cache-Control": "no-store",
    "Surrogate-Control": "no-store",
    Pragma: "no-cache",
    Expires: "0",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Aeterna-Upload-Version": "v1",
    "X-Aeterna-Publication-Authority": "executor-hot",
  };
}

function fail(origin: string, status: number, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: baseHeaders(origin),
  });
}

/**
 * Decodes a base64 ciphertext payload into raw bytes without ever
 * treating the decoded content as anything other than opaque bytes.
 * Returns null on malformed base64 rather than throwing, so callers
 * can fail closed uniformly.
 */
function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/* ================= OPTIONS ================= */

export const onRequestOptions = async (
  context: EventContext<any, any, any>
): Promise<Response> => {
  const origin = context.request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
};

/* ================= POST ================= */

export const onRequestPost = async (
  context: EventContext<UploadEnv, any, any>
): Promise<Response> => {
  const { request, env } = context;

  const origin = request.headers.get("origin") ?? "";

  /* 1. Origin check */
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ ok: false }), { status: 403 });
  }

  /* 2. Content-Type check */
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  /* 3. Rate limit, per client IP */
  const ip = getClientIp(request);
  if (!rateLimit(ip)) {
    return fail(origin, 429, "TOO_MANY_REQUESTS");
  }

  if (!env?.UPLOAD_TOKENS || !env?.VERIFIED_PAYMENTS) {
    return fail(origin, 503, "STORAGE_UNAVAILABLE");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }

  if (!isPlainObject(body)) {
    return fail(origin, 400, "INVALID_BODY");
  }

  /* 4. Body schema whitelist */
  if (!Object.keys(body).every((k) => ALLOWED_BODY_FIELDS.includes(k))) {
    return fail(origin, 400, "UNRECOGNIZED_FIELD");
  }

  const { capsuleId, uploadToken, kind, chunkId, ciphertext, declaredSize, vaultSha256 } =
    body as Record<string, unknown>;

  // capsuleId is optional — see note above ALLOWED_BODY_FIELDS.
  if (capsuleId !== undefined) {
    if (typeof capsuleId !== "string" || !CAPSULE_ID_REGEX.test(capsuleId)) {
      return fail(origin, 400, "INVALID_CAPSULE_ID");
    }
  }

  if (typeof uploadToken !== "string" || !UPLOAD_TOKEN_REGEX.test(uploadToken)) {
    return fail(origin, 400, "INVALID_UPLOAD_TOKEN");
  }

  // kind is optional — see note above ALLOWED_BODY_FIELDS.
  if (kind !== undefined && kind !== "vault" && kind !== "chunk") {
    return fail(origin, 400, "INVALID_KIND");
  }

  // chunkId is optional — carried only by the chunk upload path
  // (StorageAdapter.uploadChunk). Vault uploads never send it, so it
  // must not be required here. When present, it must be a non-empty
  // string: the server only receives the canonical chunkId (produced
  // client-side as SHA-256 of the chunk ciphertext); it never
  // generates or derives one.
  if (chunkId !== undefined) {
    if (typeof chunkId !== "string" || chunkId.length === 0) {
      return fail(origin, 400, "INVALID_CHUNK_ID");
    }

    // Chunk Pointer Registry availability — required only for the
    // chunk path. Fail closed before any publication cost when the
    // Registry binding is not present (deploying the binding is a
    // separate infra step; the Vault path never needs the Registry).
    if (!env?.CHUNK_POINTER_REGISTRY) {
      return fail(origin, 503, "STORAGE_UNAVAILABLE");
    }
  }

  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    return fail(origin, 400, "INVALID_CIPHERTEXT");
  }

  if (!Number.isSafeInteger(declaredSize) || (declaredSize as number) <= 0) {
    return fail(origin, 400, "INVALID_DECLARED_SIZE");
  }

  // When kind is unknown, enforce the union of both limits (the
  // larger of the two).
  const maxAllowed =
    kind === "vault"
      ? MAX_ENCRYPTED_VAULT_SIZE
      : kind === "chunk"
        ? MAX_ENCRYPTED_CHUNK_SIZE
        : Math.max(MAX_ENCRYPTED_VAULT_SIZE, MAX_ENCRYPTED_CHUNK_SIZE);

  if ((declaredSize as number) > maxAllowed) {
    return fail(origin, 400, "SIZE_LIMIT_EXCEEDED");
  }

  // vaultSha256 is accepted only for verification, never derivation —
  // per Section 2, the server never derives anything from it.
  if (vaultSha256 !== undefined) {
    if (typeof vaultSha256 !== "string" || !SHA256_REGEX.test(vaultSha256)) {
      return fail(origin, 400, "INVALID_VAULT_HASH");
    }
  }

  /* 5. Upload Token validation */
  const storedTokenRaw = await env.UPLOAD_TOKENS.get(uploadToken);
  if (!storedTokenRaw) {
    return fail(origin, 403, "INVALID_UPLOAD_TOKEN");
  }

  type UploadTokenRecord = {
    capsuleId: string;
    transactionId: string;
    issuedAt: number;
    expiresAt: number;
    permissions: { uploadChunks: boolean; uploadVault: boolean };
  };

  let tokenData: UploadTokenRecord;
  try {
    tokenData = JSON.parse(storedTokenRaw) as UploadTokenRecord;
  } catch {
    return fail(origin, 503, "TOKEN_STORAGE_CORRUPTED");
  }

  /* 10. Trusted Time read (used to evaluate token TTL only) */
  let now: number;
  try {
    const { nowUtc } = await getTrustedTime();
    if (!Number.isSafeInteger(nowUtc) || nowUtc < MIN_TIME || nowUtc > MAX_TIME) {
      return fail(origin, 503, "TIME_UNAVAILABLE");
    }
    now = nowUtc;
  } catch {
    return fail(origin, 503, "TIME_UNAVAILABLE");
  }

  if (
    !tokenData ||
    typeof tokenData.expiresAt !== "number" ||
    !Number.isSafeInteger(tokenData.expiresAt) ||
    tokenData.expiresAt <= now
  ) {
    return fail(origin, 403, "UPLOAD_TOKEN_EXPIRED");
  }

  // If the client supplied capsuleId, it must match the token's own
  // binding. If it did not, the token's binding is authoritative.
  if (capsuleId !== undefined && tokenData.capsuleId !== capsuleId) {
    return fail(origin, 403, "UPLOAD_TOKEN_CAPSULE_MISMATCH");
  }

  const resolvedCapsuleId = (capsuleId as string | undefined) ?? tokenData.capsuleId;
  if (!resolvedCapsuleId || !CAPSULE_ID_REGEX.test(resolvedCapsuleId)) {
    return fail(origin, 403, "UPLOAD_TOKEN_CAPSULE_UNRESOLVABLE");
  }

  /* 6. Permission check, matching the object being uploaded. A vault
     upload requires vault-upload permission; a chunk upload requires
     chunk-upload permission. When the client did not disambiguate
     `kind` (unchanged StorageAdapter interface), any one granted
     upload permission on the token authorizes the request. */
  if (kind === "vault" && tokenData.permissions?.uploadVault !== true) {
    return fail(origin, 403, "UPLOAD_TOKEN_PERMISSION_DENIED");
  }
  if (kind === "chunk" && tokenData.permissions?.uploadChunks !== true) {
    return fail(origin, 403, "UPLOAD_TOKEN_PERMISSION_DENIED");
  }
  if (
    kind === undefined &&
    tokenData.permissions?.uploadVault !== true &&
    tokenData.permissions?.uploadChunks !== true
  ) {
    return fail(origin, 403, "UPLOAD_TOKEN_PERMISSION_DENIED");
  }

  /* 7. CapsuleId format validation — already enforced above via
        CAPSULE_ID_REGEX, restated here as an explicit checklist step. */

  /* 8. Consistency check between token and the payment record it was
        issued against. No re-verification of payment itself — the
        token is trusted, not a raw transaction reference. */
  if (!tokenData.transactionId) {
    return fail(origin, 403, "UPLOAD_TOKEN_UNBOUND");
  }

  const paymentRaw = await env.VERIFIED_PAYMENTS.get(tokenData.transactionId);
  if (!paymentRaw) {
    // Payment authority may have already been consumed by a
    // concurrent successful seal — that is not this endpoint's
    // concern. What matters here is only that the token was issued
    // against a real payment binding at some point; the token's own
    // validity (5) and TTL (10) are the operative gates for retries.
    // If the binding record is simply gone, fail closed rather than
    // assume anything about why.
    return fail(origin, 403, "UPLOAD_TOKEN_PAYMENT_UNRESOLVABLE");
  }

  /* 9. Declared size vs actual received size */

  // Transport decoding only.
  //
  // Base64 exists solely because the ciphertext
  // travelled inside JSON.
  //
  // The resulting bytes remain opaque ciphertext.
  // No decryption or cryptographic processing
  // occurs here.
  const bytes = decodeBase64(ciphertext);
  if (!bytes) {
    return fail(origin, 400, "INVALID_CIPHERTEXT_ENCODING");
  }

  if (bytes.byteLength !== declaredSize) {
    return fail(origin, 400, "SIZE_MISMATCH");
  }

  if (bytes.byteLength > maxAllowed) {
    return fail(origin, 400, "SIZE_LIMIT_EXCEEDED");
  }

  // vaultSha256 is accepted only for verification, never derivation
  // (Section 2). If the client supplied it, it must actually match
  // the received ciphertext — accepting it for format only, without
  // checking it against the bytes, would make the field decorative.
  if (vaultSha256 !== undefined) {
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
    const computedHex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (computedHex !== vaultSha256) {
      return fail(origin, 400, "VAULT_HASH_MISMATCH");
    }
  }

  /* 11–13. Fund Executor Hot if required, upload via Executor Hot,
     await independently-confirmed propagation. Nothing above this
     line may fund or sign anything (Section 4, final MUST NOT). */
  try {
    const { storagePointer } = await publishCiphertext(env, bytes, now);

    /* Chunk path — canonical Chunk Pointer Registry persistence
       (Storage Authority). Sequence: obtain StoragePointer →
       assertStoragePointer → Registry Creation → Registry
       Validation → Registry Persistence → success. Registry
       persistence MUST complete before the success response. */
    if (chunkId !== undefined) {
      const pointer = assertStoragePointer(storagePointer);

      // Branded capsuleId refinement for the Registry store API.
      assertCapsuleId(resolvedCapsuleId);

      const existing = await getChunkPointerMap(env, resolvedCapsuleId);
      if (existing[chunkId] !== undefined) {
        // Duplicate chunkId — fail closed. Never silently overwrite
        // an existing immutable pointer mapping.
        return fail(origin, 409, "DUPLICATE_CHUNK_ID");
      }

      await putChunkPointerEntries(env, resolvedCapsuleId, {
        [chunkId]: pointer,
      });
    }

    /* 14. Return only { ok: true, storagePointer } */
    return new Response(JSON.stringify({ ok: true, storagePointer }), {
      status: 200,
      headers: baseHeaders(origin),
    });
  } catch (error) {
    if (error instanceof ExecutorUnavailableError) {
      // Failure Law: no partial upload, token remains valid and
      // unused, client may safely retry with the same token.
      return fail(origin, 503, "EXECUTOR_TEMPORARILY_UNAVAILABLE");
    }

    if (env.DEBUG === "true") {
      console.error(
        "[AETERNA][upload] publication failed",
        error instanceof Error ? error.stack : String(error)
      );
    }

    // Any other publication failure (funding, upload, or propagation)
    // is also fail-closed and retryable: the Manifest is never
    // touched by this endpoint, and the token is never marked used
    // here at all — consumption happens exclusively at seal.ts, per
    // Section 7 (Failure Law / token consumption semantics).
    return fail(origin, 502, "PUBLICATION_FAILED");
  } finally {
    bytes.fill(0);
  }
};