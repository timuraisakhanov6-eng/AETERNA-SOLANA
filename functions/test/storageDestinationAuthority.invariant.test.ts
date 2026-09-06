/**
 * Exact Irys payment destination authority — verifier regression.
 *
 * Canonical rule: the on-chain token recipient MUST be exactly the
 * expected Irys destination for the expected USDC mint. Any fallback
 * to another owner/balance holder is forbidden — payments to a
 * different destination fail closed (DESTINATION_MISMATCH).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const NOW = 1_800_000_000_000;

const PAYER = "PayerWalletAccount11111111111111111111111111111";
const IRYS_DESTINATION = "IrysDestinationAccount333333333333333333333";
const OTHER_DESTINATION = "OtherDestinationAccount4444444444444444444";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SIGNATURE = "S".repeat(88);

interface TokenBalance {
  owner: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

function tokenBalance(owner: string, amount: string): TokenBalance {
  return { owner, mint: TOKEN_MINT, uiTokenAmount: { amount } };
}

let txResult: Record<string, unknown> | null = null;
let rpcCallCount = 0;

function stubRpc() {
  const routing = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === RPC_URL) {
      rpcCallCount += 1;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: txResult }),
        { status: 200 }
      );
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", routing);
  return routing;
}

function tx(opts: {
  payer?: string;
  pre?: TokenBalance[];
  post?: TokenBalance[];
  err?: unknown;
}) {
  return {
    slot: 123,
    blockTime: NOW / 1000,
    result: {
      err: opts.err ?? null,
      transaction: { message: { accountKeys: [opts.payer ?? PAYER, IRYS_DESTINATION] } },
      meta: {
        preTokenBalances: opts.pre ?? [],
        postTokenBalances: opts.post ?? [],
      },
    },
  };
}

async function verify() {
  const { verifySolanaUsdcStoragePayment } = await import(
    "./../lib/storage/solanaUsdcVerifier"
  );
  return verifySolanaUsdcStoragePayment({
    rpcUrl: RPC_URL,
    transactionSignature: SIGNATURE,
    expectedPayer: PAYER,
    expectedMint: TOKEN_MINT,
    expectedAmountAtomic: "1000000",
    expectedDestination: IRYS_DESTINATION,
  });
}

describe("Exact Irys payment destination authority", () => {
  beforeEach(() => {
    txResult = null;
    rpcCallCount = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A. exact destination + correct payer + exact amount → VERIFIED", async () => {
    txResult = tx({
      pre: [tokenBalance(PAYER, "2000000")],
      post: [tokenBalance(PAYER, "1000000"), tokenBalance(IRYS_DESTINATION, "1000000")],
    });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(true);
  });

  it("B. wrong destination (no exact destination balance) → DESTINATION_MISMATCH", async () => {
    txResult = tx({
      pre: [tokenBalance(PAYER, "2000000")],
      post: [tokenBalance(PAYER, "1000000"), tokenBalance(OTHER_DESTINATION, "1000000")],
    });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DESTINATION_MISMATCH");
  });

  it("C. another owner holding the same USDC does not satisfy the destination", async () => {
    // Post balances contain OTHER destination with exact amount + the
    // payer's USDC account — no exact Irys destination anywhere.
    txResult = tx({
      pre: [tokenBalance(PAYER, "2000000")],
      post: [
        tokenBalance(PAYER, "1000000"),
        tokenBalance(OTHER_DESTINATION, "1000000"),
        tokenBalance("ThirdOwnerAccount55555555555555555555555555", "500000"),
      ],
    });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DESTINATION_MISMATCH");
  });

  it("D. no token balance for the exact destination → FAIL", async () => {
    txResult = tx({ pre: [tokenBalance(PAYER, "1000000")], post: [tokenBalance(PAYER, "1000000")] });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DESTINATION_MISMATCH");
  });

  it("E. correct destination + wrong payer → PAYER_MISMATCH", async () => {
    txResult = tx({
      payer: OTHER_WALLET(),
      pre: [tokenBalance(OTHER_WALLET(), "2000000")],
      post: [tokenBalance(OTHER_WALLET(), "1000000"), tokenBalance(IRYS_DESTINATION, "1000000")],
    });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PAYER_MISMATCH");
  });

  it("F. correct destination + wrong amount → AMOUNT_MISMATCH", async () => {
    txResult = tx({
      pre: [tokenBalance(PAYER, "3000000")],
      post: [tokenBalance(PAYER, "1000000"), tokenBalance(IRYS_DESTINATION, "2000000")],
    });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AMOUNT_MISMATCH");
  });

  it("G. correct destination + wrong mint → FAIL", async () => {
    const WRONG_MINT = "WrongMint999999999999999999999999999999999999";
    txResult = tx({
      pre: [{ owner: PAYER, mint: WRONG_MINT, uiTokenAmount: { amount: "2000000" } }],
      post: [
        { owner: PAYER, mint: WRONG_MINT, uiTokenAmount: { amount: "1000000" } },
        { owner: IRYS_DESTINATION, mint: WRONG_MINT, uiTokenAmount: { amount: "1000000" } },
      ],
    });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(false);
  });

  it("H. destination balance for the exact owner under a DIFFERENT mint does not count", async () => {
    const WRONG_MINT = "WrongMint999999999999999999999999999999999999";
    txResult = tx({
      pre: [tokenBalance(PAYER, "1000000")],
      post: [
        tokenBalance(PAYER, "1000000"),
        { owner: IRYS_DESTINATION, mint: WRONG_MINT, uiTokenAmount: { amount: "1000000" } },
      ],
    });
    stubRpc();
    const result = await verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DESTINATION_MISMATCH");
  });
});

function OTHER_WALLET(): string {
  return "OtherWalletAccount222222222222222222222222222";
}
