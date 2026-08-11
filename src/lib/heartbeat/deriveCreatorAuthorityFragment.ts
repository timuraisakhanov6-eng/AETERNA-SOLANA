/**
 * =========================================================
 * AETERNA Heartbeat Authority Fragment Derivation (v1.3)
 * =========================================================
 *
 * Canonical derivation rule:
 *
 * creatorAuthorityFragment =
 * HKDF(secret, "aeterna-heartbeat-authority")
 *
 * Output format:
 * HEX64 (32 bytes)
 *
 * Capability:
 * confirmation authority ONLY
 */

const encoder = new TextEncoder();

/**
 * Canonical HKDF namespace
 */
const HKDF_DOMAIN =
  encoder.encode("aeterna-heartbeat-authority");


/**
 * Detached buffer guard
 */

function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return arr.buffer.byteLength === 0;

}


/**
 * HEX encoder
 *
 * Deterministic lowercase HEX
 */

function toHex(
  bytes: Uint8Array
): string {

  let hex = "";

  for (let i = 0; i < bytes.length; i++) {

    hex += bytes[i]!
      .toString(16)
      .padStart(2, "0");

  }

  return hex;

}


/**
 * HKDF derive creatorAuthorityFragment
 *
 * Protocol invariants:
 *
 * secret === Uint8Array(32)
 * output === HEX64
 * hash === SHA-256
 * length === 256 bits
 */

export async function deriveCreatorAuthorityFragment(
  secret: Uint8Array
): Promise<string> {

  /**
   * WebCrypto availability guard
   */

  const cryptoObj =
    globalThis.crypto;

  if (!cryptoObj?.subtle) {

    throw new Error(
      "[AETERNA] WebCrypto unavailable"
    );

  }


  /**
   * HARD PROTOCOL INVARIANT
   *
   * secret MUST be exactly 32 bytes
   * and buffer MUST NOT be detached
   */

  if (

    !(secret instanceof Uint8Array) ||

    secret.length !== 32 ||

    isDetachedBuffer(secret)

  ) {

    throw new Error(
      "[AETERNA] Invalid secret input for HKDF derivation"
    );

  }


  /**
   * Import HKDF key material
   */

  const hkdfKey =
    await cryptoObj.subtle.importKey(
      "raw",
      secret,
      "HKDF",
      false,
      ["deriveBits"]
    );


  /**
   * Canonical HKDF params
   *
   * NOTE:
   * salt intentionally equals domain namespace.
   * This is canonicalized across AETERNA v1.3
   * and MUST NOT be changed (breaking capability links).
   */

  const hkdfParams: HkdfParams = {

    name: "HKDF",

    hash: "SHA-256",

    salt: HKDF_DOMAIN,

    info: new Uint8Array()

  };


  /**
   * Derive fragment (32 bytes)
   */

  const derivedBits =
    await cryptoObj.subtle.deriveBits(
      hkdfParams,
      hkdfKey,
      256
    );


  /**
   * Detached-buffer guard
   */

  if (!(derivedBits instanceof ArrayBuffer)) {

    throw new Error(
      "[AETERNA] HKDF deriveBits returned invalid buffer"
    );

  }


  /**
   * Convert to HEX64 fragment
   */

  const fragmentBytes =
    new Uint8Array(derivedBits);

  const fragment =
    toHex(fragmentBytes);


  /**
   * Memory safety wipe (canonical §25)
   */

  fragmentBytes.fill(0);


  /**
   * Output invariant enforcement
   */

  if (fragment.length !== 64) {

    throw new Error(
      "[AETERNA] Invalid creatorAuthorityFragment length"
    );

  }


  return fragment;

}