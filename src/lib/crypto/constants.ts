/**
 * AETERNA Protocol Constants Registry
 *
 * All cryptographic constants MUST be declared here.
 * These values are protocol invariants.
 *
 * Changing them breaks compatibility.
 */


/* ─────────────────────────────
   PROTOCOL VERSION MARKER
───────────────────────────── */

export const AETERNA_PROTOCOL_VERSION =
  "AETERNA_CANONICAL_V1_1" as const;

export const AETERNA_PROTOCOL_VERSION_LEGACY =
  "AETERNA_V5_BASELINE" as const;


/* ─────────────────────────────
   PBKDF2 SETTINGS
───────────────────────────── */

/**
 * PBKDF2 iteration count
 *
 * Security invariant:
 * must remain high to resist brute-force attacks
 */

export const PBKDF2_ITERATIONS =
  600_000 as const;


/* ─────────────────────────────
   AES-GCM PARAMETERS
───────────────────────────── */

/**
 * AES-GCM IV length (bytes)
 *
 * ABSOLUTE PROTOCOL INVARIANT
 */

export const AES_GCM_IV_LENGTH =
  12 as const;


/**
 * AES-GCM authentication tag length (bits)
 *
 * ABSOLUTE PROTOCOL INVARIANT
 */

export const AES_GCM_TAG_LENGTH =
  128 as const;


/* ─────────────────────────────
   SALT MODEL
───────────────────────────── */

/**
 * saltBase length (bytes)
 *
 * ABSOLUTE PROTOCOL INVARIANT
 */

export const SALT_BASE_LENGTH_BYTES =
  16 as const;


/* ─────────────────────────────
   DOMAIN SEPARATION TAGS
───────────────────────────── */

/**
 * Domain separation label:
 * deterministic salt derivation namespace
 */

export const DOMAIN_VAULT_SALT =
  "AETERNA_VAULT_SALT_V1" as const;


/**
 * Domain separation label:
 * vault key derivation namespace
 */

export const DOMAIN_VAULT_KEY =
  "AETERNA_VAULT_KEY_V1" as const;


/**
 * Domain separation label:
 * vault AAD namespace
 *
 * Reserved for future AAD namespace versioning.
 * Not currently used in Vault encryption pipeline.
 */

export const DOMAIN_VAULT_AAD =
  "AETERNA_VAULT_AAD_V2" as const;


/**
 * Canonical vault AES-GCM AAD
 *
 * ABSOLUTE PROTOCOL INVARIANT:
 * must equal Uint8Array([1])
 *
 * SECURITY:
 * Returns fresh immutable-value-equivalent
 * Uint8Array instance per call.
 *
 * WHY:
 * Prevents shared mutable crypto authority
 * across runtimes/modules while preserving:
 *
 * - deterministic crypto semantics
 * - SES compatibility
 * - emergency runtime parity
 *
 * MUST ALWAYS RETURN:
 *
 * Uint8Array([1])
 */

export function getVaultAAD(): Uint8Array {

  return new Uint8Array([1]);

}


/**
 * Chunk encryption domain separation labels
 */

export const DOMAIN_CHUNK_IV =
  "AETERNA_CHUNK_IV_V1" as const;

export const DOMAIN_CHUNK_BASE_IV =
  "AETERNA_CHUNK_BASE_IV_V1" as const;

export const DOMAIN_CHUNK_AAD =
  "AETERNA_CHUNK_AAD_V1" as const;


/* ─────────────────────────────
   VAULT SIZE MODEL
───────────────────────────── */

/**
 * Maximum encrypted vault size
 *
 * ABSOLUTE PROTOCOL INVARIANT
 *
 * Vault contains metadata JSON only.
 * Binary payload stored separately as encrypted chunks.
 */

export const MAX_ENCRYPTED_VAULT_SIZE =
  10 * 1024 * 1024;


/**
 * Maximum plaintext chunk size
 *
 * Used before encryption:
 * file.slice → encryptChunk
 *
 * ABSOLUTE PROTOCOL INVARIANT
 */

export const MAX_CHUNK_SIZE =
  10 * 1024 * 1024;


/**
 * Maximum encrypted chunk size
 *
 * Layout:
 * 12 bytes IV
 * +
 * ciphertext
 * +
 * 16 bytes AES-GCM auth tag
 *
 * ABSOLUTE PROTOCOL INVARIANT
 */

export const MAX_ENCRYPTED_CHUNK_SIZE =
  MAX_CHUNK_SIZE +
  AES_GCM_IV_LENGTH +
  AES_GCM_TAG_LENGTH / 8;

/**
 * ABSOLUTE RULE:
 * These constants are consensus-critical protocol invariants.
 *
 * Any modification requires:
 * - compatibility review
 * - migration strategy
 * - manifest/runtime compatibility audit
 */