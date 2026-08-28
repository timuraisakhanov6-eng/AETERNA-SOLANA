/**
 * AETERNA — Irys storage quote helper
 *
 * Minimal read-only Irys client for:
 * - usdc-solana price
 * - dynamic Irys USDC funding destination
 *
 * This module does NOT perform uploads or funding.
 */

const IRYS_NODE_URL = "https://node1.irys.xyz";
const IRYS_TOKEN = "usdc-solana";

const IRYS_HTTP_TIMEOUT_MS = 15_000;

async function irysFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    IRYS_HTTP_TIMEOUT_MS
  );

  try {
    return await fetch(`${IRYS_NODE_URL}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function irysFetchText(
  path: string,
  errorCode: string
): Promise<string> {
  const res = await irysFetch(path);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `${errorCode}_HTTP_${res.status}${body ? `: ${body}` : ""}`
    );
  }
  return res.text();
}

export async function getIrysUsdcSolanaPrice(
  sizeBytes: number
): Promise<string> {
  const text = await irysFetchText(
    `/price/${IRYS_TOKEN}/${sizeBytes}`,
    "IRYS_STORAGE_PRICE"
  );

  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "number") return String(parsed);
    if (
      parsed &&
      typeof parsed === "object" &&
      "price" in parsed
    ) {
      return String((parsed as { price: unknown }).price);
    }
  } catch {
    // ignore and fall through
  }

  throw new Error("IRYS_STORAGE_PRICE_INVALID_RESPONSE");
}

export async function getIrysUsdcDestination(): Promise<string> {
  const text = await irysFetchText("/info", "IRYS_INFO");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("IRYS_INFO_INVALID_RESPONSE");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("addresses" in parsed)
  ) {
    throw new Error("IRYS_INFO_MISSING_ADDRESSES");
  }

  const addresses = (parsed as { addresses?: Record<string, string> }).addresses;
  const address = addresses?.[IRYS_TOKEN];

  if (!address || typeof address !== "string") {
    throw new Error("IRYS_INFO_USDC_SOLANA_ADDRESS_MISSING");
  }

  return address;
}
