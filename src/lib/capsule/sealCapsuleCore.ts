import type {
  RuntimeStorage,
} from "@/lib/runtime/runtimeStorage";

import type {
  StorageAdapter,
} from "@/lib/storage/storageAdapter";

import {
  assertSealUploadOutcome,
} from "@/lib/capsule/sealUploadOutcome";

import {
  MANIFEST_VERSION
} from "@/types/manifest";

import {
  type ManifestV1,
  OpenAtUtc,
  SealedAtUtc,
  CapsuleId,
  SaltBaseHex,
  Sha256Hex,
  HeartbeatInterval,
  ArweaveTxId,
  assertArweaveTxId,
  assertHeartbeatConsistency
} from "@/types/manifest";

import type {
  ChunkMetadata,
} from "@/types/vault";

import {
  assertStoragePointer
} from "@/lib/storage/storageAdapter";

import { deepFreeze } from "@/lib/utils/deepFreeze";

import { asUploadToken } from "@/lib/storage/uploadToken";

import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX
} from "@/lib/crypto/validators";

import {
  deriveCreatorAuthorityFragment
} from "@/lib/heartbeat/deriveCreatorAuthorityFragment";

import {
  asArweaveTxId
} from "@/lib/storage/assertArweaveTxId";

import {
  assertLocalVaultPointer,
  localVaultPointerCapsuleId,
} from "@/lib/runtime/localVaultPointer";

import { getTrustedTime } from "@/shared/time/getTrustedTime";

import {
  tagSealFailure,
  type SealDiagnosticCode,
} from "@/lib/capsule/sealDiagnostic";

export interface SealCapsuleResult {

  capsuleId: string;

  manifest: ManifestV1;

  recipientLink: string;

  confirmationLink: string;

  finalized: boolean;

  finalizationPending: boolean;

}

const SEALED_ERROR =
  new Error("[AETERNA] Capsule sealing failed");

function sealedError(): never {

  throw SEALED_ERROR;

}

/**
 * Runs `operation`, re-tagging any failure with the stage `code` while
 * PRESERVING a more precise tag an inner boundary already attached.
 *
 * Diagnostic only: it never alters control flow, retry policy, ordering or
 * the fail-closed contract — it only classifies WHICH stage failed before
 * the failure is masked. The original exception is never attached, logged
 * or surfaced; only the fixed public message and the code travel on.
 */
async function withSealStage<T>(
  code: SealDiagnosticCode,
  operation: () => Promise<T>
): Promise<T> {

  try {

    return await operation();

  } catch (error) {

    throw tagSealFailure(error, code);

  }

}

/* ── Finalization wiring ──────────────────────────────────────────
 *
 * Canonical order (publication/seal/finalization spec §6.5):
 *   upload → publication verify → seal → seal verify → finalize.
 *
 * The client only initiates server checks and passes identifiers.
 * expectedTxId / expectedVaultSha256 / publication state / seal
 * state are established server-side and are never inputs here.
 * Every call below is idempotent server-side, so a lost response
 * can be retried safely (repeat calls return the existing state).
 * ──────────────────────────────────────────────────────────────── */

const FINALIZATION_MAX_ATTEMPTS = 3;

/**
 * Lost-response retry cache for the vault upload. A cached value is
 * accepted only if it is a structurally valid txId; anything missing
 * or malformed falls back to a normal upload. The cache is evidence
 * only — the server-side PENDING record remains authoritative.
 */
function readCachedVaultTxId(capsuleId: string): ArweaveTxId | null {

  try {

    const cached = sessionStorage.getItem(`aeterna-vault-txid:${capsuleId}`);

    if (typeof cached !== "string" || cached.length === 0) {
      return null;
    }

    assertArweaveTxId(cached);

    return cached;

  } catch {

    return null;

  }

}

/* ── Container retry cache ────────────────────────────────────────
 *
 * Lost-response / late-failure retry cache for the Container V1 upload.
 *
 * WHY THIS EXISTS (root cause)
 * ----------------------------
 * The Vault upload already had a txId cache, but the Container upload
 * did NOT. A container DataItem is produced by ONE `uploadData()` call
 * that carries ONE creator signature — so if the container upload
 * succeeded but a LATER stage (vault upload, publication verify, seal
 * commit, seal verify) failed, a retry re-entered the container branch
 * and re-signed a NEW container DataItem, costing an extra Phantom
 * `signMessage` prompt for data that was already published.
 *
 * WHAT IS CACHED
 * --------------
 * The FULL immutable outcome of a successful container upload —
 * `containerTxId` PLUS the `chunkIds` and `layoutDigest` it was
 * published with. The chunkIds/layoutDigest are NOT decoration: they are
 * exactly what `assertSealUploadOutcome()` re-checks, so a reused
 * container outcome is re-validated against the current chunk set and
 * fails closed if the capsule's media changed since the upload.
 *
 * FAIL-CLOSED CONTRACT
 * --------------------
 * A cache entry is accepted ONLY when it is well-formed:
 *   • a structurally valid storage-pointer txId (assertArweaveTxId),
 *   • a non-empty array of chunk ids,
 *   • a sha256-shaped layoutDigest.
 * Anything missing, malformed, truncated or ambiguous returns null and
 * falls back to a normal first upload. The cache NEVER invents a txId,
 * never fabricates a chunk set and never guesses a digest. Like the
 * vault cache, this is client-side EVIDENCE only — the server-side
 * PENDING publication record remains authoritative at verify time, so a
 * stale/poisoned entry fails closed there too.
 */

/** sessionStorage key for the container upload outcome of one capsule. */
function containerCacheKey(capsuleId: string): string {
  return `aeterna-container-upload:${capsuleId}`;
}

/**
 * Read a previously recorded container upload outcome for this capsule.
 * Returns null unless EVERY field is present and well-formed.
 */
function readCachedContainerOutcome(
  capsuleId: string
): { containerTxId: string; chunkIds: readonly string[]; layoutDigest: string } | null {

  try {

    const raw = sessionStorage.getItem(containerCacheKey(capsuleId));

    if (typeof raw !== "string" || raw.length === 0) {
      return null;
    }

    const parsed = JSON.parse(raw) as {
      containerTxId?: unknown;
      chunkIds?: unknown;
      layoutDigest?: unknown;
    } | null;

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const { containerTxId, chunkIds, layoutDigest } = parsed;

    // txId must be a structurally valid storage pointer.
    if (typeof containerTxId !== "string") {
      return null;
    }
    assertArweaveTxId(containerTxId);

    // Chunk ids must be a non-empty array of non-empty strings.
    if (!Array.isArray(chunkIds) || chunkIds.length === 0) {
      return null;
    }
    for (const id of chunkIds) {
      if (typeof id !== "string" || id.length === 0) {
        return null;
      }
    }

    // layoutDigest must be sha256-shaped.
    if (typeof layoutDigest !== "string" || !SHA256_REGEX.test(layoutDigest)) {
      return null;
    }

    return {
      containerTxId,
      chunkIds: [...(chunkIds as string[])],
      layoutDigest,
    };

  } catch {

    return null;

  }

}

/**
 * Persist the immutable outcome of a successful container upload so a
 * retry can reuse the EXISTING DataItem instead of creating (and
 * re-signing) a new one. Only a fully well-formed outcome is written; a
 * malformed write is skipped and degrades to a normal upload.
 */
function writeCachedContainerOutcome(
  capsuleId: string,
  outcome: { containerTxId: string; chunkIds: readonly string[]; layoutDigest: string }
): void {

  try {

    if (
      typeof outcome.containerTxId !== "string" ||
      !Array.isArray(outcome.chunkIds) ||
      outcome.chunkIds.length === 0 ||
      typeof outcome.layoutDigest !== "string"
    ) {
      return;
    }

    assertArweaveTxId(outcome.containerTxId);

    if (!SHA256_REGEX.test(outcome.layoutDigest)) {
      return;
    }

    sessionStorage.setItem(
      containerCacheKey(capsuleId),
      JSON.stringify({
        containerTxId: outcome.containerTxId,
        chunkIds: [...outcome.chunkIds],
        layoutDigest: outcome.layoutDigest,
      })
    );

  } catch {

    // Intentional no-op: cache failure degrades to re-upload on retry.

  }

}

function clearCachedContainerOutcome(capsuleId: string): void {

  try {

    sessionStorage.removeItem(containerCacheKey(capsuleId));

  } catch {

    // Intentional no-op: cleanup failure must not alter fail-closed path.

  }

}

function finalizationDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
}

/**
 * Operation-level deadline for the discrete `POST /api/capsule/seal`.
 *
 * This bounds ONE request — never the capsule preparation, the upload
 * duration, or the whole `/create/hold` page. The seal endpoint is
 * server-side KV + WebCrypto only (no outbound network fetch), so it
 * settles in tens of milliseconds in normal operation; 8 s is generous
 * against KV latency spikes while still far below "forever".
 *
 * The value intentionally matches the project's canonical bounded-HTTP
 * constant (`IRYS_NODE_TIMEOUT_MS` / `GATEWAY_TIMEOUT` = 8000) rather
 * than inventing a new convention. An `AbortController` timed by
 * `setTimeout` aborts the request so a never-settling response rejects
 * into the existing `!sealRes.ok` / `finalizeSealing` catch path
 * instead of hanging the page indefinitely.
 */
const SEAL_REQUEST_TIMEOUT_MS = 8_000;

/**
 * `fetch` for the seal endpoint with an operation-level abort deadline.
 *
 * The server-side seal is idempotent/retry-safe, so an aborted request
 * can be retried verbatim without duplicating the seal. A timeout here is
 * a CLIENT-side observation failure ("this request did not settle"),
 * never a statement that the capsule took too long.
 */
async function fetchSealWithDeadline(
  body: Record<string, unknown>
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEAL_REQUEST_TIMEOUT_MS);

  try {
    return await fetch("/api/capsule/seal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}


/**
 * POST a JSON body to a same-origin Cloudflare Function with an
 * operation-level abort deadline.
 *
 * Bound at the SAME 8 s value as the seal request: every endpoint
 * routed through here (`/api/publication/verify`, `/api/seal/verify`,
 * `/api/creator/finalize-credit`) is a same-origin Function whose own
 * outbound calls are already internally bounded (Irys node 8 s). A
 * client-side deadline only converts a genuinely non-settling request
 * into a rejection; the callers' existing retry-on-transport-failure
 * behaviour is unchanged, and a real HTTP error response is still
 * returned intact (the deadline never rewrites a status).
 */
async function postJson(
  url: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEAL_REQUEST_TIMEOUT_MS);

  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

/**
 * Server-authoritative publication verification. Retryable while the
 * server reports a transient fetch/hash state (502); any other
 * non-VERIFIED outcome (REJECTED, mismatch, unreserved lifecycle)
 * is terminal and must NOT proceed to the irreversible seal.
 */
async function verifyPublicationOrThrow(
  creatorIdentityId: string,
  canonicalLifecycleId: string,
  capsuleId: string,
  publicationId: string
): Promise<void> {

  for (let attempt = 1; ; attempt++) {

    let res: { status: number; json: Record<string, unknown> | null };

    try {

      res = await postJson(
        "/api/publication/verify",
        {
          creatorIdentityId,
          lifecycleId: canonicalLifecycleId,
          capsuleId,
          publicationId,
        }
      );

    } catch {

      if (attempt >= FINALIZATION_MAX_ATTEMPTS) sealedError();
      await finalizationDelay(attempt);
      continue;

    }

    if (
      res.status === 200 &&
      res.json?.['ok'] === true &&
      res.json['state'] === "VERIFIED"
    ) {
      return;
    }

    if (res.status === 502 && attempt < FINALIZATION_MAX_ATTEMPTS) {
      await finalizationDelay(attempt);
      continue;
    }

    sealedError();

  }

}

async function verifySealOrThrow(
  creatorIdentityId: string,
  canonicalLifecycleId: string,
  capsuleId: string,
  manifest: ManifestV1
): Promise<void> {

  for (let attempt = 1; ; attempt++) {

    let res: { status: number; json: Record<string, unknown> | null };

    try {

      res = await postJson(
        "/api/seal/verify",
        {
          creatorIdentityId,
          lifecycleId: canonicalLifecycleId,
          capsuleId,
          manifest,
        }
      );

    } catch {

      if (attempt >= FINALIZATION_MAX_ATTEMPTS) sealedError();
      await finalizationDelay(attempt);
      continue;

    }

    if (
      res.status === 200 &&
      res.json?.['ok'] === true &&
      res.json['state'] === "VERIFIED"
    ) {
      return;
    }

    if (res.status >= 500 && attempt < FINALIZATION_MAX_ATTEMPTS) {
      await finalizationDelay(attempt);
      continue;
    }

    sealedError();

  }

}

/**
 * Finalization is idempotent (CONSUMED / ALREADY_CONSUMED both count
 * as success). A retryable failure after a successful seal never
 * rolls the seal back — the caller receives finalizationPending and
 * finalization completes on a later idempotent retry. Terminal
 * binding mismatches fail closed.
 */
async function finalizeCreditOrPending(
  creatorIdentityId: string,
  canonicalLifecycleId: string,
  capsuleId: string
): Promise<boolean> {

  for (let attempt = 1; ; attempt++) {

    let res: { status: number; json: Record<string, unknown> | null };

    try {

      res = await postJson(
        "/api/creator/finalize-credit",
        {
          creatorIdentityId,
          lifecycleId: canonicalLifecycleId,
          capsuleId,
        }
      );

    } catch {

      if (attempt >= FINALIZATION_MAX_ATTEMPTS) return false;
      await finalizationDelay(attempt);
      continue;

    }

    if (
      res.status === 200 &&
      res.json?.["ok"] === true
    ) {
      const outcome = res.json['outcome'];
      if (outcome === "CONSUMED" || outcome === "ALREADY_CONSUMED") {
        return true;
      }
    }

    if (res.status === 409) {
      const error = String(res.json?.["error"] ?? res.json?.["outcome"] ?? "");
      if (error === "PUBLICATION_NOT_VERIFIED" || error === "SEAL_NOT_VERIFIED") {
        if (attempt < FINALIZATION_MAX_ATTEMPTS) {
          await finalizationDelay(attempt);
          continue;
        }
        return false;
      }
      sealedError();
    }

    if (res.status >= 500 && attempt < FINALIZATION_MAX_ATTEMPTS) {
      await finalizationDelay(attempt);
      continue;
    }

    return false;

  }

}

import {
  MAX_ENCRYPTED_VAULT_SIZE
} from "@/lib/crypto/constants";

/**
 * Canonical detached-buffer guard.
 *
 * A Uint8Array can appear non-empty at the view level (byteLength > 0)
 * while its backing ArrayBuffer has been neutered (buffer.byteLength === 0)
 * via structured-clone transfer, SharedArrayBuffer detachment, or
 * runtime GC edge cases. Checking both axes is the dual-semantic standard
 * used throughout Layer 2 / Layer 3 / Layer 4 of this protocol.
 */
function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return (
    arr.byteLength === 0 ||
    arr.buffer.byteLength === 0
  );

}

function asSaltBaseHex(
  value: string
): SaltBaseHex {

  if (!SALT_BASE_REGEX.test(value)) {
    sealedError();
  }

  return value as SaltBaseHex;

}

function asSha256Hex(
  value: string
): Sha256Hex {

  if (!SHA256_REGEX.test(value)) {
    sealedError();
  }

  return value as Sha256Hex;

}

function asCapsuleId(
  value: string
): CapsuleId {

  if (!CAPSULE_ID_REGEX.test(value)) {
    sealedError();
  }

  return value as CapsuleId;

}

function asOpenAtUtc(
  value: number
): OpenAtUtc {

  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIME ||
    value > MAX_TIME
  ) {
    sealedError();
  }

  return value as OpenAtUtc;

}

function asSealedAtUtc(
  value: number
): SealedAtUtc {

  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIME ||
    value > MAX_TIME
  ) {
    sealedError();
  }

  return value as SealedAtUtc;

}

const MIN_TIME =
  1577836800000;

const MAX_TIME =
  4102444800000;

/* ================================================
   RETRY-SAFE SEAL MANIFEST CACHE (Finding 2)
   ================================================ */


/**
 * Per-capsule persisted canonical manifest.
 *
 * Written immediately before the seal POST, after all publication and
 * verification succeeded. If that POST's response is lost, a retry
 * resubmits this exact manifest (original sealedAt/heartbeatInterval)
 * so the server accepts it idempotently instead of rejecting with
 * MANIFEST_ALREADY_EXISTS_DIFFERENT.
 */

const SEAL_MANIFEST_KEY_PREFIX =
  "aeterna-seal-manifest:";

function sealManifestCacheKey(
  capsuleId: string
): string {

  return `${SEAL_MANIFEST_KEY_PREFIX}${capsuleId}`;

}

function persistSealManifest(
  capsuleId: string,
  manifest: ManifestV1
): void {

  try {

    sessionStorage.setItem(
      sealManifestCacheKey(capsuleId),
      JSON.stringify(manifest)
    );

  } catch {

    // Non-fatal: the cache is a retry-safety optimization only.

  }

}

function readPersistedSealManifest(
  capsuleId: string
): ManifestV1 | null {

  try {

    const raw =
      sessionStorage.getItem(
        sealManifestCacheKey(capsuleId)
      );

    if (!raw) {
      return null;
    }

    const parsed: unknown =
      JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    return parsed as ManifestV1;

  } catch {

    return null;

  }

}

function clearPersistedSealManifest(
  capsuleId: string
): void {

  try {

    sessionStorage.removeItem(
      sealManifestCacheKey(capsuleId)
    );

  } catch {

    // Non-fatal.

  }

}

/**
 * Strict identity + shape validation of a persisted seal manifest
 * against the current prepared inputs.
 *
 * A persisted manifest is reusable ONLY when it is the exact canonical
 * manifest of THIS prepared capsule — identical capsuleId, saltBase,
 * openAt, encryptedSizeBytes, and ext.vaultSha256 — with a structurally
 * valid vault pointer and temporal invariants. Anything else fails
 * closed to the fresh seal path.
 */
function isReusableSealManifest(
  manifest: unknown,
  current: {
    capsuleId: string;
    saltBase: string;
    openAt: number;
    encryptedSizeBytes: number;
    vaultSha256: string;
  }
): manifest is ManifestV1 {

  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.getPrototypeOf(manifest) !== Object.prototype
  ) {
    return false;
  }

  const m =
    manifest as Record<string, unknown>;

  if (
    m["version"] !== MANIFEST_VERSION ||
    m["capsuleId"] !== current.capsuleId ||
    m["saltBase"] !== current.saltBase ||
    m["openAt"] !== current.openAt ||
    m["encryptedSizeBytes"] !== current.encryptedSizeBytes
  ) {
    return false;
  }

  if (
    typeof m["sealedAt"] !== "number" ||
    !Number.isSafeInteger(m["sealedAt"]) ||
    (m["sealedAt"] as number) < MIN_TIME ||
    (m["sealedAt"] as number) > MAX_TIME ||
    (m["openAt"] as number) <= (m["sealedAt"] as number)
  ) {
    return false;
  }

  if (typeof m["vaultTxId"] !== "string") {
    return false;
  }

  try {
    assertStoragePointer(m["vaultTxId"]);
  } catch {
    return false;
  }

  if (
    typeof m["heartbeatInterval"] !== "number" ||
    !Number.isSafeInteger(m["heartbeatInterval"])
  ) {
    return false;
  }

  const ext = m["ext"];

  if (
    !ext ||
    typeof ext !== "object" ||
    Array.isArray(ext) ||
    Object.getPrototypeOf(ext) !== Object.prototype
  ) {
    return false;
  }

  const extObj =
    ext as Record<string, unknown>;

  if (
    extObj["vaultSha256"] !== current.vaultSha256 ||
    typeof extObj["vaultSha256"] !== "string" ||
    !SHA256_REGEX.test(extObj["vaultSha256"] as string)
  ) {
    return false;
  }

  return true;

}

/**
 * Deterministic creator-authority fragment derivation.
 *
 * Extracted so the fresh-seal path and the retry-reuse path share the
 * exact same derivation. The temporary hex-decoded buffer is wiped on
 * every exit path.
 */
async function deriveCreatorFragment(
  creatorAuthority: string
): Promise<string> {

  const authorityHex =
    creatorAuthority.match(/[0-9a-f]{2}/gi);

  if (!authorityHex) {
    sealedError();
  }

  const authorityBytes =
    new Uint8Array(
      authorityHex.map(
        byte => parseInt(byte, 16)
      )
    );

  try {

    if (authorityBytes.length !== 32)
      sealedError();

    return await deriveCreatorAuthorityFragment(
      authorityBytes
    );

  } finally {

    // wipe temporary hex-decoded buffer on every exit path
    authorityBytes.fill(0);

  }

}

export async function sealCapsuleCore(

  params: {

    capsuleId: string;

    saltBase: string;

    recipientSecret: string;

    creatorAuthority: string;

    openAt: number;

    description?: string;

    uploadToken: string;

    canonicalLifecycleId: string;

    creatorIdentityId: string;

    /**
     * Phase D2b — storage DI. Storage is required for the sealing
     * path: the Creator-paid canonical caller injects the
     * creatorIrysStorage adapter. There is no Executor write-path
     * fallback and no default singleton.
     */
    storage: StorageAdapter;

    encryptedVaultPointer:
      string;

    encryptedSizeBytes:
      number;

    vaultSha256:
      string;

    runtime:
      RuntimeStorage;

    chunkMetadata:
      readonly ChunkMetadata[];

  }

): Promise<SealCapsuleResult> {

  const {

    capsuleId,
    saltBase,
    openAt,
    description,
    uploadToken,
    canonicalLifecycleId,
    creatorIdentityId,
    encryptedVaultPointer,
    encryptedSizeBytes,
    vaultSha256,

    runtime,
    chunkMetadata

  } = params;

  let {

    recipientSecret,
    creatorAuthority

  } = params;

  // Phase D2b — storage DI: storage is required; the Creator-paid
  // canonical caller injects creatorIrysStorage. There is no Executor
  // write-path fallback. Protocol logic does not know which
  // implementation runs.
  const storageAdapter: StorageAdapter = params.storage;

  let encryptedPayload: Uint8Array | null = null;

  try {

    if (!crypto?.subtle)
      sealedError();

    const refinedCapsuleId =
      asCapsuleId(
        capsuleId
      );

    const refinedLocalVaultPointer =
      assertLocalVaultPointer(
        encryptedVaultPointer
      );

    const pointerCapsuleId =
      localVaultPointerCapsuleId(
        refinedLocalVaultPointer
      );

    if (
      pointerCapsuleId !==
      refinedCapsuleId
    ) {
      sealedError();
    }

    /**
     * Read temporary encrypted Vault from local runtime.
     */

    encryptedPayload =
      await runtime.readVault(
        capsuleId
      );

    if (
      !(encryptedPayload instanceof Uint8Array) ||
      isDetachedBuffer(encryptedPayload)
    ) {
      sealedError();
    }

    const refinedSaltBase =
      asSaltBaseHex(
        saltBase
      );

    const refinedVaultSha256 =
      asSha256Hex(
        vaultSha256
      );

    if (
      !Number.isSafeInteger(encryptedSizeBytes) ||
      encryptedSizeBytes <= 0
    ) {
      sealedError();
    }

    if (
      encryptedSizeBytes >
      MAX_ENCRYPTED_VAULT_SIZE
    )
      sealedError();

    if (
      encryptedPayload.byteLength !==
      encryptedSizeBytes
    ) {
      sealedError();
    }

    /**
     * derive confirmation authority fragment
     * BEFORE creatorAuthority is released — derive creator confirmation
     * fragment from creatorAuthority. Fragment allows creator to confirm
     * delivery without exposing creatorAuthority.
     *
     * The temporary hex-decoded buffer (authorityBytes) is wiped in a
     * finally block so it is scrubbed on every exit path, including
     * an exception thrown by deriveCreatorAuthorityFragment().
     */

    const creatorAuthorityFragment =
      await deriveCreatorFragment(
        creatorAuthority
      );

    /**
     * upload encrypted vault FIRST
     */

    const token =
      asUploadToken(
        uploadToken
      );

    /**
     * FINDING 2 — retry-safe seal reuse.
     *
     * If a previous attempt already persisted the canonical manifest
     * for this capsuleId (same PREPARED identity), resubmit that
     * manifest VERBATIM instead of deriving a new sealedAt from
     * trusted time. Reusing the original sealedAt/heartbeatInterval
     * keeps the retry byte-identical, so the server's idempotency
     * path accepts it (200) instead of returning
     * MANIFEST_ALREADY_EXISTS_DIFFERENT (409).
     *
     * No chunk/vault upload is repeated: the persisted manifest exists
     * only after a previous attempt completed all publication and
     * verification. If the persisted manifest no longer matches the
     * current prepared inputs, this fails closed to the fresh path.
     */
    const persistedManifest =
      readPersistedSealManifest(capsuleId);

    if (
      persistedManifest &&
      isReusableSealManifest(
        persistedManifest,
        {
          capsuleId,
          saltBase: refinedSaltBase,
          openAt,
          encryptedSizeBytes,
          vaultSha256: refinedVaultSha256,
        }
      )
    ) {

      const reusedManifest =
        deepFreeze(persistedManifest);

      const sealRes =
        await withSealStage(
          "SEAL_API",
          () =>
            fetchSealWithDeadline({
              uploadToken: token,
              manifest: reusedManifest,
              creatorAuthorityFragment,
            })
        );

      if (!sealRes.ok) {

        const text =
          await sealRes.text();

        if (import.meta.env.DEV) {
          console.error(
            "[AETERNA] seal endpoint failed (reuse):",
            sealRes.status,
            text
          );
        }

        sealedError();

      }

      // Reuse path: the publication was verified before the original
      // seal commit — no re-upload, no second publication, no second
      // manifest. Only the idempotent seal verify + finalize run here.
      await withSealStage(
        "SEAL_VERIFY",
        () =>
          verifySealOrThrow(
            creatorIdentityId,
            canonicalLifecycleId,
            capsuleId,
            reusedManifest
          )
      );

      const finalized =
        await withSealStage(
          "FINALIZE_CREDIT",
          () =>
            finalizeCreditOrPending(
              creatorIdentityId,
              canonicalLifecycleId,
              capsuleId
            )
        );

      // Retry caches are cleared only on full finalization. While
      // finalization is pending, the persisted manifest and txId
      // cache must survive so re-entry can reuse the existing
      // idempotent path instead of starting over.
      if (finalized) {

        try {
          sessionStorage.removeItem(
            `aeterna-vault-txid:${capsuleId}`
          );
        } catch {
          // Intentional no-op: cleanup failure must not alter fail-closed path.
        }

        clearCachedContainerOutcome(capsuleId);

        clearPersistedSealManifest(capsuleId);

      }

      const recipientLink =
        `/capsule/${capsuleId}#${recipientSecret}`;

      const confirmationLink =
        `/capsule/${capsuleId}#${recipientSecret}&c=${creatorAuthorityFragment}`;

      return {
        capsuleId,
        manifest: reusedManifest,
        recipientLink,
        confirmationLink,
        finalized,
        finalizationPending: !finalized,
      };

    }

    /**
     * Canonical media upload — an EXPLICIT, content-based branch.
     *
     * The channel is decided from the capsule's OWN chunk metadata, BEFORE
     * any upload is attempted — never from a failed upload and never from
     * the absence of a record:
     *
     *   • chunkMetadata.length > 0  → Container V1: the whole media payload
     *     is published as ONE container DataItem and claimed with ONE
     *     container publication claim. There is deliberately NO per-chunk
     *     fallback: an adapter that cannot upload containers fails closed
     *     rather than silently degrading.
     *
     *   • chunkMetadata.length === 0 → Vault-only: a text-only capsule has
     *     no media bytes, so there is no container to build and no
     *     publication to claim. Its content already lives in the Vault,
     *     which the unconditional Vault upload below publishes.
     *
     * This is NOT a fallback and NOT a silent degradation: the zero-chunk
     * case never calls uploadContainer() and never reacts to a container
     * error. A capsule that HAS chunks still takes the container path and
     * still fails closed on any container failure.
     */
    if (chunkMetadata.length > 0) {
      if (
        typeof storageAdapter.uploadContainer !==
        "function"
      ) {
        throw new Error(
          "[AETERNA] The storage adapter cannot upload containers"
        );
      }

      /**
       * Container retry cache — reuse an ALREADY-published container.
       *
       * If a previous attempt already uploaded the container DataItem
       * (ONE signature) and a LATER stage then failed, this re-enters
       * the container branch. A cached, well-formed outcome lets the
       * flow SKIP `uploadContainer()` entirely: no new DataItem, no
       * second Phantom `signMessage` prompt. The reused outcome carries
       * the same chunkIds/layoutDigest and is re-validated by
       * `assertSealUploadOutcome()` below exactly like a fresh upload,
       * so a capsule whose media changed since the upload fails closed
       * rather than silently reusing a stale container.
       *
       * A missing / malformed / ambiguous cache returns null and falls
       * through to a normal first upload. The cache NEVER invents a
       * txId.
       */
      const cachedContainerOutcome =
        readCachedContainerOutcome(capsuleId);

      const containerOutcome =
        cachedContainerOutcome !== null
          ? cachedContainerOutcome
          : await withSealStage(
              "CONTAINER_UPLOAD_UNKNOWN",
              () =>
                storageAdapter.uploadContainer(
                  runtime,
                  chunkMetadata,
                  token
                )
            );

      /**
       * Record the immutable outcome ONLY when this call actually
       * performed the upload — a reused cache entry is already stored
       * and must not be rewritten (it is byte-identical anyway).
       */
      if (cachedContainerOutcome === null) {
        writeCachedContainerOutcome(capsuleId, {
          containerTxId: containerOutcome.containerTxId,
          chunkIds: containerOutcome.chunkIds,
          layoutDigest: containerOutcome.layoutDigest,
        });
      }

      /**
       * Stage 4 — media upload outcome contract, container mode.
       *
       * N logical chunks → 1 physical container publication. The contract
       * verifies the published set IS the expected set, that every chunk is
       * represented exactly once, and that a multi-chunk capsule is not
       * published as a single-chunk container.
       */
      assertSealUploadOutcome(chunkMetadata, {
        mode: "container",
        containerChunkIds: containerOutcome.chunkIds,
      });
    }

    const nowUtc =
      await getTrustedTime();

    const sealedAt =
      asSealedAtUtc(
        nowUtc.nowUtc
      );

    /**
     * Canonical heartbeatInterval (Complete System Logic, "Heartbeat
     * Specification"; ManifestV1.heartbeatInterval is UtcMs).
     *
     * The value is the RAW originally-selected opening interval
     * (openAt - sealedAt) in UTC MILLISECONDS, fixed at sealing time.
     *
     * There is deliberately NO division by 60000, NO rounding, and NO
     * Math.max(1, …) clamp: the previous minutes conversion contradicted
     * the canonical millisecond semantics and produced a value below the
     * canonical lower bound (1 day) enforced by the seal endpoint.
     */
    const heartbeatInterval =
      (openAt - sealedAt) as HeartbeatInterval;

    /**
     * Vault upload with lost-response retry cache.
     *
     * A lost upload response leaves a server-side PENDING publication
     * record the browser does not know about. Re-uploading would be
     * rejected (PUBLICATION_ALREADY_BOUND). The txId is cached in
     * sessionStorage immediately after a successful upload and BEFORE
     * publication verification, so a re-invocation reuses it instead
     * of re-uploading. The cached txId is evidence only: the server
     * still compares it against its own authoritative PENDING record,
     * so a stale/poisoned cache fails closed at verification.
     */

    const cachedTxId =
      readCachedVaultTxId(
        capsuleId
      );

    let txId: ArweaveTxId;

    if (cachedTxId !== null) {

      txId = cachedTxId;

    } else {

      // Bind the narrowed payload to a const: the diagnostic wrapper is a
      // closure, and TypeScript does not carry a `let` narrowing into one.
      const vaultPayload = encryptedPayload;

      const vaultTxId =
        await withSealStage(
          "VAULT_UPLOAD",
          () =>
            storageAdapter.upload(
              vaultPayload,
              token
            )
        );

      txId =
        asArweaveTxId(
          vaultTxId.txId
        );

      try {

        sessionStorage.setItem(
          `aeterna-vault-txid:${capsuleId}`,
          txId
        );

      } catch {
        // Intentional no-op: cache failure degrades to re-upload on retry.
      }

    }

    const refinedTxId =
      txId;

    /**
     * Canonical order: server-authoritative publication verification
     * MUST complete before the irreversible seal commit. The txId is
     * submitted as evidence only — the server verifies against its
     * own PENDING record created by /api/publication/claim.
     */
    await withSealStage(
      "PUBLICATION_VERIFY",
      () =>
        verifyPublicationOrThrow(
          creatorIdentityId,
          canonicalLifecycleId,
          capsuleId,
          txId
        )
    );

    const manifest: ManifestV1 =
      deepFreeze({

        version:
          MANIFEST_VERSION,

        capsuleId:
          refinedCapsuleId,

        ...(typeof description === "string" &&
        description.length > 0
          ? { description }
          : {}),

        saltBase:
          refinedSaltBase,

        sealedAt,

        openAt:
          asOpenAtUtc(
            openAt
          ),

        vaultTxId:
          refinedTxId,

        encryptedSizeBytes,

        heartbeatInterval,

        ext: {

          vaultSha256:
            refinedVaultSha256,

        },

      });

    /**
     * Fail-closed heartbeat invariant (client-side, pre-POST).
     *
     * The seal endpoint rejects a manifest whose
     * heartbeatInterval = openAt - sealedAt is outside the canonical
     * bounds (>= 1 day, <= 100 years) with 400 INVALID_HEARTBEAT. That
     * request is guaranteed unusable, so it MUST NOT be sent: validate
     * locally with the canonical guard and abort with the generic seal
     * failure BEFORE persisting the manifest or hitting the network.
     *
     * This is the canonical, purpose-built heartbeat validator
     * (assertHeartbeatConsistency -> assertHeartbeatIntervalBounds);
     * it is deliberately reused rather than re-derived here so the
     * client and the seal endpoint share one source of truth.
     */
    try {
      assertHeartbeatConsistency(manifest);
    } catch {
      sealedError();
    }

    /**
     * Publish manifest with retry-safe manifest cache.
     *
     * The manifest is persisted BEFORE the seal POST so that a
     * lost response can be retried verbatim.
     */

    persistSealManifest(
      capsuleId,
      manifest
    );

    const sealRes =
      await withSealStage(
        "SEAL_API",
        () =>
          fetchSealWithDeadline({
            uploadToken: token,
            manifest,
            creatorAuthorityFragment,
          })
      );

    if (!sealRes.ok) {

      const text =
        await sealRes.text();

      if (import.meta.env.DEV) {
        console.error(
          "[AETERNA] seal endpoint failed:",
          sealRes.status,
          text
        );
      }

      sealedError();

    }

    await withSealStage(
      "SEAL_VERIFY",
      () =>
        verifySealOrThrow(
          creatorIdentityId,
          canonicalLifecycleId,
          capsuleId,
          manifest
        )
    );

    const finalized =
      await withSealStage(
        "FINALIZE_CREDIT",
        () =>
          finalizeCreditOrPending(
            creatorIdentityId,
            canonicalLifecycleId,
            capsuleId
          )
      );

    try {

      await runtime.removeVault(
        capsuleId
      );

    } catch {
      // Intentional no-op: cleanup failure must not alter fail-closed path.
    }

    // Retry caches are cleared only on full finalization. While
    // finalization is pending, the persisted manifest and txId cache
    // must survive so re-entry can reuse the existing idempotent
    // path instead of starting over.
    if (finalized) {

      try {

        sessionStorage.removeItem(
          `aeterna-vault-txid:${capsuleId}`
        );

      } catch {
        // Intentional no-op.
      }

      clearCachedContainerOutcome(capsuleId);

      clearPersistedSealManifest(capsuleId);

    }

    const recipientLink =
      `/capsule/${capsuleId}#${recipientSecret}`;

    const confirmationLink =
      `/capsule/${capsuleId}#${recipientSecret}&c=${creatorAuthorityFragment}`;

    return {

      capsuleId,
      manifest,
      recipientLink,
      confirmationLink,
      finalized,
      finalizationPending: !finalized,

    };

  }

  catch (error) {

    /**
     * Diagnostic stage preservation — CRITICAL ORDERING.
     *
     * Each inner boundary tags the failure with the exact stage BEFORE it
     * reaches here; that tag is read FIRST and never overwritten, so the
     * original failure is classified before anything is masked. Only a
     * failure no boundary claimed falls back to SEAL_UNKNOWN.
     *
     * The propagated error carries ONLY the fixed public message and the
     * code — never the original exception, its message, or any payload it
     * may hold (tokens, URLs, bodies, plaintext).
     *
     * Fail-closed is unchanged: this catch still throws, exactly as the
     * previous `sealedError()` did.
     */
    throw tagSealFailure(error, "SEAL_UNKNOWN");

  }

  finally {

    /**
     * FIX 4 (revised) — wipe the ciphertext buffer at the very end of
     * the function lifecycle, not mid-flow. This guarantees the buffer
     * stays alive and intact for the full duration of upload/verify/
     * seal, immune to any future reordering, retry logic, or lazy-read
     * pattern introduced upstream of this line. Symmetric with how
     * recipientSecret / creatorAuthority / authorityBytes are already
     * scrubbed only once their last use has passed.
     *
     * Guarded with isDetachedBuffer(): a detached/neutered buffer throws
     * on .fill(), and finally blocks must never throw — an exception
     * here would mask the original error (or silently replace a clean
     * return) and break the fail-safe guarantee this cleanup exists for.
     */

    if (
      encryptedPayload &&
      !isDetachedBuffer(encryptedPayload)
    ) {
      encryptedPayload.fill(0);
    }

    recipientSecret = "";
    creatorAuthority = "";

  }

}
