/**
 * AETERNA — SHA256 helper (protocol integrity layer)
 *
 * Used for:
 * manifest.ext.vaultSha256 verification
 *
 * Deterministic
 * Browser-native
 * Zero-dependency
 */

function isDetachedBuffer(
  arr: Uint8Array
): boolean {

  return arr.buffer.byteLength === 0;

}

export async function sha256(
  data: Uint8Array
): Promise<string> {

  let bytes: Uint8Array | null = null;

  try {

    const cryptoObj =
      globalThis.crypto;

    if (!cryptoObj?.subtle) {

      throw new Error(
        "[AETERNA] WebCrypto unavailable"
      );

    }

    if (
      !(data instanceof Uint8Array) ||
      data.byteLength === 0 ||
      isDetachedBuffer(data)
    ) {

      throw new Error(
        "[AETERNA] Invalid SHA256 input"
      );

    }

    const digest =
      await cryptoObj.subtle.digest(
        "SHA-256",
        data
      );

    if (
      !(digest instanceof ArrayBuffer)
    ) {

      throw new Error(
        "[AETERNA] SHA256 internal failure"
      );

    }

    bytes =
      new Uint8Array(digest);

    if (
      bytes.byteLength !== 32 ||
      isDetachedBuffer(bytes)
    ) {

      throw new Error(
        "[AETERNA] SHA256 internal failure"
      );

    }

    let hex = "";

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {

      const b =
        bytes[i];

      if (
        typeof b !== "number"
      ) {

        throw new Error(
          "[AETERNA] SHA256 internal failure"
        );

      }

      hex +=
        b
          .toString(16)
          .padStart(2, "0");

    }

    return hex;

  } finally {

    /**
     * Memory safety hardening
     *
     * Always wipe the digest buffer,
     * regardless of how the function exits.
     */

    try {
      bytes?.fill(0);
    } catch {}

  }

}

/**
 * SECURITY MODEL
 *
 * Digest buffers are zeroized after use
 * on every exit path.
 */