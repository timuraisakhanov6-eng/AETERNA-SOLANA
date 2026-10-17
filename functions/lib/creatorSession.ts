/**
 * AETERNA — Creator authorization session (server side).
 *
 * A short-lived, opaque bearer capability that lets a creator who ALREADY
 * proved their identity (verify-proof) call the two AUTHORIZATION-ONLY
 * endpoints (`/api/creator/credit-status` and
 * `/api/service-payment/create-quote`) WITHOUT a fresh challenge + wallet
 * signature.
 *
 * WHAT A SESSION IS — AND IS NOT
 * ------------------------------
 * A session proves exactly ONE thing: "the holder already proved this
 * creator identity recently". It NEVER proves that money moved, and it is
 * NEVER consulted by a financial decision:
 *
 *   - the $1 USDC amount / mint / destination / payer checks,
 *   - the on-chain verification (`/api/service-payment/verify`),
 *   - the strict signed-transaction parsing + mainnet guard + atomic
 *     signature binding (`/api/solana/broadcast`),
 *   - the global transaction uniqueness claim, and
 *   - the `AVAILABLE -> CONSUMING -> CONSUMED` lifecycle
 *
 * all keep reading the quote, the identity Durable Object and the chain —
 * never this token. Replacing a signature with a session therefore cannot
 * weaken any financial invariant.
 *
 * STORAGE
 * -------
 * Sessions live INSIDE the existing `CREDIT_OP_COORDINATOR` Durable
 * Object, scoped per creator identity (`identity:<creatorIdentityId>`),
 * so validation is strongly consistent — the same reason the purchase
 * guard uses the DO instead of KV. No new binding, namespace or secret is
 * introduced.
 *
 * TOKEN SHAPE
 * -----------
 * `aets.<creatorIdentityId>.<32 random bytes, base64url>`
 *
 * The identity prefix is NOT a secret: `verify-proof` / `credit-status`
 * already return `creatorIdentityId` to the client, and several endpoints
 * already accept it as a bearer identifier. It exists ONLY so the server
 * knows which identity's Durable Object to ask; it grants nothing on its
 * own — the DO matches the SHA-256 digest of the WHOLE token against a
 * record bound to that identity, network and account.
 *
 * The server stores ONLY the digest, never the token (same doctrine as the
 * creator authority fragment in `api/capsule/seal.ts`): a storage read or
 * leak yields a verification artifact, not a usable capability.
 */

import { sha256 } from "./sha256";

/** Initial lifetime of one creator session (8 minutes). */
export const CREATOR_SESSION_TTL_MS = 8 * 60 * 1000;

/**
 * Bounded number of concurrently valid sessions per identity.
 *
 * Several tabs/devices of ONE creator each hold their own session; they
 * must not invalidate each other. The bound keeps the per-identity record
 * small and is enforced by evicting the OLDEST sessions first, after
 * expired records have been pruned.
 */
export const CREATOR_SESSION_MAX_PER_IDENTITY = 8;

/** Rejected-by-session error codes the client may safely react to. */
export const CREATOR_SESSION_ERROR_CODES = [
  "SESSION_INVALID",
  "SESSION_EXPIRED",
  "SESSION_UNAVAILABLE",
] as const;

export type CreatorSessionError = (typeof CREATOR_SESSION_ERROR_CODES)[number];

const SESSION_TOKEN_PREFIX = "aets";
const SESSION_TOKEN_SEPARATOR = ".";

export interface CreatorSessionBinding {
  idFromName(name: string): { id: string };
  get(binding: { id: string }): { fetch(request: Request): Promise<Response> };
}

export interface CreatorSessionEnv {
  CREDIT_OP_COORDINATOR?: CreatorSessionBinding | undefined;
}

/** One stored session record (the DO's own storage shape). */
export interface CreatorSessionRecord {
  /** SHA-256 hex digest of the WHOLE bearer token. */
  digest: string;
  creatorIdentityId: string;
  network: string;
  account: string;
  issuedAt: number;
  expiresAt: number;
}

/* ───────────────── TOKEN PRIMITIVES ───────────────── */

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Cryptographically random bearer token. Uses Web Crypto
 * (`crypto.getRandomValues`) — never `Math.random`.
 */
export function generateCreatorSessionToken(creatorIdentityId: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${SESSION_TOKEN_PREFIX}${SESSION_TOKEN_SEPARATOR}${creatorIdentityId}${SESSION_TOKEN_SEPARATOR}${base64Url(bytes)}`;
}

/**
 * Extracts the identity reference from a token so the server knows which
 * Durable Object to ask. Returns null for anything that is not a
 * well-formed token — a malformed token is simply invalid, never treated
 * as a valid session for some other identity.
 */
export function parseCreatorSessionToken(
  token: string
): { creatorIdentityId: string } | null {
  if (typeof token !== "string") return null;
  const prefix = `${SESSION_TOKEN_PREFIX}${SESSION_TOKEN_SEPARATOR}`;
  if (!token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const separatorIndex = rest.indexOf(SESSION_TOKEN_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const creatorIdentityId = rest.slice(0, separatorIndex);
  const secret = rest.slice(separatorIndex + 1);
  if (!creatorIdentityId || !secret) return null;
  // The identity reference must not itself contain the separator.
  if (creatorIdentityId.includes(SESSION_TOKEN_SEPARATOR)) return null;
  return { creatorIdentityId };
}

/** SHA-256 hex digest of the WHOLE token (what the server stores). */
export async function digestCreatorSessionToken(token: string): Promise<string> {
  return sha256(new TextEncoder().encode(token));
}

const SESSION_DIGEST_REGEX = /^[0-9a-f]{64}$/;

/* ───────────────── DO TRANSPORT ───────────────── */

function coordinatorStub(
  binding: CreatorSessionBinding,
  creatorIdentityId: string
) {
  return binding.get(binding.idFromName(`identity:${creatorIdentityId}`));
}

async function postToCoordinator(
  binding: CreatorSessionBinding,
  creatorIdentityId: string,
  payload: Record<string, unknown>
): Promise<{ httpStatus: number; data: Record<string, unknown> | null }> {
  const stub = coordinatorStub(binding, creatorIdentityId);
  const res = await stub.fetch(
    new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { httpStatus: res.status, data };
}

/* ───────────────── ISSUE ───────────────── */

export type CreatorSessionIssueResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false };

/**
 * Best-effort issuance.
 *
 * The caller has ALREADY completed identity verification, so a session
 * that cannot be issued must NEVER turn that success into a failure: the
 * caller omits the token and the client transparently uses the legacy
 * challenge/proof path. This function therefore never throws and returns
 * `{ ok: false }` on any unavailability, without emitting an invalid
 * token.
 *
 * No bearer token, digest, signature or proof content is ever logged.
 */
export async function issueCreatorSession(
  env: CreatorSessionEnv,
  input: { creatorIdentityId: string; network: string; account: string },
  now: number
): Promise<CreatorSessionIssueResult> {
  const binding = env?.CREDIT_OP_COORDINATOR;
  if (!binding) return { ok: false };

  let token: string;
  let digest: string;
  try {
    token = generateCreatorSessionToken(input.creatorIdentityId);
    digest = await digestCreatorSessionToken(token);
  } catch {
    return { ok: false };
  }
  if (!SESSION_DIGEST_REGEX.test(digest)) return { ok: false };

  const expiresAt = now + CREATOR_SESSION_TTL_MS;
  try {
    const { httpStatus, data } = await postToCoordinator(binding, input.creatorIdentityId, {
      op: "session-issue",
      creatorIdentityId: input.creatorIdentityId,
      network: input.network,
      account: input.account,
      digest,
      issuedAt: now,
      expiresAt,
    });
    if (httpStatus !== 200 || !data?.["ok"]) return { ok: false };
  } catch {
    return { ok: false };
  }

  return { ok: true, token, expiresAt };
}

/* ───────────────── VALIDATE ───────────────── */

export type CreatorSessionValidationResult =
  | { ok: true; creatorIdentityId: string; network: string; account: string }
  | { ok: false; status: number; error: CreatorSessionError };

/**
 * Validates a presented token against the strongly consistent
 * per-identity session store.
 *
 * Checks: the digest exists, the TTL has not passed, and the presented
 * network / account / identity all match the record. Every failure mode is
 * distinct from a transport failure so the client can tell "your session
 * is no longer usable" (fall back to a proof) from "the server is
 * temporarily unavailable" (do not spin).
 */
export async function validateCreatorSession(
  env: CreatorSessionEnv,
  input: { sessionToken: string; network: string; account: string },
  now: number
): Promise<CreatorSessionValidationResult> {
  const parsed = parseCreatorSessionToken(input.sessionToken);
  if (!parsed) return { ok: false, status: 401, error: "SESSION_INVALID" };

  const binding = env?.CREDIT_OP_COORDINATOR;
  if (!binding) return { ok: false, status: 503, error: "SESSION_UNAVAILABLE" };

  let digest: string;
  try {
    digest = await digestCreatorSessionToken(input.sessionToken);
  } catch {
    return { ok: false, status: 401, error: "SESSION_INVALID" };
  }

  let httpStatus = 0;
  let data: Record<string, unknown> | null = null;
  try {
    const result = await postToCoordinator(binding, parsed.creatorIdentityId, {
      op: "session-validate",
      creatorIdentityId: parsed.creatorIdentityId,
      network: input.network,
      account: input.account,
      digest,
      now,
    });
    httpStatus = result.httpStatus;
    data = result.data;
  } catch {
    return { ok: false, status: 503, error: "SESSION_UNAVAILABLE" };
  }

  if (httpStatus === 503) {
    return { ok: false, status: 503, error: "SESSION_UNAVAILABLE" };
  }

  if (!data?.["ok"]) {
    return {
      ok: false,
      status: 401,
      error: data?.["error"] === "SESSION_EXPIRED" ? "SESSION_EXPIRED" : "SESSION_INVALID",
    };
  }

  const creatorIdentityId =
    typeof data["creatorIdentityId"] === "string" ? data["creatorIdentityId"] : "";
  const network = typeof data["network"] === "string" ? data["network"] : "";
  const account = typeof data["account"] === "string" ? data["account"] : "";
  if (
    !creatorIdentityId ||
    !network ||
    !account ||
    creatorIdentityId !== parsed.creatorIdentityId
  ) {
    return { ok: false, status: 401, error: "SESSION_INVALID" };
  }

  return { ok: true, creatorIdentityId, network, account };
}

/* ───────────────── REVOKE ───────────────── */

/**
 * Revokes EXACTLY the session identified by the token, leaving every other
 * session of the same identity (other tabs / devices) untouched.
 *
 * Best-effort and never throws: the caller must not depend on a successful
 * network revocation, because the server-side identity/network/account
 * binding and the TTL remain authoritative regardless.
 */
export async function revokeCreatorSession(
  env: CreatorSessionEnv,
  input: { sessionToken: string }
): Promise<{ ok: boolean; revoked: boolean }> {
  const parsed = parseCreatorSessionToken(input.sessionToken);
  if (!parsed) return { ok: false, revoked: false };
  const binding = env?.CREDIT_OP_COORDINATOR;
  if (!binding) return { ok: false, revoked: false };

  let digest: string;
  try {
    digest = await digestCreatorSessionToken(input.sessionToken);
  } catch {
    return { ok: false, revoked: false };
  }

  try {
    const { httpStatus, data } = await postToCoordinator(binding, parsed.creatorIdentityId, {
      op: "session-revoke",
      creatorIdentityId: parsed.creatorIdentityId,
      digest,
    });
    if (httpStatus !== 200 || !data?.["ok"]) return { ok: false, revoked: false };
    return { ok: true, revoked: data["revoked"] === true };
  } catch {
    return { ok: false, revoked: false };
  }
}
