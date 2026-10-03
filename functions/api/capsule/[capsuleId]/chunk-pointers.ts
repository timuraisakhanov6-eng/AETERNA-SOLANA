/**
 * AETERNA — GET /api/capsule/:capsuleId/chunk-pointers
 *
 * Canonical Container V1 publication readout (Storage Authority).
 *
 * Runtime resolves the capsule's media publication EXCLUSIVELY through
 * this endpoint. The response is sourced ONLY from the container
 * publication record (independent Storage Authority state);
 * manifest.ext.chunkPointers is NEVER consulted and is not a source of
 * truth here.
 *
 * The legacy per-chunk pointer registry NO LONGER EXISTS: Container V1
 * is the only media model, so this endpoint answers with the ONE
 * container publication record (or `container: null` when the capsule
 * has not been published yet).
 *
 * This endpoint is strictly read-only: it never writes, deletes, or
 * modifies publication state.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { CAPSULE_ID_REGEX } from "../../../../src/lib/crypto/validators";
import { assertCapsuleId } from "../../../../src/types/manifest";
import {
  getContainerPublication,
  type ContainerPublicationKV,
} from "../../../../src/lib/storage/container/containerPublication";

/**
 * Read-path bindings: the container publication namespace only.
 */
type ChunkPointerReadEnv = ContainerPublicationKV;

/* ================= ORIGINS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
];

/* ================= HEADERS ================= */

/**
 * Canonical GET response headers.
 *
 * Mirrors functions/api/capsule/[capsuleId].ts: the Origin is echoed
 * back only when it is in ALLOWED_ORIGINS; otherwise the CORS headers
 * are omitted entirely (never the literal "null").
 *
 * Cache-Control is no-store: the publication record is written during
 * the capsule creation window, so a long-lived immutable cache could
 * serve a stale read. Reads must observe the current persisted state.
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
  context: EventContext<ChunkPointerReadEnv, unknown, unknown>
): Promise<Response> => {
  const origin = context.request.headers.get("origin") ?? "";
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
};

/* ================= GET ================= */

export const onRequestGet = async (
  context: EventContext<ChunkPointerReadEnv, unknown, unknown>
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
   * Container publication binding required.
   */
  if (!env?.PUBLICATION_VERIFICATIONS) {
    return fail(503, "STORAGE_UNAVAILABLE", origin);
  }

  // Branded capsuleId refinement for the container store API.
  assertCapsuleId(capsuleId);

  let container;

  try {
    container = await getContainerPublication(env, capsuleId);
  } catch {
    // Fail closed. KV unavailable or malformed — internal details are
    // never exposed. An ABSENT record is NOT an error: it returns null.
    return fail(503, "STORAGE_ERROR", origin);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      capsuleId,
      container: container ?? null,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
};
