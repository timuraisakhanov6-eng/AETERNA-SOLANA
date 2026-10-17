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
import { verifyIdentityProof } from "../../lib/creatorIdentityProof";
import {
  validateCreatorSession,
  type CreatorSessionBinding,
} from "../../lib/creatorSession";

interface CreditStatusEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
  };
  CREATOR_IDENTITIES: {
    get(key: string): Promise<string | null>;
  };
  CREDIT_OP_COORDINATOR?: CreatorSessionBinding;
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

/**
 * The single response builder for this endpoint.
 *
 * Additive extension of the historical payload (ok / status /
 * creatorCreditId / lifecycleId / creatorIdentityId) with the authoritative
 * enumeration result, so existing consumers keep working unchanged while
 * the Home Gate gains the CONSUMING / summary facts it needs.
 *
 * `status: "none"` is only ever produced by a COMPLETED, consistent
 * enumeration (or by an explicit owner-scoped lookup of a non-usable
 * credit) — never by a corrupt, inconsistent or incomplete one; those
 * paths return through `fail()` above.
 */
function statusResponse(
  origin: string,
  status: "available" | "consuming" | "consumed" | "none",
  creatorCreditId: string | null,
  lifecycleId: string | null,
  creatorIdentityId: string,
  summary: {
    availableCount: number;
    consumingCount: number;
    consumedCount: number;
    total: number;
    enumerationComplete: boolean;
  } | null,
  unfinishedLifecycles: Array<{
    creatorCreditId: string;
    lifecycleId: string | null;
    capsuleId: string | null;
  }> | null,
  /**
   * Authoritative unfinished PURCHASE attempt (from the identity
   * coordinator), when one exists. Purely informational for the client:
   * it explains why a payment window is being resumed instead of a new
   * purchase being offered. It is never authority to pay.
   */
  activeAttempt: {
    paymentIntentId: string;
    quoteId: string;
    state: string;
    createdAt: number;
  } | null = null
): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      status,
      creatorCreditId,
      lifecycleId,
      creatorIdentityId,
      summary,
      unfinishedLifecycles,
      activeAttempt,
    }),
    { status: 200, headers: baseHeaders(origin) }
  );
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
  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";
  const creatorCreditId = typeof body.creatorCreditId === "string" ? body.creatorCreditId.trim() : "";
  const lifecycleId = typeof body.lifecycleId === "string" ? body.lifecycleId.trim() : "";

  /**
   * Two mutually exclusive authorization modes:
   *
   *   - a short-lived creator session (verify-proof has already proven the
   *     identity), used to avoid a fresh challenge + wallet signature;
   *   - the legacy challenge/proof, kept for recovery when no session
   *     exists or it has expired.
   *
   * The session only substitutes the AUTHORIZATION step. Every credit
   * decision below still re-derives the identity server-side from the
   * session's strongly consistent record, exactly as the proof path
   * derives it from the signature — a client-supplied identity is never
   * trusted.
   */
  const hasSession = sessionToken.length > 0;

  if (
    typeof network !== "string" ||
    typeof account !== "string" ||
    !network ||
    !account ||
    (!hasSession && (typeof challengeId !== "string" || typeof signature !== "string" || !challengeId || !signature))
  ) {
    return fail(origin, 400, "INVALID_FIELDS");
  }

  /**
   * creatorCreditId MAY be omitted: when absent, the endpoint performs
   * authenticated discovery of the creator's rights (see below). When
   * supplied, the exact pre-existing ownership/status semantics apply
   * unchanged.
   */

  const nowSource = await getTrustedTime().catch(() => ({ nowUtc: Date.now() }));
  const now = typeof nowSource.nowUtc === "number" ? nowSource.nowUtc : Date.now();

  let authenticatedCreatorIdentityId: string;
  if (hasSession) {
    const sessionResult = await validateCreatorSession(
      { CREDIT_OP_COORDINATOR: context.env.CREDIT_OP_COORDINATOR },
      { sessionToken, network, account },
      now
    );
    if (!sessionResult.ok) {
      // Distinguishes "session no longer usable" (fall back to a proof)
      // from "server temporarily unavailable" (do not spin).
      return fail(origin, sessionResult.status, sessionResult.error);
    }
    authenticatedCreatorIdentityId = sessionResult.creatorIdentityId;
  } else {
    const proofResult = await verifyIdentityProof(
      context.env,
      { challengeId, network, account, signature },
      now
    );
    if (!proofResult.ok) {
      return fail(origin, proofResult.status, proofResult.error);
    }
    authenticatedCreatorIdentityId = proofResult.creatorIdentityId;
  }

  /* ================= Creator Credit lookup ================= */

  let resolvedCreatorCreditId = creatorCreditId;
  let kvFallback = false;
  /**
   * True when the identity coordinator (strongly consistent) resolved
   * the credit. A lagging KV projection must then NOT be allowed to
   * downgrade the answer to "none" — the coordinator already vouched
   * for the right.
   */
  let resolvedByCoordinator = false;
  /** Authoritative unfinished purchase attempt, when the coordinator reported one. */
  let coordinatorActiveAttempt: {
    paymentIntentId: string;
    quoteId: string;
    state: string;
    createdAt: number;
  } | null = null;

  /**
   * Authoritative enumeration of the authenticated creator's rights.
   *
   * Populated in discovery mode (no client-supplied creatorCreditId) and
   * reported additively in EVERY response of this endpoint. The KV prefix
   * is built EXCLUSIVELY from the SERVER-DERIVED
   * authenticatedCreatorIdentityId — a client-supplied creatorIdentityId
   * is never trusted — and every resolved record is re-validated for
   * ownership against that same server-derived value.
   *
   * Discovery is strictly read-only: no KV writes, no consumption, no
   * reservation.
   */
  let entitlementSummary: {
    availableCount: number;
    consumingCount: number;
    consumedCount: number;
    total: number;
    enumerationComplete: boolean;
  } | null = null;
  let unfinishedLifecycles: Array<{
    creatorCreditId: string;
    lifecycleId: string | null;
    capsuleId: string | null;
  }> | null = null;

  if (!resolvedCreatorCreditId) {
    /**
     * IDENTITY COORDINATOR (strongly consistent) — the PRIMARY source.
     *
     * The KV enumeration below is eventually consistent, so a credit
     * written seconds ago can be missing from it; that missed credit is
     * what used to authorise a second $1. The identity-scoped Durable
     * Object holds the same facts transactionally, so it is consulted
     * first. KV remains the fallback for environments without the
     * binding, and as positive evidence whenever it DOES find rights.
     */
    const coordinatorBinding = (context.env as CreditStatusEnv).CREDIT_OP_COORDINATOR;
    if (coordinatorBinding) {
      try {
        const stub = coordinatorBinding.get(
          coordinatorBinding.idFromName(`identity:${authenticatedCreatorIdentityId}`)
        );
        const res = await stub.fetch(
          new Request("https://aeterna-credit-coordinator.invalid", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              op: "identity-summary",
              creatorIdentityId: authenticatedCreatorIdentityId,
            }),
          })
        );
        const data = (await res.json()) as {
          ok?: boolean;
          available?: Array<{ creatorCreditId: string; createdAt?: number }>;
          consuming?: Array<{
            creatorCreditId: string;
            lifecycleId: string | null;
            capsuleId: string | null;
          }>;
          summary?: {
            availableCount: number;
            consumingCount: number;
            consumedCount: number;
            total: number;
          };
          activeAttempt?: {
            paymentIntentId: string;
            quoteId: string;
            state: string;
            createdAt: number;
          } | null;
          error?: string;
        };

        if (!res.ok || !data?.ok) {
          // The identity coordinator refuses to vouch for a complete,
          // consistent view (unresolved old right, unenumerable index):
          // an absence can NOT be established — fail closed.
          return fail(
            origin,
            503,
            (data && data.error) || "ENTITLEMENT_STATE_UNKNOWN"
          );
        }

        const available = Array.isArray(data.available) ? data.available : [];
        const consuming = Array.isArray(data.consuming) ? data.consuming : [];
        const doSummary = {
          availableCount: available.length,
          consumingCount: consuming.length,
          consumedCount: data.summary?.consumedCount ?? 0,
          total:
            available.length +
            consuming.length +
            (data.summary?.consumedCount ?? 0),
          enumerationComplete: true,
        };
        const doUnfinished = consuming.map((entry) => ({
          creatorCreditId: entry.creatorCreditId,
          lifecycleId: entry.lifecycleId ?? null,
          capsuleId: entry.capsuleId ?? null,
        }));

        if (available.length === 0) {
          return statusResponse(
            origin,
            consuming.length > 0 ? "consuming" : "none",
            null,
            null,
            authenticatedCreatorIdentityId,
            doSummary,
            doUnfinished,
            data.activeAttempt ?? null
          );
        }

        // Same deterministic rule as the KV path: earliest granted
        // (smallest createdAt), tie-break smallest id.
        const sorted = [...available].sort((a, b) => {
          const ca =
            typeof a.createdAt === "number" && Number.isFinite(a.createdAt)
              ? a.createdAt
              : Number.MAX_SAFE_INTEGER;
          const cb =
            typeof b.createdAt === "number" && Number.isFinite(b.createdAt)
              ? b.createdAt
              : Number.MAX_SAFE_INTEGER;
          return ca !== cb ? ca - cb : a.creatorCreditId < b.creatorCreditId ? -1 : 1;
        });
        resolvedCreatorCreditId = sorted[0]!.creatorCreditId;
        entitlementSummary = doSummary;
        unfinishedLifecycles = doUnfinished;
        coordinatorActiveAttempt = data.activeAttempt ?? null;
        resolvedByCoordinator = true;

        // Fall through to the shared record read below, which validates
        // ownership from the KV projection exactly like before.
      } catch {
        /**
         * Durable Object unreachable: fall back to the KV enumeration,
         * but a KV answer that found NOTHING is downgraded to an
         * UNCONFIRMED absence (enumerationComplete: false) — the
         * client must not treat it as authority to pay. Positive
         * findings stay authoritative as before.
         */
        kvFallback = true;
      }
    }

    /**
     * KV enumeration: only when the identity coordinator did not
     * resolve the answer (no binding, or it was unreachable). Its own
     * fail-closed error codes are unchanged.
     */
    if (resolvedCreatorCreditId) {
      // The DO path already resolved the credit; skip KV entirely.
    } else {
    const indexPrefix = `creator:credit:index:${authenticatedCreatorIdentityId}:`;
    const listed = await context.env.CREATOR_CREDITS.list({ prefix: indexPrefix });

    /**
     * Completeness is reported ONLY when the binding states it. An absent
     * `list_complete` (older bindings, test doubles) means "unknown", NOT
     * "complete" — the caller must then treat a "no rights" answer as an
     * UNCONFIRMED absence (see the Home Gate pre-payment re-check).
     */
    const listComplete = (listed as { list_complete?: unknown }).list_complete;
    if (listComplete === false) {
      return fail(origin, 500, "ENTITLEMENT_ENUMERATION_INCOMPLETE");
    }
    const enumerationComplete = listComplete === true;

    /**
     * One right may be reachable through BOTH index shapes
     * (…:{capsuleId} written at reserve and …:{quoteId} written at grant),
     * so the resolved credit ids are de-duplicated before any record read.
     */
    const creditIds = new Set<string>();
    for (const key of listed.keys) {
      const creditIdRaw = await context.env.CREATOR_CREDITS.get(key.name);
      if (!creditIdRaw) continue; // dangling pointer — nothing to reason about
      if (typeof creditIdRaw !== "string") {
        return fail(origin, 500, "ENTITLEMENT_STATE_UNREADABLE");
      }
      const creditId = creditIdRaw.trim();
      if (creditId) creditIds.add(creditId);
    }

    const availableCredits: Array<{ id: string; createdAt: number }> = [];
    const consumingLifecycles: Array<{
      creatorCreditId: string;
      lifecycleId: string | null;
      capsuleId: string | null;
    }> = [];
    let consumedCount = 0;

    for (const creditId of [...creditIds].sort()) {
      const recordRaw = await context.env.CREATOR_CREDITS.get(`creator:credit:${creditId}`);
      if (!recordRaw) continue; // dangling index pointer — not an inconsistency

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(recordRaw) as Record<string, unknown>;
      } catch {
        return fail(origin, 500, "ENTITLEMENT_STATE_UNREADABLE");
      }

      if (typeof record["id"] !== "string" || record["id"] !== creditId) {
        return fail(origin, 500, "ENTITLEMENT_INDEX_INCONSISTENT");
      }
      if (record["creatorIdentityId"] !== authenticatedCreatorIdentityId) {
        return fail(origin, 500, "ENTITLEMENT_INDEX_INCONSISTENT");
      }

      if (record["status"] === "AVAILABLE") {
        const createdAt = record["createdAt"];
        // Unknown createdAt ranks last (never last-foremost), tie-broken by
        // id — identical ordering to the pinned multi-AVAILABLE invariant
        // whenever createdAt is present.
        availableCredits.push({
          id: creditId,
          createdAt:
            typeof createdAt === "number" && Number.isFinite(createdAt)
              ? createdAt
              : Number.MAX_SAFE_INTEGER,
        });
      } else if (record["status"] === "CONSUMING") {
        // The authoritative CreditRecord already carries the recovery
        // identifiers — the client never has to supply them.
        const lifecycleId = record["lifecycleId"];
        const capsuleId = record["capsuleId"];
        consumingLifecycles.push({
          creatorCreditId: creditId,
          lifecycleId: typeof lifecycleId === "string" ? lifecycleId : null,
          capsuleId: typeof capsuleId === "string" ? capsuleId : null,
        });
      } else if (record["status"] === "CONSUMED") {
        consumedCount += 1;
      } else {
        return fail(origin, 500, "ENTITLEMENT_STATE_UNREADABLE");
      }
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

    entitlementSummary = {
      availableCount: availableCredits.length,
      consumingCount: consumingLifecycles.length,
      consumedCount,
      total:
        availableCredits.length + consumingLifecycles.length + consumedCount,
      enumerationComplete,
    };
    unfinishedLifecycles = consumingLifecycles;

    if (availableCredits.length === 0) {
      /**
       * No AVAILABLE right. A CONSUMING answer means a right EXISTS but is
       * bound to an unfinished lifecycle — it must never be reported as an
       * absence, because an absence is what authorises a new $1.
       *
       * When this enumeration ran only because the identity coordinator
       * was unreachable, an empty result is an UNCONFIRMED absence
       * (enumerationComplete: false): eventual consistency means a
       * recently written credit may simply be invisible yet.
       */
      const status =
        consumingLifecycles.length > 0 ? "consuming" : "none";
      const fallbackSummary = kvFallback
        ? { ...entitlementSummary!, enumerationComplete: false }
        : entitlementSummary;
      return statusResponse(
        origin,
        status,
        null,
        null,
        authenticatedCreatorIdentityId,
        fallbackSummary,
        unfinishedLifecycles
      );
    }

    resolvedCreatorCreditId = availableCredits[0]!.id;
    }
  }

  const creditRaw = await context.env.CREATOR_CREDITS.get(`creator:credit:${resolvedCreatorCreditId}`);
  if (!creditRaw) {
    if (resolvedByCoordinator) {
      /**
       * The KV projection is not (yet) readable — the documented
       * eventual-consistency window. The identity coordinator already
       * established that this credit EXISTS and is AVAILABLE, so the
       * answer is "available"; reporting "none" here is exactly the
       * downgrade that used to authorise a second $1.
       */
      return statusResponse(
        origin,
        "available",
        resolvedCreatorCreditId,
        null,
        authenticatedCreatorIdentityId,
        entitlementSummary,
        unfinishedLifecycles,
        coordinatorActiveAttempt
      );
    }
    return statusResponse(
      origin,
      "none",
      resolvedCreatorCreditId,
      null,
      authenticatedCreatorIdentityId,
      entitlementSummary,
      unfinishedLifecycles
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

  return statusResponse(
    origin,
    status,
    creditRecord.id,
    lifecycleId || creditRecord.lifecycleId || null,
    authenticatedCreatorIdentityId,
    entitlementSummary,
    unfinishedLifecycles
  );
}

