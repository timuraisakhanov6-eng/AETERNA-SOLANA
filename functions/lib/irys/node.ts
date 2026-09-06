/**
 * AETERNA — Irys Node transaction confirmation helper
 *
 * Primary authoritative source for publication facts (canonical
 * §3.2/§5 of the publication/seal/finalization spec). Shared by
 * /api/publication/verify and /api/publication/claim.
 *
 * Read-only: no keys, no funding, no Executor Hot.
 */

import { IRYS_NODE_URL } from "../../irys/transport";

export type IrysNodeConfirmation = "CONFIRMED" | "ABSENT" | "UNAVAILABLE";

const IRYS_NODE_TIMEOUT_MS = 8000;

/**
 * Confirms that the Irys node holds the exact transaction:
 *   - HTTP 200 (path-addressed) → "CONFIRMED";
 *   - if the body exposes an `id`, it must match — a mismatched body
 *     is a protocol anomaly → "UNAVAILABLE" (fail-closed, retry);
 *   - 404 → "ABSENT" (definitively not published);
 *   - 5xx / timeout / network → "UNAVAILABLE".
 */
export async function confirmTxOnIrysNode(expectedTxId: string): Promise<IrysNodeConfirmation> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IRYS_NODE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${IRYS_NODE_URL}/tx/${expectedTxId}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch {
    return "UNAVAILABLE";
  }

  if (res.status === 404) {
    return "ABSENT";
  }

  if (!res.ok) {
    return "UNAVAILABLE";
  }

  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    if (
      body &&
      typeof body === "object" &&
      typeof body["id"] === "string" &&
      body["id"] !== expectedTxId
    ) {
      return "UNAVAILABLE";
    }
  } catch {
    // Non-JSON body: the path-addressed 200 remains the confirmation.
  }

  return "CONFIRMED";
}
