// @/lib/crypto/encryptChunk.ts

import { deriveChunkIV } from "./deriveChunkIV";

import {
  DOMAIN_CHUNK_AAD,
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
  MAX_ENCRYPTED_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
} from "@/lib/crypto/constants";

import {
  CAPSULE_ID_REGEX
} from "@/lib/crypto/validators";


const SEALED_ERROR =
  new Error("[AETERNA] Cryptographic failure");


const encoder =
  new TextEncoder();


function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return arr.buffer.byteLength === 0;

}


function isAllZeroIV(
  arr: Uint8Array
): boolean {

  for (let i = 0; i < arr.length; i++) {

    if (arr[i] !== 0)
      return false;

  }

  return true;

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
 * canonical chunk AAD builder
 */

function buildChunkAAD(
  capsuleId: string,
  index: number
): Uint8Array {

  if (
    typeof DOMAIN_CHUNK_AAD !== "string" ||
    DOMAIN_CHUNK_AAD.length === 0
  ) {
    throw SEALED_ERROR;
  }

  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    throw SEALED_ERROR;
  }

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > 0xffffffff
  ) {
    throw SEALED_ERROR;
  }


  const prefix =
    encoder.encode(
      DOMAIN_CHUNK_AAD
    );


  const capsule =
    encoder.encode(
      capsuleId
    );


  if (
    prefix.byteLength === 0 ||
    capsule.byteLength === 0 ||
    isDetachedBuffer(prefix) ||
    isDetachedBuffer(capsule)
  ) {
    throw SEALED_ERROR;
  }


  const aad =
    new Uint8Array(
      prefix.byteLength +
      capsule.byteLength +
      4
    );


  if (
    aad.byteLength === 0 ||
    isDetachedBuffer(aad)
  ) {
    throw SEALED_ERROR;
  }


  aad.set(prefix, 0);


  aad.set(
    capsule,
    prefix.byteLength
  );


  new DataView(aad.buffer)
    .setUint32(
      prefix.byteLength +
      capsule.byteLength,
      index,
      false
    );


  return aad;

}


/**
 * encryptChunk
 *
 * AES-256-GCM chunk encryption
 *
 * output layout:
 *
 * [12-byte IV][ciphertext+tag]
 */

export async function encryptChunk(
  data: Uint8Array,
  key: CryptoKey,
  baseIV: Uint8Array,
  index: number,
  capsuleId: string
): Promise<Uint8Array> {

  let payload: Uint8Array | null = null;

  let iv: Uint8Array | null = null;

  let cipher: Uint8Array | null = null;

  let aad: Uint8Array | null = null;


  try {

    const cryptoObj =
      globalThis.crypto;

    if (!cryptoObj?.subtle) {

      throw SEALED_ERROR;

    }


    if (
      !(data instanceof Uint8Array) ||
      isDetachedBuffer(data) ||
      data.byteLength === 0 ||
      data.byteLength > MAX_CHUNK_SIZE
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
      !key.usages.includes("encrypt") ||
      algo.name !== "AES-GCM" ||
      algo.length !== 256
    ) {
      throw SEALED_ERROR;
    }


    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 0xffffffff
    ) {
      throw SEALED_ERROR;
    }


    iv =
      await deriveChunkIV(
        baseIV,
        index
      );


    if (
      !(iv instanceof Uint8Array) ||
      iv.byteLength !== AES_GCM_IV_LENGTH ||
      isDetachedBuffer(iv) ||
      isAllZeroIV(iv)
    ) {
      throw SEALED_ERROR;
    }


    aad =
      buildChunkAAD(
        capsuleId,
        index
      );


    /**
     * Internal copy — caller-owned data is never mutated.
     *
     * Isolates the WebCrypto async read boundary from any
     * upstream buffer reuse, retry, or integrity-check flows.
     * Zeroization in `finally` targets only this copy,
     * preserving ownership parity with encryptVault.ts.
     */
    payload = data.slice();


    const encryptedBuffer =
      await cryptoObj.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
          tagLength: AES_GCM_TAG_LENGTH
        },
        key,
        payload
      );


    if (
      !(encryptedBuffer instanceof ArrayBuffer)
    ) {
      throw SEALED_ERROR;
    }


    cipher =
      new Uint8Array(
        encryptedBuffer
      );


    // HARDENING: explicit zero-length guard — symmetric with vault layer.
    // Practically impossible given WebCrypto contract, but makes the
    // invariant visible and independent of upstream assumptions.
    if (
      cipher.byteLength === 0 ||
      cipher.byteLength <
      data.byteLength + (AES_GCM_TAG_LENGTH / 8)
    ) {
      throw SEALED_ERROR;
    }


    const result =
      new Uint8Array(
        iv.byteLength +
        cipher.byteLength
      );


    if (
      isDetachedBuffer(result)
    ) {
      throw SEALED_ERROR;
    }


    // HARDENING: explicit upper-bound on final output size.
    // Enforces the protocol invariant as a named constant rather than
    // relying on the plaintext ceiling propagating correctly through
    // future MAX_CHUNK_SIZE refactors or algorithm changes.
    if (
      result.byteLength >
      MAX_ENCRYPTED_CHUNK_SIZE
    ) {
      throw SEALED_ERROR;
    }


    result.set(iv, 0);


    result.set(
      cipher,
      iv.byteLength
    );


    return result;

  } catch {

    throw SEALED_ERROR;

  } finally {

    try { payload?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }

    try { iv?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }

    try { cipher?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }

    try { aad?.fill(0); } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }

  }

}