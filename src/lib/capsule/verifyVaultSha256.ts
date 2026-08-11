import { sha256 } from "@/lib/crypto/sha256";

import {
  SHA256_REGEX
} from "@/lib/crypto/validators";

import {
  MAX_ENCRYPTED_VAULT_SIZE
} from "@/lib/crypto/constants";


function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return arr.buffer.byteLength === 0;

}


/**
 * Constant-time string comparison
 */
function constantTimeHexEqual(
  a: string,
  b: string
): boolean {

  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;

}


/**
 * Verify encrypted Vault integrity
 *
 * REQUIRED invariant:
 *
 * sha256(ciphertextVaultBytes)
 * === manifest.ext.vaultSha256
 */
export async function verifyVaultSha256(
  ciphertextVaultBytes: Uint8Array,
  manifestVaultSha256: string
): Promise<void> {

  if (
    typeof manifestVaultSha256 !== "string" ||
    manifestVaultSha256.length !== 64 ||
    !SHA256_REGEX.test(manifestVaultSha256)
  ) {
    throw new Error(
      "[AETERNA] Invalid manifest.ext.vaultSha256"
    );
  }


  if (
    !(ciphertextVaultBytes instanceof Uint8Array) ||
    ciphertextVaultBytes.byteLength === 0 ||
    isDetachedBuffer(ciphertextVaultBytes)
  ) {
    throw new Error(
      "[AETERNA] Invalid ciphertext vault buffer"
    );
  }


  if (
    ciphertextVaultBytes.byteLength >
    MAX_ENCRYPTED_VAULT_SIZE
  ) {
    throw new Error(
      "[AETERNA] Ciphertext exceeds protocol size limit"
    );
  }


  const actualHex =
    await sha256(ciphertextVaultBytes);


  /**
   * Optional hardening:
   * canonical sha256 result validation
   */
  if (
    typeof actualHex !== "string" ||
    actualHex.length !== 64 ||
    !SHA256_REGEX.test(actualHex)
  ) {
    throw new Error(
      "[AETERNA] Invalid sha256 computation result"
    );
  }


  if (
    !constantTimeHexEqual(
      actualHex,
      manifestVaultSha256
    )
  ) {
    throw new Error(
      "[AETERNA] Vault integrity verification failed"
    );
  }

}