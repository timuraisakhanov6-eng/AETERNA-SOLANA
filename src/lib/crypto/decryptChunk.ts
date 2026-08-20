import {
  DOMAIN_CHUNK_AAD,
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
  MAX_ENCRYPTED_CHUNK_SIZE,
} from "@/lib/crypto/constants";

import {
  CAPSULE_ID_REGEX
} from "@/lib/crypto/validators";


const SEALED_ERROR =
  new Error("[AETERNA] Chunk decryption failed");


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


export async function decryptChunk(
  payload: Uint8Array,
  key: CryptoKey,
  index: number,
  capsuleId: string
): Promise<Uint8Array> {

  let aad: Uint8Array | null = null;

  let decrypted: Uint8Array | null = null;

  try {

    const cryptoObj =
      globalThis.crypto;

    if (!cryptoObj?.subtle) {

      throw SEALED_ERROR;

    }

    if (
      !(payload instanceof Uint8Array) ||
      isDetachedBuffer(payload)
    ) {
      throw SEALED_ERROR;
    }

    if (
      payload.byteLength <
        AES_GCM_IV_LENGTH + (AES_GCM_TAG_LENGTH / 8) ||
      payload.byteLength > MAX_ENCRYPTED_CHUNK_SIZE
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

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 2 ** 32
    ) {
      throw SEALED_ERROR;
    }


    const iv =
      payload.subarray(0, AES_GCM_IV_LENGTH);


    if (
      iv.byteLength !== AES_GCM_IV_LENGTH ||
      isDetachedBuffer(iv) ||
      isAllZeroIV(iv)
    ) {
      throw SEALED_ERROR;
    }


    const ciphertext =
      payload.subarray(AES_GCM_IV_LENGTH);


    if (
      ciphertext.byteLength < AES_GCM_TAG_LENGTH / 8 ||
      isDetachedBuffer(ciphertext)
    ) {
      throw SEALED_ERROR;
    }


    aad =
      buildChunkAAD(
        capsuleId,
        index
      );


    const decryptedBuffer =
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


    if (
      !(decryptedBuffer instanceof ArrayBuffer)
    ) {
      throw SEALED_ERROR;
    }


    decrypted =
      new Uint8Array(
        decryptedBuffer
      );


    if (
      decrypted.byteLength === 0 ||
      isDetachedBuffer(decrypted)
    ) {
      throw SEALED_ERROR;
    }


    /**
     * Ownership isolation — caller receives an independent copy.
     *
     * WebCrypto returns a fresh ArrayBuffer, but returning a direct
     * view leaves the internal crypto buffer reachable and mutable
     * from outside this layer. Slicing severs the shared-reference
     * risk and lets `decrypted.fill(0)` wipe the internal buffer
     * immediately, before the caller has any handle to it.
     *
     * Symmetric with the isolation model on the encrypt side:
     * encryptChunk copies plaintext in, decryptChunk copies
     * plaintext out — crypto memory never escapes the boundary.
     */
    const output =
      decrypted.slice();

    decrypted.fill(0);

    return output;

  } catch {

    throw SEALED_ERROR;

  } finally {

    /**
     * Zeroize only cryptographic material.
     * `decrypted` is wiped inline above before `output` is returned.
     * Guard here handles the error path where `decrypted` was
     * assigned but the slice or fill threw before completion.
     */
    try { aad?.fill(0); } catch {
      // Intentional no-op: zeroization failure must not alter fail-closed path.
    }

    try { decrypted?.fill(0); } catch {
      // Intentional no-op: zeroization failure must not alter fail-closed path.
    }

  }

}