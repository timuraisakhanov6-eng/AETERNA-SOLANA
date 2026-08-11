import {
  DOMAIN_CHUNK_BASE_IV,
  AES_GCM_IV_LENGTH,
} from "@/lib/crypto/constants";

import {
  CAPSULE_ID_REGEX,
  ITEM_ID_REGEX,
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


/**
 * deriveChunkBaseIV
 *
 * deterministic per-media base IV derivation
 *
 * layout:
 *
 * DOMAIN_CHUNK_BASE_IV
 * 0x00
 * capsuleId
 * 0x00
 * itemId
 *
 * SHA-256 → truncate to 96-bit
 *
 * guarantees:
 *
 * • capsule isolation
 * • media-item isolation
 * • deterministic reproducibility
 * • AES-GCM nonce namespace separation
 */

export async function deriveChunkBaseIV(
  capsuleId: string,
  itemId: string,
): Promise<Uint8Array> {

  let material: Uint8Array | null = null;
  let hash: Uint8Array | null = null;

  try {

    /**
     * WebCrypto availability
     */

    const cryptoObj =
      globalThis.crypto;

    if (!cryptoObj?.subtle) {
       throw SEALED_ERROR;
  }


    /**
     * domain invariant
     */

    if (
      typeof DOMAIN_CHUNK_BASE_IV !== "string" ||
      DOMAIN_CHUNK_BASE_IV.length === 0
    ) {
      throw SEALED_ERROR;
    }


    /**
     * capsuleId validation
     */

    if (
      typeof capsuleId !== "string" ||
      !CAPSULE_ID_REGEX.test(capsuleId)
    ) {
      throw SEALED_ERROR;
    }


    /**
     * itemId validation
     */

    if (
      typeof itemId !== "string" ||
      !ITEM_ID_REGEX.test(itemId)
    ) {
      throw SEALED_ERROR;
    }


    /**
     * canonical derivation layout
     */

    const domainBytes =
      encoder.encode(
        DOMAIN_CHUNK_BASE_IV
      );

    const capsuleBytes =
      encoder.encode(
        capsuleId
      );

    const itemBytes =
      encoder.encode(
        itemId
      );


    if (
      domainBytes.byteLength === 0 ||
      capsuleBytes.byteLength === 0 ||
      itemBytes.byteLength === 0 ||
      isDetachedBuffer(domainBytes) ||
      isDetachedBuffer(capsuleBytes) ||
      isDetachedBuffer(itemBytes)
    ) {
      throw SEALED_ERROR;
    }


    material =
      new Uint8Array(
        domainBytes.byteLength +
        1 +
        capsuleBytes.byteLength +
        1 +
        itemBytes.byteLength
      );


    if (
      material.byteLength === 0 ||
      isDetachedBuffer(material)
    ) {
      throw SEALED_ERROR;
    }


    let offset = 0;


    material.set(
      domainBytes,
      offset
    );

    offset +=
      domainBytes.byteLength;


    material[offset++] =
      0x00;


    material.set(
      capsuleBytes,
      offset
    );

    offset +=
      capsuleBytes.byteLength;


    material[offset++] =
      0x00;


    material.set(
      itemBytes,
      offset
    );


    /**
     * SHA-256 digest
     */

    const hashBuffer =
      await cryptoObj.subtle.digest(
        "SHA-256",
        material
      );


    if (
      !(hashBuffer instanceof ArrayBuffer) ||
      hashBuffer.byteLength !== 32
    ) {
      throw SEALED_ERROR;
    }


    hash =
      new Uint8Array(
        hashBuffer
      );


    if (
      isDetachedBuffer(hash)
    ) {
      throw SEALED_ERROR;
    }


    /**
     * truncate → 96-bit IV
     */

    const baseIV =
      hash.slice(0, AES_GCM_IV_LENGTH);


    if (
      !(baseIV instanceof Uint8Array) ||
      baseIV.byteLength !== AES_GCM_IV_LENGTH ||
      isDetachedBuffer(baseIV) ||
      isAllZeroIV(baseIV)
    ) {
      throw SEALED_ERROR;
    }


    return baseIV;

  } catch {

    throw SEALED_ERROR;

  } finally {

    try {
      material?.fill(0);
    } catch {}

    try {
      hash?.fill(0);
    } catch {}

    material = null;
    hash = null;

  }

}