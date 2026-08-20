/**
 * AETERNA — GET /api/capsule/:capsuleId/chunk-pointers
 *
 * Canonical Chunk Pointer Registry read path (Storage Authority).
 *
 * Runtime resolves chunkId → StoragePointer exclusively through this
 * endpoint. The response is sourced ONLY from the Chunk Pointer
 * Registry (independent Storage Authority state); manifest.ext.chunkPointers
 * is NEVER consulted and is not a source of truth here.
 *
 * This endpoint is strictly read-only: it never writes, deletes, or
 * modifies Registry state.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { CAPSULE_ID_REGEX } from "../../../../src/lib/crypto/validators";
import { assertCapsuleId } from "../../../../src/types/manifest";
import { assertChunkPointerMap } from "../../../../src/lib/storage/storageAdapter";
import {
  getChunkPointerMap,
  type ChunkPointerRegistryKV,
  type ChunkPointerMap,
} from "../../../lib/storage/chunkPointerRegistryStore";

/* ================= ORIGINS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
];

/* ================= HEADERS ================= */

/**
 * Canonical GET response headers.
 *
 * Mirrors functions/api/capsule/[capsuleId].ts: the Origin is echoed
 * back only when it is in ALLOWED_ORIGINS; otherwise the CORS headers
 * are omitted entirely (never the literal "null").
 *
 * Cache-Control is no-store: the Registry is append-only during the
 * capsule creation window, so a long-lived immutable cache could serve
 * a partial map. Reads must observe the current persisted Registry.
 */
function baseHeaders(origin?: string): Record<string, string> {
  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : undefined;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
    headers["Timing-Allow-Origin"] = allowed;
  }

  return headers;
}

/* ================= ERROR ================= */

/**
 * Canonical failure response — never leaks internal KV/storage details.
 */
function fail(
  status = 400,
  message = "error",
  origin?: string
): Response {
  return new Response(
    JSON.stringify({ ok: false, error: message }),
    { status, headers: baseHeaders(origin) }
  );
}

/* ================= OPTIONS ================= */

export const onRequestOptions = async (
  context: EventContext<ChunkPointerRegistryKV, unknown, unknown>
): Promise<Response> => {
  const origin = context.request.headers.get("origin") ?? "";
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
};

/* ================= GET ================= */

export const onRequestGet = async (
  context: EventContext<ChunkPointerRegistryKV, unknown, unknown>
): Promise<Response> => {
  const { request, env, params } = context;

  const origin = request.headers.get("origin") ?? "";

  const capsuleId = params?.capsuleId;

  /**
   * capsuleId validation — canonical fail-closed pattern.
   */
  if (
    !capsuleId ||
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    return fail(400, "INVALID_CAPSULE_ID", origin);
  }

  /**
   * Chunk Pointer Registry binding required.
   */
  if (!env?.CHUNK_POINTER_REGISTRY) {
    return fail(503, "STORAGE_UNAVAILABLE", origin);
  }

  // Branded capsuleId refinement for the Registry store API. The
  // Registry model is already scoped per capsuleId (KV key
  // "chunk-pointer-registry:<capsuleId>") — no new key scheme.
  assertCapsuleId(capsuleId);

  let map: ChunkPointerMap;

  try {
    map = await getChunkPointerMap(env, capsuleId);
  } catch {
    // Fail closed. Registry unavailable or malformed — internal KV
    // details are never exposed. Absent Registry data (no raw entry)
    // is NOT an error: getChunkPointerMap returns an empty map, and a
    // text-only capsule legitimately has an empty Registry.
    return fail(503, "STORAGE_ERROR", origin);
  }

  let chunkPointers: ChunkPointerMap;

  try {
    // Canonical Registry integrity validation — every pointer MUST
    // satisfy StoragePointer validation before reaching Runtime.
    chunkPointers = assertChunkPointerMap(map);
  } catch {
    return fail(500, "REGISTRY_INVALID", origin);
  }

  /**
   * Success — existing client contract:
   * { ok, capsuleId, chunkPointers }
   */
  return new Response(
    JSON.stringify({
      ok: true,
      capsuleId,
      chunkPointers,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
};
