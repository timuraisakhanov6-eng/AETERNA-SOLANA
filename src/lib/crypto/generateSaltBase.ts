import {
  SALT_BASE_LENGTH_BYTES,
} from "@/lib/crypto/constants";

const SALT_ERROR =
  new Error(
    "[AETERNA] Salt generation failed"
  );

export function generateSaltBase(): string {

  try {

    const cryptoObj =
      globalThis.crypto;

    if (!cryptoObj?.getRandomValues) {
      throw SALT_ERROR;
    }

    const bytes =
      new Uint8Array(
        SALT_BASE_LENGTH_BYTES
      );

    cryptoObj.getRandomValues(
      bytes
    );

    return Array
      .from(
        bytes,
        b =>
          b
            .toString(16)
            .padStart(2, "0")
      )
      .join("");

  } catch {

    throw SALT_ERROR;

  }

}