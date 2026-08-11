import {
  encryptVault,
} from "@/lib/crypto/encryptVault";

import {
  sha256,
} from "@/lib/crypto/sha256";

import {
  CAPSULE_ID_REGEX,
} from "@/lib/crypto/validators";


const PREPARE_ERROR =
  new Error(
    "[AETERNA] Encrypted capsule preparation failed"
  );


export async function prepareEncryptedCapsule(
  params: {

    capsuleId: string;

    vaultBytes: Uint8Array;

    vaultKey: CryptoKey;

  }

): Promise<{

  encryptedPayload: Uint8Array;

  encryptedSizeBytes: number;

  vaultSha256: string;

}> {

  const {
    capsuleId,
    vaultBytes,
    vaultKey,
  } = params;


  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    throw PREPARE_ERROR;

  }


  if (
    !(vaultBytes instanceof Uint8Array) ||
    vaultBytes.byteLength === 0
  ) {

    throw PREPARE_ERROR;

  }


  try {

    const encryptedPayload =
      await encryptVault(
        vaultBytes,
        vaultKey,
      );


    if (
      !(encryptedPayload instanceof Uint8Array) ||
      encryptedPayload.byteLength === 0
    ) {

      throw PREPARE_ERROR;

    }


    const vaultSha256 =
      await sha256(
        encryptedPayload
      );


    if (
      typeof vaultSha256 !== "string" ||
      vaultSha256.length !== 64
    ) {

      throw PREPARE_ERROR;

    }


    return Object.freeze({

      encryptedPayload,

      encryptedSizeBytes:
        encryptedPayload.byteLength,

      vaultSha256,

    });

  }

  catch {

    throw PREPARE_ERROR;

  }

}