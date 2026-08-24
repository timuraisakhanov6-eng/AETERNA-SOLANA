/**
 * AETERNA — Reserve Creator Credit Lifecycle
 *
 * POST /api/creator/reserve-lifecycle
 *
 * Canonical order:
 *   entitlement already exists
 *   -> actual capsule creation begins
 *   -> real capsuleId appears
 *   -> reserve-lifecycle binds that lifecycle
 *
 * This endpoint MUST NOT use capsuleId to identify pre-capsule payment.
 * Entitlement is already created by /api/creator/grant-credit.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import {
  CAPSULE_ID_REGEX,
} from "../../../src/lib/crypto/validators";

interface ReserveLifecycleEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
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
    "X-Aeterna-Reserve-Lifecycle-Version": "v1",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: baseHeaders(origin) });
}

function creditIndexKey(creatorIdentityId: string, quoteId: string): string {
  return `creator:credit:index:${creatorIdentityId}:${quoteId}`;
}

function quoteKey(paymentIntentId: string): string {
  return `quote:${paymentIntentId}`;
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
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const creatorIdentityId = typeof body.creatorIdentityId === "string" ? body.creatorIdentityId.trim() : "";
  const creatorCreditId = typeof body.creatorCreditId === "string" ? body.creatorCreditId.trim() : "";
  const capsuleId = typeof body.capsuleId === "string" ? body.capsuleId.trim() : "";
  const lifecycleId = typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";
  const paymentIntentId = typeof body.paymentIntentId === "string" ? body.paymentIntentId.trim() : "";

  if (
    typeof creatorIdentityId !== "string" ||
    typeof creatorCreditId !== "string" ||
    typeof capsuleId !== "string" ||
    typeof lifecycleId !== "string"
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  if (!CAPSULE_ID_REGEX.test(capsuleId)) {
    return fail(origin, 400, "INVALID_CAPSULE_ID");
  }

  if (!creatorCreditId) {
    return fail(origin, 400, "CREATOR_CREDIT_ID_REQUIRED");
  }

  if (!lifecycleId) {
    return fail(origin, 400, "LIFECYCLE_ID_REQUIRED");
  }

  const bindings = env;

  const creditRaw = await bindings.CREATOR_CREDITS.get(`creator:credit:${creatorCreditId}`);
  if (!creditRaw) {
    return fail(origin, 402, "CREATOR_CREDIT_NOT_FOUND");
  }

  let creditRecord: {
    id: string;
    creatorIdentityId: string;
    status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
    quoteId: string;
    createdAt: number;
    updatedAt: number;
    lifecycleId?: string;
  };

  try {
    creditRecord = JSON.parse(creditRaw) as {
      id: string;
      creatorIdentityId: string;
      status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
      quoteId: string;
      createdAt: number;
      updatedAt: number;
      lifecycleId?: string;
    };
  } catch {
    return fail(origin, 500, "CREATOR_CREDIT_CORRUPT");
  }

  if (creditRecord.id !== creatorCreditId) {
    return fail(origin, 403, "CREATOR_CREDIT_MISMATCH");
  }

  if (creditRecord.creatorIdentityId !== creatorIdentityId) {
    return fail(origin, 403, "CREATOR_MISMATCH");
  }

  if (creditRecord.status === "CONSUMED") {
    return fail(origin, 409, "CREATOR_CREDIT_ALREADY_CONSUMED");
  }

  const lifecycleRaw = await bindings.CREATOR_CREDITS.get(`creator:credit:lifecycle:${creatorIdentityId}:${lifecycleId}`);
  if (!lifecycleRaw || lifecycleRaw !== creatorCreditId) {
    return fail(origin, 409, "LIFECYCLE_MISMATCH");
  }

  if (creditRecord.status === "CONSUMING") {
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
