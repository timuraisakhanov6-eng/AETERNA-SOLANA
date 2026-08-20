/**
 * AETERNA — Authoritative Publication Verification Boundary
 *
 * POST /api/publication/verify
 *
 * This endpoint records server-authoritative publication verification.
 * Client-supplied publication identifiers are evidence only.
 * The server MUST independently verify publication facts through a
 * trusted verifier/provider before returning VERIFIED.
 *
 * If provider verification cannot be established, the endpoint MUST
 * fail closed and return NOT_VERIFIED/REJECTED.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";

/* ================= ENV ================= */

interface PublicationVerifyEnv {
  CREATOR_CREDITS: unknown;
  PUBLICATION_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
  DEBUG?: "true" | "false";
}

/* ================= ORIGINS ================= */

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-capsule.pages.dev",
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

type PublicationState = "NOT_VERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";

interface PublicationVerificationRecord {
  lifecycleId: string;
  capsuleId: string;
  creatorIdentityId: string;
  state: PublicationState;
  evidenceIds: string[];
  verifiedAt?: number;
  rejectedAt?: number;
  createdAt: number;
  updatedAt: number;
}

function publicationKey(lifecycleId: string): string {
  return `creator:publication:${lifecycleId}`;
}

function parsePublicationInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ================= PUBLICATION VERIFIER INTERFACE ================= */

/**
 * Provider-neutral publication verification boundary.
 *
 * This interface isolates the unresolved Irys/provider decision.
 * Concrete verifier implementation remains PENDING.
 */
interface PublicationVerifier {
  verifyPublication(input: {
    publicationId: string;
    lifecycleId: string;
    capsuleId: string;
    creatorIdentityId: string;
  }): Promise<{
    exists: boolean;
    networkMatch: boolean;
    capsuleMatch: boolean;
    lifecycleMatch: boolean;
    status: "success" | "pending" | "failed" | "unknown";
    finality: boolean;
  }>;
}

/**
 * Minimal fail-closed verifier implementation.
 *
 * Because the exact Irys verification provider is still PENDING,
 * this verifier currently rejects all publication verification
 * requests. When a provider is selected, replace this implementation
 * with a concrete verifier that independently establishes publication
 * facts from authoritative source.
 */
class FailClosedPublicationVerifier implements PublicationVerifier {
  async verifyPublication(): Promise<{
    exists: boolean;
    networkMatch: boolean;
    capsuleMatch: boolean;
    lifecycleMatch: boolean;
    status: "success" | "pending" | "failed" | "unknown";
    finality: boolean;
  }> {
    return {
      exists: false,
      networkMatch: false,
      capsuleMatch: false,
      lifecycleMatch: false,
      status: "unknown",
      finality: false,
    };
  }
}

let publicationVerifier: PublicationVerifier = new FailClosedPublicationVerifier();

export function setPublicationVerifier(verifier: PublicationVerifier): void {
  publicationVerifier = verifier;
}

/* ================= ENDPOINT ================= */

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, PublicationVerifyEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, PublicationVerifyEnv>): Promise<Response> {
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

  const creatorIdentityId = parsePublicationInput(body.creatorIdentityId);
  const lifecycleId = parsePublicationInput(body.lifecycleId);
  const capsuleId = parsePublicationInput(body.capsuleId);
  const publicationId = parsePublicationInput(body.publicationId);
  const txHash = parsePublicationInput(body.txHash);
  const providerRef = parsePublicationInput(body.providerRef);

  if (!creatorIdentityId || !lifecycleId || !capsuleId || !publicationId) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  const evidenceIds = [publicationId];
  if (txHash) evidenceIds.push(txHash);
  if (providerRef) evidenceIds.push(providerRef);

  const key = publicationKey(lifecycleId);
  const existingRaw = await env.PUBLICATION_VERIFICATIONS.get(key);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as PublicationVerificationRecord;
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

  const verifierResult = await publicationVerifier.verifyPublication({
    publicationId,
    lifecycleId,
    capsuleId,
    creatorIdentityId,
  });

  let state: PublicationState = "REJECTED";
  if (
    verifierResult.exists &&
    verifierResult.networkMatch &&
    verifierResult.capsuleMatch &&
    verifierResult.lifecycleMatch &&
    verifierResult.status === "success" &&
    verifierResult.finality
  ) {
    state = "VERIFIED";
  }

  const now = Date.now();
  const record: PublicationVerificationRecord = {
    lifecycleId,
    capsuleId,
    creatorIdentityId,
    state,
    evidenceIds,
    verifiedAt: state === "VERIFIED" ? now : undefined,
    rejectedAt: state === "REJECTED" ? now : undefined,
    createdAt: now,
    updatedAt: now,
  };

  await env.PUBLICATION_VERIFICATIONS.put(key, JSON.stringify(record));

  return new Response(
    JSON.stringify({
      ok: true,
      state,
      lifecycleId,
      capsuleId,
      creatorIdentityId,
      verifiedAt: record.verifiedAt,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
