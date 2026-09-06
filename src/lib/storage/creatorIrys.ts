/**
 * AETERNA — Creator-paid Irys browser capability (Phase A)
 *
 * Canonical basis: AETERNA_IRYS_DIRECT_CREATOR_PAYMENT_AND_CHUNK_PAYMENT_POLICY_SPEC
 * — the Creator pays Irys directly from their own wallet; AETERNA never
 * funds, prices, or marks up Irys storage; the AETERNA $1 Service Payment
 * is a separate economic operation.
 *
 * This module is browser-side ONLY:
 *   - the wallet (Reown/AppKit Solana provider) holds the signer;
 *   - AETERNA servers never see a private key;
 *   - no EXECUTOR_PRIVATE_KEY / Executor Hot code is imported;
 *   - the returned txId is CLIENT EVIDENCE only — the server must
 *     independently verify it against the Irys Node before any
 *     publication state becomes VERIFIED (see /api/publication/*).
 *
 * Not yet wired into the production upload flow (Phase D).
 */

import { WebUploader } from "@irys/web-upload";

/** Canonical Irys mainnet node — same constant the server transport uses. */
const IRYS_NODE_URL = "https://node1.irys.xyz";

/** Irys token family used by the creator-paid Solana USDC rail. */
const IRYS_TOKEN = "usdc-solana";

const IRYS_HTTP_TIMEOUT_MS = 15_000;

/**
 * Minimal wallet surface required by @irys/web-upload-solana
 * (verified against installed package source):
 *   - provider.publicKey (PublicKey with toBuffer());
 *   - provider.signMessage(data)  — data-item signing;
 *   - provider.sendTransaction(tx, connection) — funding transfer.
 * This is the standard Solana wallet-adapter interface exposed by
 * the Reown AppKit Solana provider already used by AETERNA.
 */
export interface CreatorIrysWallet {
  publicKey: unknown;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  sendTransaction?(transaction: unknown, connection: unknown): Promise<string>;
}

export interface CreatorIrysUploadResult {
  /** Client evidence only — server verifies against the Irys Node. */
  txId: string;
}

function failClosed(reason: string): never {
  throw new Error(`[AETERNA] creatorIrys: ${reason}`);
}

function requireWallet(wallet: CreatorIrysWallet | null | undefined): CreatorIrysWallet {
  if (!wallet) failClosed("wallet is required");
  if (!wallet.publicKey) failClosed("wallet.publicKey is required");
  if (typeof wallet.signMessage !== "function") failClosed("wallet.signMessage is required");
  return wallet;
}

/**
 * Builds a browser Irys uploader bound to the creator's wallet.
 * The wallet is passed through as the injected provider; no keys
 * are extracted, exported, or stored anywhere.
 */
async function buildCreatorUploader(wallet: CreatorIrysWallet, rpcUrl?: string): Promise<{
  getPrice(byteLength: number): Promise<{ toString(): string }>;
  getBalance(): Promise<{ toString(): string }>;
  fund(amount: { toString(): string }): Promise<unknown>;
  upload(data: Uint8Array): Promise<{ id?: unknown }>;
}> {
  const builder = WebUploader({
    url: IRYS_NODE_URL,
    token: IRYS_TOKEN,
  })
    .withProvider(wallet as never)
    .withRpc(rpcUrl ?? "https://api.mainnet-beta.solana.com");

  const uploader = (await builder.build()) as unknown as {
    getPrice(byteLength: number): Promise<{ toString(): string }>;
    getBalance(): Promise<{ toString(): string }>;
    fund(amount: { toString(): string }): Promise<unknown>;
    upload(data: Uint8Array): Promise<{ id?: unknown }>;
  } | null;

  if (!uploader) failClosed("failed to build Irys uploader");
  return uploader;
}

/**
 * Irys-determined storage price for a payload size, in the token's
 * atomic units. The price is fetched from the Irys node; AETERNA
 * never sets or alters it.
 */
export async function getCreatorIrysUploadPrice(
  byteLength: number,
  wallet: CreatorIrysWallet,
  rpcUrl?: string
): Promise<string> {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    failClosed("invalid payload size");
  }
  requireWallet(wallet);

  const uploader = await buildCreatorUploader(wallet, rpcUrl);
  try {
    const price = await uploader.getPrice(byteLength);
    const atomic = typeof price === "object" && price !== null ? price.toString() : String(price);
    if (!/^\d+$/.test(atomic)) failClosed("malformed Irys price");
    return atomic;
  } catch (error) {
    failClosed(`price lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Irys deposit destination (the address the creator pays), resolved
 * from the Irys node itself — never an AETERNA-controlled address.
 */
export async function getCreatorIrysDestination(): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IRYS_HTTP_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${IRYS_NODE_URL}/info`, { method: "GET", cache: "no-store", signal: controller.signal });
    clearTimeout(timeoutId);
  } catch (error) {
    failClosed(`Irys info lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!res.ok) failClosed(`Irys info lookup failed: HTTP_${res.status}`);

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    failClosed("Irys info malformed response");
  }

  const addresses = parsed?.["addresses"];
  if (
    !addresses ||
    typeof addresses !== "object" ||
    typeof (addresses as Record<string, unknown>)[IRYS_TOKEN] !== "string" ||
    ((addresses as Record<string, unknown>)[IRYS_TOKEN] as string).length === 0
  ) {
    failClosed("Irys info missing deposit address");
  }

  return (addresses as Record<string, unknown>)[IRYS_TOKEN] as string;
}

/**
 * Creator-paid upload: ensures the creator's own Irys balance covers
 * the Irys-determined price (one wallet confirmation for the funding
 * transfer when needed), then uploads the bytes and returns the
 * publication txId as client evidence.
 */
export async function uploadCreatorPaid(
  data: Uint8Array,
  wallet: CreatorIrysWallet,
  rpcUrl?: string
): Promise<CreatorIrysUploadResult> {
  requireWallet(wallet);

  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    failClosed("invalid payload");
  }

  const uploader = await buildCreatorUploader(wallet, rpcUrl);

  try {
    const price = await uploader.getPrice(data.byteLength);
    const balance = await uploader.getBalance();

    if (BigInt(balance.toString()) < BigInt(price.toString())) {
      if (typeof wallet.sendTransaction !== "function") {
        failClosed("wallet does not support sendTransaction required for Irys funding");
      }
      await uploader.fund(price);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[AETERNA] creatorIrys:")) throw error;
    failClosed(`Irys funding check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let receipt: { id?: unknown } | null = null;
  try {
    receipt = await uploader.upload(data);
  } catch (error) {
    failClosed(`Irys upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!receipt || typeof receipt !== "object") {
    failClosed("malformed Irys receipt");
  }

  const txId = receipt.id;
  if (typeof txId !== "string" || txId.length === 0) {
    failClosed("Irys receipt has no txId");
  }

  return { txId };
}
