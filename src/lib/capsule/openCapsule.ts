import type { ManifestV1 } from "@/types/manifest";
import type { VaultV2 } from "@/types/vault";

import { storage } from "@/lib/storage";


import { decryptVault } from "@/lib/crypto/decryptVault";
import { generateVaultKey } from "@/lib/crypto/generateVaultKey";

import { getTrustedTime } from "@/shared/time/getTrustedTime";
import { verifyVaultSize } from "@/lib/capsule/verifyVaultSize";
import { verifyVaultSha256 } from "@/lib/capsule/verifyVaultSha256";
import { resolveEffectiveOpenAt } from "@/shared/heartbeat/resolveEffectiveOpenAt";
import { loadHeartbeatRecord } from "@/lib/capsule/loadHeartbeatRecord";
import { assertStoragePointer } from "@/lib/storage/storageAdapter";

import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SECRET_REGEX,
} from "@/lib/crypto/validators";


import {
  MAX_ENCRYPTED_VAULT_SIZE
} from "@/lib/crypto/constants";

const MIN_TIME =
  1577836800000;

const MAX_TIME =
  4102444800000;


/**
 * FINDING 2 — module-scope frozen whitelist
 * Eliminates per-call allocation and hardens immutability posture.
 */

const ALLOWED_EXT_KEYS =
  Object.freeze(["vaultSha256"]);


/**
 * FINDING 3 — module-scope frozen whitelists
 * Replaces repeated inline mutable array allocations inside isValidVaultV2.
 *
 * Key sets mirror canonical serializer output from canonicalSerializeVaultV2.
 * Any drift here causes valid capsules to fail the refinement boundary.
 */

const ALLOWED_VAULT_KEYS =
  Object.freeze(["version", "createdAt", "capsule"]);

const ALLOWED_CAPSULE_KEYS =
  Object.freeze(["capsuleId", "items"]);

const ALLOWED_TEXT_KEYS =
  Object.freeze([
    "type",
    "text",
    "createdAt",
  ]);

const ALLOWED_MEDIA_KEYS =
  Object.freeze([
    "type",
    "mediaType",
    "filename",
    "mimeType",
    "size",
    "chunks",
    "createdAt",
  ]);

const ALLOWED_MEDIA_TYPES =
  Object.freeze(["image", "video", "audio", "file"]);


type OpenCapsuleInput = {

  capsuleId: string;

  secret: string;

  manifest: ManifestV1;

};


type OpenCapsuleResult = {

  cryptoKey: CryptoKey;

  vault: VaultV2;

  downloadVaultJson: () => void;

};


function sealedError(): never {

  throw new Error(
    "[AETERNA] Capsule is sealed"
  );

}

/**
 * Canonical detached-buffer guard.
 *
 * A Uint8Array can appear non-empty at the view level (byteLength > 0)
 * while its backing ArrayBuffer has been neutered (buffer.byteLength === 0)
 * via structured-clone transfer, SharedArrayBuffer detachment, or
 * runtime GC edge cases. Checking both axes is the dual-semantic standard
 * used throughout Layer 2 / Layer 3 / Layer 4 of this protocol.
 *
 * Mirrors the identically-named helper in sealCapsuleCore.ts.
 */
function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return (
    arr.byteLength === 0 ||
    arr.buffer.byteLength === 0
  );

}


/**
 * VaultV2 schema validator
 *
 * Protects against:
 * schema confusion attacks
 * prototype poisoning
 * malformed decrypt output
 */

function isValidVaultV2(
  value: unknown,
  capsuleId: string
): value is VaultV2 {

  if (
    !value ||
    typeof value !== "object"
  ) return false;

  if (Array.isArray(value))
    return false;

  if (
    Object.getPrototypeOf(value)
      !== Object.prototype
  )
    return false;

  const v =
    value as Record<string, unknown>;

  // Vault root key whitelist — rejects extra or injected top-level fields
  for (const k of Object.keys(v)) {
    if (!ALLOWED_VAULT_KEYS.includes(k))
      return false;
  }

  if (v['version'] !== 2)
    return false;

  /**
   * FINDING 4 — createdAt canonical bounds enforcement
   * Mirrors MIN_TIME / MAX_TIME sanity model already used in manifest layer.
   */

  if (typeof v['createdAt'] !== "string")
    return false;

  const createdAtMs =
    Date.parse(v['createdAt']);

  if (
    !Number.isFinite(createdAtMs) ||
    createdAtMs < MIN_TIME ||
    createdAtMs > MAX_TIME
  )
    return false;

  if (!v['capsule'])
    return false;

  // capsule prototype boundary — blocks polluted capsule objects
  if (
    typeof v['capsule'] !== "object" ||
    Array.isArray(v['capsule']) ||
    Object.getPrototypeOf(v['capsule'])
      !== Object.prototype
  )
    return false;

  const capsule =
    v['capsule'] as Record<string, unknown>;

  // Capsule key whitelist — rejects extra or injected capsule fields
  for (const k of Object.keys(capsule)) {
    if (!ALLOWED_CAPSULE_KEYS.includes(k))
      return false;
  }

  if (
    capsule['capsuleId'] !== capsuleId
  )
    return false;

  if (!Array.isArray(capsule['items']))
    return false;

  if ((capsule['items'] as unknown[]).length > 100)
    return false;

  for (const item of capsule['items'] as unknown[]) {

    if (!item)
      return false;

    // item prototype boundary — blocks polluted item objects
    if (
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.getPrototypeOf(item)
        !== Object.prototype
    )
      return false;

    const i =
      item as Record<string, unknown>;

    if (
      i['type'] !== "text" &&
      i['type'] !== "media"
    )
      return false;

    if (i['type'] === "text") {

      if (typeof i['text'] !== "string")
        return false;

      // createdAt: required string, canonical bounds enforced
      if (typeof i['createdAt'] !== "string")
        return false;

      const itemCreatedAtMs = Date.parse(i['createdAt'] as string);

      if (
        !Number.isFinite(itemCreatedAtMs) ||
        itemCreatedAtMs < MIN_TIME ||
        itemCreatedAtMs > MAX_TIME
      )
        return false;

      for (const k of Object.keys(i)) {
        if (!ALLOWED_TEXT_KEYS.includes(k))
          return false;
      }

    }

    if (i['type'] === "media") {

      if (
        typeof i['filename'] !== "string" ||
        i['filename'].length === 0
      )
        return false;

      // mediaType: must be one of the four canonical media categories
      if (
        typeof i['mediaType'] !== "string" ||
        !(ALLOWED_MEDIA_TYPES as readonly string[]).includes(i['mediaType'])
      )
        return false;

      // mimeType: required non-empty string
      if (
        typeof i['mimeType'] !== "string" ||
        i['mimeType'].length === 0
      )
        return false;

      // size: required non-negative integer
      if (
        !Number.isInteger(i['size']) ||
        (i['size'] as number) < 0
      )
        return false;

      // chunks: required array
      if (!Array.isArray(i['chunks']))
        return false;

      // createdAt: required string, canonical bounds enforced
      if (typeof i['createdAt'] !== "string")
        return false;

      const itemCreatedAtMs = Date.parse(i['createdAt'] as string);

      if (
        !Number.isFinite(itemCreatedAtMs) ||
        itemCreatedAtMs < MIN_TIME ||
        itemCreatedAtMs > MAX_TIME
      )
        return false;

      for (const k of Object.keys(i)) {
        if (!ALLOWED_MEDIA_KEYS.includes(k))
          return false;
      }

    }

  }

  return true;

}


/**
 * VaultV2 refinement boundary helper
 *
 * canonical: unknown → validated → VaultV2
 */

function asVaultV2(
  value: unknown,
  capsuleId: string
): VaultV2 {

  if (!isValidVaultV2(value, capsuleId)) {
    sealedError();
  }

  return value;

}


export async function openCapsule({

  capsuleId,
  secret,
  manifest,

}: OpenCapsuleInput): Promise<OpenCapsuleResult> {


  /**
   * WebCrypto availability invariant
   */

  if (!crypto?.subtle)
    sealedError();


  /**
   * manifest structure validation
   */

  if (

    !manifest ||

    Array.isArray(manifest) ||

    Object.getPrototypeOf(manifest)
      !== Object.prototype

  )

    sealedError();


  if (manifest.version !== 1)
    sealedError();


  /**
   * capsuleId validation
   */

  if (

    typeof capsuleId !== "string" ||

    !CAPSULE_ID_REGEX.test(capsuleId)

  )

    sealedError();


  /**
   * secret validation
   */

  if (

    typeof secret !== "string" ||

    !SECRET_REGEX.test(secret)

  )

    sealedError();


  /**
   * identity continuity enforcement
   */

  if (manifest.capsuleId !== capsuleId)
    sealedError();

  /**
   * saltBase validation
   */

  if (

    typeof manifest.saltBase !== "string" ||

    !SALT_BASE_REGEX.test(manifest.saltBase)

  )

    sealedError();


  /**
   * timestamp sanity checks
   */

  if (

    !Number.isInteger(manifest.openAt) ||

    manifest.openAt < MIN_TIME ||

    manifest.openAt > MAX_TIME

  )

    sealedError();


  if (

    !Number.isInteger(manifest.sealedAt) ||

    manifest.sealedAt < MIN_TIME ||

    manifest.sealedAt > MAX_TIME

  )

    sealedError();


  if (

    manifest.openAt <=
    manifest.sealedAt

  )

    sealedError();


  /**
   * encrypted size validation
   *
   * Lower bound is > 0, not ≥ 1024.
   *
   * The seal runtime allows any non-zero ciphertext; imposing a 1024-byte
   * floor here would create a runtime contradiction: capsules sealed
   * successfully with small vaults would be permanently unopenable.
   * The SHA-256 integrity check and size-continuity check (verifyVaultSize)
   * are the authoritative integrity anchors — not a minimum size floor.
   */

  if (

    !Number.isInteger(
      manifest.encryptedSizeBytes
    ) ||

    manifest.encryptedSizeBytes <= 0 ||

    manifest.encryptedSizeBytes >
      MAX_ENCRYPTED_VAULT_SIZE

  )

    sealedError();


  /**
   * integrity scaffold validation
   */

  if (

    !manifest.ext ||

    typeof manifest.ext !== "object" ||

    Array.isArray(manifest.ext) ||

    Object.getPrototypeOf(manifest.ext)
      !== Object.prototype ||

    typeof manifest.ext.vaultSha256 !==
      "string"

  )

    sealedError();


  /**
   * integrity scaffold key whitelist
   */

  for (const k of Object.keys(manifest.ext)) {
    if (!ALLOWED_EXT_KEYS.includes(k))
      sealedError();
  }

  /**
   * trusted-time unlock boundary
   *
   * MUST occur before key derivation
   * MUST occur before decryptVault
   */

  const { nowUtc } =
    await getTrustedTime();


  /**
   * trusted time sanity bounds
   */

  if (

    !Number.isFinite(nowUtc) ||

    nowUtc < MIN_TIME ||

    nowUtc > MAX_TIME

  )

    sealedError();


  /**
   * Canonical heartbeat fallback semantics:
   *
   * loadHeartbeatRecord() intentionally fails safe.
   *
   * If heartbeat infrastructure is unavailable,
   * runtime falls back to immutable manifest.openAt.
   *
   * This is canonical protocol behavior —
   * heartbeat availability itself is NOT an
   * additional authority source.
   *
   * Authority derives from:
   * - capability possession
   * - trusted time
   * - persisted heartbeat continuity
   *
   * Infrastructure availability MUST NOT
   * become protocol authority.
   */

  /**
   * Heartbeat rolling unlock resolver (v1.3)
   */

  const heartbeat =
    await loadHeartbeatRecord(
      capsuleId
    );

  const effectiveOpenAt =
    resolveEffectiveOpenAt({

      manifestOpenAt:
        manifest.openAt,

      heartbeatInterval:
        manifest.heartbeatInterval,

      lastConfirmedAt:
        heartbeat?.lastConfirmedAt ?? undefined,

    });


  /**
   * trusted-time unlock boundary
   */

  if (nowUtc < effectiveOpenAt)
    sealedError();


  /**
   * storage pointer boundary cast
   */

  if (!manifest.ext.vaultSha256)
    sealedError();

  const vaultPointer =
    assertStoragePointer(
      manifest.vaultTxId
    );


  /**
   * download encrypted vault
   */

  const encrypted =
    await storage.download(
      vaultPointer
    );


  /**
   * Downloaded buffer validation.
   *
   * Lower bound is > 0, not ≥ 1024 — symmetric with the
   * manifest.encryptedSizeBytes check above. verifyVaultSize()
   * immediately below enforces the precise byte-for-byte match
   * against the manifest value, which is the real size invariant.
   */

  if (

    !(encrypted instanceof Uint8Array) ||

    encrypted.byteLength === 0 ||

    encrypted.byteLength >
      MAX_ENCRYPTED_VAULT_SIZE

  )

    sealedError();


  /**
   * encrypted size continuity check
   */

  verifyVaultSize(
    encrypted,
    manifest
  );


  /**
   * integrity scaffold verification
   */

  await verifyVaultSha256(
    encrypted,
    manifest.ext.vaultSha256
  );


  /**
   * derive vault key
   *
   * PBKDF2 domain separation enforced:
   * secret + saltBase + capsuleId + openAt
   */

  const cryptoKey =
    await generateVaultKey({

      secret,

      saltBase: manifest.saltBase,

      openAt: manifest.openAt,

      capsuleId,

    });


  /**
   * best-effort secret wipe
   */

  secret = "";


  /**
   * decrypt vault
   *
   * ciphertext wipe guaranteed in finally
   */

  let decryptedAny: unknown;

  try {
    decryptedAny =
      await decryptVault(
        encrypted,
        cryptoKey
      );
  } finally {

    // FINDING B — guard against a detached/neutered buffer, matching
    // the identical fail-safe pattern applied in sealCapsuleCore.ts's
    // finally block. A detached buffer throws on .fill(), and a finally
    // block must never throw — that would mask the original error (or,
    // on the success path, replace a clean return with an exception).
    if (!isDetachedBuffer(encrypted)) {
      encrypted.fill(0);
    }

  }


  /**
   * Vault schema validation boundary
   *
   * canonical: unknown → validated → VaultV2
   */

  const vault =
    asVaultV2(
      decryptedAny,
      capsuleId
    );


  /**
   * FINDING 1 — minimize raw decrypt object lifetime
   * Clears reference after refinement boundary is crossed.
   */

  decryptedAny = null;


  /**
   * developer export helper
   */

  function downloadVaultJson() {

    try {

      const jsonStr =
        JSON.stringify(
          vault,
          null,
          2
        );


      if (jsonStr.length > 5_000_000)
        throw new Error();


      const blob =
        new Blob(
          [jsonStr],
          { type: "application/json" }
        );


      const url =
  URL.createObjectURL(blob);

    try {

    const a =
    document.createElement("a");

     a.href = url;

     a.download =
    `aeterna-capsule-${capsuleId}.json`;

      document.body.appendChild(a);

      a.click();

      document.body.removeChild(a);

      } finally {

     // Delay remains intentional.
     // Some browsers require the ObjectURL to stay alive
     // briefly after programmatic download is triggered.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);

    }

    } catch (err) {

      /**
       * FINDING 5 — developer helper failure observability.
       *
       * DEV-only diagnostics — matches the canonical Runtime logging
       * policy used across the Runtime Layer.
       *
       * sealedError() is intentionally not used here: download helper
       * failure must never invalidate an already-successful capsule open.
       */

      if (import.meta.env.DEV) {
        console.error(
          "[AETERNA] downloadVaultJson failed",
          err
        );
      }

    }

  }


  return {

    vault,

    cryptoKey,

    downloadVaultJson,

  };

}