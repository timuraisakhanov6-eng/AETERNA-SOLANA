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
import { PublicKey } from "@solana/web3.js";

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
  /**
   * Solana transaction signature of the creator's USDC funding
   * transfer to the Irys node (returned by `irys.fund()` as
   * `id`). This is the value /api/storage/verify-payment resolves
   * through the Solana RPC as `transactionSignature`.
   */
  fundingSignature: string;

  /**
   * Irys upload/data-item identifier (returned by `irys.upload()`
   * receipt as `id`). NOT a Solana signature.
   */
  dataTxId: string;
}

/**
 * Minimal structural view of the AETERNA wallet context object.
 * Adapter translation happens in toCreatorIrysWallet(); no wallet
 * provider internals are imported here.
 */
export interface AeternaWalletLike {
  account: string | null;
  signMessage(message: string | Uint8Array): Promise<{ signature: Uint8Array }>;
  signAndSendTransaction(transaction: unknown): Promise<{ signature: string }>;
}

/**
 * Adapter: AETERNA wallet context → CreatorIrysWallet (the injected
 * provider interface required by @irys/web-upload-solana).
 *   publicKey       ← new PublicKey(wallet.account)
 *   signMessage     ← wallet.signMessage(bytes).signature
 *   sendTransaction ← wallet.signAndSendTransaction(tx).signature
 * No keys are extracted; every signature is produced by the wallet.
 */
export function toCreatorIrysWallet(wallet: AeternaWalletLike): CreatorIrysWallet {
  if (!wallet.account) failClosed("wallet account is required");
  if (typeof wallet.signMessage !== "function") failClosed("wallet.signMessage is required");
  if (typeof wallet.signAndSendTransaction !== "function") {
    failClosed("wallet.signAndSendTransaction is required");
  }
  return {
    publicKey: new PublicKey(wallet.account),
    signMessage: async (message: Uint8Array) =>
      (await wallet.signMessage(message)).signature,
    sendTransaction: async (transaction: unknown /*, connection */) =>
      (await wallet.signAndSendTransaction(transaction)).signature,
  };
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
  // The @irys factory's published typing is loose (ConstructableWebToken
  // overload); the runtime factory accepts the node config shown here.
  const buildUploader = WebUploader as unknown as (config: {
    url: string;
    token: string;
  }) => {
    withProvider(provider: never): {
      withRpc(rpcUrl: string): { build(): Promise<unknown> };
      build(): Promise<unknown>;
    };
  };
  const builder = buildUploader({
    url: IRYS_NODE_URL,
    token: IRYS_TOKEN,
  }).withProvider(wallet as never).withRpc(rpcUrl ?? "https://api.mainnet-beta.solana.com");

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
/**
 * FUND-ONLY storage payment (Phase B): funds the creator's Irys
 * balance with the EXACT atomic amount from the server-derived
 * StorageQuote and returns the Solana funding transaction signature.
 *
 * The amount is never recalculated client-side — the quote is the
 * authority. Upload/data-item publication is NOT performed here.
 */
export async function fundCreatorPaidStorage(
  expectedAmountAtomic: string,
  wallet: CreatorIrysWallet,
  rpcUrl?: string
): Promise<{ fundingSignature: string }> {
  requireWallet(wallet);

  if (!/^[1-9][0-9]*$/.test(expectedAmountAtomic)) {
    failClosed("expectedAmountAtomic must be a positive integer atomic amount from the server quote");
  }

  const uploader = await buildCreatorUploader(wallet, rpcUrl);

  try {
    const fundResult = (await uploader.fund({
      toString: () => expectedAmountAtomic,
    })) as { id?: unknown };
    if (
      !fundResult ||
      typeof fundResult !== "object" ||
      typeof fundResult.id !== "string" ||
      fundResult.id.length === 0
    ) {
      failClosed("Irys funding returned no transaction signature");
    }
    return { fundingSignature: fundResult.id };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[AETERNA] creatorIrys:")) throw error;
    failClosed(`Irys funding failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
 * UPLOAD-ONLY creator publication (Phase D2a).
 *
 * Uploads already-paid-for encrypted bytes to Irys using the creator
 * wallet and returns the Irys data-item id. This helper performs NO
 * payment operations: no getPrice, no getBalance, no fund. The Irys
 * storage payment must already be PAYMENT_VERIFIED (Phase B) before
 * this helper is invoked.
 *
 * The returned dataTxId is upload EVIDENCE only — the server-side
 * publication claim (Node confirmation) turns it into authoritative
 * publication state. The input buffer is passed through without
 * cloning (whole-vault buffering is inherited from the legacy path
 * and remains a separate streaming enhancement).
 */
export async function uploadCreatorData(
  data: Uint8Array,
  wallet: CreatorIrysWallet,
  rpcUrl?: string
): Promise<{ dataTxId: string }> {
  requireWallet(wallet);

  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    failClosed("invalid payload");
  }

  const uploader = await buildCreatorUploader(wallet, rpcUrl);

  try {
    const receipt = (await uploader.upload(data)) as { id?: unknown };
    if (!receipt || typeof receipt !== "object") {
      failClosed("malformed Irys receipt");
    }
    const dataTxId = receipt.id;
    if (typeof dataTxId !== "string" || dataTxId.length === 0) {
      failClosed("Irys receipt has no data txId");
    }
    return { dataTxId };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[AETERNA] creatorIrys:")) throw error;
    failClosed(`Irys upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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

  let fundingSignature: string;
  try {
    const price = await uploader.getPrice(data.byteLength);
    const balance = await uploader.getBalance();

    if (BigInt(balance.toString()) < BigInt(price.toString())) {
      if (typeof wallet.sendTransaction !== "function") {
        failClosed("wallet does not support sendTransaction required for Irys funding");
      }
      // Creator wallet signs and sends the USDC funding transfer to
      // the Irys node. fund() returns { id } = the Solana transaction
      // signature (verified against installed package source).
      const fundResult = (await uploader.fund(price)) as { id?: unknown };
      if (
        !fundResult ||
        typeof fundResult !== "object" ||
        typeof fundResult.id !== "string" ||
        fundResult.id.length === 0
      ) {
        failClosed("Irys funding returned no transaction signature");
      }
      fundingSignature = fundResult.id;
    } else {
      failClosed("creator Irys balance already covers the price; funding transaction is required as payment evidence");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[AETERNA] creatorIrys:")) throw error;
    failClosed(`Irys funding failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let receipt: { id?: unknown } | null = null;
  try {
    receipt = await uploader.upload(data);
  } catch (error) {
    failClosed(
      `Irys upload failed (fundingSignature=${fundingSignature}): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!receipt || typeof receipt !== "object") {
    failClosed(`malformed Irys receipt (fundingSignature=${fundingSignature})`);
  }

  const dataTxId = receipt.id;
  if (typeof dataTxId !== "string" || dataTxId.length === 0) {
    failClosed(`Irys receipt has no data txId (fundingSignature=${fundingSignature})`);
  }

  return { fundingSignature, dataTxId };
}
