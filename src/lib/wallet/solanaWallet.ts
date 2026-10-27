/**
 * AETERNA — Solana-compatible wallet abstraction
 *
 * Provider-agnostic helper for supported Solana-compatible wallets.
 * Uses Wallet Standard / standard wallet capability detection where available.
 *
 * Canonical active rail:
 * - network: Solana Mainnet
 * - asset: native USDC
 * - token mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 * - service settlement address: 6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu
 *
 * This helper does NOT store private keys.
 * This helper does NOT request seed phrases.
 * This helper does NOT provide custody.
 */

export type SolanaWalletAdapter = {
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  getPublicKey: () => string | null;
  signMessage: (message: string | Uint8Array) => Promise<{ signature: string }>;
  signTransaction: (tx: unknown) => Promise<unknown>;
  signAndSendTransaction?: (tx: unknown) => Promise<{ signature: string }>;
};

interface SolanaProviderLike {
  publicKey?: string | { toBase58: () => string };
  signMessage?: (message: Uint8Array) => Promise<unknown>;
  signTransaction?: (transaction: unknown) => Promise<unknown>;
  signAndSendTransaction?: (transaction: unknown) => Promise<unknown>;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  request?: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  autoConnect?: boolean;
}

function readPublicKey(provider: SolanaProviderLike): string | null {
  const publicKey = provider.publicKey;

  if (typeof publicKey === "string") {
    return publicKey;
  }

  if (publicKey && typeof publicKey === "object" && typeof publicKey.toBase58 === "function") {
    return publicKey.toBase58();
  }

  return null;
}

async function connectStandardLike(provider: SolanaProviderLike): Promise<string> {
  if (!provider.connect) {
    throw new Error("Unsupported Solana wallet: missing connect");
  }

  await provider.connect();

  const publicKey = readPublicKey(provider);
  if (!publicKey) {
    throw new Error("Unsupported Solana wallet: missing public key");
  }

  return publicKey;
}

async function connectLegacyLike(provider: SolanaProviderLike): Promise<string> {
  if (!provider.request) {
    throw new Error("Unsupported Solana wallet: missing request");
  }

  const accounts = (await provider.request({
    method: "connect",
  })) as string[] | undefined;

  const publicKey =
    typeof accounts?.[0] === "string" && accounts[0].length > 0
      ? accounts[0]
      : null;

  if (!publicKey) {
    throw new Error("Unsupported Solana wallet: missing public key");
  }

  return publicKey;
}

export async function connectSolanaWallet(): Promise<SolanaWalletAdapter> {
  if (typeof window === "undefined") {
    throw new Error("Solana wallet connection is only available in browser");
  }

  const windowWithSolana = window as Window & {
    solana?: unknown;
    solana_wallet?: unknown;
  };

  const rawProvider: unknown =
    windowWithSolana.solana ?? windowWithSolana.solana_wallet ?? null;

  let provider: SolanaProviderLike | null = null;

  if (isCandidateProvider(rawProvider)) {
    provider = rawProvider as SolanaProviderLike;
  }

  if (!provider) {
    throw new Error("No supported Solana-compatible wallet detected");
  }

  const publicKey = readPublicKey(provider);
  const isConnected = publicKey !== null;

  const signMessage = provider.signMessage;
  if (!signMessage) {
    throw new Error("Unsupported Solana wallet: missing signMessage");
  }

  const adapter: SolanaWalletAdapter = {
    connect: async () => {
      if (isConnected && provider.autoConnect) {
        return publicKey!;
      }

      if (provider.connect) {
        return connectStandardLike(provider);
      }

      if (provider.request) {
        return connectLegacyLike(provider);
      }

      throw new Error("Unsupported Solana wallet: missing connect");
    },
    disconnect: async () => {
      if (provider.disconnect) {
        await provider.disconnect();
      }
    },
    getPublicKey: () => (isConnected ? publicKey : null),
    signMessage: async (message) => {
      const encoded =
        message instanceof Uint8Array ? message : new TextEncoder().encode(message);

      const signature = (await signMessage(encoded)) as
        | { signature: Uint8Array }
        | Uint8Array;

      const bytes = Array.isArray(signature)
        ? new Uint8Array(signature)
        : "signature" in signature
          ? (signature as { signature: Uint8Array }).signature
          : signature;

      return { signature: Buffer.from(bytes).toString("base64") };
    },
    signTransaction: async (tx) => {
      if (!provider.signTransaction) {
        throw new Error("Unsupported Solana wallet: missing signTransaction");
      }

      return provider.signTransaction(tx);
    },
    signAndSendTransaction: async (tx) => {
      if (!provider.signAndSendTransaction) {
        throw new Error("Unsupported Solana wallet: missing signAndSendTransaction");
      }

      const result = await provider.signAndSendTransaction(tx);

      let signature: string | null = null;
      if (typeof result === "string") {
        signature = result;
      } else if (result && typeof result === "object") {
        const maybe = result as { signature?: unknown };
        if (typeof maybe.signature === "string") {
          signature = maybe.signature;
        }
      }

      if (!signature) {
        throw new Error("Unsupported Solana wallet: missing transaction signature");
      }

      return { signature };
    },
  };

  if (!isConnected) {
    try {
      await adapter.connect();
    } catch {
      // leave disconnected state for caller to handle
    }
  }

  return adapter;
}

function isCandidateProvider(provider: unknown): provider is SolanaProviderLike {
  if (!provider || typeof provider !== "object") {
    return false;
  }

  const record = provider as Record<string, unknown>;
  const publicKey = record["publicKey"];
  const hasPublicKey =
    typeof publicKey === "string" ||
    (publicKey && typeof publicKey === "object" && typeof (publicKey as Record<string, unknown>)["toBase58"] === "function");

  const hasRequest = typeof record["request"] === "function";

  const hasSigning =
    typeof record["signMessage"] === "function" ||
    typeof record["signTransaction"] === "function" ||
    typeof record["signAndSendTransaction"] === "function";

  return (hasPublicKey || hasRequest) && hasSigning;
}

export function isSolanaWalletAdapter(
  value: unknown
): value is SolanaWalletAdapter {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record["connect"] === "function" &&
    typeof record["disconnect"] === "function" &&
    typeof record["getPublicKey"] === "function" &&
    typeof record["signMessage"] === "function" &&
    typeof record["signTransaction"] === "function"
  );
}

const AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

const SOLANA_CONFIRM_POLL_INTERVAL_MS = 500
const SOLANA_CONFIRM_TIMEOUT_MS = 15000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSignatureStatus(
  signature: string,
  getStatus: (signature: string) => Promise<{ err?: unknown; confirmationStatus?: string } | null>,
  timeoutMs = SOLANA_CONFIRM_TIMEOUT_MS
): Promise<void> {
  const maxAttempts = Math.ceil(timeoutMs / SOLANA_CONFIRM_POLL_INTERVAL_MS) + 1
  let attempt = 0
  while (attempt < maxAttempts) {
    attempt++
    let status: { err?: unknown; confirmationStatus?: string } | null = null
    try {
      status = await getStatus(signature)
    } catch {
      throw new Error("Transaction status lookup failed.")
    }

    if (!status) {
      await sleep(SOLANA_CONFIRM_POLL_INTERVAL_MS)
      continue
    }

    if (status.err) {
      const message =
        typeof status.err === "string"
          ? status.err
          : JSON.stringify(status.err)
      throw new Error(`Transaction failed: ${message}`)
    }

    if (
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
    ) {
      return
    }

    await sleep(SOLANA_CONFIRM_POLL_INTERVAL_MS)
  }

  throw new Error("Transaction confirmation timed out.")
}

/**
 * AETERNA — server-proxied Solana account-existence check.
 *
 * The browser never talks to Solana RPC directly (same policy as the
 * blockhash fetch): the read-only check goes through the AETERNA server
 * proxy, which uses the configured mainnet RPC.
 *
 * FAIL-CLOSED: if the check cannot be completed, or the response is not a
 * well-formed answer, this throws and the payment is abandoned BEFORE any
 * transaction is built or handed to the wallet. AETERNA never guesses about
 * the settlement token account.
 */
async function fetchAccountExists(address: string): Promise<boolean> {
  const res = await fetch(
    `/api/solana/token-account?address=${encodeURIComponent(address)}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    }
  )

  if (!res.ok) {
    const errorPayload = (await res.json().catch(() => ({}))) as {
      error?: string
    }

    throw new Error(
      typeof errorPayload?.error === "string"
        ? errorPayload.error
        : `Token account check failed: HTTP ${res.status}`
    )
  }

  const data = (await res.json()) as { ok?: boolean; exists?: boolean }

  if (typeof data?.exists !== "boolean") {
    throw new Error("Invalid token account response.")
  }

  return data.exists
}

export interface SendSolanaUSDCPaymentOptions {
  readonly destination?: string
  readonly amountAtomic?: string
  readonly publicKey?: string
  /**
   * REQUIRED.
   *
   * AETERNA signs and sends EXCLUSIVELY through the wallet-adapter callback:
   * the application never holds a signing key and never opens a browser-side
   * Solana RPC connection of its own. There is deliberately no fallback
   * signing/sending path.
   */
  readonly signAndSendTransaction: (
    transaction: import("@solana/web3.js").Transaction | import("@solana/web3.js").VersionedTransaction
  ) => Promise<{ signature: string }>
  readonly getSignatureStatus?: (
    signature: string
  ) => Promise<{ err?: unknown; confirmationStatus?: string } | null>
}

/**
 * Builds the CANONICAL $1 USDC service-payment transaction.
 *
 * Extracted verbatim from sendSolanaUSDCPayment so the two-phase flow
 * (sign → persist → bind → broadcast) builds EXACTLY the same
 * transaction as the legacy single-call flow: same instructions, same
 * amount, same mint, same recipient, same fee payer. The strict server
 * broadcast endpoint validates this shape, so there must never be a
 * second builder.
 */
async function buildServicePaymentTransaction({
  destination = AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS,
  amountAtomic = "1000000",
  publicKey: publicKeyOption,
}: {
  destination?: string | undefined
  amountAtomic?: string | undefined
  publicKey?: string | null | undefined
}): Promise<{
  transaction: import("@solana/web3.js").Transaction
  blockhash: string
  lastValidBlockHeight: number | null
}> {
  const web3 = await import("@solana/web3.js")
  const { Transaction, PublicKey } = web3
  const spl = await import("@solana/spl-token")
  const {
    getAssociatedTokenAddressSync,
    createTransferInstruction,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
  } = spl

  const publicKey = publicKeyOption
  if (!publicKey) {
    throw new Error("publicKey is required when using signAndSendTransaction")
  }

  const payer = new PublicKey(publicKey)
  const mint = new PublicKey(SOLANA_USDC_MINT)
  const destinationWallet = new PublicKey(destination)

  const sourceAta = getAssociatedTokenAddressSync(mint, payer, false)
  const destinationAta = getAssociatedTokenAddressSync(mint, destinationWallet, false)

  /**
   * The settlement wallet's USDC associated token account may not exist yet.
   * An SPL Token `Transfer` into a non-existent token account can neither be
   * simulated nor executed, which is exactly what makes a wallet refuse the
   * request before signing it.
   *
   * The account is therefore created inside the SAME atomic transaction, and
   * only when it is genuinely absent: an unconditional create would fail with
   * "account already in use" once the account exists.
   */
  const destinationAtaExists = await fetchAccountExists(
    destinationAta.toBase58()
  )

  const instructions: unknown[] = []

  if (!destinationAtaExists) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payer,
        destinationAta,
        destinationWallet,
        mint,
        TOKEN_PROGRAM_ID
      )
    )
  }

  instructions.push(
    createTransferInstruction(
      sourceAta,
      destinationAta,
      payer,
      BigInt(amountAtomic),
      [payer],
      TOKEN_PROGRAM_ID
    )
  )

  const blockhashRes = await fetch("/api/solana/blockhash", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  })

  if (!blockhashRes.ok) {
    const errorPayload = (await blockhashRes.json().catch(() => ({}))) as { error?: string }

    throw new Error(
      typeof errorPayload?.error === "string"
        ? errorPayload.error
        : `Blockhash fetch failed: HTTP ${blockhashRes.status}`
    )
  }

  const blockhashData = (await blockhashRes.json()) as {
    ok?: boolean
    blockhash?: string
    lastValidBlockHeight?: number | null
  }

  if (!blockhashData?.ok || typeof blockhashData.blockhash !== "string" || blockhashData.blockhash.length === 0) {
    throw new Error("Invalid blockhash response.")
  }

  const transaction = new Transaction().add(...instructions as never[])
  transaction.feePayer = payer
  transaction.recentBlockhash = blockhashData.blockhash

  if (typeof blockhashData.lastValidBlockHeight === "number") {
    transaction.lastValidBlockHeight = blockhashData.lastValidBlockHeight
  }


  return {
    transaction,
    blockhash: blockhashData.blockhash,
    lastValidBlockHeight:
      typeof blockhashData.lastValidBlockHeight === "number"
        ? blockhashData.lastValidBlockHeight
        : null,
  }
}

/**
 * The wallet returned a transaction whose MESSAGE is not the one AETERNA
 * prepared for signing.
 *
 * A wallet is free to force a different message (adjusted fees, extra or
 * removed instructions, another blockhash) and to sign THAT message
 * correctly — the signature checks alone cannot see the difference. Such
 * a transaction is never this payment: it is refused here, BEFORE the
 * signed bytes can reach the controller or `/api/solana/broadcast`, and
 * no pending attempt is recorded for it.
 *
 * ONE exception exists, enforced structurally rather than textually (see
 * `walletMessageIsAcceptable`): a wallet may add canonical, fee-only
 * priority-fee instructions on the ComputeBudget program — Phantom does
 * this automatically for every unsigned dApp transaction — while EVERY
 * payment instruction, resolved account, account role and the blockhash
 * must still match the prepared message exactly, and the worst-case
 * priority fee those instructions can request stays within the payment's
 * bounded SOL policy (0.001 SOL, see `MAX_WALLET_PRIORITY_FEE_LAMPORTS`).
 *
 * `code` is a stable, structured marker for callers; classification must
 * never rely on matching the error text.
 */
export class WalletModifiedTransactionError extends Error {
  readonly code = "WALLET_MODIFIED_TRANSACTION" as const

  constructor() {
    super(
      "WALLET_MODIFIED_TRANSACTION: the wallet returned a transaction whose message differs from the one AETERNA prepared"
    )
    this.name = "WalletModifiedTransactionError"
  }
}

/** Exact byte-sequence equality of two serialized Solana messages. */
function messageBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * The message bytes of the transaction a wallet returned, or null when
 * they cannot be read at all (unknown shape, alien type, serialization
 * error).
 *
 * null means the identity of the transaction CANNOT be proven, so the
 * caller must fail closed and refuse it.
 */
function readReturnedMessageBytes(transaction: unknown): Uint8Array | null {
  const candidate = transaction as { serializeMessage?: unknown }
  if (typeof candidate?.serializeMessage !== "function") return null
  try {
    const message = (candidate.serializeMessage as () => unknown).call(
      candidate
    )
    return message instanceof Uint8Array ? message : null
  } catch {
    return null
  }
}

/**
 * Canonical ComputeBudget program. Instructions on it configure FEES and
 * COMPUTE LIMITS only: they cannot move tokens, touch a token account or
 * change which accounts any other instruction reads.
 */
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111"

/** ComputeBudget tag of `setComputeUnitLimit` (tag byte + u32 LE). */
const COMPUTE_BUDGET_SET_UNIT_LIMIT = 2
/** ComputeBudget tag of `setComputeUnitPrice` (tag byte + u64 LE). */
const COMPUTE_BUDGET_SET_UNIT_PRICE = 3
/** Protocol maximum compute-unit limit; anything higher is not canonical. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000
/**
 * Phantom inserts exactly its priority-fee pair (a compute-unit limit and
 * a compute-unit price). Anything BEYOND that pair — more than two fee
 * instructions, or the same fee tag twice — is not the documented
 * behavior and is refused.
 */
const MAX_WALLET_PRIORITY_FEE_INSTRUCTIONS = 2
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
 * an unbounded SOL loss. The policy caps the worst case the message can
 * request; it is evaluated with ceiling integer arithmetic so the
 * accepted maximum can never round up past this constant on-chain.
 *
 * This is an acceptance CEILING, not a target: Phantom's automatic
 * injections under normal network conditions sit orders of magnitude
 * below it, and a wallet asking for more fails closed — the refusal
 * happens before anything is broadcast and nothing is sent.
 */
const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 1_000_000n

/**
 * Phantom's transaction guard. Lighthouse instructions are READ-ONLY
 * assertions: they can make a transaction fail, but they cannot move tokens
 * or mutate an account. Only the exact v2 shapes Phantom was observed to
 * append are recognized below; a matching program id alone is never enough.
 */
const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"

/** SPL Token program, used to locate the prepared transfer's source ATA. */
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

/**
 * Phantom v2 Lighthouse payload fixtures, RECONSTRUCTED from the production
 * diagnostic's recorded shape and hashes. The original production 27-byte
 * token-assertion payload was not independently recovered; the fixtures
 * below pin the accepted v2 shape rather than claim those exact remote
 * bytes.
 *
 *   info  (16 B): 39bb93d1a828d59455ba9e8b9679901d04086bcf0c44251af08e7e60383e7fbc
 *   token (27 B): b4441240a9f8613e359bc99ff3ca06512982b4d7ef1db1378000d149e2bf5a5f
 *
 * Info: AssertAccountInfoMulti(logLevel=4) on the payer:
 *   KnownOwner(System) == Equal; DataLength == Equal(0)
 *
 * Token: AssertTokenAccountMulti(logLevel=4) on the source ATA:
 *   Amount >= <post-transfer balance>; Delegate == null;
 *   DelegatedAmount <= 0; TokenAccountOwnerIsDerived
 */
const PHANTOM_LIGHTHOUSE_INFO_DATA = new Uint8Array([
  6, 4, 2,
  3, 0, 0,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])

const PHANTOM_LIGHTHOUSE_TOKEN_DATA = new Uint8Array([
  10, 4, 4,
  2, 0x22, 0x16, 0x07, 0, 0, 0, 0, 0, 4,
  3, 0, 0,
  6, 0, 0, 0, 0, 0, 0, 0, 0, 5,
  8,
])

function isPhantomLighthouseInfoData(data: Uint8Array): boolean {
  return messageBytesEqual(data, PHANTOM_LIGHTHOUSE_INFO_DATA)
}

/**
 * The ONLY variable field is the u64 Amount lower bound: Phantom derives it
 * from the simulated post-transfer balance, so pinning this particular
 * user's 464418 would break every other balance. It is still a read-only
 * assertion — the transfer itself remains byte-identical to the prepared
 * payment — and every other discriminator, operator, option and value is
 * fixed. Extra/trailing bytes are rejected by the exact length check.
 */
function isPhantomLighthouseTokenData(data: Uint8Array): boolean {
  if (data.length !== PHANTOM_LIGHTHOUSE_TOKEN_DATA.length) return false
  for (let index = 0; index < data.length; index++) {
    // Bytes 4..11 are the runtime-specific Amount u64.
    if (index >= 4 && index <= 11) continue
    if (data[index] !== PHANTOM_LIGHTHOUSE_TOKEN_DATA[index]) return false
  }
  return true
}

/**
 * Resolve the source token account from the PREPARED SPL Token transfer by
 * address, never by a numeric index. The returned account-key table can be
 * recompiled and reordered by the wallet, so index equality is not identity.
 */
function preparedTokenTransferSource(
  prepared: import("@solana/web3.js").Message
): string | null {
  let source: string | null = null
  for (const instruction of prepared.compiledInstructions) {
    const program = prepared.accountKeys[instruction.programIdIndex]
    if (!program || program.toBase58() !== SPL_TOKEN_PROGRAM) continue
    // SPL Token `Transfer` (tag 3) is exactly 1 + 8 bytes.
    if (instruction.data.length !== 9 || instruction.data[0] !== 3) continue
    if (source !== null) return null
    const sourceKey = prepared.accountKeys[instruction.accountKeyIndexes[0]!]
    if (!sourceKey) return null
    source = sourceKey.toBase58()
  }
  return source
}

/** Little-endian u32 read (bounds guaranteed by the caller). */
function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  )
}

/** Little-endian u64 read (bounds guaranteed by the caller). */
function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i]!)
  }
  return value
}

/**
 * `true` only when the returned message is BYTE-IDENTICAL to the prepared
 * one, or differs from it by nothing except canonical wallet-added
 * priority-fee instructions and Phantom's exact Lighthouse v2 assertion
 * pair.
 *
 * Rationale — documented wallet behavior, not a relaxation of the
 * payment's identity: Phantom automatically inserts a compute-unit limit
 * and a compute-unit price instruction into dApp transactions that carry
 * no signatures and no priority-fee instructions of their own, and signs
 * THAT message (docs.phantom.com/developer-powertools/solana-priority-fees).
 * It may also append Lighthouse assertions that pin the payer and source
 * token account. Both additions are bounded:
 *
 *   - fee instructions have ZERO account metas, so they cannot reference,
 *     let alone move, any token account;
 *   - only the two canonical fee tags are accepted (`setComputeUnitLimit`
 *     with a protocol-valid limit, and `setComputeUnitPrice`), at most
 *     ONE instruction of each, and the worst-case priority fee they can
 *     request — `ceil(limit × price / 1_000_000)` lamports, using the
 *     protocol MAXIMUM of 1 400 000 CU when the wallet sets no limit — may
 *     not exceed `MAX_WALLET_PRIORITY_FEE_LAMPORTS` (0.001 SOL);
 *   - every instruction AETERNA prepared must still match exactly —
 *     same program, same RESOLVED account keys in the same order, same
 *     data bytes — the fee payer must be unchanged, the blockhash must be
 *     unchanged, the signer count must be unchanged, and every prepared
 *     account key must keep its exact signer/writable role;
 *   - Lighthouse is accepted ONLY as the exact two-instruction pair
 *     Phantom was observed to append, in order, after the payment:
 *     AssertAccountInfoMulti(payer) with KnownOwner(System) and
 *     DataLength==0, then AssertTokenAccountMulti(source ATA) with
 *     Amount>=<lower bound>, Delegate==null, DelegatedAmount<=0 and
 *     TokenAccountOwnerIsDerived. Unknown versions, variants,
 *     discriminators, values, extra assertions/accounts/instructions or
 *     duplicates are refused. These are read-only assertions: they cannot
 *     move tokens, and the transfer itself is still compared exactly;
 *   - the ONLY account keys the wallet may append are the ComputeBudget
 *     and Lighthouse programs, each read-only and unsigned, and only when
 *     the corresponding instructions were actually added.
 *
 * Everything else — a single changed account, amount, mint, authority,
 * destination, blockhash or instruction — still fails closed, and an
 * unparseable message is never acceptable.
 */
async function walletMessageIsAcceptable(
  preparedMessage: Uint8Array,
  returnedMessage: Uint8Array
): Promise<boolean> {
  if (messageBytesEqual(preparedMessage, returnedMessage)) return true
  try {
    const { Message, PublicKey } = await import("@solana/web3.js")
    const prepared = Message.from(preparedMessage)
    const returned = Message.from(returnedMessage)

    const preparedPayer = prepared.accountKeys[0]
    const returnedPayer = returned.accountKeys[0]
    if (
      !preparedPayer ||
      !returnedPayer ||
      !preparedPayer.equals(returnedPayer)
    ) {
      return false
    }
    if (prepared.recentBlockhash !== returned.recentBlockhash) return false
    if (
      returned.header.numRequiredSignatures !==
      prepared.header.numRequiredSignatures
    ) {
      return false
    }

    const computeBudget = new PublicKey(COMPUTE_BUDGET_PROGRAM)
    const lighthouse = new PublicKey(LIGHTHOUSE_PROGRAM)
    const preparedTransferSource = preparedTokenTransferSource(prepared)
    const lighthouseKinds: Array<"info" | "token"> = []
    const kept: Array<{
      program: string
      accounts: string[]
      data: Uint8Array
    }> = []
    let priorityFeeInstructions = 0
    let walletUnitLimit: number | null = null
    let walletUnitPrice: bigint | null = null
    let sawLighthouse = false

    for (const instruction of returned.compiledInstructions) {
      const programKey = returned.accountKeys[instruction.programIdIndex]
      if (!programKey) return false
      if (programKey.equals(computeBudget)) {
        const isCanonicalLimit =
          instruction.data.length === 5 &&
          instruction.data[0] === COMPUTE_BUDGET_SET_UNIT_LIMIT &&
          readU32LE(instruction.data, 1) <= MAX_COMPUTE_UNIT_LIMIT
        const isCanonicalPrice =
          instruction.data.length === 9 &&
          instruction.data[0] === COMPUTE_BUDGET_SET_UNIT_PRICE
        if (
          instruction.accountKeyIndexes.length !== 0 ||
          (!isCanonicalLimit && !isCanonicalPrice)
        ) {
          return false
        }
        priorityFeeInstructions += 1
        if (priorityFeeInstructions > MAX_WALLET_PRIORITY_FEE_INSTRUCTIONS) {
          return false
        }
        /**
         * At most ONE instruction per fee tag: the documented wallet
         * shape is a single limit/price pair, and a duplicated tag would
         * make the priority-fee policy ambiguous (which of the values
         * would the network actually charge?).
         */
        if (isCanonicalLimit) {
          if (walletUnitLimit !== null) return false
          walletUnitLimit = readU32LE(instruction.data, 1)
        } else {
          if (walletUnitPrice !== null) return false
          walletUnitPrice = readU64LE(instruction.data, 1)
        }
        continue
      }
      if (programKey.equals(lighthouse)) {
        /**
         * The Lighthouse program account is a read-only, unsigned program
         * key. A writable/signer role would be a different message from the
         * documented Phantom shape and is refused.
         */
        if (
          returned.isAccountSigner(instruction.programIdIndex) ||
          returned.isAccountWritable(instruction.programIdIndex)
        ) {
          return false
        }
        if (instruction.accountKeyIndexes.length !== 1) return false
        const target =
          returned.accountKeys[instruction.accountKeyIndexes[0]!]
        if (!target) return false
        const data = new Uint8Array(instruction.data)

        if (data[0] === 6) {
          // AssertAccountInfoMulti on the fee payer: System-owned, no data.
          if (!target.equals(preparedPayer)) return false
          if (!isPhantomLighthouseInfoData(data)) return false
          lighthouseKinds.push("info")
        } else if (data[0] === 10) {
          // AssertTokenAccountMulti on the prepared transfer's source ATA.
          if (
            preparedTransferSource === null ||
            target.toBase58() !== preparedTransferSource ||
            !isPhantomLighthouseTokenData(data)
          ) {
            return false
          }
          lighthouseKinds.push("token")
        } else {
          // Unknown Lighthouse version/variant/discriminator.
          return false
        }
        if (lighthouseKinds.length > 2) return false
        sawLighthouse = true
        continue
      }
      // Lighthouse assertions are appended AFTER the prepared payment.
      if (sawLighthouse) return false
      const accounts: string[] = []
      for (const accountIndex of instruction.accountKeyIndexes) {
        const accountKey = returned.accountKeys[accountIndex]
        if (!accountKey) return false
        accounts.push(accountKey.toBase58())
      }
      kept.push({
        program: programKey.toBase58(),
        accounts,
        data: new Uint8Array(instruction.data),
      })
    }

    /**
     * PRIORITY-FEE POLICY — see `MAX_WALLET_PRIORITY_FEE_LAMPORTS`.
     *
     * The worst case the wallet's own instructions can request is
     * `ceil(units × price / 1_000_000)` lamports, where `units` is the
     * wallet's limit or — when it set none — the protocol MAXIMUM of
     * 1 400 000 CU: a missing limit is charged against the protocol's
     * per-instruction default (200 000 CU per payable instruction here,
     * i.e. up to 400 000 CU), and bounding that case by the maximum keeps
     * the cap independent of the default's accounting. Anything above the
     * policy ceiling refuses the whole message: the fee exception is never
     * a blank cheque for SOL.
     */
    if (priorityFeeInstructions > 0) {
      const policyUnits =
        walletUnitLimit ?? MAX_COMPUTE_UNIT_LIMIT
      const policyPrice = walletUnitPrice ?? 0n
      const worstCasePriorityFeeLamports =
        (BigInt(policyUnits) * policyPrice + 999_999n) / 1_000_000n
      if (worstCasePriorityFeeLamports > MAX_WALLET_PRIORITY_FEE_LAMPORTS) {
        return false
      }
    }

    const preparedInstructions = prepared.compiledInstructions
    if (kept.length !== preparedInstructions.length) return false
    /**
     * The bytes may differ from the prepared ones ONLY because the wallet
     * added its canonical fee instruction(s) and/or Phantom's exact
     * Lighthouse v2 assertion pair. Without at least one such addition the
     * message is refused even when it still resolves to the same payment —
     * the exception exists for documented wallet behavior, not as a general
     * "semantically equal" allowance.
     */
    if (priorityFeeInstructions === 0 && lighthouseKinds.length === 0) {
      return false
    }
    /**
     * Exactly two Lighthouse instructions, in this order, after the payment:
     * AssertAccountInfoMulti(payer), then AssertTokenAccountMulti(source ATA).
     * One alone, a duplicate, a reorder, or a third assertion is refused.
     */
    if (
      lighthouseKinds.length !== 0 &&
      (lighthouseKinds.length !== 2 ||
        lighthouseKinds[0] !== "info" ||
        lighthouseKinds[1] !== "token")
    ) {
      return false
    }
    for (let index = 0; index < kept.length; index++) {
      const preparedInstruction = preparedInstructions[index]!
      const preparedProgram =
        prepared.accountKeys[preparedInstruction.programIdIndex]
      if (
        !preparedProgram ||
        preparedProgram.toBase58() !== kept[index]!.program
      ) {
        return false
      }
      if (
        preparedInstruction.accountKeyIndexes.length !==
        kept[index]!.accounts.length
      ) {
        return false
      }
      for (
        let account = 0;
        account < preparedInstruction.accountKeyIndexes.length;
        account++
      ) {
        const preparedAccount =
          prepared.accountKeys[preparedInstruction.accountKeyIndexes[account]!]
        if (
          !preparedAccount ||
          preparedAccount.toBase58() !== kept[index]!.accounts[account]
        ) {
          return false
        }
      }
      if (
        !messageBytesEqual(
          new Uint8Array(preparedInstruction.data),
          kept[index]!.data
        )
      ) {
        return false
      }
    }

    /**
     * Account identity is by ADDRESS, not index: the wallet may recompile and
     * reorder the account-key table. Every prepared key must occur exactly
     * once (no aliasing through a duplicate key) and keep its exact role.
     */
    for (const [index, preparedKey] of prepared.accountKeys.entries()) {
      let found = -1
      let occurrences = 0
      for (const [returnedIndex, returnedKey] of returned.accountKeys.entries()) {
        if (!returnedKey.equals(preparedKey)) continue
        if (found < 0) found = returnedIndex
        occurrences += 1
      }
      if (occurrences !== 1) return false
      if (returned.isAccountSigner(found) !== prepared.isAccountSigner(index)) {
        return false
      }
      if (returned.isAccountWritable(found) !== prepared.isAccountWritable(index)) {
        return false
      }
    }

    let computeBudgetKeys = 0
    let lighthouseKeys = 0
    for (const [index, returnedKey] of returned.accountKeys.entries()) {
      const wasPrepared = prepared.accountKeys.some((key) =>
        key.equals(returnedKey)
      )
      if (wasPrepared) continue
      if (returnedKey.equals(computeBudget)) {
        if (priorityFeeInstructions === 0) return false
        computeBudgetKeys += 1
      } else if (returnedKey.equals(lighthouse)) {
        if (lighthouseKinds.length !== 2) return false
        lighthouseKeys += 1
      } else {
        // No other account key may be appended.
        return false
      }
      if (returned.isAccountSigner(index) || returned.isAccountWritable(index)) {
        return false
      }
    }
    if (computeBudgetKeys !== (priorityFeeInstructions > 0 ? 1 : 0)) return false
    if (lighthouseKeys !== (lighthouseKinds.length > 0 ? 1 : 0)) return false

    return true
  } catch {
    return false
  }
}

/**
 * TEMPORARY, OPT-IN diagnostics for the message-identity guard.
 *
 * The guard below refuses a wallet-returned message without recording any
 * evidence about the difference. With `?aeternaWalletDiag=1` appended to
 * the URL, ONE structured, privacy-filtered object is emitted through
 * `console.warn` at the moment of a refusal; without that exact flag
 * nothing is collected, stored or logged.
 *
 * Diagnostics are decoupled from the guard: any failure to collect them is
 * swallowed and can never change the refusal, and the comparison itself
 * still runs on the FROZEN `preparedMessage` bytes versus the message
 * bytes taken from the object the wallet returned.
 *
 * Never emitted: signatures, serialized messages, base64 payloads,
 * account keys, secrets. Only lengths, SHA-256 fingerprints, legacy
 * header bytes, the public recentBlockhash, program IDs and per-
 * instruction data lengths/hashes. No storage, no network, no telemetry.
 */
const WALLET_MESSAGE_DIAG_PARAM = "aeternaWalletDiag"

function isWalletMessageDiagEnabled(): boolean {
  if (typeof window === "undefined") return false
  try {
    return (
      new URLSearchParams(window.location.search).get(
        WALLET_MESSAGE_DIAG_PARAM
      ) === "1"
    )
  } catch {
    return false
  }
}

function walletDiagBytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex
}

async function walletDiagSha256Hex(bytes: Uint8Array): Promise<string> {
  const data = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return walletDiagBytesToHex(new Uint8Array(digest))
}

interface WalletDiagInstructionSide {
  index: number
  programId: string
  accountCount: number
  dataLength: number
  dataSha256: string
}

interface WalletDiagMessageSide {
  messageLength: number
  messageSha256: string
  header: [number, number, number] | null
  accountKeyCount: number | null
  accountKeyFingerprints: Array<{ index: number; sha256: string }> | null
  recentBlockhash: string | null
  instructionCount: number | null
  instructions: WalletDiagInstructionSide[] | null
  parseError: "message_not_parseable" | null
}

interface WalletDiagCompiledInstruction {
  programIdIndex: number
  accounts: number[]
  data: Uint8Array
}

interface WalletDiagParsedMessage {
  header: [number, number, number]
  accountKeys: import("@solana/web3.js").PublicKey[]
  recentBlockhash: string
  instructions: WalletDiagCompiledInstruction[]
}

/**
 * Parses ONE message byte sequence with the real @solana/web3.js parser
 * (never a hand-rolled decoder) and derives the reportable side fields.
 * A parse failure is reported inside the record, not thrown.
 */
async function parseWalletDiagMessage(messageBytes: Uint8Array): Promise<{
  parsed: WalletDiagParsedMessage | null
  side: WalletDiagMessageSide
}> {
  const messageSha256 = await walletDiagSha256Hex(messageBytes)
  const unparseable: WalletDiagMessageSide = {
    messageLength: messageBytes.length,
    messageSha256,
    header: null,
    accountKeyCount: null,
    accountKeyFingerprints: null,
    recentBlockhash: null,
    instructionCount: null,
    instructions: null,
    parseError: "message_not_parseable",
  }

  try {
    const { Message, Transaction } = await import("@solana/web3.js")
    const message = Message.from(messageBytes)
    // `Transaction.populate` decompiles the compiled instructions with the
    // library's own base58 decoding, so instruction data is raw bytes.
    const populated = Transaction.populate(message)
    const instructions: WalletDiagCompiledInstruction[] =
      message.instructions.map((compiled, index) => {
        const transactionInstruction = populated.instructions[index]
        if (!transactionInstruction) {
          throw new Error("decompiled instruction is missing")
        }
        return {
          programIdIndex: compiled.programIdIndex,
          accounts: Array.from(compiled.accounts),
          data: new Uint8Array(transactionInstruction.data),
        }
      })
    const header: [number, number, number] = [
      message.header.numRequiredSignatures,
      message.header.numReadonlySignedAccounts,
      message.header.numReadonlyUnsignedAccounts,
    ]

    return {
      parsed: {
        header,
        accountKeys: message.accountKeys,
        recentBlockhash: message.recentBlockhash,
        instructions,
      },
      side: {
        messageLength: messageBytes.length,
        messageSha256,
        header,
        accountKeyCount: message.accountKeys.length,
        accountKeyFingerprints: await Promise.all(
          message.accountKeys.map(async (key, index) => ({
            index,
            sha256: await walletDiagSha256Hex(key.toBytes()),
          }))
        ),
        recentBlockhash: message.recentBlockhash,
        instructionCount: instructions.length,
        instructions: await Promise.all(
          instructions.map(async (instruction, index) => ({
            index,
            programId:
              message.accountKeys[instruction.programIdIndex]?.toBase58() ??
              "unknown",
            accountCount: instruction.accounts.length,
            dataLength: instruction.data.length,
            dataSha256: await walletDiagSha256Hex(instruction.data),
          }))
        ),
        parseError: null,
      },
    }
  } catch {
    return { parsed: null, side: unparseable }
  }
}

function walletDiagInstructionsEqual(
  a: WalletDiagCompiledInstruction[],
  b: WalletDiagCompiledInstruction[]
): boolean {
  if (a.length !== b.length) return false
  return a.every((instruction, index) => {
    const other = b[index]
    if (!other) return false
    return (
      instruction.programIdIndex === other.programIdIndex &&
      instruction.accounts.length === other.accounts.length &&
      instruction.accounts.every(
        (account, accountIndex) => account === other.accounts[accountIndex]
      ) &&
      messageBytesEqual(instruction.data, other.data)
    )
  })
}

function walletDiagInstructionFingerprint(
  instruction: WalletDiagCompiledInstruction
): string {
  return [
    instruction.programIdIndex,
    instruction.accounts.join(","),
    walletDiagBytesToHex(instruction.data),
  ].join(":")
}

/**
 * Best-effort structural classification of the most specific difference.
 * Returns "unknown" whenever the combination is not unambiguous — never a
 * guess. Instruction-level differences take precedence because account-key
 * changes are a derived consequence of them.
 */
function classifyWalletMessageMismatch(
  prepared: WalletDiagParsedMessage,
  returned: WalletDiagParsedMessage
): string {
  if (prepared.instructions.length !== returned.instructions.length) {
    return "instruction_count"
  }
  if (
    !walletDiagInstructionsEqual(prepared.instructions, returned.instructions)
  ) {
    const preparedFingerprints = prepared.instructions
      .map(walletDiagInstructionFingerprint)
      .sort()
    const returnedFingerprints = returned.instructions
      .map(walletDiagInstructionFingerprint)
      .sort()
    if (preparedFingerprints.join("|") === returnedFingerprints.join("|")) {
      return "instruction_order"
    }
    const structureEqual = prepared.instructions.every((instruction, index) => {
      const other = returned.instructions[index]
      if (!other) return false
      return (
        instruction.programIdIndex === other.programIdIndex &&
        instruction.accounts.length === other.accounts.length &&
        instruction.accounts.every(
          (account, accountIndex) => account === other.accounts[accountIndex]
        )
      )
    })
    return structureEqual ? "instruction_data" : "instruction_structure"
  }

  const accountKeysEqual =
    prepared.accountKeys.length === returned.accountKeys.length &&
    prepared.accountKeys.every((key, index) => {
      const other = returned.accountKeys[index]
      return other !== undefined && key.equals(other)
    })
  if (!accountKeysEqual) return "account_keys"

  const headerEqual =
    prepared.header[0] === returned.header[0] &&
    prepared.header[1] === returned.header[1] &&
    prepared.header[2] === returned.header[2]
  if (!headerEqual) return "message_header"

  if (prepared.recentBlockhash !== returned.recentBlockhash) {
    return "recent_blockhash"
  }

  return "unknown"
}

/** Offset of the first differing byte; null only for identical inputs. */
function firstDifferingMessageByteOffset(
  a: Uint8Array,
  b: Uint8Array
): number | null {
  const sharedLength = Math.min(a.length, b.length)
  for (let index = 0; index < sharedLength; index++) {
    if (a[index] !== b[index]) return index
  }
  return a.length === b.length ? null : sharedLength
}

/**
 * Emits exactly ONE structured record. Called only when the guard is
 * about to refuse AND the URL flag is present; every failure inside is
 * contained so the refusal itself can never be affected.
 */
async function emitWalletMessageMismatchDiagnostics(
  preparedMessage: Uint8Array,
  returnedMessage: Uint8Array | null
): Promise<void> {
  let record: Record<string, unknown>
  try {
    const prepared = await parseWalletDiagMessage(preparedMessage)
    if (!returnedMessage) {
      record = {
        event: "WALLET_MODIFIED_TRANSACTION",
        cause: "returned_message_unreadable",
        firstDifferingOffset: null,
        prepared: prepared.side,
        returned: null,
      }
    } else {
      const returned = await parseWalletDiagMessage(returnedMessage)
      record = {
        event: "WALLET_MODIFIED_TRANSACTION",
        cause:
          prepared.parsed && returned.parsed
            ? classifyWalletMessageMismatch(prepared.parsed, returned.parsed)
            : "unknown",
        firstDifferingOffset: firstDifferingMessageByteOffset(
          preparedMessage,
          returnedMessage
        ),
        prepared: prepared.side,
        returned: returned.side,
      }
    }
  } catch {
    record = {
      event: "WALLET_MODIFIED_TRANSACTION",
      diagnostics: "collection_failed",
    }
  }
  try {
    console.warn(record)
  } catch {
    // Diagnostics must never change the refusal.
  }
}

/**
 * Signs the canonical payment WITHOUT sending it.
 *
 * Returns the transaction signature (computed from the signed
 * transaction itself), the serialized signed bytes, and the blockhash
 * window. The caller persists all of it, binds the signature
 * server-side, and only then broadcasts through the validated endpoint —
 * so a lost response can only ever resume the SAME transaction.
 */
export async function signSolanaUSDCPayment({
  destination = AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS,
  amountAtomic = "1000000",
  publicKey: publicKeyOption,
  signTransaction,
}: {
  destination?: string
  amountAtomic?: string
  publicKey?: string | null
  signTransaction: (
    transaction: import("@solana/web3.js").Transaction | import("@solana/web3.js").VersionedTransaction
  ) => Promise<import("@solana/web3.js").Transaction | import("@solana/web3.js").VersionedTransaction>
}): Promise<{
  signature: string
  signedTransactionBase64: string
  blockhash: string
  lastValidBlockHeight: number | null
}> {
  if (typeof signTransaction !== "function") {
    throw new Error(
      "signTransaction is required: AETERNA signs through the wallet adapter only"
    )
  }
  if (!publicKeyOption) {
    throw new Error("publicKey is required when using signTransaction")
  }

  const { transaction, blockhash, lastValidBlockHeight } =
    await buildServicePaymentTransaction({ destination, amountAtomic, publicKey: publicKeyOption })

  /**
   * FREEZE the exact message that is put in front of the wallet.
   *
   * Captured BEFORE the wallet is called, so a wallet that mutates the
   * transaction object it was handed cannot move the reference point
   * afterwards.
   */
  const preparedMessage = transaction.serializeMessage()

  const signed = await signTransaction(transaction)

  // Fully signed means: exactly one signature slot and a non-empty value.
  const signatures = (signed as { signatures?: Array<{ length?: number } | null> }).signatures
  if (!Array.isArray(signatures) || signatures.length !== 1 || !signatures[0]) {
    throw new Error("Transaction is not fully signed")
  }

  const signedTransaction = signed as import("@solana/web3.js").Transaction
  const signatureBytes = signedTransaction.signature
  if (!signatureBytes || signatureBytes.length === 0) {
    throw new Error("Signed transaction carries no signature")
  }

  /**
   * MESSAGE-IDENTITY GUARD — fail closed BEFORE broadcast.
   *
   * The signature checks above only prove that the wallet signed the
   * message it RETURNED; they cannot see that the returned message is a
   * different one. `walletMessageIsAcceptable` therefore accepts only
   * the byte-identical prepared message, or one that differs solely by
   * canonical wallet-added fee-only priority-fee instructions within the
   * bounded SOL policy (the documented, deterministic Phantom behavior).
   * ANY other difference —
   * or a message that cannot be read at all — ends the payment path here
   * with the typed `WALLET_MODIFIED_TRANSACTION` refusal. The signed
   * bytes never reach the controller and never reach
   * `/api/solana/broadcast`.
   */
  const returnedMessage = readReturnedMessageBytes(signed)
  const acceptable =
    returnedMessage !== null &&
    (await walletMessageIsAcceptable(preparedMessage, returnedMessage))
  if (!acceptable) {
    if (isWalletMessageDiagEnabled()) {
      await emitWalletMessageMismatchDiagnostics(
        preparedMessage,
        returnedMessage
      )
    }
    throw new WalletModifiedTransactionError()
  }

  return {
    // The Solana transaction signature IS the base58 of the first (and
    // only) signature — derived from the bytes that will be broadcast.
    signature: base58EncodeBytes(new Uint8Array(signatureBytes)),
    signedTransactionBase64: bytesToBase64(signedTransaction.serialize()),
    blockhash,
    lastValidBlockHeight,
  }
}

const BASE58_ALPHABET_LOCAL =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

/** Base58 encoding of raw bytes (no dependency). */
function base58EncodeBytes(bytes: Uint8Array): string {
  // Starts EMPTY (a seeded leading 0 digit would add a spurious '1').
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8
      digits[i] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let result = ""
  for (const byte of bytes) {
    if (byte === 0) result += BASE58_ALPHABET_LOCAL[0]
    else break
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET_LOCAL[digits[i]!]
  }
  return result
}

/** Base64 encoding of raw bytes (no dependency). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

export async function sendSolanaUSDCPayment({
  destination = AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS,
  amountAtomic = "1000000",
  publicKey: publicKeyOption,
  signAndSendTransaction,
  getSignatureStatus: getSignatureStatusOption,
}: SendSolanaUSDCPaymentOptions): Promise<string> {
  /**
   * Fail-closed contract guard — never a ReferenceError.
   *
   * `signAndSendTransaction` is a REQUIRED contract, but a JavaScript caller
   * can still pass anything. A missing / non-function callback is rejected
   * with an explicit typed error BEFORE any transaction is built, so a broken
   * caller fails loudly and early instead of reaching an undefined symbol.
   */
  if (typeof signAndSendTransaction !== "function") {
    throw new Error(
      "signAndSendTransaction is required: AETERNA signs and sends through the wallet adapter only"
    )
  }

  const { transaction } = await buildServicePaymentTransaction({
    destination,
    amountAtomic,
    publicKey: publicKeyOption,
  })

  const result = await signAndSendTransaction(transaction)
  if (!result?.signature) {
    throw new Error("No transaction signature from wallet.")
  }

  if (getSignatureStatusOption) {
    await waitForSignatureStatus(result.signature, getSignatureStatusOption)
  }

  return result.signature
}
