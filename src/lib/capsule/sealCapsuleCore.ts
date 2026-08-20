import type {
  RuntimeStorage,
} from "@/lib/runtime/runtimeStorage";

import { storage } from "@/lib/storage";

import {
  uploadPreparedChunks,
} from "@/lib/storage/uploadPreparedChunks";

import {
  MANIFEST_VERSION
} from "@/types/manifest";

import type {
  ManifestV1,
  OpenAtUtc,
  SealedAtUtc,
  CapsuleId,
  SaltBaseHex,
  Sha256Hex,
  ArweaveTxId,
  HeartbeatInterval
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

import { getTrustedTime } from "@/shared/time/getTrustedTime";


export interface SealCapsuleResult {

  capsuleId: string;

  manifest: ManifestV1;

  recipientLink: string;

  confirmationLink: string;

}


const SEALED_ERROR =
  new Error("[AETERNA] Capsule sealing failed");


function sealedError(): never {

  throw SEALED_ERROR;

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

    encryptedPayload:
      Uint8Array;

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

    encryptedPayload,
    encryptedSizeBytes,
    vaultSha256,

    runtime,
    chunkMetadata

  } = params;

  let {

    recipientSecret,
    creatorAuthority

  } = params;


  try {

    if (!crypto?.subtle)
      sealedError();


    if (!CAPSULE_ID_REGEX.test(capsuleId))
      sealedError();


    /**
     * enforce canonical HEX64 invariant for both capability secrets.
     * rev3: recipientSecret and creatorAuthority are independently
     * generated upstream (no longer one derived from the other), so
     * each is validated on its own here.
     */

    if (
      !SHA256_REGEX.test(recipientSecret) ||
      !SHA256_REGEX.test(creatorAuthority)
    ) {
      sealedError();
    }


    /**
     * openAt bounds validation
     */

    if (
      !Number.isSafeInteger(openAt) ||
      openAt < MIN_TIME ||
      openAt > MAX_TIME
    ) {
      sealedError();
    }


    const token =
      asUploadToken(uploadToken);

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
          saltBase,
          openAt,
          encryptedSizeBytes,
          vaultSha256,
        }
      )
    ) {

      const reusedManifest =
        deepFreeze(persistedManifest);

      const creatorAuthorityFragment =
        await deriveCreatorFragment(
          creatorAuthority
        );

      const sealRes =
        await fetch(
          "/api/capsule/seal",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              uploadToken: token,
              manifest: reusedManifest,
              creatorAuthorityFragment,
            }),
          }
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

      // Seal confirmed idempotently — clear the retry caches.
      try {
        sessionStorage.removeItem(
          `aeterna-vault-txid:${capsuleId}`
        );
      } catch {
        // Intentional no-op: cleanup failure must not alter fail-closed path.
      }

      clearPersistedSealManifest(capsuleId);

      const recipientLink =
        `/capsule/${capsuleId}#${recipientSecret}`;

      const confirmationLink =
        `/capsule/${capsuleId}#${recipientSecret}&c=${creatorAuthorityFragment}`;

      return {
        capsuleId,
        manifest: reusedManifest,
        recipientLink,
        confirmationLink,
      };

    }

    const uploadedChunks =
      await uploadPreparedChunks(
        runtime,
        chunkMetadata,
        token
      );


    if (
      uploadedChunks.length !==
      chunkMetadata.length
    ) {
      throw new Error(
        "[AETERNA] Chunk upload count mismatch"
      );
    }

    const uniqueChunkIds =
      new Set(
        uploadedChunks.map(
          chunk => chunk.chunkId
        )
      );

    if (
      uniqueChunkIds.size !==
      uploadedChunks.length
    ) {
      throw new Error(
        "[AETERNA] Duplicate chunk upload"
      );
    }

    /**
     * RFC-001 §7 — Publication invariant.
     *
     * The count-equality and uploaded-side uniqueness checks above are
     * not sufficient on their own: a chunkMetadata input with a
     * repeated chunkId could still satisfy both while producing a
     * chunkPointers map with fewer entries than chunkMetadata.length.
     *
     * The full invariant requires BOTH sides to be duplicate-free AND
     * their chunkId sets to be exactly equal — no extra keys, no
     * missing keys (RFC-001 §4, §7).
     */

    const uniqueSourceChunkIds =
      new Set(
        chunkMetadata.map(
          chunk => chunk.chunkId
        )
      );

    if (
      uniqueSourceChunkIds.size !==
      chunkMetadata.length
    ) {
      throw new Error(
        "[AETERNA] Duplicate chunkId in chunkMetadata"
      );
    }

    /**
     * Set-equality check.
     *
     * Both sides have already been proven duplicate-free above
     * (uniqueSourceChunkIds.size === chunkMetadata.length and
     * uniqueChunkIds.size === uploadedChunks.length). Given that
     * precondition, equal set sizes plus full inclusion in one
     * direction (every source chunkId present in the uploaded set)
     * is equivalent to strict set equality — there is no way for
     * either set to contain an element absent from the other while
     * both conditions hold.
     */

    if (
      uniqueSourceChunkIds.size !==
        uniqueChunkIds.size ||
      ![...uniqueSourceChunkIds].every(
        chunkId => uniqueChunkIds.has(chunkId)
      )
    ) {
      throw new Error(
        "[AETERNA] chunkId set mismatch between chunkMetadata and uploaded chunks"
      );
    }

    const normalizedDescription =
      typeof description === "string" &&
      description.trim().length > 0
        ? description.trim()
        : "";


    if (normalizedDescription.length > 500)
      sealedError();


    /**
     * trusted-time boundary
     *
     * Time authority is always /api/time — never caller-supplied.
     * MUST occur before any temporal comparison.
     */

    const { nowUtc } =
      await getTrustedTime();


    if (
      !Number.isSafeInteger(nowUtc) ||
      nowUtc < MIN_TIME ||
      nowUtc > MAX_TIME
    ) {
      sealedError();
    }


    if (nowUtc >= openAt)
      sealedError();


    /**
     * validate incoming encryptedPayload, saltBase, vaultSha256, encryptedSizeBytes
     * from canonical preparation phase — no re-encryption in seal phase.
     */

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


    /**
     * upload encrypted vault FIRST
     */

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

    /**
     * FIX 3 — strict hex-pair matching.
     * creatorAuthority is already validated against SHA256_REGEX above,
     * so this is defense-in-depth rather than a functional change: the
     * strict [0-9a-f]{2} pairing keeps the split self-contained and
     * independent of that earlier validation, matching the same
     * "re-assert within the boundary that consumes it" pattern used
     * in the VERIFYING phase below.
     */

    const creatorAuthorityFragment =
      await deriveCreatorFragment(
        creatorAuthority
      );


    /**
     * Retry-safe upload reuse.
     *
     * If a previous upload already succeeded,
     * reuse the existing vaultTxId instead of
     * creating a new upload during retry.
     */

    let vaultTxId: ArweaveTxId | null = null;

    try {

      const existingVaultTxId =
        sessionStorage.getItem(
          `aeterna-vault-txid:${capsuleId}`
        );

      if (
        typeof existingVaultTxId === "string" &&
        existingVaultTxId.length === 43
      ) {

        const pointer =
          assertStoragePointer(
            existingVaultTxId
          );

        vaultTxId =
          asArweaveTxId(pointer);

      }

    } catch {
      // Intentional no-op: cleanup failure must not alter fail-closed path.
    }


    if (!vaultTxId) {

      const uploadResult =
        await storage.upload(
          encryptedPayload,
          token
        );


      const pointer =
        assertStoragePointer(
          uploadResult.txId
        );


      vaultTxId =
        asArweaveTxId(pointer);


      try {

        sessionStorage.setItem(
          `aeterna-vault-txid:${capsuleId}`,
          vaultTxId
        );

      } catch {
        // Intentional no-op: cleanup failure must not alter fail-closed path.
      }

    }
     
    /* ───────────────────────────────────────────────
       STEP — Storage Authority Established

     Ciphertext publication has completed successfully.

     At this point:

     • encrypted chunks have been published;
     • the encrypted Vault has been published;
     • storage pointers now exist;
     • Chunk Pointer Registry has been established.

     Manifest Authority has NOT yet been created.

     The next protocol boundary is Verification.
      ─────────────────────────────────────────────── */

    /**
     * ── VERIFYING ──────────────────────────────────────────────────
     *
     * Explicit integrity verification boundary.
     *
     * Spec requires VERIFYING to complete before:
     *   - manifest persistence
     *   - seal confirmation
     *   - capability issuance
     *
     * Each check is independent so the failure site is unambiguous.
     *
     * Flow: ENCRYPT → HASH → UPLOAD → VERIFY → MANIFEST → SEAL → CAPABILITY
     */

    /**
     * payload liveness — canonical dual detached-buffer guard.
     *
     * Checks both view-level byteLength and backing buffer byteLength
     * via isDetachedBuffer(). Guards against neutering that may have
     * occurred between upload completion and this verification boundary
     * (structured-clone transfer, async GC edge cases).
     */

    if (
      !(encryptedPayload instanceof Uint8Array) ||
      isDetachedBuffer(encryptedPayload)
    ) {
      sealedError();
    }

    /**
     * size consistency — encryptedSizeBytes was captured from the
     * payload before upload; re-verifying the live buffer confirms
     * no mutation or reallocation occurred in the async gap.
     */

    if (
      encryptedPayload.byteLength !==
      encryptedSizeBytes
    ) {
      sealedError();
    }

    /**
     * hash format — vaultSha256 was already refined through asSha256Hex()
     * but re-asserting the regex here makes the VERIFYING phase
     * self-contained and independent of the earlier refinement path.
     */

    if (
      !SHA256_REGEX.test(refinedVaultSha256)
    ) {
      sealedError();
    }

    /**
     * ── END VERIFYING ──────────────────────────────────────────────
     */


    /**
     * build immutable manifest AFTER pointer exists.
     *
     * FIX — description is omitted entirely when empty rather
     * than being stored as "". Eliminates the optional-but-always-
     * present schema ambiguity: consumers can rely on presence of
     * the key to mean the capsule actually has a description.
     */

    const finalManifest: ManifestV1 =
      deepFreeze({

        version: MANIFEST_VERSION,

        capsuleId:
          asCapsuleId(capsuleId),

        ...(normalizedDescription
          ? { description: normalizedDescription }
          : {}),

        sealedAt:
          asSealedAtUtc(nowUtc),

        openAt:
          asOpenAtUtc(openAt),

        saltBase:
          refinedSaltBase,

        encryptedSizeBytes,

        vaultTxId,

        /**
         * Heartbeat (v4.3): canonical, always-active capability —
         * no per-capsule enable flag. heartbeatInterval records the
         * originally selected opening interval, fixed at sealing
         * (openAt - sealedAt), and governs both Heartbeat Window
         * availability and the fixed Renewal Rule at resolution time.
         * See Complete System Logic, "Heartbeat Specification".
         */
        heartbeatInterval:
          (openAt - nowUtc) as HeartbeatInterval,

        ext: {

          vaultSha256:
            refinedVaultSha256

        }

      });


    // FINDING 2 — persist the canonical manifest before submission so
    // a lost response can be retried byte-identically.
    persistSealManifest(
      capsuleId,
      finalManifest
    );


    /**
     * server-side seal confirmation AFTER pointer exists
     */

    const sealRes =
      await fetch(
        "/api/capsule/seal",
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json"

          },

          body: JSON.stringify({

            uploadToken: token,
            manifest: finalManifest,
            creatorAuthorityFragment

          })

        }
      );


    if (!sealRes.ok) {

      const text =
        await sealRes.text();

      // FIX 1 — DEV-only diagnostics, matching the logging policy
      // already applied across the Runtime layer.
      if (import.meta.env.DEV) {
        console.error(
          "[AETERNA] seal endpoint failed:",
          sealRes.status,
          text
        );
      }

      sealedError();

    }


    /**
     * Clear retry cache — upload succeeded and seal confirmed.
     * sessionStorage entry is no longer needed and must not
     * persist into a future unrelated capsule creation flow.
     */

    try {
      sessionStorage.removeItem(
        `aeterna-vault-txid:${capsuleId}`
      );
    } catch {
      // Intentional no-op: cleanup failure must not alter fail-closed path.
    }

    // FINDING 2 — manifest retry cache no longer needed.
    clearPersistedSealManifest(capsuleId);


    /**
     * generate capability links
     *
     * Canonical capability grammar:
     *   recipient:    /capsule/:id#HEX64
     *   creator:      /capsule/:id#HEX64&c=HEX64
     *
     * Ordering:
     *   1. recipientLink    — built with recipientSecret
     *   2. confirmationLink — built with recipientSecret + creatorAuthorityFragment
     *
     * recipientSecret and creatorAuthority are wiped exactly once, in the
     * function's `finally` block, alongside encryptedPayload — a single
     * unified release point for every sensitive value this function holds,
     * regardless of which exit path (success or error) is taken.
     *
     * recipientSecret and creatorAuthority never reach the server. Fragment never reaches the server.
     * Both live only in the URL fragment (#) which is client-only.
     */

    const recipientLink =
      `/capsule/${capsuleId}#${recipientSecret}`;

    const confirmationLink =
      `/capsule/${capsuleId}#${recipientSecret}&c=${creatorAuthorityFragment}`;

    return {

      capsuleId,

      manifest: finalManifest,

      recipientLink,

      confirmationLink

    };

  }

  catch (err) {

    // FIX 1 — DEV-only diagnostics, matching the logging policy
    // already applied across the Runtime layer.
    if (import.meta.env.DEV) {
      console.error(
        "[AETERNA] sealCapsuleCore error:",
        err
      );
    }

    sealedError();

    // Unreachable: sealedError() always throws (return type `never`).
    // TypeScript's control-flow analysis does not propagate `never`
    // through a try/catch that is paired with a `finally` block (a
    // known compiler limitation — TS2366 fires here without this line).
    // This throw exists purely to satisfy the compiler; it can never
    // execute at runtime.
    throw SEALED_ERROR;

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

    if (!isDetachedBuffer(encryptedPayload)) {
      encryptedPayload.fill(0);
    }

    recipientSecret = "";
    creatorAuthority = "";

  }

}