/**
 * AETERNA — Shared Solana Identity Proof Primitives
 *
 * Reusable, behavior-identical extraction of the Solana verification
 * primitives previously private to /api/creator/verify-proof:
 *   - base58 decoding (canonical Solana public keys)
 *   - base64 → bytes conversion (wallet signature transport)
 *   - SIWS-style challenge message construction
 *   - Ed25519 verification (WebCrypto)
 *
 * This module is a VERIFICATION HELPER ONLY. It is NOT a second
 * identity authority: it holds no identity store, issues no
 * creatorIdentityId, and makes no entitlement decisions. Challenge
 * binding, single-use behavior, expiry, and identity creation remain
 * exclusively in the canonical endpoints.
 */

export const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    lookup.set(BASE58_ALPHABET[i]!, i);
  }

  const bytes: number[] = [];
  for (const char of input) {
    const value = lookup.get(char);
    if (value === undefined) {
      throw new Error("Invalid base58");
    }

    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }

  let leadingZeros = 0;
  for (const char of input) {
    if (char === "1") {
      leadingZeros++;
    } else {
      break;
    }
  }

  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < leadingZeros; i++) {
    result[i] = 0;
  }
  for (let i = 0; i < bytes.length; i++) {
    result[leadingZeros + bytes.length - 1 - i] = bytes[i]!;
  }

  return result;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function buildSolanaMessage(record: {
  network: string;
  challenge: string;
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
  id: string;
}): string {
  return [
    "AETERNA identity challenge",
    `network=${record.network}`,
    `address=${record.publicKey}`,
    `challenge=${record.challenge}`,
    `id=${record.id}`,
    `issuedAt=${record.issuedAt}`,
    `expiresAt=${record.expiresAt}`,
  ].join("\n");
}

/**
 * Verify a Solana wallet signature over `message`.
 *
 * The verification key is imported FROM `publicKey` itself, so a true
 * result simultaneously binds the signature to the claimed account:
 * the signer IS the account. Returns false for any malformed input
 * (fail-closed).
 */
export async function verifySolanaSignature(
  publicKey: string,
  signatureBase64: string,
  message: string
): Promise<boolean> {
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = base58Decode(publicKey);
  } catch {
    return false;
  }
  if (publicKeyBytes.length !== 32) {
    return false;
  }

  try {
    signatureBytes = base64ToUint8Array(signatureBase64);
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) {
    return false;
  }

  const messageBytes = new TextEncoder().encode(message);

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      messageBytes
    );
  } catch {
    return false;
  }
}
