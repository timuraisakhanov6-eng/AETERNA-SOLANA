/**
 * AETHERNA — Reserve Creator Credit Lifecycle
 *
 * POST /api/creator/reserve-lifecycle
 *
 * Delegates authoritative reservation to the CreditOperationCoordinator.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { CAPSULE_ID_REGEX } from "../../../src/lib/crypto/validators";

interface ReserveLifecycleEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
  };
  BUSINESS_QUOTES: {
    get(key: string): Promise<string | null>;
  };
  CREDIT_OP_COORDINATOR: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): DurableObjectStub;
  };
}

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

function parseLifecycleId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function creditIndexKey(creatorIdentityId: string, quoteId: string): string {
  return `creator:credit:index:${creatorIdentityId}:${quoteId}`;
}

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, ReserveLifecycleEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, ReserveLifecycleEnv>): Promise<Response> {
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

  const creatorIdentityId = body.creatorIdentityId;
  const capsuleId = body.capsuleId;
  const lifecycleId = parseLifecycleId(body.lifecycleId);

  if (typeof creatorIdentityId !== "string" || typeof capsuleId !== "string" || !CAPSULE_ID_REGEX.test(capsuleId)) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  const bindings = env;

  const quoteRaw = await bindings.BUSINESS_QUOTES.get(capsuleId);
  if (!quoteRaw) {
    return fail(origin, 402, "BUSINESS_QUOTE_NOT_FOUND");
  }

  if (!lifecycleId) {
    return fail(origin, 400, "LIFECYCLE_ID_REQUIRED");
  }

  const creditIndexRaw = await bindings.CREATOR_CREDITS.get(creditIndexKey(creatorIdentityId, capsuleId));
  if (!creditIndexRaw) {
    return fail(origin, 402, "CREATOR_CREDIT_NOT_FOUND");
  }
  const creatorCreditId = creditIndexRaw.trim();

  const coordinatorId = bindings.CREDIT_OP_COORDINATOR.idFromName(creatorCreditId);
  const coordinator = bindings.CREDIT_OP_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(
    new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "reserve",
        creatorCreditId,
        creatorIdentityId,
        lifecycleId,
        capsuleId,
      }),
    })
  );

  return response;
}
