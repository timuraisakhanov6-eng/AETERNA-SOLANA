/**
 * AETERNA: VAULT SCHEMA DEFINITIONS
 *
 * ⚠️ IMPORTANT:
 * Vault schemas are IMMUTABLE.
 * Any breaking change MUST introduce a new version (V1 -> V2 -> V3).
 *
 * SECURITY RULE:
 * Vault must remain JSON serializable.
 * No binary data should be stored directly inside production schemas.
 */

import type {
  CapsuleId,
  ChunkId,
  // Used only by experimental VaultV3 (MediaCapsuleItemV3 / FileCapsuleItemV3).
  // VaultV2 stores ChunkMetadata only, per RFC-001 — no ArweaveTxId in V2.
  ArweaveTxId,
} from "./manifest";

import type {
  StoragePointer,
} from "@/lib/storage/storageAdapter";

import {
  ISO8601_REGEX, // FIX (Issue A) — IsoUtcString validator authority
} from "@/lib/crypto/validators";


/* =========================
   BRANDED TIME TYPE
   ========================= */

// IMPROVEMENT #4 — branded ISO UTC string
// prevents local time injection, timezone drift, non-UTC serialization
export type IsoUtcString =
  string & { __brand: "IsoUtcString" };

// FIX (Issue A) — runtime assertion for IsoUtcString branded type.
// Eliminates timezone drift and non-UTC serialization at validation boundary.
// Used in: refinement pipeline, loadManifest, VaultBuilder, emergency parity.
export function assertIsoUtcString(
  value: string
): asserts value is IsoUtcString {

  if (!ISO8601_REGEX.test(value)) {

    throw new Error(
      "[AETERNA] Invalid UTC ISO timestamp"
    );

  }

}


/* =========================
   VAULT ROOT (UNION TYPE)
   ========================= */

export type Vault =
  | VaultV1
  | VaultV2
  | VaultV3;


/* =========================
   TYPE GUARDS
   ========================= */

export function isVaultV1(vault: Vault): vault is VaultV1 {
  return vault.version === 1;
}

export function isVaultV2(vault: Vault): vault is VaultV2 {
  return vault.version === 2;
}

export function isVaultV3(vault: Vault): vault is VaultV3 {
  return vault.version === 3;
}


/* =========================
   RUNTIME GUARDS
   ========================= */

// IMPROVEMENT — version + shape guard used before decryptVault(),
// VaultRenderer(), and storage.read()
export function assertVaultVersion(
  vault: unknown
): asserts vault is Vault {

  if (
    typeof vault !== "object" ||
    vault === null ||
    Object.getPrototypeOf(vault) !== Object.prototype ||
    !("version" in vault)
  ) {

    throw new Error(
      "[AETERNA] Invalid vault format"
    );

  }

  const version = (vault as { version?: unknown }).version;

  if (
  typeof version !== "number" ||
  !Number.isInteger(version) ||
  (
    version !== 1 &&
    version !== 2 &&
    version !== 3
  )
) {

    throw new Error(
      "[AETERNA] Unsupported vault version"
    );

  }

}

// IMPROVEMENT #5 — capsuleId continuity guard
// used in: decryptVault(), CapsuleController, Recipient flow
export function assertVaultCapsuleContinuity(
  vaultCapsuleId: CapsuleId,
  manifestCapsuleId: CapsuleId
): void {

  if (vaultCapsuleId !== manifestCapsuleId) {

    throw new Error(
      "[AETERNA] capsuleId continuity violation: vault does not match manifest"
    );

  }

}


/* =========================
   V1 (LEGACY / DEPRECATED)
   ========================= */

// FIX (Issue 1) — readonly enforces immutable transition boundary across all vault versions.
// Prevents post-validation mutation: vault.capsule.capsuleId, item injection, chunk manipulation.
// Symmetric with ManifestV1 readonly hardening.

export interface VaultV1 {
  readonly version: 1;
  readonly capsule: CapsuleV1;
}

export interface CapsuleV1 {
  readonly title: string;
  readonly createdAt: IsoUtcString;
  readonly openAt: number;
  readonly items: readonly CapsuleItemV1[];
}

export type CapsuleItemV1 =
  | TextItemV1
  | MediaItemV1;

export interface TextItemV1 {
  readonly type: "text";
  readonly text: string;
  readonly createdAt: IsoUtcString;
}

export interface MediaItemV1 {
  readonly type: "media";
  readonly mediaType: "image" | "video" | "audio" | "file";

  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;

  /**
   * ⚠️ LEGACY FIELD
   * Base64 encoded media.
   * Kept only for V1 backward-compatibility decoding.
   * MUST NOT be used in V2+ schemas.
   */
  readonly data: string;

  readonly createdAt: IsoUtcString;
}


/* =========================
   V2 (CURRENT PRODUCTION)
   ========================= */

/**
 * ❗ CURRENT PRODUCTION SCHEMA
 *
 * Vault DOES NOT contain openAt.
 * openAt exists only inside the Manifest.
 *
 * Vault must remain small (metadata only).
 */

export interface VaultV2 {
  readonly version: 2;

  /**
   * Vault creation timestamp (UTC ISO string).
   */
  readonly createdAt: IsoUtcString;

  readonly capsule: CapsuleV2;
}

export interface CapsuleV2 {

  /**
   * Capsule identifier.
   *
   * MUST match:
   * manifest.capsuleId
   *
   * Required for integrity scaffold:
   * prevents vault swap attacks.
   */
  readonly capsuleId: CapsuleId;

  readonly items: readonly CapsuleItemV2[];
}

export type CapsuleItemV2 =
  | TextItemV2
  | MediaItemV2;


/* ---------- TEXT ITEM V2 ---------- */

export interface TextItemV2 {
  readonly type: "text";
  readonly text: string;
  readonly createdAt: IsoUtcString;
}


/* ---------- MEDIA ITEM V2 ---------- */

export interface MediaItemV2 {
  readonly type: "media";

  readonly mediaType:
    | "image"
    | "video"
    | "audio"
    | "file";

  readonly filename: string;

  readonly mimeType: string;

  /**
   * Size of the original plaintext media in bytes.
   *
   * Runtime uses this as the canonical logical file length
   * when reconstructing arbitrary byte ranges.
   *
   * This value MUST equal the sum of all plaintext chunk sizes.
   */
  readonly size: number;

  /**
   * RFC-001 — Chunk Pointer Extraction from Vault to Manifest
   *
   * Vault stores transport-independent chunk metadata only.
   * It never carries a storage/publication pointer: pointer values
   * are publication metadata, resolved at Runtime from
   * `Manifest.ext.chunkPointers` (see RFC-001 §4, §7).
   *
   * Vault content is finalized and hashed (`vaultSha256`) at PREPARE
   * time, before chunks are uploaded and before `pointer` values
   * exist — so Vault items structurally cannot carry `pointer`.
   */
  readonly chunks:
    readonly ChunkMetadata[];

  readonly createdAt:
    IsoUtcString;
}


/* =========================
   V3 (EXPERIMENTAL / DRAFT)
   ========================= */

/**
 * ⚠️ EXPERIMENTAL
 *
 * V3 introduces item identifiers and byte size tracking.
 * This schema is NOT yet used in production capsules.
 */

export interface VaultV3 {
  readonly version: 3;

  /**
   * Vault creation timestamp (UTC ISO string).
   */
  readonly createdAt: IsoUtcString;

  readonly capsule: CapsuleV3;
}

export interface CapsuleV3 {

  /**
   * Capsule identifier.
   *
   * MUST match manifest.capsuleId.
   * Prevents vault substitution attacks.
   */
  readonly capsuleId: CapsuleId;

  /**
   * Vault-level creation timestamp.
   */
  readonly createdAt: IsoUtcString;

  /**
   * openAt intentionally absent.
   *
   * Spec invariant:
   * openAt exists ONLY in Manifest.
   */

  readonly items: readonly CapsuleItemV3[];
}

export interface BaseCapsuleItemV3 {
  readonly id: string;
  readonly createdAt: IsoUtcString;

  /**
   * Byte size of encrypted payload.
   */
  readonly byteSize: number;
}

export type CapsuleItemV3 =
  | TextCapsuleItemV3
  | MediaCapsuleItemV3
  | FileCapsuleItemV3;

export interface TextCapsuleItemV3
  extends BaseCapsuleItemV3 {

  readonly type: "text";

  readonly text: string;

  /**
   * Optional formatting metadata.
   */
  readonly format?: "plain" | "markdown";
}

export interface MediaCapsuleItemV3
  extends BaseCapsuleItemV3 {

  readonly type: "media";

  readonly mediaType: "image" | "video" | "audio";

  readonly filename: string;
  readonly mimeType: string;

  /**
   * Streaming storage model.
   *
   * file.slice → encryptChunk → uploadChunk
   *
   * Each entry references encrypted chunk txId
   * stored in Arweave / Irys.
   */
  readonly chunks: readonly ArweaveTxId[];

  /**
   * Optional thumbnail preview.
   *
   * MUST remain small (~10KB max).
   * MUST NOT contain full media payload.
   */
  readonly previewDataUrl?: string;

  readonly durationSeconds?: number;
}

// FIX #3 — file is not a separate item type
// canonical model: type="media" + mediaType="file" (matches VaultV2)
export interface FileCapsuleItemV3
  extends BaseCapsuleItemV3 {

  readonly type: "media";

  readonly mediaType: "file";

  readonly filename: string;
  readonly mimeType: string;

  /**
   * Streaming storage model.
   *
   * file.slice → encryptChunk → uploadChunk
   *
   * Each entry references encrypted chunk txId
   * stored in Arweave / Irys.
   */
  readonly chunks: readonly ArweaveTxId[];

}


/* =========================
   CHUNK METADATA
   ========================= */

export interface ChunkMetadata {
  readonly chunkId: ChunkId;

  readonly mediaId: string;

  readonly index: number;

  readonly size: number;
}

/**
 * Published chunk metadata.
 *
 * Runtime upload has completed.
 * Storage pointer is now permanently assigned.
 *
 * This object crosses the Runtime → Protocol boundary.
 *
 * Per RFC-001, this shape is produced by `uploadPreparedChunks()` and
 * consumed by `ByteRuntime` / `chunkLoader`. It is never stored inside
 * Vault items; Runtime constructs it by resolving `ChunkMetadata`
 * against `Manifest.ext.chunkPointers`.
 */
export interface PublishedChunkMetadata
  extends ChunkMetadata {

  readonly pointer: StoragePointer;

}

export interface PreparedChunk {
  readonly chunkId: ChunkId;

  readonly mediaId: string;

  readonly chunkIndex: number;

  readonly ciphertext: Uint8Array;

  readonly ciphertextSize: number;
}

export interface PreparedMediaResult {

  readonly chunkMetadata:
    readonly ChunkMetadata[];

  readonly plaintextBytes:
    number;

  readonly encryptedBytes:
    number;

}


/* =========================
   CHUNK POINTER REGISTRY
   ========================= */

export interface ChunkPointer {

  readonly chunkId: ChunkId;

  readonly pointer: string;

}

export interface ChunkPointerRegistry {

  readonly pointers:
    readonly ChunkPointer[];

}