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
   * different one. Only a full byte comparison of the prepared and the
   * returned message can, so ANY difference — or a message that cannot
   * be read at all — ends the payment path here with the typed
   * `WALLET_MODIFIED_TRANSACTION` refusal. The signed bytes never reach
   * the controller and never reach `/api/solana/broadcast`.
   */
  const returnedMessage = readReturnedMessageBytes(signed)
  if (!returnedMessage || !messageBytesEqual(preparedMessage, returnedMessage)) {
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
