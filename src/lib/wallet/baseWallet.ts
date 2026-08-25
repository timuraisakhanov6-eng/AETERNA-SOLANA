/**
 * AETERNA — Base Wallet Payment Helper
 *
 * Minimal browser-side Base Mainnet USDC transfer flow.
 * Uses EIP-1193 provider only. No new dependencies.
 *
 * Canonical payment:
 * - network: Base Mainnet
 * - asset: native USDC
 * - amount: exactly 1 USDC = 1,000,000 base units
 * - recipient: canonical AETERNA Settlement Wallet
 *
 * This helper is NOT payment authority.
 * Server-side verification remains the only authority.
 */

const BASE_CHAIN_ID = "0x2105";
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SETTLEMENT_WALLET = "0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755";
const USDC_ATOMIC_AMOUNT = 1_000_000n;

type EIP1193Provider = {
  request: (args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }) => Promise<unknown>;
};

function getEthereum(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  return eth ?? null;
}

function abiEncodeTransfer(toHex: string, amount: bigint): string {
  const selector = "0xa9059cbb";
  const toPadded = toHex.replace("0x", "").padStart(64, "0");
  const amountPadded = amount.toString(16).padStart(64, "0");
  return `0x${selector}${toPadded}${amountPadded}`;
}

async function ensureBaseChain(provider: EIP1193Provider): Promise<void> {
  let chainId: unknown;
  try {
    chainId = await provider.request({ method: "eth_chainId" });
  } catch {
    // ignore and attempt switch
  }

  if (typeof chainId === "string" && chainId.toLowerCase() === BASE_CHAIN_ID.toLowerCase()) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID }],
    });
    return;
  } catch {
    // try add chain
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: BASE_CHAIN_ID,
        chainName: "Base Mainnet",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://mainnet.base.org"],
        blockExplorerUrls: ["https://basescan.org"],
      },
    ],
  });
}

export async function connectBaseWallet(): Promise<string> {
  const provider = getEthereum();
  if (!provider) {
    throw new Error(
      "No compatible wallet found. Please install a Base-compatible wallet and reload."
    );
  }

  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];

  if (!accounts || accounts.length === 0) {
    throw new Error("Wallet connection was rejected.");
  }

  const account = accounts[0];
  if (account === undefined) {
    throw new Error("Wallet provider returned no account.");
  }

  await ensureBaseChain(provider);

  return account;
}

export async function sendBaseUSDCPayment(): Promise<string> {
  const provider = getEthereum();
  if (!provider) {
    throw new Error(
      "No compatible wallet found. Please install a Base-compatible wallet and reload."
    );
  }

  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];

  const account = accounts?.[0];
  if (!account) {
    throw new Error("No connected wallet account.");
  }

  await ensureBaseChain(provider);
  const data = abiEncodeTransfer(SETTLEMENT_WALLET, USDC_ATOMIC_AMOUNT);

  const txHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: account,
        to: USDC_CONTRACT,
        data,
      },
    ],
  })) as string;

  if (
    typeof txHash !== "string" ||
    txHash.length !== 66 ||
    !txHash.startsWith("0x")
  ) {
    throw new Error("Invalid transaction hash from wallet.");
  }

  return txHash;
}

export function getBaseUsdcDisplayAmount(): string {
  return "1.00";
}
