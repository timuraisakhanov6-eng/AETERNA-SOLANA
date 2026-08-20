import {
  PBKDF2_ITERATIONS,
  DOMAIN_VAULT_SALT,
  DOMAIN_VAULT_KEY,
} from "@/lib/crypto/constants";

import {
  CAPSULE_ID_REGEX,
  SECRET_REGEX,
  SALT_BASE_REGEX,
} from "@/lib/crypto/validators";


function cryptoError(): never {
  throw new Error("[AETERNA] Cryptographic failure");
}


const MAX_TIMESTAMP = 4102444800000;


const encoder =
  new TextEncoder();


/**
 * strict hex → bytes
 */
function hexToBytes(hex: string): Uint8Array {

  if (hex.length % 2 !== 0) {
    cryptoError();
  }

  const len = hex.length;
  const bytes = new Uint8Array(len / 2);

  for (let i = 0; i < len; i += 2) {

    const byte = Number.parseInt(
      hex.slice(i, i + 2),
      16
    );

    if (Number.isNaN(byte)) {
      cryptoError();
    }

    bytes[i / 2] = byte;

  }

  return bytes;

}


/**
 * canonical uint64 big-endian encoding
 */
function encodeUint64BE(value: number): Uint8Array {

  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP
  ) {
    cryptoError();
  }

  const buffer = new ArrayBuffer(8);

  new DataView(buffer).setBigUint64(
    0,
    BigInt(value),
    false
  );

  return new Uint8Array(buffer);

}


/**
 * deterministic salt construction
 *
 * Layout:
 * domain 0x00 saltBase 0x00 openAt(8 bytes BE) 0x00 capsuleId
 *
 * capsuleId is encoded as UTF-8, not hex — it is a string
 * identifier (UUID / UUID-like), consistent with how capsuleId
 * is encoded elsewhere in the protocol (AAD, chunk derivation).
 */
function buildSaltMaterial(
  saltBase: string,
  openAt: number,
  capsuleId: string,
): Uint8Array {

  const domain = encoder.encode(
    DOMAIN_VAULT_SALT
  );

  const saltBaseBytes =
    hexToBytes(saltBase);

  const openAtBytes =
    encodeUint64BE(openAt);

  const capsuleIdBytes =
    encoder.encode(capsuleId);

  const result = new Uint8Array(
    domain.length +
    1 +
    saltBaseBytes.length +
    1 +
    openAtBytes.length +
    1 +
    capsuleIdBytes.length
  );

  let offset = 0;

  result.set(domain, offset);
  offset += domain.length;

  result[offset++] = 0x00;

  result.set(
    saltBaseBytes,
    offset
  );

  offset += saltBaseBytes.length;

  result[offset++] = 0x00;

  result.set(
    openAtBytes,
    offset
  );

  offset += openAtBytes.length;

  result[offset++] = 0x00;

  result.set(
    capsuleIdBytes,
    offset
  );

  return result;

}


/**
 * canonical vault key derivation
 */
export async function generateVaultKey(params: {
  secret: string;
  saltBase: string;
  openAt: number;
  capsuleId: string;
}): Promise<CryptoKey> {

  const {
    secret,
    saltBase,
    openAt,
    capsuleId
  } = params;

  const cryptoObj =
    globalThis.crypto;

  if (!cryptoObj?.subtle) {
    cryptoError();
  }

  if (
    !SECRET_REGEX.test(secret)
  ) {
    cryptoError();
  }

  if (
    !SALT_BASE_REGEX.test(saltBase)
  ) {
    cryptoError();
  }

  if (
    !Number.isInteger(openAt) ||
    openAt <= 0 ||
    openAt > MAX_TIMESTAMP
  ) {
    cryptoError();
  }

  if (
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    cryptoError();
  }

  const secretBytes =
    hexToBytes(secret);

  /**
   * HARD PROTOCOL INVARIANT
   *
   * Secret MUST be exactly 32 bytes (HEX64)
   * Even if regex passes, enforce binary length check.
   */
  if (secretBytes.length !== 32) {
    cryptoError();
  }

  let saltMaterial:
    Uint8Array | null = null;

  let salt:
    Uint8Array | null = null;

  // Tracked for wipe — holds DOMAIN_VAULT_KEY || saltHash before
  // the second SHA-256 digest. Must be zeroed on all exit paths.
  let combined:
    Uint8Array | null = null;

  let pbkdfSalt:
    Uint8Array | null = null;

  try {

    saltMaterial =
      buildSaltMaterial(
        saltBase,
        openAt,
        capsuleId
      );

    const saltHashBuffer =
      await cryptoObj.subtle.digest(
        "SHA-256",
        saltMaterial
      );

    salt =
      new Uint8Array(
        saltHashBuffer
      );

    /**
     * SECOND DOMAIN SEPARATION LAYER
     * PBKDF2 namespace isolation
     */

    const keyDomain =
      encoder.encode(
        DOMAIN_VAULT_KEY
      );

    combined =
      new Uint8Array(
        keyDomain.length +
        salt.length
      );

    combined.set(
      keyDomain,
      0
    );

    combined.set(
      salt,
      keyDomain.length
    );

    const pbkdfSaltBuffer =
      await cryptoObj.subtle.digest(
        "SHA-256",
        combined
      );

    pbkdfSalt =
      new Uint8Array(
        pbkdfSaltBuffer
      );

    const baseKey =
      await cryptoObj.subtle.importKey(
        "raw",
        secretBytes,
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
      );

    const derivedKey =
      await cryptoObj.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: pbkdfSalt,
          iterations:
            PBKDF2_ITERATIONS,
          hash: "SHA-256",
        },
        baseKey,
        {
          name: "AES-GCM",
          length: 256,
        },
        false,
        [
          "encrypt",
          "decrypt"
        ]
      );

    return derivedKey;

  } catch {

    throw cryptoError();

  } finally {

    try { secretBytes.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }
    try { saltMaterial?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }
    try { salt?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }
    try { combined?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }
    try { pbkdfSalt?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }

  }

}