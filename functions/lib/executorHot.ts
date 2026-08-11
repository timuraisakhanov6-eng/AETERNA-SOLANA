/**
 * AETERNA — Executor Hot (Publication Authority)
 *
 * Implements AETERNA_EXECUTOR_HOT per:
 *   AETERNA_EXECUTOR_PUBLICATION_SPEC_v1, Section 5 (Executor Law)
 *
 * Responsibilities (and ONLY these):
 *   - hold EXECUTOR_PRIVATE_KEY exclusively as a Cloudflare Secret
 *   - check its own gas balance before attempting to fund or upload
 *   - fund the Irys node balance from its own wallet when required
 *   - sign and submit exactly one storage transaction per accepted
 *     /api/upload request
 *   - never accept plaintext or capability values
 *
 * Executor Hot is Authority for publication only (Section 1). It is
 * never Authority for payment, verification, Business Quote, or
 * Manifest. This module MUST NOT be imported by anything that
 * establishes those authorities.
 *
 * Out of scope for this Freeze (Section 5): choice of RPC provider(s)
 * for balance/gas checks. The RPC fallback list below may be changed
 * freely without revising the Freeze document.
 */

import { createExecutorTransport } from "../irys/transport";

/* ================= ENV CONTRACT ================= */

export interface ExecutorEnv {
  EXECUTOR_PRIVATE_KEY: string;
  UPLOAD_TOKENS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
  DEBUG?: "true" | "false";
}

/* ================= CONSTANTS ================= */

const IRYS_NODE_URL = "https://node1.irys.xyz";

// Irys uploads for AETERNA are funded via Base Mainnet ETH.
const BASE_MAINNET_CHAIN_ID = 8453;

const RPC_URLS = [
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
];

const RPC_TIMEOUT_MS = 5_000;

// Mirrors the threshold already enforced in upload-token.ts. Kept as
// a single shared capability here rather than duplicated across
// endpoints, per Section 5.
const EXECUTOR_MIN_BALANCE_WEI = BigInt("1500000000000000"); // 0.0015 ETH

const EXECUTOR_BALANCE_CACHE_KEY = "executor-balance-cache";
const EXECUTOR_BALANCE_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

const GATEWAYS = [
  "https://gateway.irys.xyz/",
  "https://arweave.net/",
  "https://permaweb.eu/",
  "https://arweave.live/",
];

const PROPAGATION_ATTEMPTS = 10;

// Executor Hot funds Irys to (basePrice * this multiplier) rather than
// exactly basePrice, to absorb price drift between quote and upload
// without needing a second funding round-trip mid-request.
const IRYS_FUNDING_MULTIPLIER = 2;

/* ================= DEV LOG ================= */

function devLog(env: ExecutorEnv, ...args: unknown[]): void {
  if (env.DEBUG === "true") {
    // Executor Hot logs never include the private key or any
    // capability value — only operational/publication metadata.
    console.log("[EXECUTOR HOT]", ...args);
  }
}

/**
 * Runs a single diagnostic probe in isolation so that one probe
 * throwing (e.g. calling String()/Function.toString on an undefined
 * export) never prevents the rest of the diagnostic block from
 * running and being logged.
 *
 * NOTE: logging `undefined` or `null` is a valid diagnostic result —
 * it means the probe ran and that's what it found. Only an actual
 * exception is reported as "<THREW>". These are different outcomes
 * and should not be conflated when reading the logs.
 */
function safeDiag(
  env: ExecutorEnv,
  label: string,
  fn: () => unknown
): void {
  try {
    devLog(env, label, fn());
  } catch (e) {
    devLog(env, `${label} <THREW>`, String(e));
  }
}

/* ================= BALANCE CHECK ================= */

type ExecutorBalanceCache = {
  balance: string;
  checkedAt: number;
};

async function fetchExecutorBalanceFromRpc(
  address: string
): Promise<bigint> {
  let lastError: unknown;

  for (const rpcUrl of RPC_URLS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getBalance",
          params: [address, "latest"],
          id: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) throw new Error("RPC_HTTP_ERROR");

      type RpcBalanceResponse = { result?: string };
      const data = (await res.json()) as RpcBalanceResponse;

      if (!data || typeof data.result !== "string") {
        throw new Error("RPC_INVALID_RESPONSE");
      }

      return BigInt(data.result);
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      continue;
    }
  }

  throw lastError ?? new Error("RPC_ALL_FAILED");
}

/**
 * Checks Executor Hot's own balance against the canonical minimum
 * threshold, per Section 5: "check its own balance against a defined
 * minimum threshold before attempting to fund or upload; this check
 * is a single shared capability, not duplicated logic scattered
 * across endpoints."
 *
 * Falls back to a short-lived cache during RPC outages, mirroring the
 * pattern already used by upload-token.ts.
 */
export async function assertExecutorHasBalance(
  env: ExecutorEnv,
  address: string,
  nowUtc: number
): Promise<void> {
  let balance: bigint;

  try {
    balance = await fetchExecutorBalanceFromRpc(address);

    await env.UPLOAD_TOKENS.put(
      EXECUTOR_BALANCE_CACHE_KEY,
      JSON.stringify({ balance: balance.toString(), checkedAt: nowUtc }),
      { expirationTtl: 24 * 60 * 60 }
    );
  } catch (error) {
    devLog(env, "RPC balance check failed, trying cache", String(error));

    const cachedRaw = await env.UPLOAD_TOKENS.get(EXECUTOR_BALANCE_CACHE_KEY);
    if (!cachedRaw) throw new ExecutorUnavailableError("EXECUTOR_BALANCE_UNKNOWN");

    let cached: ExecutorBalanceCache;
    try {
      cached = JSON.parse(cachedRaw) as ExecutorBalanceCache;
    } catch {
      throw new ExecutorUnavailableError("EXECUTOR_BALANCE_CACHE_CORRUPT");
    }

    if (
      typeof cached.balance !== "string" ||
      !Number.isSafeInteger(cached.checkedAt)
    ) {
      throw new ExecutorUnavailableError("EXECUTOR_BALANCE_CACHE_INVALID");
    }

    const age = nowUtc - cached.checkedAt;
    if (age < 0 || age > EXECUTOR_BALANCE_CACHE_MAX_AGE_MS) {
      throw new ExecutorUnavailableError("EXECUTOR_BALANCE_CACHE_STALE");
    }

    try {
      balance = BigInt(cached.balance);
    } catch {
      throw new ExecutorUnavailableError("EXECUTOR_BALANCE_CACHE_INVALID");
    }
  }

  if (balance < EXECUTOR_MIN_BALANCE_WEI) {
    throw new ExecutorUnavailableError("EXECUTOR_BALANCE_INSUFFICIENT");
  }
}

/**
 * Thrown for every failure mode that Section 4/Section 5 require to
 * surface as "service temporarily unavailable" rather than a hard
 * failure — i.e. any condition where the Upload Token MUST remain
 * valid and unused and the client MUST be able to safely retry.
 */
export class ExecutorUnavailableError extends Error {}

/* ================= WALLET / SIGNING RUNTIME ================= */

let cachedIrys: unknown | null = null;
let cachedIrysAddress: string | null = null;

/**
 * Derives the Executor Hot address from EXECUTOR_PRIVATE_KEY without
 * any network call. Pure local key material — never logged, never
 * exposed to the client.
 */
async function deriveExecutorAddress(privateKey: string): Promise<string> {
  const { Wallet } = await import("ethers");
  const wallet = new Wallet(privateKey);
  return wallet.address;
}

/**
 * Returns Executor Hot's address, derived from EXECUTOR_PRIVATE_KEY
 * and cached for the lifetime of the isolate.
 *
 * This is the single source of truth for "which address is Executor
 * Hot." Any caller that needs the address — including balance
 * preflight checks in other endpoints — MUST call this rather than
 * hold its own copy of the address as a string constant. A hardcoded
 * address string silently diverges the moment EXECUTOR_PRIVATE_KEY is
 * rotated in Cloudflare Secrets, which would let a balance check pass
 * against a wallet Executor Hot no longer controls.
 */
export async function getExecutorAddress(env: ExecutorEnv): Promise<string> {
  if (!env.EXECUTOR_PRIVATE_KEY) {
    throw new ExecutorUnavailableError("EXECUTOR_KEY_MISSING");
  }

  if (cachedIrysAddress) {
    return cachedIrysAddress;
  }

  const address = await deriveExecutorAddress(env.EXECUTOR_PRIVATE_KEY);
  cachedIrysAddress = address;
  return address;
}

/**
 * Lazily builds and caches the Executor Hot signing runtime bound to
 * EXECUTOR_PRIVATE_KEY.
 *
 * Executor Hot is the canonical Publication Authority. It owns the
 * signing key, funds the Irys node when required, and signs storage
 * transactions on behalf of the publication pipeline.
 *
 * EXECUTOR_PRIVATE_KEY never leaves this module: it is read once from
 * env, handed to the Irys/ethers constructors, and never returned,
 * logged, or serialized.
 */
async function getExecutorIrys(env: ExecutorEnv): Promise<{
  irys: any;
  address: string;
}> {
  if (!env.EXECUTOR_PRIVATE_KEY) {
    throw new ExecutorUnavailableError("EXECUTOR_KEY_MISSING");
  }

  const address = await getExecutorAddress(env);

  if (cachedIrys) {
    return { irys: cachedIrys, address };
  }

  devLog(env, "1a creating executor transport");
  const irys = await createExecutorTransport(
    env.EXECUTOR_PRIVATE_KEY,
    RPC_URLS[0],
  );

  cachedIrys = irys;

  devLog(env, "Executor Irys runtime ready", { address });

  return {
    irys,
    address,
  };
}

/* ================= PUBLICATION ================= */

export interface PublicationResult {
  storagePointer: string;
}

/**
 * Publishes ciphertext through Executor Hot, per Section 3
 * (Publication Law) and Section 5 (Executor Law):
 *
 *   1. check Executor Hot's own balance
 *   2. fund the Irys node balance from Executor Hot's wallet if the
 *      node's prepaid balance is insufficient for this upload
 *   3. sign and submit exactly one storage transaction
 *   4. wait for independently-confirmed propagation before returning
 *
 * Never signs a transaction for a request that failed any check in
 * Section 4 — callers MUST perform all of Section 4's checks 1–10
 * before calling this function.
 *
 * `nowUtc` MUST be the already-verified Trusted Time from the caller
 * (Upload Law step 10), not a fresh Date.now() read here. Executor
 * Hot's balance check has no cryptographic dependency on Trusted
 * Time, but every timestamp in the publication pipeline is expected
 * to come from a single source — see Trusted Time Authority.
 */
export async function publishCiphertext(
  env: ExecutorEnv,
  data: Uint8Array,
  nowUtc: number
): Promise<PublicationResult> {
  devLog(env, "1 getExecutorIrys");
  const { irys, address } = await getExecutorIrys(env);
  devLog(env, "2 executor ready", { address });

  await assertExecutorHasBalance(env, address, nowUtc);
  devLog(env, "2b executor balance ok");
  // Executor-owned publication buffer.
  //
  // The caller retains ownership of the original
  // ciphertext. Executor Hot wipes only its own
  // temporary transport copy after publication.
  const normalized = data.slice();

  let receipt: unknown;

  try {
    const uploadSize = normalized.byteLength;

    devLog(env, "3 getPrice", { uploadSize });
    const basePrice = await irys.getPrice(uploadSize);
    const price = basePrice.multipliedBy(IRYS_FUNDING_MULTIPLIER);
    devLog(env, "4 price", { basePrice: basePrice.toString(), price: price.toString() });

    const nodeBalance = await irys.utils.getBalance(irys.address);
    devLog(env, "4b node balance", { nodeBalance: nodeBalance.toString() });

    if (nodeBalance.isLessThan(price)) {
      const deficit = price.minus(nodeBalance);
      const atomicDeficit = BigInt(Math.ceil(Number(deficit.toString())));

      devLog(env, "5 funding", { atomicDeficit: atomicDeficit.toString() });
      await irys.fund(atomicDeficit);
      devLog(env, "5b funded, polling for sync");

      // Poll until the Irys node balance reflects the funding tx.
      let funded = false;
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const synced = await irys.utils.getBalance(irys.address);
        devLog(env, "5c funding poll", { attempt: i, synced: synced.toString() });
        if (!synced.isLessThan(price)) {
          funded = true;
          break;
        }
      }

      if (!funded) {
        throw new ExecutorUnavailableError("EXECUTOR_FUNDING_SYNC_TIMEOUT");
      }
    }

    devLog(env, "6 upload", { uploadSize });
    receipt = await irys.uploadData(Buffer.from(normalized), {
      tags: [
        { name: "App-Name", value: "AETERNA" },
        { name: "Protocol-Version", value: "1" },
        { name: "Content-Type", value: "application/octet-stream" },
      ],
    });
    devLog(env, "7 uploaded", { receipt });
  } finally {
    normalized.fill(0);
  }

  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof (receipt as Record<string, unknown>).id !== "string"
  ) {
    throw new Error("EXECUTOR_INVALID_RECEIPT");
  }

  const pointer = String((receipt as Record<string, unknown>).id).trim();

  // Step 13 of Section 4: propagation confirmed via at least one
  // independent gateway before the token may be consumed. The exact
  // gateway set is an implementation detail of Storage Authority.
  devLog(env, "8 propagation", { pointer });
  const propagated = await confirmPropagation(pointer);
  devLog(env, "9 propagated", { propagated });

  if (!propagated) {
    throw new Error("EXECUTOR_PROPAGATION_FAILED");
  }

  devLog(env, "Publication complete");

  return { storagePointer: pointer };
}

async function confirmPropagation(pointer: string): Promise<boolean> {
  for (let attempt = 0; attempt < PROPAGATION_ATTEMPTS; attempt++) {
    for (const gateway of GATEWAYS) {
      try {
        const url = gateway.endsWith("/") ? gateway + pointer : gateway + "/" + pointer;
        const res = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (res.ok && res.status === 200) {
          const contentLength = res.headers.get("content-length");
          // A 200 with an empty or missing body is not a confirmed
          // publication — guards against a gateway that responds OK
          // before it actually has the object.
          if (contentLength === null || Number(contentLength) > 0) {
            return true;
          }
        }
      } catch {
        // fail closed — try next gateway/attempt
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }

  return false;
}