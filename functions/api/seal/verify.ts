/**
 * AETERNA — Authoritative Seal Verification Boundary
 *
 * POST /api/seal/verify
 *
 * This endpoint records server-authoritative Seal verification.
 * It consumes existing authoritative publication verification and
 * manifest authority, but does not itself consume Credit.
 *
 * Frontend claims are never sufficient for Seal verification.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { sha256 } from "../../lib/sha256";

/* ================= ENV ================= */

interface SealVerifyEnv {
  CAPSULE_MANIFESTS: {
    get(key: string): Promise<string | null>;
  };
  PUBLICATION_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
  };
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
  SEAL_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
  DEBUG?: "true" | "false";
}

/* ================= ORIGINS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && PAGES_PREVIEW_REGEX.test(url.hostname)) return true;
  } catch {
    // ignore
  }
  return false;
}

/* ================= HELPERS ================= */

function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: baseHeaders(origin) });
}

type SealState = "NOT_VERIFIED" | "PENDING" | "VERIFIED";

interface SealVerificationRecord {
  lifecycleId: string;
  capsuleId: string;
  creatorIdentityId: string;
  manifestHash: string;
  state: SealState;
  verifiedAt?: number;
  createdAt: number;
  updatedAt: number;
}

function sealKey(lifecycleId: string): string {
  return `creator:seal:${lifecycleId}`;
}

async function computeManifestHash(manifest: unknown): Promise<string> {
  const text = JSON.stringify(manifest);
  const digest = await sha256(new TextEncoder().encode(text));
  return `manifest:${digest}`;
}

/* ================= ENDPOINT ================= */

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, SealVerifyEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, SealVerifyEnv>): Promise<Response> {
  const { request, env } = context;
  const origin = request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return fail(origin, 403, "INVALID_ORIGIN");

  const ip = getClientIp(request);
  if (!rateLimit(ip)) return fail(origin, 429, "TOO_MANY_REQUESTS");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const creatorIdentityId = typeof body.creatorIdentityId === "string" ? body.creatorIdentityId.trim() : "";
  const lifecycleId = typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";
  const capsuleId = typeof body.capsuleId === "string" ? body.capsuleId.trim() : "";
  const manifest = body.manifest;

  if (!creatorIdentityId || !lifecycleId || !capsuleId || !manifest || typeof manifest !== "object") {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  const creditRaw = await env.CREATOR_CREDITS.get(`creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`);
  if (!creditRaw) {
    return fail(origin, 409, "LIFECYCLE_NOT_RESERVED");
  }
  const credit = JSON.parse(creditRaw) as { id: string; status: string; creatorIdentityId: string };
  if (credit.status !== "CONSUMING") {
    return fail(origin, 409, "CREDIT_NOT_CONSUMING");
  }
  if (credit.creatorIdentityId !== creatorIdentityId) {
    return fail(origin, 409, "IDENTITY_MISMATCH");
  }

  const publicationRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${lifecycleId}`);
  if (!publicationRaw) {
    return fail(origin, 409, "PUBLICATION_NOT_VERIFIED");
  }
  const publication = JSON.parse(publicationRaw) as { lifecycleId: string; capsuleId: string; state: string };
  if (publication.state !== "VERIFIED") {
    return fail(origin, 409, "PUBLICATION_NOT_VERIFIED");
  }
  if (publication.capsuleId !== capsuleId || publication.lifecycleId !== lifecycleId) {
    return fail(origin, 409, "PUBLICATION_BINDING_MISMATCH");
  }

  const storedManifest = await env.CAPSULE_MANIFESTS.get(capsuleId);
  if (!storedManifest) {
    return fail(origin, 409, "MANIFEST_NOT_FOUND");
  }
  const storedManifestObj = JSON.parse(storedManifest);
  const storedHash = await computeManifestHash(storedManifestObj);
  const submittedHash = await computeManifestHash(manifest);
  if (storedHash !== submittedHash) {
    return fail(origin, 409, "MANIFEST_MISMATCH");
  }

  const key = sealKey(lifecycleId);
  const existingRaw = await env.SEAL_VERIFICATIONS.get(key);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as SealVerificationRecord;
    return new Response(
      JSON.stringify({
        ok: true,
        state: existing.state,
        lifecycleId,
        capsuleId,
        creatorIdentityId,
        verifiedAt: existing.verifiedAt,
      }),
      { status: 200, headers: baseHeaders(origin) }
    );
  }

  const now = Date.now();
  const manifestHash = await computeManifestHash(manifest);
  const record: SealVerificationRecord = {
    lifecycleId,
    capsuleId,
    creatorIdentityId,
    manifestHash,
    state: "VERIFIED",
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await env.SEAL_VERIFICATIONS.put(key, JSON.stringify(record));

  return new Response(
    JSON.stringify({
      ok: true,
      state: "VERIFIED",
      lifecycleId,
      capsuleId,
      creatorIdentityId,
      verifiedAt: now,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
