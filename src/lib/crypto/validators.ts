// src/lib/crypto/validators.ts

/**
 * AETERNA — Canonical Protocol Regex Validators
 *
 * Spec authority layer:
 * MASTER_SPEC_INDEX.md
 * CRYPTOGRAPHIC_INVARIANTS_SPEC_v1.0.md
 * STORAGE_CAPABILITY_MODEL_SPEC_v1.0.md
 *
 * Rule:
 * Regex duplication outside this registry is forbidden.
 */


/**
 * capsuleId
 *
 * 256-bit lowercase hex identifier
 *
 * Format:
 * 64 lowercase hex characters
 *
 * Used in:
 * manifest.capsuleId
 * prepareVault()
 * sealCapsuleCore()
 * upload-token verification
 */
export const CAPSULE_ID_REGEX =
  Object.freeze(/^[a-f0-9]{64}$/);


/**
 * secret (URL fragment key material)
 *
 * 256-bit entropy
 *
 * MUST exist only in:
 * memory
 * URL fragment
 *
 * MUST NOT exist in:
 * sessionStorage
 * localStorage
 * IndexedDB
 * backend APIs
 * logs
 * analytics
 */
export const SECRET_REGEX =
  Object.freeze(/^[a-f0-9]{64}$/);


/**
 * Creator heartbeat authority fragment
 *
 * Used in:
 * creator master capability
 * heartbeat-only capability
 * canonical capability parsing
 */
export const CREATOR_AUTHORITY_FRAGMENT_REGEX =
  Object.freeze(/^[a-f0-9]{64}$/);


/**
 * saltBase
 *
 * 128-bit hex string (16 bytes)
 *
 * Used in PBKDF2 domain separation:
 *
 * saltBase + capsuleId + openAt
 *
 * Stored in manifest
 */
export const SALT_BASE_REGEX =
  Object.freeze(/^[a-f0-9]{32}$/);


/**
 * Arweave TXID
 *
 * Storage pointer identifier
 *
 * Format:
 * 43-character URL-safe base64 string
 *
 * Example:
 * p7Qh9YV5kQ0rR3W8vKqC8G6nKpT3M9yV7xYpQvWJd7A
 *
 * Used in:
 * manifest.vaultTxId
 * storageAdapter.ts
 * gateway fallback loader
 */
export const TXID_REGEX =
  Object.freeze(/^[a-zA-Z0-9_-]{43}$/);


/**
 * Canonical storage pointer
 *
 * Currently identical to Arweave/Irys txId.
 *
 * MUST remain centralized here to preserve:
 *
 * runtime parity
 * emergency runtime parity
 * validator authority unification
 */
export const STORAGE_POINTER_REGEX =
  TXID_REGEX;


/**
 * Upload token capability
 *
 * Opaque backend-issued upload authority.
 *
 * Used in:
 * upload-token.ts
 * storageAdapter.ts
 * upload authorization boundary
 *
 * Bounded to prevent:
 * unbounded capability surfaces
 * parser ambiguity
 * memory abuse vectors
 */
export const UPLOAD_TOKEN_REGEX =
  Object.freeze(/^[a-zA-Z0-9_-]{32,256}$/);


/**
 * EVM transaction hash
 *
 * Format:
 * 0x + 64 hex characters
 *
 * Example:
 * 0x5f2c3a...64hex
 *
 * Used in:
 * /api/web3/verify
 * VERIFIED_PAYMENTS KV
 * upload-token capability issuance
 *
 * Replay protection identifier
 */
export const TX_HASH_REGEX =
  Object.freeze(/^0x[a-fA-F0-9]{64}$/);


/**
 * Capsule item ID
 *
 * Safe for:
 * JSON transport
 * URL transport
 * storage indexing
 *
 * Max length:
 * 128 characters
 *
 * Used in:
 * CapsuleItemV2
 */
export const ITEM_ID_REGEX =
  Object.freeze(/^[a-zA-Z0-9_-]{1,128}$/);


/**
 * ISO8601 UTC timestamp
 *
 * Example:
 * 2026-04-02T12:15:22.123Z
 *
 * Required for:
 * manifest.openAt
 * manifest.sealedAt
 *
 * Used in PBKDF2 binding:
 *
 * vaultKey = PBKDF2(
 *   secret,
 *   saltBase + capsuleId + openAt
 * )
 */
export const ISO8601_REGEX =
  Object.freeze(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);


/**
 * Canonical ISO timestamp validator
 *
 * Lightweight structural ISO timestamp check
 * used by runtime preparation layers.
 *
 * Example:
 * 2026-04-02T12:15:22.123Z
 *
 * NOTE:
 * This validator remains fully fail-closed and
 * anchored to preserve validator parity across:
 *
 * primary runtime
 * emergency runtime
 * manifest validation layers
 *
 * Unlike ISO8601_REGEX, milliseconds are optional
 * for lightweight runtime timestamp acceptance.
 */
export const ISO_TIMESTAMP_REGEX =
  Object.freeze(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);


/**
 * SHA-256 hex digest
 *
 * Used for:
 * manifest.ext.vaultSha256
 *
 * MUST equal:
 *
 * SHA256(ciphertext vault)
 *
 * Verified before vault decrypt
 */
export const SHA256_REGEX =
  Object.freeze(/^[a-f0-9]{64}$/);

/**
 * VALIDATION AUTHORITY RULE
 *
 * All runtime validation MUST anchor to this registry.
 *
 * Ad-hoc validators outside this file are forbidden.
 *
 * This registry is consensus-critical.
 * Runtime validators MUST NOT redefine protocol formats.
 */