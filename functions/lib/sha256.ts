/**
 * AETERNA — SHA-256 canonical hash helper
 *
 * Cloudflare Workers runtime implementation.
 * Used for manifest binding / integrity verification.
 */

export async function sha256(data: Uint8Array): Promise<string> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new Error("[AETERNA] Invalid SHA256 input");
  }

  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  if (bytes.byteLength !== 32) {
    throw new Error("[AETERNA] SHA256 internal failure");
  }

  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }

  return hex;
}
