const GENERATE_ERROR =
  new Error(
    "[AETERNA] Recipient secret generation failed"
  );

export function generateRecipientSecret(): string {

  try {

    const bytes =
      crypto.getRandomValues(
        new Uint8Array(32)
      );

    return Array.from(bytes)
      .map(v => v.toString(16).padStart(2, "0"))
      .join("");

  }

  catch {

    throw GENERATE_ERROR;

  }

}