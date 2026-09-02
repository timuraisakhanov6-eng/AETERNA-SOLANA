/**
 * AETERNA — Authoritative Publication Verification Boundary
 *
 * POST /api/publication/verify
 *
 * This endpoint records server-authoritative publication verification.
 * Client-supplied publication identifiers are evidence only.
 * The server MUST independently verify publication facts through
 * trusted gateways before returning VERIFIED.
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

type PublicationState = "NOT_VERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";

interface PublicationVerificationRecord {
  lifecycleId: string;
  capsuleId: string;
  creatorIdentityId: string;
  state: PublicationState;
  expectedTxId: string;
  expectedVaultSha256: string | null;
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

/* ================= GATEWAY FETCH ================= */

const GATEWAYS = [
  "https://gateway.irys.xyz/",
  "https://arweave.net/",
  "https://permaweb.eu/",
  "https://arweave.live/",
];

async function fetchPublishedCiphertext(txId: string): Promise<Uint8Array> {
  let lastStatus = 0;
  for (const gateway of GATEWAYS) {
    const url = gateway.endsWith("/") ? `${gateway}${txId}` : `${gateway}/${txId}`;
    let res: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      res = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);
    } catch {
      continue;
    }

    lastStatus = res.status;

    if (res.status === 404) {
      return new Uint8Array(0);
    }

    if (res.status !== 200) {
      continue;
    }

    const length = Number(res.headers.get("content-length") ?? "0");
    if (!Number.isFinite(length) || length <= 0) {
      return new Uint8Array(0);
    }

    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  }

  throw new Error(`gateway-fetch-failed: lastStatus=${lastStatus}; txId=${txId}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  const clientPublicationId = parsePublicationInput(body.publicationId);

  if (!creatorIdentityId || !lifecycleId || !capsuleId) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  const key = publicationKey(lifecycleId);
  const existingRaw = await env.PUBLICATION_VERIFICATIONS.get(key);

  let record: PublicationVerificationRecord | null = null;
  if (existingRaw) {
    try {
      record = JSON.parse(existingRaw) as PublicationVerificationRecord;
    } catch {
      record = null;
    }
  }

  if (record && (record.state === "VERIFIED" || record.state === "REJECTED")) {
    return new Response(
      JSON.stringify({
        ok: true,
        state: record.state,
        lifecycleId,
        capsuleId,
        creatorIdentityId,
        verifiedAt: record.verifiedAt,
        rejectedAt: record.rejectedAt,
        expectedTxId: record.expectedTxId,
        expectedVaultSha256: record.expectedVaultSha256,
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

  let authoritativeTxId = "";
  if (record && typeof record.expectedTxId === "string" && record.expectedTxId.trim().length > 0) {
    authoritativeTxId = record.expectedTxId.trim();
  } else {
    return fail(origin, 409, "PUBLICATION_NOT_CLAIMED");
  }

  if (clientPublicationId && clientPublicationId !== authoritativeTxId) {
    return fail(origin, 409, "PUBLICATION_ID_MISMATCH");
  }

  let fetchedBytes: Uint8Array;
  try {
    fetchedBytes = await fetchPublishedCiphertext(authoritativeTxId);
  } catch (error) {
    const now = Date.now();
    const updated: PublicationVerificationRecord = {
      lifecycleId,
      capsuleId,
      creatorIdentityId,
      state: "PENDING",
      expectedTxId: authoritativeTxId,
      expectedVaultSha256: record?.expectedVaultSha256 ?? null,
      evidenceIds: record?.evidenceIds ?? [authoritativeTxId],
      createdAt: record?.createdAt ?? now,
      updatedAt: now,
    };
    await env.PUBLICATION_VERIFICATIONS.put(key, JSON.stringify(updated));
    return fail(origin, 502, "PUBLICATION_FETCH_FAILED");
  }

  if (fetchedBytes.byteLength === 0) {
    const now = Date.now();
    const rejected: PublicationVerificationRecord = {
      lifecycleId,
      capsuleId,
      creatorIdentityId,
      state: "REJECTED",
      expectedTxId: authoritativeTxId,
      expectedVaultSha256: null,
      evidenceIds: record?.evidenceIds ?? [authoritativeTxId],
      createdAt: record?.createdAt ?? now,
      updatedAt: now,
      rejectedAt: now,
    };
    await env.PUBLICATION_VERIFICATIONS.put(key, JSON.stringify(rejected));
    return fail(origin, 409, "PUBLICATION_EMPTY");
  }

  let computedHash: string;
  try {
    computedHash = await sha256Hex(fetchedBytes);
  } catch {
    const now = Date.now();
    const updated: PublicationVerificationRecord = {
      lifecycleId,
      capsuleId,
      creatorIdentityId,
      state: "PENDING",
      expectedTxId: authoritativeTxId,
      expectedVaultSha256: record?.expectedVaultSha256 ?? null,
      evidenceIds: record?.evidenceIds ?? [authoritativeTxId],
      createdAt: record?.createdAt ?? now,
      updatedAt: now,
    };
    await env.PUBLICATION_VERIFICATIONS.put(key, JSON.stringify(updated));
    return fail(origin, 502, "PUBLICATION_HASH_FAILED");
  }

  const now = Date.now();
  const terminalState: PublicationVerificationRecord =
    record && (record.state === "VERIFIED" || record.state === "REJECTED")
      ? record
      : {
          lifecycleId,
          capsuleId,
          creatorIdentityId,
          state: "VERIFIED",
          expectedTxId: authoritativeTxId,
          expectedVaultSha256: computedHash,
          evidenceIds: record?.evidenceIds ?? [authoritativeTxId],
          createdAt: record?.createdAt ?? now,
          updatedAt: now,
          verifiedAt: now,
        };

  await env.PUBLICATION_VERIFICATIONS.put(key, JSON.stringify(terminalState));

  return new Response(
    JSON.stringify({
      ok: true,
      state: terminalState.state,
      lifecycleId,
      capsuleId,
      creatorIdentityId,
      verifiedAt: terminalState.verifiedAt,
      expectedTxId: terminalState.expectedTxId,
      expectedVaultSha256: terminalState.expectedVaultSha256,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}
