import {
  getVaultAAD,
  MAX_ENCRYPTED_VAULT_SIZE,
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
} from "@/lib/crypto/constants";

import { deepFreeze } from "@/lib/utils/deepFreeze";


export interface EncryptedEnvelope {
  v: 2;
  iv: string;
  d: string;
}


const SEALED_ERROR =
  new Error("[AETERNA] Cryptographic failure");


/**
 * Observation 1 — module-scope frozen whitelist
 * Eliminates per-call allocation; mirrors pattern in openCapsule.ts.
 */

const ALLOWED_ENVELOPE_KEYS =
  Object.freeze(["v", "iv", "d"]);


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


function isBase64(str: string): boolean {

  if (
    typeof str !== "string" ||
    str.length === 0 ||
    str.length % 4 !== 0
  ) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(str);

}


function buildVaultAAD(): Uint8Array {

  const aad = getVaultAAD();

  if (
    !(aad instanceof Uint8Array) ||
    aad.byteLength !== 1 ||
    aad[0] !== 1
  ) {
    throw SEALED_ERROR;
  }

  return aad;

}


function decodeBase64Canonical(
  str: string
): Uint8Array {

  try {

    if (
      typeof str !== "string" ||
      str.length === 0 ||
      !isBase64(str) ||
      typeof atob !== "function"
    ) {
      throw SEALED_ERROR;
    }

    const binary =
      atob(str);

    const len =
      binary.length;

    /**
     * MAX_ENCRYPTED_VAULT_SIZE applies ONLY to:
     * encrypted envelope bytes (encryptedData.byteLength)
     *
     * NOT to decoded base64 fields.
     * Removed per Master Document v3.1 §6.
     */
    if (
      !Number.isFinite(len) ||
      len === 0
    ) {
      throw SEALED_ERROR;
    }

    const bytes =
      new Uint8Array(len);

    for (
      let i = 0;
      i < len;
      i++
    ) {
      bytes[i] =
        binary.charCodeAt(i);
    }

    if (
      isDetachedBuffer(bytes)
    ) {
      throw SEALED_ERROR;
    }

    return bytes;

  } catch {

    throw SEALED_ERROR;

  }

}


export async function decryptVault(
  encryptedData: Uint8Array,
  key: CryptoKey
): Promise<unknown> {

  const cryptoObj =
    globalThis.crypto;

  if (!cryptoObj?.subtle) {
    throw SEALED_ERROR;
  }

  /**
   * Canonical size check per Master Document v3.1 §6
   * This is the ONLY place MAX_ENCRYPTED_VAULT_SIZE is applied.
   */
  if (
    !(encryptedData instanceof Uint8Array) ||
    encryptedData.byteLength === 0 ||
    encryptedData.byteLength > MAX_ENCRYPTED_VAULT_SIZE ||
    isDetachedBuffer(encryptedData)
  ) {
    throw SEALED_ERROR;
  }

  if (!isCryptoKey(key)) {
    throw SEALED_ERROR;
  }

  const algo =
    key.algorithm as AesKeyAlgorithm;

  if (
    key.type !== "secret" ||
    key.extractable !== false ||
    !key.usages.includes("decrypt") ||
    algo.name !== "AES-GCM" ||
    algo.length !== 256
  ) {
    throw SEALED_ERROR;
  }

  const decoder =
    new TextDecoder(
      "utf-8",
      { fatal: true }
    );

  let envelope:
    EncryptedEnvelope;

  try {

    const jsonStr =
      decoder.decode(
        encryptedData
      );

    envelope =
      JSON.parse(jsonStr);

  } catch {

    throw SEALED_ERROR;

  }

  if (
    !envelope ||
    Object.getPrototypeOf(envelope) !== Object.prototype ||
    envelope.v !== 2 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.d !== "string"
  ) {
    throw SEALED_ERROR;
  }

  /**
   * Envelope key whitelist — closes parity gap with emergency runtime.
   * Extra fields beyond {v, iv, d} are not part of the EncryptedEnvelope
   * schema and must be rejected before deepFreeze locks the object.
   */
  for (const k of Object.keys(envelope)) {
    if (!ALLOWED_ENVELOPE_KEYS.includes(k)) {
      throw SEALED_ERROR;
    }
  }

  deepFreeze(envelope);

  let iv =
    decodeBase64Canonical(
      envelope.iv
    );

  let ciphertext =
    decodeBase64Canonical(
      envelope.d
    );

  if (
    iv.byteLength !== AES_GCM_IV_LENGTH ||
    ciphertext.byteLength < AES_GCM_TAG_LENGTH / 8
  ) {
    throw SEALED_ERROR;
  }

  /**
   * decryptedBuffer declared in outer scope so the finally block
   * can wipe it regardless of whether decode or parse throws.
   * Spec §18: plaintext bytes must not outlive their use.
   */
  let decryptedBuffer: ArrayBuffer | undefined;

  let aad: Uint8Array | null = null;

  try {

    aad =
      buildVaultAAD();

    decryptedBuffer =
      await cryptoObj.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
          tagLength: AES_GCM_TAG_LENGTH
        },
        key,
        ciphertext
      );

    const plaintext =
      decoder.decode(
        decryptedBuffer
      );

    const parsed =
      JSON.parse(
        plaintext
      );

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      throw SEALED_ERROR;
    }

    deepFreeze(parsed);

    return parsed;

  } catch {

    throw SEALED_ERROR;

  } finally {

    // Wipe plaintext buffer on every exit path: success, decode failure,
    // parse failure, schema rejection. Guard handles the case where
    // crypto.subtle.decrypt itself threw before decryptedBuffer was set.
    if (decryptedBuffer !== undefined) {
      try { new Uint8Array(decryptedBuffer).fill(0); } catch {}
    }

    try {
      aad?.fill(0);
    } catch {}

    try {
      iv.fill(0);
    } catch {}

    try {
      ciphertext.fill(0);
    } catch {}

  }

}