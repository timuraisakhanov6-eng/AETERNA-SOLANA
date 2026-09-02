/**
 * AETERNA — Authoritative Finalization Boundary
 *
 * Conceptual contract:
 *   CONSUMING + publication VERIFIED + Seal VERIFIED + correct binding
 *   -> CONSUMED
 *
 * This endpoint delegates the Credit state decision to the
 * CreditOperationCoordinator.
 *
 * Frontend state is never sufficient.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";

/* ================= ENV ================= */

interface FinalizeEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
  };
  PUBLICATION_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
  };
  SEAL_VERIFICATIONS: {
    get(key: string): Promise<string | null>;
  };
  CREDIT_OP_COORDINATOR: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): DurableObjectStub;
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

/* ================= ENDPOINT ================= */

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, FinalizeEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, FinalizeEnv>): Promise<Response> {
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

  if (!creatorIdentityId || !lifecycleId || !capsuleId) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  const bindings = env as {
    CREATOR_CREDITS: { get(key: string): Promise<string | null> };
    PUBLICATION_VERIFICATIONS: { get(key: string): Promise<string | null> };
    SEAL_VERIFICATIONS: { get(key: string): Promise<string | null> };
    CREDIT_OP_COORDINATOR: {
      idFromName(name: string): { id: string };
      get(binding: { id: string }): DurableObjectStub;
    };
  };

  const lifecycleRaw = await bindings.CREATOR_CREDITS.get(`creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`);
  if (!lifecycleRaw) {
    return fail(origin, 409, "LIFECYCLE_NOT_FOUND");
  }
  const lifecycle = JSON.parse(lifecycleRaw) as { id: string };

  const publicationRaw = await bindings.PUBLICATION_VERIFICATIONS.get(`creator:publication:${lifecycleId}`);
  const publication = publicationRaw ? (JSON.parse(publicationRaw) as { state: string }) : { state: "NOT_VERIFIED" };
  const sealRaw = await bindings.SEAL_VERIFICATIONS.get(`creator:seal:${lifecycleId}`);
  const seal = sealRaw ? (JSON.parse(sealRaw) as { state: string }) : { state: "NOT_VERIFIED" };

  const coordinatorId = bindings.CREDIT_OP_COORDINATOR.idFromName(lifecycle.id);
  const coordinator = bindings.CREDIT_OP_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(
    new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "finalize",
        creatorCreditId: lifecycle.id,
        creatorIdentityId,
        lifecycleId,
        capsuleId,
        publicationVerified: publication.state === "VERIFIED",
        sealVerified: seal.state === "VERIFIED",
      }),
    })
  );

  return response;
}
