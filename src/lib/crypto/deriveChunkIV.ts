import {
  DOMAIN_CHUNK_IV,
  AES_GCM_IV_LENGTH,
} from "@/lib/crypto/constants";


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
 * deriveChunkIV
 *
 * deterministic nonce derivation
 *
 * layout:
 * DOMAIN_CHUNK_IV
 * 0x00
 * baseIV
 * 0x00
 * chunkIndex (uint32 BE)
 *
 * hashed via SHA-256 → truncated to 96-bit
 *
 * prevents:
 * - nonce reuse
 * - chunk reorder attacks
 * - cross-capsule collisions
 * - domain derivation ambiguity
 */

export async function deriveChunkIV(
  baseIV: Uint8Array,
  index: number
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
     * domain separation invariant
     */

    if (
      typeof DOMAIN_CHUNK_IV !== "string" ||
      DOMAIN_CHUNK_IV.length === 0
    ) {
      throw SEALED_ERROR;
    }


    /**
     * validate baseIV
     */

    if (
      !(baseIV instanceof Uint8Array) ||
      baseIV.byteLength !== AES_GCM_IV_LENGTH ||
      isDetachedBuffer(baseIV) ||
      isAllZeroIV(baseIV)
    ) {
      throw SEALED_ERROR;
    }


    /**
     * validate chunk index
     */

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 2 ** 32
    ) {
      throw SEALED_ERROR;
    }


    /**
     * build derivation material
     */

    const domainBytes =
      encoder.encode(
        DOMAIN_CHUNK_IV
      );


    if (
      domainBytes.byteLength === 0
    ) {
      throw SEALED_ERROR;
    }


    material =
      new Uint8Array(
        domainBytes.length +
        1 +
        AES_GCM_IV_LENGTH +
        1 +
        4
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
      domainBytes.length;


    material[offset++] =
      0x00;


    material.set(
      baseIV,
      offset
    );

    offset +=
      AES_GCM_IV_LENGTH;


    material[offset++] =
      0x00;


    new DataView(
      material.buffer
    ).setUint32(
      offset,
      index,
      false
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
     * extract 96-bit IV
     */

    const iv =
      hash.slice(0, AES_GCM_IV_LENGTH);


    if (
      !(iv instanceof Uint8Array) ||
      iv.length !== AES_GCM_IV_LENGTH ||
      isDetachedBuffer(iv) ||
      isAllZeroIV(iv)
    ) {
      throw SEALED_ERROR;
    }


    return iv;

  } catch {

    throw SEALED_ERROR;

  } finally {

    try {
      material?.fill(0);
    } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }

    try {
      hash?.fill(0);
    } catch { /* Intentional no-op: zeroization failure must not alter fail-closed path. */ }

    material = null;
    hash = null;

  }

}