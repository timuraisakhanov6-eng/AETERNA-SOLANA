/**
 * AETERNA — Credit Status
 *
 * POST /api/creator/credit-status
 *
 * Requires fresh identity proof.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { getTrustedTime } from "../time";
import { verifyMessage } from "ethers";
import { getCreatorIdentity } from "../../../src/lib/creator/creatorIdentityStore";
import {
  base58Decode,
  buildSolanaMessage,
  verifySolanaSignature,
} from "../../lib/solanaIdentityProof";

interface CreditStatusEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
  };
  CREATOR_IDENTITIES: {
    get(key: string): Promise<string | null>;
  };
}

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

function baseHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function fail(origin: string, status = 400, error = "error"): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: baseHeaders(origin) });
}

export async function onRequestOptions(context: EventContext<Record<string, unknown>, string, CreditStatusEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

/* ================= POST challenge-bound entitlement ================= */

export async function onRequestPost(context: EventContext<Record<string, unknown>, string, CreditStatusEnv>): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return fail(origin, 403, "INVALID_ORIGIN");
  }

  const ip = getClientIp(context.request);
  if (!ip || !rateLimit(ip)) {
    return fail(origin, 429, "TOO_MANY_REQUESTS");
  }

  const contentType = context.request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  let body: Record<string, unknown>;
  try {
    body = await context.request.json() as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY");
  }

  const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  const network = typeof body.network === "string" ? body.network.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const creatorCreditId = typeof body.creatorCreditId === "string" ? body.creatorCreditId.trim() : "";
  const lifecycleId = typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";

  if (
    typeof challengeId !== "string" ||
    typeof network !== "string" ||
    typeof account !== "string" ||
    typeof signature !== "string"
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  /**
   * creatorCreditId MAY be omitted: when absent, the endpoint performs
   * authenticated discovery of the creator's AVAILABLE Credit (see
   * below). When supplied, the exact pre-existing ownership/status
   * semantics apply unchanged.
   */

  const isSolanaRequest = network === "solana";
  if (isSolanaRequest) {
    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = base58Decode(account);
    } catch {
      return fail(origin, 400, "INVALID_ACCOUNT");
    }
    if (publicKeyBytes.length !== 32) {
      return fail(origin, 400, "INVALID_ACCOUNT");
    }
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return fail(origin, 400, "INVALID_ACCOUNT");
  }

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  /* ================= Challenge verification ================= */

  const challengeRaw = await context.env.CREATOR_IDENTITIES.get(`creator:challenge:${challengeId}`);
  if (!challengeRaw) {
    return fail(origin, 401, "CHALLENGE_NOT_FOUND");
  }

  let challengeRecord: Record<string, unknown>;
  try {
    challengeRecord = JSON.parse(challengeRaw) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "CHALLENGE_CORRUPT");
  }

  if (challengeRecord.network !== network) {
    return fail(origin, 401, "NETWORK_MISMATCH");
  }

  if (now > (challengeRecord.expiresAt as number)) {
    return fail(origin, 401, "CHALLENGE_EXPIRED");
  }

  let recovered = "";
  if (isSolanaRequest) {
    /**
     * Solana: Ed25519 verification via the shared proof helper. The
     * verification key is imported from `account` itself, so a valid
     * signature simultaneously binds the signer to the claimed
     * account (fail-closed on any mismatch/malformation).
     */
    const message = buildSolanaMessage(
      challengeRecord as unknown as Parameters<typeof buildSolanaMessage>[0]
    );
    const valid = await verifySolanaSignature(account, signature, message);
    if (!valid) {
      return fail(origin, 401, "INVALID_SIGNATURE");
    }
    recovered = account;
  } else {
    try {
      const message = `AETERNA identity challenge:${challengeRecord.challenge}`;
      const recoveredAddress = await verifyMessage(message, signature);
      recovered = recoveredAddress;
    } catch {
      return fail(origin, 401, "INVALID_SIGNATURE");
    }

    if (recovered.toLowerCase() !== account.toLowerCase()) {
      return fail(origin, 401, "ACCOUNT_MISMATCH");
    }
  }

  /* ================= Creator identity resolution ================= */

  const identityRecord = await getCreatorIdentity(context.env, network, account);
  if (!identityRecord) {
    return fail(origin, 403, "CREATOR_IDENTITY_NOT_FOUND");
  }

  const authenticatedCreatorIdentityId = identityRecord.id;

  /* ================= Creator Credit lookup ================= */

  let resolvedCreatorCreditId = creatorCreditId;

  if (!resolvedCreatorCreditId) {
    /**
     * Authenticated discovery mode (creatorCreditId omitted).
     *
     * The KV prefix is constructed EXCLUSIVELY from the
     * SERVER-DERIVED authenticated creatorIdentityId — never from any
     * client-supplied value — then resolved credit records are
     * re-validated for ownership. Discovery is strictly read-only:
     * no KV writes, no consumption, no reservation.
     */
    const indexPrefix = `creator:credit:index:${authenticatedCreatorIdentityId}:`;
    const listed = await context.env.CREATOR_CREDITS.list({ prefix: indexPrefix });

    const availableCredits: Array<{
      id: string;
      createdAt: number;
    }> = [];

    for (const key of listed.keys) {
      const creditIdRaw = await context.env.CREATOR_CREDITS.get(key.name);
      if (!creditIdRaw || typeof creditIdRaw !== "string") {
        continue;
      }
      const recordRaw = await context.env.CREATOR_CREDITS.get(`creator:credit:${creditIdRaw}`);
      if (!recordRaw || typeof recordRaw !== "string") {
        continue;
      }
      try {
        const record = JSON.parse(recordRaw) as {
          id?: unknown;
          creatorIdentityId?: unknown;
          status?: unknown;
          createdAt?: unknown;
        };
        if (
          typeof record.id === "string" &&
          record.id === creditIdRaw &&
          typeof record.creatorIdentityId === "string" &&
          record.creatorIdentityId === authenticatedCreatorIdentityId &&
          record.status === "AVAILABLE" &&
          typeof record.createdAt === "number" &&
          Number.isFinite(record.createdAt)
        ) {
          availableCredits.push({ id: record.id, createdAt: record.createdAt });
        }
      } catch {
        // corrupt record — skip (fail closed: never returned as available)
      }
    }

    if (availableCredits.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          status: "none",
          creatorCreditId: null,
          lifecycleId: lifecycleId || null,
          creatorIdentityId: authenticatedCreatorIdentityId,
        }),
        { status: 200, headers: baseHeaders(origin) }
      );
    }

    /**
     * Deterministic server-side rule when multiple AVAILABLE credits
     * exist: the EARLIEST granted credit (smallest createdAt, tie-break
     * lexicographically smallest id). Discovery is authority-neutral —
     * any returned AVAILABLE credit is a valid, unconsumed entitlement.
     */
    availableCredits.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt - b.createdAt
        : a.id < b.id
        ? -1
        : 1
    );
    resolvedCreatorCreditId = availableCredits[0]!.id;
  }

  const creditRaw = await context.env.CREATOR_CREDITS.get(`creator:credit:${resolvedCreatorCreditId}`);
  if (!creditRaw) {
    return new Response(
      JSON.stringify({ ok: true, status: "none", creatorCreditId: resolvedCreatorCreditId, lifecycleId: lifecycleId || null, creatorIdentityId: authenticatedCreatorIdentityId }),
      { status: 200, headers: baseHeaders(origin) }
    );
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

  if (creditRecord.id !== resolvedCreatorCreditId) {
    return fail(origin, 403, "CREATOR_CREDIT_MISMATCH");
  }

  if (creditRecord.creatorIdentityId !== authenticatedCreatorIdentityId) {
    return fail(origin, 403, "CREATOR_MISMATCH");
  }

  /* ================= Lifecycle binding check ================= */

  let boundLifecycleId: string | null = null;
  if (lifecycleId) {
    const lifecycleRaw = await context.env.CREATOR_CREDITS.get(`creator:credit:lifecycle:${authenticatedCreatorIdentityId}:${lifecycleId}`);
    if (lifecycleRaw) {
      try {
        const lifecycleRecord = JSON.parse(lifecycleRaw) as { id?: unknown };
        if (typeof lifecycleRecord.id === "string") {
          boundLifecycleId = lifecycleRecord.id;
        }
      } catch {
        // fail closed below
      }
    }

    if (!boundLifecycleId || boundLifecycleId !== creatorCreditId) {
      return fail(origin, 403, "LIFECYCLE_MISMATCH");
    }
  }

  /* ================= Status mapping ================= */

  let status: "available" | "consuming" | "consumed" | "none";

  if (creditRecord.status === "AVAILABLE") {
    status = "available";
  } else if (creditRecord.status === "CONSUMING") {
    status = lifecycleId && boundLifecycleId === creatorCreditId ? "consuming" : "none";
  } else if (creditRecord.status === "CONSUMED") {
    status = "none";
  } else {
    status = "none";
  }

  return new Response(
    JSON.stringify({
      ok: true,
      status,
      creatorCreditId: creditRecord.id,
      lifecycleId: lifecycleId || creditRecord.lifecycleId || null,
      creatorIdentityId: authenticatedCreatorIdentityId,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
}

