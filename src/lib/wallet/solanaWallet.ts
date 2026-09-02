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

export interface SendSolanaUSDCPaymentOptions {
  readonly destination?: string;
  readonly amountAtomic?: string;
  readonly publicKey?: string;
  readonly signAndSendTransaction?: (transaction: import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction) => Promise<{ signature: string }>;
}

export async function sendSolanaUSDCPayment({
  destination = AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS,
  amountAtomic = "1000000",
  publicKey: publicKeyOption,
  signAndSendTransaction: signAndSendOption,
}: SendSolanaUSDCPaymentOptions = {}): Promise<string> {
  const web3 = await import("@solana/web3.js")
  const { Connection, Transaction, PublicKey } = web3
  const spl = await import("@solana/spl-token")
  const {
    getAssociatedTokenAddressSync,
    createTransferInstruction,
    TOKEN_PROGRAM_ID,
  } = spl

  const connection = new Connection(SOLANA_MAINNET_RPC, "confirmed")

  let publicKey = publicKeyOption
  if (!publicKey && signAndSendOption) {
    throw new Error("publicKey is required when using signAndSendTransaction")
  }

  if (!signAndSendOption) {
    const adapter = await connectSolanaWallet()
    publicKey = adapter.getPublicKey() ?? publicKey
    if (!publicKey) {
      throw new Error("Solana wallet is not connected")
    }
  }

  if (!publicKey) {
    throw new Error("Solana wallet public key is required")
  }

  const payer = new PublicKey(publicKey)
  const mint = new PublicKey(SOLANA_USDC_MINT)
  const destinationWallet = new PublicKey(destination)

  const sourceAta = getAssociatedTokenAddressSync(mint, payer, false)
  const destinationAta = getAssociatedTokenAddressSync(mint, destinationWallet, false)

  const instructions: unknown[] = [
    createTransferInstruction(
      sourceAta,
      destinationAta,
      payer,
      BigInt(amountAtomic),
      [payer],
      TOKEN_PROGRAM_ID
    )
  ]

  const blockhashRes = await fetch("/api/solana/blockhash", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!blockhashRes.ok) {
    const errorPayload = (await blockhashRes.json().catch(() => ({}))) as { error?: string };

    throw new Error(
      typeof errorPayload?.error === "string"
        ? errorPayload.error
        : `Blockhash fetch failed: HTTP ${blockhashRes.status}`
    );
  }

  const blockhashData = (await blockhashRes.json()) as {
    ok?: boolean;
    blockhash?: string;
    lastValidBlockHeight?: number | null;
  };

  if (!blockhashData?.ok || typeof blockhashData.blockhash !== "string" || blockhashData.blockhash.length === 0) {
    throw new Error("Invalid blockhash response.")
  }

  const transaction = new Transaction().add(...instructions as never[])
  transaction.feePayer = payer
  transaction.recentBlockhash = blockhashData.blockhash

  if (typeof blockhashData.lastValidBlockHeight === "number") {
    transaction.lastValidBlockHeight = blockhashData.lastValidBlockHeight
  }

  if (signAndSendOption) {
    const result = await signAndSendOption(transaction)
    if (!result?.signature) {
      throw new Error("No transaction signature from wallet.")
    }
    return result.signature
  }

  const signedTransaction = (await connectSolanaWallet().then(adapter => adapter.signTransaction(transaction))) as { serialize: () => Uint8Array }
  const signature = await connection.sendRawTransaction(signedTransaction.serialize())
  return signature
}
