/**
 * AETERNA — Strict signed-transaction broadcast
 *
 * POST /api/solana/broadcast
 *
 * The ONE write path to the Solana network for the canonical $1 USDC
 * service payment. It accepts an ALREADY-SIGNED transaction and:
 *
 *   1. parses it strictly (legacy format only, exact length, bounded
 *      counts) — anything else is rejected;
 *   2. verifies the ed25519 signature cryptographically against the
 *      transaction's own fee payer;
 *   3. re-derives the expected Associated Token Accounts and validates
 *      EVERY instruction (program, account metas, amount, mint,
 *      destination) — not by string search, but from the compiled
 *      message. The tolerated additions are the canonical, fee-only
 *      ComputeBudget priority-fee pair and Phantom's exact Lighthouse v2
 *      read-only assertion pair: the fee instructions have ZERO account
 *      metas, may not exceed one instruction per fee tag, and stay within
 *      the payment's bounded SOL policy (0.001 SOL); the two Lighthouse
 *      instructions must be the terminal pair, decode to the exact recorded
 *      payloads, target the payer and the transfer's source ATA, and carry
 *      no signer/writable privileges. Any other extra instruction or
 *      account is refused;
 *   4. resolves the creator identity SERVER-SIDE from the payment intent
 *      (the identity coordinator's intent index) and requires the
 *      transaction's payer to be that identity's on-chain account;
 *   5. proves the configured RPC is Solana mainnet-beta (genesis-hash
 *      comparison against a server constant) and refuses on any
 *      mismatch or unverifiable answer — before any state is written;
 *   6. atomically binds the transaction signature to the payment attempt
 *      in the identity coordinator, so two tabs/devices can never
 *      broadcast two different transactions for one purchase;
 *   7. only then forwards the SAME bytes to the configured RPC and
 *      requires the returned signature to match the computed one.
 *
 * /api/solana/rpc stays READ-ONLY: no write method was added to its
 * allowlist. The upstream RPC URL is never echoed, and neither the raw
 * transaction nor its bytes are ever logged.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../../lib/rateLimit";
import { solanaJsonRpc } from "../../lib/solana/rpc";
import { base58Decode, base64ToUint8Array } from "../../lib/solanaIdentityProof";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TransactionParseError,
  base58Encode,
  deriveAssociatedTokenAddress,
  getAccountPrivilege,
  parseLegacyTransaction,
  verifyTransactionSignature,
} from "../../lib/solana/legacyTransaction";
import type { ParsedInstruction } from "../../lib/solana/legacyTransaction";
import { getCreatorIdentity } from "../../../src/lib/creator/creatorIdentityStore";

export interface SolanaBroadcastEnv {
  SOLANA_MAINNET_RPC_URL?: string;
  CREATOR_IDENTITIES?: {
    get(key: string): Promise<string | null>;
  };
  CREDIT_OP_COORDINATOR?: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(request: Request): Promise<Response>;
    };
  };
}

/**
 * Canonical payment parameters. These MUST match the client's payment
 * builder (src/lib/wallet/solanaWallet.ts) and the server-side payment
 * verification (/api/service-payment/verify). They are never taken from
 * the request.
 */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_SERVICE_SETTLEMENT_ADDRESS =
  "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";
const SERVICE_PAYMENT_ATOMIC = 1_000_000n;

/**
 * Canonical Solana MAINNET-BETA genesis hash.
 *
 * This is the value mainnet-beta validators pin with
 * `--expected-genesis-hash`, i.e. a public protocol constant — NOT a
 * secret and NOT a value taken from the request. It is the single
 * network on which this payment is valid: the configured RPC
 * (`SOLANA_MAINNET_RPC_URL`), the settlement address, the USDC mint and
 * the `"solana-mainnet"` network recorded by the storage/service
 * payment verification are all mainnet configuration.
 *
 * Used ONLY to prove the configured RPC really is mainnet-beta before
 * anything is bound or broadcast. There is deliberately no fallback,
 * no auto-switch and no client-supplied cluster: a mismatch or an
 * undeterminable answer refuses the broadcast.
 */
const SOLANA_MAINNET_BETA_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Solana packet limit. */
const MAX_TRANSACTION_BYTES = 1232;
/** SPL Token `Transfer` instruction tag. */
const SPL_TOKEN_TRANSFER = 3;
/**
 * Canonical ComputeBudget program — one of the two wallet-added programs
 * and only through its two fee-only instructions below (see
 * `isCanonicalPriorityFeeInstruction`); the other is the exact Lighthouse
 * assertion pair. A bare program-id allowance is never accepted.
 */
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
/** ComputeBudget tag of `setComputeUnitLimit` (tag byte + u32 LE). */
const COMPUTE_BUDGET_SET_UNIT_LIMIT = 2;
/** ComputeBudget tag of `setComputeUnitPrice` (tag byte + u64 LE). */
const COMPUTE_BUDGET_SET_UNIT_PRICE = 3;
/** Protocol maximum compute-unit limit; anything higher is not canonical. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/**
 * Phantom inserts exactly its priority-fee pair (a compute-unit limit and
 * a compute-unit price) into unsigned dApp transactions that have no
 * priority-fee instructions. Anything BEYOND that pair — more than two
 * fee instructions, or the same fee tag twice — is not the documented
 * behavior and is refused.
 */
const MAX_WALLET_PRIORITY_FEE_INSTRUCTIONS = 2;
/**
 * PRIORITY-FEE POLICY — the absolute worst-case priority fee (in
 * lamports) that the wallet's own fee instructions may request:
 * 1_000_000 lamports = 0.001 SOL.
 *
 * A fee injection bounds its cost only through the product
 * `compute_unit_limit × compute_unit_price`: the protocol charges
 * `ceil(compute_unit_limit × compute_unit_price / 1_000_000)` lamports on
 * the limit the message REQUESTS — the wallet's own limit when it sets
 * one, otherwise the protocol's per-instruction default (up to 200 000 CU
 * per instruction, clamped by the runtime to `MAX_COMPUTE_UNIT_LIMIT`).
 * That default is NOT a flat 200 000 CU: this payment carries one or two
 * payable instructions (the USDC transfer, plus the ATA-create when the
 * settlement token account is absent), so its default is 200 000 or
 * 400 000 CU. A missing wallet limit is therefore bounded here by the
 * protocol MAXIMUM (1 400 000 CU) rather than by the default formula, so
 * the ceiling holds for every instruction mix the runtime could charge
 * and never depends on runtime accounting details. Without a ceiling, a
 * wallet could name an arbitrarily large price and turn a $1 payment into
 * an unbounded SOL loss. This mirrors the client guard in
 * `src/lib/wallet/solanaWallet.ts` and is evaluated with ceiling integer
 * arithmetic, so the accepted maximum can never round up past this
 * constant on-chain. A wallet asking for more is refused before anything
 * is bound or broadcast.
 */
const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 1_000_000n;
/**
 * The canonical ATA-create instruction carries EMPTY data (verified
 * against the installed @solana/spl-token builder, which passes
 * `Buffer.alloc(0)`); the idempotent variant would carry `[1]` and is
 * deliberately NOT accepted, because the payment builder never emits it.
 */
const ATA_CREATE_DATA_LENGTH = 0;

const ALLOWED_ORIGINS = [
  "https://aeternacapsule.com",
  "https://www.aeternacapsule.com",
  "https://aeterna-solana.pages.dev",
];

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.aeterna-capsule\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && PAGES_PREVIEW_REGEX.test(url.hostname))
      return true;
  } catch {
    // ignore
  }
  return false;
}

function baseHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * Refusal envelope.
 *
 * `broadcastAttempted` is an EXPLICIT, structured part of the contract —
 * never something a client may infer from the error text:
 *
 *   - false: this request was refused BEFORE `sendTransaction` was ever
 *     called (origin/rate-limit/body checks, intent resolution, strict
 *     transaction parsing and every content validation, the mainnet-beta
 *     network guard, or the atomic signature binding). The endpoint
 *     provably did not submit these bytes.
 *   - true: the refusal happened AT or AFTER the RPC call, so the outcome
 *     on chain is UNKNOWN (the transaction may or may not have landed).
 *
 * The parameter is REQUIRED so a refusal can never be published without
 * an explicit classification. It describes THIS server-side endpoint
 * only; it is NOT a statement about any on-chain operation performed by
 * anyone else (e.g. a wallet), and the client must not treat it as one.
 */
function fail(
  origin: string,
  status: number,
  error: string,
  broadcastAttempted: boolean
): Response {
  return new Response(JSON.stringify({ ok: false, error, broadcastAttempted }), {
    status,
    headers: baseHeaders(origin),
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i]!);
  }
  return value;
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

/**
 * Lighthouse v2 assertion program and the EXACT payloads Phantom appended
 * to the production diagnostic transaction. The recorded SHA-256 values
 * are:
 *
 *   info  (16 B): 39bb93d1a828d59455ba9e8b9679901d04086bcf0c44251af08e7e60383e7fbc
 *   token (27 B): b4441240a9f8613e359bc99ff3ca06512982b4d7ef1db1378000d149e2bf5a5f
 *
 * Both are READ-ONLY assertions: they can make a transaction fail, but
 * cannot move tokens or mutate an account. A matching program id alone is
 * never accepted — the payload, order, account mapping and privileges are
 * all validated below.
 */
const LIGHTHOUSE_PROGRAM_ID = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const PHANTOM_LIGHTHOUSE_INFO_DATA = new Uint8Array([
  6, 4, 2,
  3, 0, 0,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const PHANTOM_LIGHTHOUSE_TOKEN_DATA = new Uint8Array([
  10, 4, 4,
  2, 0x22, 0x16, 0x07, 0, 0, 0, 0, 0, 4,
  3, 0, 0,
  6, 0, 0, 0, 0, 0, 0, 0, 0, 5,
  8,
]);

function isPhantomLighthouseInfoData(data: Uint8Array): boolean {
  return sameBytes(data, PHANTOM_LIGHTHOUSE_INFO_DATA);
}

/**
 * The ONLY variable field is the u64 Amount lower bound (bytes 4..11):
 * Phantom derives it from the simulated post-transfer balance, so pinning
 * one user's value would reject every other balance. The transfer itself
 * remains byte-identical to the canonical payment, and every other
 * discriminator, operator, option and value is fixed. The exact length
 * check rejects trailing bytes.
 */
function isPhantomLighthouseTokenData(data: Uint8Array): boolean {
  if (data.length !== PHANTOM_LIGHTHOUSE_TOKEN_DATA.length) return false;
  for (let index = 0; index < data.length; index++) {
    if (index >= 4 && index <= 11) continue;
    if (data[index] !== PHANTOM_LIGHTHOUSE_TOKEN_DATA[index]) return false;
  }
  return true;
}

/**
 * A canonical wallet-added PRIORITY-FEE instruction: the ComputeBudget
 * program carries exactly one of the two fee-only tags with its exact
 * payload length, and — critically — ZERO account metas, so the
 * instruction cannot reference (let alone move) any token account.
 *
 * This is the ONLY instruction shape a wallet may add to the canonical
 * payment on top of the builder's own instructions. It mirrors the
 * client-side guard in `src/lib/wallet/solanaWallet.ts`: Phantom
 * automatically inserts this limit/price pair (in that order, at index
 * 0) into unsigned dApp transactions that have no priority-fee
 * instructions of their own, then signs the resulting message — so a
 * byte-identity check that ignores this documented fee-only pair would
 * refuse every legitimate Phantom payment.
 *
 * Shape alone is not acceptance: the caller additionally requires at
 * most ONE instruction per fee tag and applies the priority-fee policy
 * (see `MAX_WALLET_PRIORITY_FEE_LAMPORTS`).
 */
function isCanonicalPriorityFeeInstruction(
  instruction: ParsedInstruction
): boolean {
  if (instruction.accountIndexes.length !== 0) return false;
  const data = instruction.data;
  if (data.length === 5 && data[0] === COMPUTE_BUDGET_SET_UNIT_LIMIT) {
    return readU32LE(data, 1) <= MAX_COMPUTE_UNIT_LIMIT;
  }
  if (data.length === 9 && data[0] === COMPUTE_BUDGET_SET_UNIT_PRICE) {
    return true;
  }
  return false;
}

/**
 * Fail-closed network guard.
 *
 * Proves the SERVER-configured RPC really is Solana mainnet-beta by
 * comparing the chain's genesis hash with the canonical constant.
 * Nothing is bound and nothing is broadcast until this returns `null`
 * (verified).
 *
 * Refusal cases — all BEFORE any state change or network write:
 *   - the probe could not be performed (RPC unreachable / erroring /
 *     timing out)                    -> 503 RPC_NETWORK_UNAVAILABLE
 *   - the answer was not a usable genesis hash
 *                                     -> 502 RPC_NETWORK_UNDETERMINED
 *   - the answer was a DIFFERENT chain -> 502 RPC_NETWORK_MISMATCH
 *
 * The expected hash is a server constant and is never read from the
 * request, so a client cannot pick a cluster, an RPC URL or move the
 * expected network. There is no auto-switch to another network.
 */
async function requireMainnetBeta(
  rpcUrl: string,
  origin: string
): Promise<Response | null> {
  let genesis: unknown;
  try {
    genesis = await solanaJsonRpc<unknown>(rpcUrl, "getGenesisHash", []);
  } catch {
    // A failed / timed-out / erroring probe is NOT proof of network.
    // (Nothing was bound and nothing was broadcast: pre-send refusal.)
    return fail(origin, 503, "RPC_NETWORK_UNAVAILABLE", false);
  }
  if (typeof genesis !== "string" || genesis.length === 0) {
    return fail(origin, 502, "RPC_NETWORK_UNDETERMINED", false);
  }
  if (genesis !== SOLANA_MAINNET_BETA_GENESIS_HASH) {
    return fail(origin, 502, "RPC_NETWORK_MISMATCH", false);
  }
  return null;
}

export async function onRequestOptions(
  context: EventContext<Record<string, unknown>, string, SolanaBroadcastEnv>
): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: baseHeaders(origin) });
}

export async function onRequestPost(
  context: EventContext<Record<string, unknown>, string, SolanaBroadcastEnv>
): Promise<Response> {
  const origin = context.request.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return fail(origin, 403, "INVALID_ORIGIN", false);
  }

  const ip = getClientIp(context.request);
  if (!ip || !rateLimit(ip)) {
    return fail(origin, 429, "TOO_MANY_REQUESTS", false);
  }

  const contentType = context.request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fail(origin, 415, "UNSUPPORTED_MEDIA_TYPE", false);
  }

  const env = context.env as SolanaBroadcastEnv;

  // The RPC endpoint is server configuration ONLY — never request-derived.
  const rpcUrl =
    typeof env.SOLANA_MAINNET_RPC_URL === "string" && env.SOLANA_MAINNET_RPC_URL
      ? env.SOLANA_MAINNET_RPC_URL
      : "";
  if (!rpcUrl) {
    return fail(origin, 502, "RPC_UNAVAILABLE", false);
  }

  let body: Record<string, unknown>;
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    return fail(origin, 400, "INVALID_JSON", false);
  }
  if (!body || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return fail(origin, 400, "INVALID_BODY", false);
  }

  const paymentIntentId =
    typeof body["paymentIntentId"] === "string" ? body["paymentIntentId"].trim() : "";
  const signedTransactionB64 =
    typeof body["signedTransaction"] === "string" ? body["signedTransaction"].trim() : "";
  /**
   * Candidate creator identity. This is a HINT, never authority: the
   * endpoint independently requires the transaction's payer account to
   * be the on-chain account of exactly this identity (resolved
   * server-side), and the signature to verify against that account — so
   * a forged hint can only produce a rejection.
   */
  const creatorIdentityIdHint =
    typeof body["creatorIdentityId"] === "string" ? body["creatorIdentityId"].trim() : "";

  if (!paymentIntentId || !signedTransactionB64 || !creatorIdentityIdHint) {
    return fail(origin, 400, "INVALID_FIELDS", false);
  }
  // Bound the encoded payload BEFORE decoding anything.
  if (signedTransactionB64.length > 1700) {
    return fail(origin, 400, "TRANSACTION_TOO_LARGE", false);
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToUint8Array(signedTransactionB64);
  } catch {
    return fail(origin, 400, "INVALID_TRANSACTION_ENCODING", false);
  }
  if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES) {
    return fail(origin, 400, "TRANSACTION_TOO_LARGE", false);
  }

  /* ================= SERVER-SIDE IDENTITY RESOLUTION ================= */

  const coordinatorBinding = env.CREDIT_OP_COORDINATOR;
  if (!coordinatorBinding) {
    return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE", false);
  }

  const postToCoordinator = async (
    name: string,
    payload: Record<string, unknown>
  ): Promise<{ httpStatus: number; data: Record<string, unknown> | null }> => {
    const stub = coordinatorBinding.get(coordinatorBinding.idFromName(name));
    const res = await stub.fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { httpStatus: res.status, data };
  };

  // The attempt state comes from the identity coordinator — the same
  // authority that reserved the purchase — never from the request body.
  let intentResolution: { httpStatus: number; data: Record<string, unknown> | null };
  try {
    intentResolution = await postToCoordinator(`identity:${creatorIdentityIdHint}`, {
      op: "identity-resolve-intent",
      creatorIdentityId: creatorIdentityIdHint,
      paymentIntentId,
    });
  } catch {
    return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE", false);
  }
  if (!intentResolution.data?.["ok"]) {
    return fail(
      origin,
      intentResolution.httpStatus === 503 ? 503 : 409,
      typeof intentResolution.data?.["error"] === "string"
        ? (intentResolution.data["error"] as string)
        : "INTENT_UNKNOWN",
      false
    );
  }

  const creatorIdentityId = String(intentResolution.data["creatorIdentityId"] ?? "");
  const attemptState = String(intentResolution.data["state"] ?? "");
  if (!creatorIdentityId) {
    return fail(origin, 409, "INTENT_UNKNOWN", false);
  }
  if (attemptState === "granting" || attemptState === "fulfilled") {
    // A payment is already recorded for this attempt: continue the
    // existing verification/grant instead of broadcasting anything.
    return fail(origin, 409, "INTENT_ALREADY_PAID", false);
  }
  if (attemptState !== "reserved") {
    return fail(origin, 409, "INTENT_NOT_PAYABLE", false);
  }

  /* ================= STRICT TRANSACTION VALIDATION ================= */

  let parsed;
  try {
    parsed = parseLegacyTransaction(bytes);
  } catch (err) {
    return fail(
      origin,
      400,
      err instanceof TransactionParseError ? err.message : "INVALID_TRANSACTION",
      false
    );
  }

  // Exactly ONE signer: the paying wallet.
  if (parsed.numRequiredSignatures !== 1 || parsed.numReadonlySigned !== 0) {
    return fail(origin, 400, "UNEXPECTED_SIGNER_SET", false);
  }
  const payerBytes = parsed.accountKeys[0]!;
  const payerAddress = base58Encode(payerBytes);

  // The payer must be the paying account of the resolved creator identity.
  const identity = await getCreatorIdentity(
    env as unknown as Parameters<typeof getCreatorIdentity>[0],
    "solana",
    payerAddress
  ).catch(() => null);
  if (!identity || identity.id !== creatorIdentityId) {
    return fail(origin, 403, "IDENTITY_MISMATCH", false);
  }

  // The signature must verify over the message, from the payer's own key.
  const signatureOk = await verifyTransactionSignature(
    payerBytes,
    parsed.signatures[0]!,
    parsed.messageBytes
  );
  if (!signatureOk) {
    return fail(origin, 400, "INVALID_TRANSACTION_SIGNATURE", false);
  }
  const transactionSignature = base58Encode(parsed.signatures[0]!);

  const programIdOf = (index: number) => base58Encode(parsed.accountKeys[index]!);
  const mintBytes = base58Decode(SOLANA_USDC_MINT);
  const settlementBytes = base58Decode(SOLANA_SERVICE_SETTLEMENT_ADDRESS);
  const expectedSourceAta = await deriveAssociatedTokenAddress(payerBytes, mintBytes);
  const expectedDestinationAta = await deriveAssociatedTokenAddress(
    settlementBytes,
    mintBytes
  );
  const tokenProgramBytes = base58Decode(TOKEN_PROGRAM_ID);
  const ataProgramBytes = base58Decode(ASSOCIATED_TOKEN_PROGRAM_ID);
  const systemProgramBytes = base58Decode(SYSTEM_PROGRAM_ID);

  /**
   * Split the compiled instructions into the canonical payment and the
   * wallet-added priority-fee pair.
   *
   * Phantom (and only the documented fee-only pattern below) may insert
   * up to two canonical ComputeBudget instructions — its priority-fee
   * limit + price — into an otherwise unsigned dApp transaction. They
   * cannot move tokens, so they are tolerated HERE and only here; every
   * remaining instruction must still be the exact canonical payment.
   */
  const computeBudgetProgramBytes = base58Decode(COMPUTE_BUDGET_PROGRAM_ID);
  const lighthouseProgramBytes = base58Decode(LIGHTHOUSE_PROGRAM_ID);
  const paymentInstructions: ParsedInstruction[] = [];
  const lighthouseKinds: Array<"info" | "token"> = [];
  let lighthouseTokenTargetIndex: number | null = null;
  let sawLighthouse = false;
  let priorityFeeInstructionCount = 0;
  let walletUnitLimit: number | null = null;
  let walletUnitPrice: bigint | null = null;
  for (const instruction of parsed.instructions) {
    const programKey = parsed.accountKeys[instruction.programIdIndex]!;
    if (sameBytes(programKey, computeBudgetProgramBytes)) {
      /**
       * Lighthouse is the terminal wallet suffix: once the first assertion
       * appears, only the second assertion may follow. A fee instruction
       * after (or between) them is not the observed Phantom shape.
       */
      if (sawLighthouse) {
        return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
      }
      if (!isCanonicalPriorityFeeInstruction(instruction)) {
        return fail(origin, 400, "UNEXPECTED_PRIORITY_FEE_INSTRUCTION", false);
      }
      priorityFeeInstructionCount += 1;
      if (
        priorityFeeInstructionCount > MAX_WALLET_PRIORITY_FEE_INSTRUCTIONS
      ) {
        return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
      }
      /**
       * At most ONE instruction per fee tag: the documented wallet shape
       * is a single limit/price pair, and a duplicated tag would make the
       * priority-fee policy ambiguous.
       */
      if (instruction.data[0] === COMPUTE_BUDGET_SET_UNIT_LIMIT) {
        if (walletUnitLimit !== null) {
          return fail(origin, 400, "UNEXPECTED_PRIORITY_FEE_INSTRUCTION", false);
        }
        walletUnitLimit = readU32LE(instruction.data, 1);
      } else {
        if (walletUnitPrice !== null) {
          return fail(origin, 400, "UNEXPECTED_PRIORITY_FEE_INSTRUCTION", false);
        }
        walletUnitPrice = readU64LE(instruction.data, 1);
      }
      continue;
    }

    if (sameBytes(programKey, lighthouseProgramBytes)) {
      /**
       * Lighthouse is the SECOND wallet-added program. It is read-only
       * ONLY when its program key is an unsigned, read-only account; a
       * writable or signer program key is not the documented assertion
       * shape and is refused before any semantic decoding.
       */
      const programPrivilege = getAccountPrivilege(
        parsed,
        instruction.programIdIndex
      );
      if (programPrivilege.isSigner || programPrivilege.isWritable) {
        return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
      }
      if (instruction.accountIndexes.length !== 1) {
        return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
      }
      const targetIndex = instruction.accountIndexes[0]!;
      const targetKey = parsed.accountKeys[targetIndex]!;
      const data = instruction.data;
      if (data[0] === 6) {
        // AssertAccountInfoMulti v2, log level 4, on the PAYER.
        if (!sameBytes(targetKey, payerBytes)) {
          return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
        }
        if (!isPhantomLighthouseInfoData(data)) {
          return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
        }
        lighthouseKinds.push("info");
      } else if (data[0] === 10) {
        // AssertTokenAccountMulti v2, log level 4, on the source ATA.
        if (!isPhantomLighthouseTokenData(data)) {
          return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
        }
        lighthouseTokenTargetIndex = targetIndex;
        lighthouseKinds.push("token");
      } else {
        return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
      }
      if (lighthouseKinds.length > 2) {
        return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
      }
      sawLighthouse = true;
      continue;
    }

    /**
     * Lighthouse assertions must come AFTER every payable instruction:
     * otherwise a later payment would be invisible to the assertion and
     * the wallet-added suffix would no longer be the observed shape.
     */
    if (sawLighthouse) {
      return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
    }
    paymentInstructions.push(instruction);
  }
  /**
   * PRIORITY-FEE POLICY — see `MAX_WALLET_PRIORITY_FEE_LAMPORTS`.
   *
   * The worst case the wallet's own instructions can request is
   * `ceil(units × price / 1_000_000)` lamports, where `units` is the
   * wallet's own limit or — when it set none — the protocol MAXIMUM of
   * 1 400 000 CU: a missing limit is charged against the protocol's
   * per-instruction default (200 000 CU per payable instruction here,
   * i.e. up to 400 000 CU), and bounding that case by the maximum keeps
   * the cap independent of the default's accounting. Anything above the
   * policy ceiling is a proven pre-send refusal: nothing is bound and
   * nothing is broadcast.
   */
  if (priorityFeeInstructionCount > 0) {
    const policyUnits =
      walletUnitLimit ?? MAX_COMPUTE_UNIT_LIMIT;
    const policyPrice = walletUnitPrice ?? 0n;
    const worstCasePriorityFeeLamports =
      (BigInt(policyUnits) * policyPrice + 999_999n) / 1_000_000n;
    if (worstCasePriorityFeeLamports > MAX_WALLET_PRIORITY_FEE_LAMPORTS) {
      return fail(origin, 400, "PRIORITY_FEE_TOO_HIGH", false);
    }
  }
  if (paymentInstructions.length < 1 || paymentInstructions.length > 2) {
    return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
  }
  /**
   * Lighthouse is either absent (the canonical payment) or appears as the
   * exact ordered pair Phantom appends: info first, token second. One
   * assertion, a duplicate, the reverse order, or more than two is not the
   * observed transformation and is refused.
   */
  if (
    lighthouseKinds.length !== 0 &&
    (lighthouseKinds.length !== 2 ||
      lighthouseKinds[0] !== "info" ||
      lighthouseKinds[1] !== "token")
  ) {
    return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
  }

  const transferInstruction = paymentInstructions[paymentInstructions.length - 1]!;
  const ataCreateInstruction =
    paymentInstructions.length === 2 ? paymentInstructions[0]! : null;

  // ---- optional canonical ATA-create (only when the settlement ATA is absent)
  if (ataCreateInstruction) {
    if (!sameBytes(parsed.accountKeys[ataCreateInstruction.programIdIndex]!, ataProgramBytes)) {
      return fail(origin, 400, "UNEXPECTED_PROGRAM", false);
    }
    /**
     * The canonical ATA-create carries SIX account metas — payer,
     * associated token account, owner, mint, System Program and the SPL
     * Token program — and EMPTY data (both verified against the
     * installed @solana/spl-token builder, not assumed).
     */
    const accounts = ataCreateInstruction.accountIndexes;
    if (
      accounts.length !== 6 ||
      ataCreateInstruction.data.length !== ATA_CREATE_DATA_LENGTH
    ) {
      return fail(origin, 400, "UNEXPECTED_ATA_INSTRUCTION", false);
    }
    const [payerIdx, ataIdx, ownerIdx, mintIdx, systemIdx, tokenProgramIdx] =
      accounts as [number, number, number, number, number, number];
    if (
      !sameBytes(parsed.accountKeys[payerIdx]!, payerBytes) ||
      !sameBytes(parsed.accountKeys[ataIdx]!, expectedDestinationAta) ||
      !sameBytes(parsed.accountKeys[ownerIdx]!, settlementBytes) ||
      !sameBytes(parsed.accountKeys[mintIdx]!, mintBytes) ||
      !sameBytes(parsed.accountKeys[systemIdx]!, systemProgramBytes) ||
      !sameBytes(parsed.accountKeys[tokenProgramIdx]!, tokenProgramBytes)
    ) {
      return fail(origin, 400, "UNEXPECTED_ATA_ACCOUNTS", false);
    }
  }

  // ---- the canonical SPL Token `Transfer`
  if (!sameBytes(parsed.accountKeys[transferInstruction.programIdIndex]!, tokenProgramBytes)) {
    return fail(origin, 400, "UNEXPECTED_PROGRAM", false);
  }
  /**
   * The canonical SPL Token `Transfer` has FOUR account metas, not
   * three: the payment builder passes the payer as the single
   * multi-signer, so the compiled instruction is
   * [source, destination, authority, signer] with authority and signer
   * being the SAME paying account (verified against the installed
   * @solana/spl-token builder).
   */
  const transferAccounts = transferInstruction.accountIndexes;
  if (transferAccounts.length !== 4 || transferInstruction.data.length !== 9) {
    return fail(origin, 400, "UNEXPECTED_TRANSFER_INSTRUCTION", false);
  }
  if (transferInstruction.data[0] !== SPL_TOKEN_TRANSFER) {
    return fail(origin, 400, "UNEXPECTED_TRANSFER_INSTRUCTION", false);
  }
  if (readU64LE(transferInstruction.data, 1) !== SERVICE_PAYMENT_ATOMIC) {
    return fail(origin, 400, "UNEXPECTED_AMOUNT", false);
  }
  const [sourceIdx, destinationIdx, authorityIdx, signerIdx] = transferAccounts as [
    number,
    number,
    number,
    number
  ];
  if (
    !sameBytes(parsed.accountKeys[sourceIdx]!, expectedSourceAta) ||
    !sameBytes(parsed.accountKeys[destinationIdx]!, expectedDestinationAta) ||
    !sameBytes(parsed.accountKeys[authorityIdx]!, payerBytes) ||
    !sameBytes(parsed.accountKeys[signerIdx]!, payerBytes)
  ) {
    return fail(origin, 400, "UNEXPECTED_TRANSFER_ACCOUNTS", false);
  }

  /**
   * The Lighthouse token assertion must read the SAME source ATA the
   * validated transfer debits — resolved by address from the compiled
   * transfer, never by a numeric index.
   */
  if (
    lighthouseKinds.length === 2 &&
    (lighthouseTokenTargetIndex === null ||
      !sameBytes(
        parsed.accountKeys[lighthouseTokenTargetIndex]!,
        parsed.accountKeys[sourceIdx]!
      ))
  ) {
    return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
  }

  // ---- exact account-key table: no unknown, duplicate or differently
  // privileged account may ride along
  type ExpectedPrivilege = { isSigner: boolean; isWritable: boolean };
  const expectedPrivileges = new Map<string, ExpectedPrivilege>();
  expectedPrivileges.set(payerAddress, { isSigner: true, isWritable: true });
  expectedPrivileges.set(base58Encode(expectedSourceAta), {
    isSigner: false,
    isWritable: true,
  });
  expectedPrivileges.set(base58Encode(expectedDestinationAta), {
    isSigner: false,
    isWritable: true,
  });
  expectedPrivileges.set(TOKEN_PROGRAM_ID, {
    isSigner: false,
    isWritable: false,
  });
  if (ataCreateInstruction) {
    expectedPrivileges.set(SOLANA_SERVICE_SETTLEMENT_ADDRESS, {
      isSigner: false,
      isWritable: false,
    });
    expectedPrivileges.set(SOLANA_USDC_MINT, {
      isSigner: false,
      isWritable: false,
    });
    expectedPrivileges.set(SYSTEM_PROGRAM_ID, {
      isSigner: false,
      isWritable: false,
    });
    expectedPrivileges.set(ASSOCIATED_TOKEN_PROGRAM_ID, {
      isSigner: false,
      isWritable: false,
    });
  }
  /**
   * The ComputeBudget and Lighthouse program keys become legitimate ONLY
   * when the wallet actually added the exact instructions above; an
   * unused stray key is refused below.
   */
  if (priorityFeeInstructionCount > 0) {
    expectedPrivileges.set(COMPUTE_BUDGET_PROGRAM_ID, {
      isSigner: false,
      isWritable: false,
    });
  }
  if (lighthouseKinds.length > 0) {
    expectedPrivileges.set(LIGHTHOUSE_PROGRAM_ID, {
      isSigner: false,
      isWritable: false,
    });
  }

  const seenAccountKeys = new Set<string>();
  for (let index = 0; index < parsed.accountKeys.length; index++) {
    const keyAddress = base58Encode(parsed.accountKeys[index]!);
    if (seenAccountKeys.has(keyAddress)) {
      return fail(origin, 400, "UNEXPECTED_ACCOUNT", false);
    }
    const expected = expectedPrivileges.get(keyAddress);
    if (!expected) {
      return fail(origin, 400, "UNEXPECTED_ACCOUNT", false);
    }
    const actual = getAccountPrivilege(parsed, index);
    if (
      actual.isSigner !== expected.isSigner ||
      actual.isWritable !== expected.isWritable
    ) {
      return fail(origin, 400, "UNEXPECTED_INSTRUCTION_COUNT", false);
    }
    seenAccountKeys.add(keyAddress);
  }
  if (parsed.accountKeys.length !== expectedPrivileges.size) {
    return fail(origin, 400, "UNEXPECTED_ACCOUNT", false);
  }

  /* ================= NETWORK GUARD ================= */

  /**
   * Prove the configured RPC is mainnet-beta BEFORE any state is
   * written. A wrong or unverifiable network must not even bind a
   * signature — binding is a side effect, and a payment attempt must
   * never be poisoned by a misconfigured endpoint.
   */
  const networkRefusal = await requireMainnetBeta(rpcUrl, origin);
  if (networkRefusal) {
    return networkRefusal;
  }

  /* ================= ATOMIC SIGNATURE BINDING ================= */

  let binding: { httpStatus: number; data: Record<string, unknown> | null };
  try {
    binding = await postToCoordinator(`identity:${creatorIdentityId}`, {
      op: "identity-bind-broadcast-signature",
      creatorIdentityId,
      paymentIntentId,
      transactionId: transactionSignature,
    });
  } catch {
    // The coordinator never received the bind: nothing was submitted.
    return fail(origin, 503, "CREDIT_COORDINATOR_UNAVAILABLE", false);
  }
  if (!binding.data?.["ok"]) {
    const error =
      typeof binding.data?.["error"] === "string"
        ? (binding.data["error"] as string)
        : "BROADCAST_NOT_AUTHORIZED";
    // A refused binding means sendTransaction is NOT called (fail closed).
    return fail(origin, binding.httpStatus === 503 ? 503 : 409, error, false);
  }

  /* ================= BROADCAST ================= */

  try {
    const result = await solanaJsonRpc<string>(rpcUrl, "sendTransaction", [
      signedTransactionB64,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      },
    ]);

    if (typeof result !== "string" || result.length === 0) {
      // sendTransaction WAS called: an unusable answer does not prove the
      // transaction was rejected on chain.
      return fail(origin, 502, "RPC_ERROR", true);
    }
    if (result !== transactionSignature) {
      // The network accepted a DIFFERENT transaction than the one we
      // validated and bound: fail closed, never continue with it.
      return fail(origin, 502, "RPC_SIGNATURE_MISMATCH", true);
    }

    return new Response(JSON.stringify({ ok: true, signature: result }), {
      status: 200,
      headers: baseHeaders(origin),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "RPC_ERROR";
    // A transaction that was already accepted is an idempotent success:
    // the signature is the same and the binding already exists.
    if (/already been processed|AlreadyProcessed/i.test(raw)) {
      return new Response(JSON.stringify({ ok: true, signature: transactionSignature }), {
        status: 200,
        headers: baseHeaders(origin),
      });
    }
    // Never surface the upstream endpoint itself.
    const message = raw.includes(rpcUrl) ? "RPC_ERROR" : raw;
    // The submission was attempted: its outcome is UNKNOWN.
    return fail(origin, 502, message || "RPC_ERROR", true);
  }
}
