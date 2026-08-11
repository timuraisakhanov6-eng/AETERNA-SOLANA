/**
 * AETERNA: MANIFEST SCHEMA DEFINITIONS (v1.2 CANONICAL TYPES)
 *
 * Manifest — публичная, неизменяемая часть капсулы времени.
 * Хранится в Arweave / Irys. Доступна любому человеку по ID.
 *
 * ⚠️ НЕ содержит секретов, ключей или расшифрованных данных.
 *
 * Protocol guarantees:
 * - version pinned
 * - capsuleId continuity enforced
 * - vault integrity anchored
 * - KDF salt domain separation enabled
 *
 * v1.2 extension:
 * Heartbeat Release Model (rolling unlock window support)
 */

import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
  STORAGE_POINTER_REGEX, // FIX (Issue 1) — storage authority via transport/storage pointer, not backend-specific validator
} from "@/lib/crypto/validators";

/* =========================
   VERSION
   ========================= */

export const MANIFEST_VERSION = 1 as const;

// FIX #1 — literal type for forward-safe union narrowing
// typeof MANIFEST_VERSION collapses to `1` anyway, but explicit literal
// keeps ManifestV2 union disambiguation stable across serializers
export type ManifestVersion = 1;


/* =========================
   BRANDED TIME TYPES
   ========================= */

export type UtcMs =
  number & { __brand: "UtcMs" };

export type OpenAtUtc =
  UtcMs & { __openAt: true };

export type SealedAtUtc =
  UtcMs & { __sealedAt: true };

export type HeartbeatInterval =
  UtcMs & { __heartbeatInterval: true };


/* =========================
   BRANDED IDENTIFIERS
   ========================= */

export type CapsuleId =
  string & {
    __brand: "CapsuleId";
    __len: 64;
  };

// FIX (improvement) — __len: 43 matches canonical Arweave TXID length
// NOTE: retained for `vaultTxId` only.
export type ArweaveTxId =
  string & {
    __brand: "ArweaveTxId";
    __len: 43;
  };

export type SaltBaseHex =
  string & {
    __brand: "SaltBaseHex";
    __len: 32;
  };

export type Sha256Hex =
  string & {
    __brand: "Sha256Hex";
    __len: 64;
  };

// Chunk identifier as referenced by Vault (`ChunkMetadata.chunkId`) and
// storage-authority chunk-pointer resolution structures. Matches the
// unbranded `string` shape already used for `ChunkMetadata.chunkId` /
// `ChunkPointer.chunkId` in vault.ts. Not branded, to avoid requiring a
// parallel assertion/casting path at every existing chunkId call site as
// part of this type-only stage.
export type ChunkId = string;


/* =========================
   RUNTIME GUARDS
   ========================= */

export function assertCapsuleId(
  value: string
): asserts value is CapsuleId {

  if (!CAPSULE_ID_REGEX.test(value)) {

    throw new Error(
      `[AETERNA] Invalid capsuleId format: expected 64 lowercase hex chars`
    );

  }

}


export function assertSaltBaseHex(
  value: string
): asserts value is SaltBaseHex {

  if (!SALT_BASE_REGEX.test(value)) {

    throw new Error(
      `[AETERNA] Invalid saltBase: expected 32 lowercase hex chars`
    );

  }

}


export function assertSha256Hex(
  value: string
): asserts value is Sha256Hex {

  if (!SHA256_REGEX.test(value)) {

    throw new Error(
      `[AETERNA] Invalid sha256 hex`
    );

  }

}


// FIX #4 — NaN / Infinity / unsafe-integer guards added
export function assertTemporalOrder(
  sealedAt: number,
  openAt: number
): void {

  if (
    !Number.isFinite(sealedAt) ||
    !Number.isFinite(openAt) ||
    !Number.isSafeInteger(sealedAt) ||
    !Number.isSafeInteger(openAt) ||
    openAt <= sealedAt
  ) {

    throw new Error(
      "[AETERNA] Invalid manifest timestamps: openAt must be a finite safe integer greater than sealedAt"
    );

  }

}


// FIX (Issue 1) — validator authority aligned to storage pointer abstraction layer.
// STORAGE_POINTER_REGEX governs transport/storage identity independently of backend format.
// ArweaveTxId branded type is preserved — no storage layer redesign.
export function assertArweaveTxId(
  value: string
): asserts value is ArweaveTxId {

  if (!STORAGE_POINTER_REGEX.test(value)) {

    throw new Error(
      `[AETERNA] Invalid vaultTxId format`
    );

  }

}


/* =========================
   HEARTBEAT VALIDATION (v1.3)
   ========================= */

export function assertHeartbeatIntervalBounds(
  value: number
): asserts value is HeartbeatInterval {

  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 86400000 ||
    value > 3153600000000
  ) {

    throw new Error(
      "[AETERNA] heartbeatInterval outside allowed bounds (1 day – 100 years)"
    );

  }

}


// FIX #2 — encryptedSizeBytes runtime guard
// required for streaming vault validation and chunk assembly boundary safety
export function assertEncryptedSizeBytes(
  value: number
): void {

  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {

    throw new Error(
      "[AETERNA] Invalid encryptedSizeBytes: must be a positive safe integer"
    );

  }

}


/**
 * Heartbeat is a canonical capability present on every capsule
 * (Complete System Logic, v4.3): there is no per-capsule opt-in
 * or opt-out. `heartbeatInterval` records the originally selected
 * opening interval, fixed at sealing time, and is REQUIRED on
 * every manifest — not conditional on any enable flag.
 */
export function assertHeartbeatConsistency(
  manifest: ManifestV1
): void {

  assertHeartbeatIntervalBounds(
    manifest.heartbeatInterval
  );

}


/* =========================
   EXTENSIONS (INTEGRITY SCAFFOLD)
   ========================= */

// FIX (Issue 1) — readonly enforces immutable transition boundary.
// Prevents post-validation mutation of integrity-critical fields.
export interface ManifestIntegrityExt {

  /**
   * SHA-256 hash of encrypted vault payload.
   *
   * Verified before decryptVault()
   */
  readonly vaultSha256: Sha256Hex;

}


/* =========================
   MANIFEST V1
   ========================= */

// FIX (Issue 1) — all fields readonly.
// Enforces canonical refinement law: validated → refined → immutable.
// Prevents post-validation mutation of openAt, ext, capsuleId, and other
// integrity-critical fields between loadManifest(), resolveEffectiveOpenAt(),
// openCapsule(), and emergency runtime parity.
export interface ManifestV1 {

  /**
   * Manifest schema version.
   */
  readonly version: ManifestVersion;

  /**
   * Unique capsule identifier (64 hex).
   *
   * Must match:
   * vault.capsule.capsuleId
   */
  readonly capsuleId: CapsuleId;

  /**
   * Optional public description.
   */
  readonly description?: string;

  /**
   * Sealing timestamp (UTC ms).
   *
   * Must be < openAt
   */
  readonly sealedAt: SealedAtUtc;

  /**
   * Capsule open timestamp (UTC ms).
   *
   * Participates in PBKDF2 domain separation.
   */
  readonly openAt: OpenAtUtc;

  /**
   * Base salt for temporal key derivation.
   *
   * lowercase hex (32 chars)
   */
  readonly saltBase: SaltBaseHex;

  /**
   * Total encrypted vault payload size.
   *
   * Used for:
   * - streaming validation
   * - early corruption detection
   */
  readonly encryptedSizeBytes: number;

  /**
   * Immutable storage transaction ID.
   *
   * Supported backends:
   * - Arweave
   * - Irys
   */
  readonly vaultTxId: ArweaveTxId;

  /**
   * Heartbeat (v4.3): canonical, always-active liveness capability.
   * Not an opt-in — every capsule carries this field.
   *
   * Stores the originally selected opening interval
   * (openAt - sealedAt at seal time), fixed at sealing.
   * Governs both:
   *  - Heartbeat Window availability (immediate if <= 30 days;
   *    else available only in the final 30 days before openAt)
   *  - Renewal amount (+= this interval if <= 30 days;
   *    += exactly 30 days otherwise)
   *
   * REQUIRED. See Complete System Logic, "Heartbeat Specification".
   */
  readonly heartbeatInterval: HeartbeatInterval;

  /**
   * Protocol integrity extensions (v6 scaffold)
   *
   * REQUIRED
   */
  readonly ext: ManifestIntegrityExt;

}


/* =========================
   UNION TYPE (FORWARD SAFE)
   ========================= */

export type Manifest =
  | ManifestV1;