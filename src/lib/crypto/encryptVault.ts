import {
  getVaultAAD,
  MAX_ENCRYPTED_VAULT_SIZE,
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
} from "@/lib/crypto/constants";


const SEALED_ERROR =
  new Error("[AETERNA] Cryptographic failure");


function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return arr.buffer.byteLength === 0;

}


function isCryptoKey(
  value: unknown
): value is CryptoKey {

  return (
    typeof CryptoKey !== "undefined" &&
    value instanceof CryptoKey
  );

}


/**
 * Ensures canonical vault AAD invariant.
 *
 * ABSOLUTE PROTOCOL INVARIANT:
 *
 * AAD must equal Uint8Array([1])
 */
function buildVaultAAD(): Uint8Array {

  const aad = getVaultAAD();

  if (
    !(aad instanceof Uint8Array) ||
    aad.length !== 1 ||
    aad[0] !== 1
  ) {
    throw SEALED_ERROR;
  }

  return aad;

}


/**
 * Safe Uint8Array → base64 conversion
 */
function encodeBase64(
  bytes: Uint8Array
): string {

  try {

    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0
    ) {
      throw SEALED_ERROR;
    }

    /**
     * Chunked conversion avoids large intermediate string copies
     * and prevents stack overflow on large buffers.
     */

    const chunkSize = 0x8000;

    let binary = "";

    for (
      let i = 0;
      i < bytes.length;
      i += chunkSize
    ) {

      const sub =
        bytes.subarray(
          i,
          i + chunkSize
        );

      binary += String.fromCharCode.apply(
        null,
        Array.from(sub)
      );

    }

    return btoa(binary);

  } catch {

    throw SEALED_ERROR;

  }

}


/**
 * Canonical vault encryption
 *
 * Output format:
 *
 * JSON envelope v2:
 *
 * {
 *   v: 2,
 *   iv: base64,
 *   d: base64
 * }
 *
 * Fully compatible with decryptVault.ts
 */
export async function encryptVault(
  plaintext: Uint8Array,
  key: CryptoKey
): Promise<Uint8Array> {

  let data: Uint8Array | null = null;
  let iv: Uint8Array | null = null;
  let aad: Uint8Array | null = null;
  let ciphertext: Uint8Array | null = null;
  let encoded: Uint8Array | null = null;

  try {

    const cryptoObj =
      globalThis.crypto;

    if (
      !cryptoObj?.subtle ||
      !cryptoObj.getRandomValues
    ) {
      throw SEALED_ERROR;
    }


    if (
      !(plaintext instanceof Uint8Array) ||
      plaintext.byteLength === 0 ||
      isDetachedBuffer(plaintext)
    ) {
      throw SEALED_ERROR;
    }


    if (!isCryptoKey(key)) {
      throw SEALED_ERROR;
    }


    const algo =
      key.algorithm as Partial<AesKeyAlgorithm> | null;


    /**
     * Strict AES-256-GCM key validation
     */
    if (
      !algo ||
      algo.name !== "AES-GCM" ||
      typeof algo.length !== "number" ||
      algo.length !== 256 ||
      key.type !== "secret" ||
      key.extractable !== false ||
      !key.usages.includes("encrypt")
    ) {
      throw SEALED_ERROR;
    }


    /**
     * Internal copy — caller-owned plaintext is never mutated.
     *
     * Zeroization in `finally` targets only this isolated copy,
     * preserving upstream state for preview, retry, and
     * integrity-verification flows.
     */
    data = plaintext.slice();


    /**
     * Generate canonical 96-bit IV
     */
    iv =
      cryptoObj.getRandomValues(
        new Uint8Array(AES_GCM_IV_LENGTH)
      );


    if (
      iv.byteLength !== AES_GCM_IV_LENGTH ||
      isDetachedBuffer(iv)
    ) {
      throw SEALED_ERROR;
    }


    aad =
      buildVaultAAD();


    /**
     * AES-256-GCM encryption
     */
    const ciphertextBuffer =
      await cryptoObj.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
          tagLength: AES_GCM_TAG_LENGTH
        },
        key,
        data
      );


    if (
      !(ciphertextBuffer instanceof ArrayBuffer)
    ) {
      throw SEALED_ERROR;
    }


    ciphertext =
      new Uint8Array(
        ciphertextBuffer
      );


    /**
     * Ciphertext must include auth tag
     */
    if (
      ciphertext.byteLength <
      data.byteLength + 16
    ) {
      throw SEALED_ERROR;
    }


    /**
     * Canonical envelope v2.
     *
     * Field order is hardcoded in the template literal — not
     * delegated to JSON.stringify — so canonical output is
     * engine-independent and refactor-proof. A future change
     * to the envelope object (reordered keys, spread, any cast)
     * cannot silently drift the wire format.
     */
    const ivB64 =
      encodeBase64(iv);

    const cipherB64 =
      encodeBase64(ciphertext);

    const envelopeJson =
      `{"v":2,"iv":"${ivB64}","d":"${cipherB64}"}`;


    encoded =
      new TextEncoder().encode(
        envelopeJson
      );


    /**
     * Detached-buffer guard + empty-buffer guard.
     *
     * isDetachedBuffer: rejects malformed transfer objects from
     * exotic runtimes or worker-context memory-transfer bugs.
     *
     * byteLength === 0: defensive invariant — TextEncoder on a
     * non-empty string cannot produce an empty buffer, but an
     * explicit check closes the gap against runtime anomalies
     * before the size ceiling check.
     */
    if (
      isDetachedBuffer(encoded) ||
      encoded.byteLength === 0
    ) {
      throw SEALED_ERROR;
    }


    /**
     * PROTOCOL INVARIANT
     *
     * MAX_ENCRYPTED_VAULT_SIZE applies to:
     * ciphertext envelope AFTER encryption
     */
    if (
      encoded.byteLength >
      MAX_ENCRYPTED_VAULT_SIZE
    ) {
      throw SEALED_ERROR;
    }


    return encoded;

  } catch {

    throw SEALED_ERROR;

  } finally {

    try { data?.fill(0); } catch { /* Intentional no-op: cleanup failure must not alter fail-closed path. */ }

    try { iv?.fill(0); } catch { /* Intentional no-op: cleanup failure must not alter fail-closed path. */ }

    try { aad?.fill(0); } catch { /* Intentional no-op: cleanup failure must not alter fail-closed path. */ }

    try { ciphertext?.fill(0); } catch { /* Intentional no-op: cleanup failure must not alter fail-closed path. */ }

  }

}