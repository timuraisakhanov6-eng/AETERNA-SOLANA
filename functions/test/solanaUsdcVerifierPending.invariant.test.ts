/**
 * AETERNA — storage USDC verifier: signature shape + PENDING distinction.
 *
 * A payment that the chain knows about but the RPC provider cannot yet serve
 * from `getTransaction` used to surface as TRANSACTION_NOT_FOUND, which read as
 * "this payment does not exist" and stranded a real, finalized payment. The
 * verifier now cross-checks `getSignatureStatuses` and reports
 * TRANSACTION_PENDING instead — still a rejection, but one the client may
 * retry (verification only).
 *
 * The shared `functions/lib/solana/rpc.ts` helper is mocked so these tests are
 * deterministic and never touch the network or the chain.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const getSolanaTransactionMock = vi.fn();
const solanaJsonRpcMock = vi.fn();

vi.mock("./../lib/solana/rpc", () => ({
  getSolanaTransaction: (...args: unknown[]) =>
    getSolanaTransactionMock(...(args as [])),
  solanaJsonRpc: (...args: unknown[]) => solanaJsonRpcMock(...(args as [])),
}));

import { verifySolanaUsdcStoragePayment } from "./../lib/storage/solanaUsdcVerifier";

const RPC_URL = "https://rpc.internal.invalid";

// A real-shaped Solana signature: base58, 87 chars (excludes 0 O I l).
const VALID_SIGNATURE =
  "3ET8Mg8axvZNgkwPDyGv9XDa5PonogHZTmESV8f7CcEsZhnZm5s67qk92Xtkezd3XNYvDNbLBaoP8p8bQSszZBTi";

const PAYER = "5doR6H8Ln328vtNG6ncr31BzxAAV3NtDdrY3JPbBHjFk";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DESTINATION = "9NERQjLetzquGwdKt3X4gZ8fE8fPfSkj2xo2esmUjWsz";

function input(signature: string) {
  return {
    rpcUrl: RPC_URL,
    transactionSignature: signature,
    expectedPayer: PAYER,
    expectedMint: MINT,
    expectedAmountAtomic: "235",
    expectedDestination: DESTINATION,
  };
}

beforeEach(() => {
  getSolanaTransactionMock.mockReset();
  solanaJsonRpcMock.mockReset();
});

describe("verifySolanaUsdcStoragePayment — signature shape", () => {
  it("A. rejects a malformed signature as INVALID_SIGNATURE without any RPC call", async () => {
    const malformed = [
      "3ET8Mg8axzNGkwPDyGv9XDa5PonogHZTmESV8f7CcEsZhnZm5s67qk92Xtkedz3XNYvDNLBaOp8p8Q5zBTI", // 83 chars + O/I
      "0OIl", // non-base58
      VALID_SIGNATURE.slice(0, 64), // truncated
      VALID_SIGNATURE.toUpperCase(), // case-mangled (contains O/I after upper)
      "",
    ];

    for (const signature of malformed) {
      const result = await verifySolanaUsdcStoragePayment(input(signature));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("INVALID_SIGNATURE");
      }
    }

    expect(getSolanaTransactionMock).not.toHaveBeenCalled();
    expect(solanaJsonRpcMock).not.toHaveBeenCalled();
  });
});

describe("verifySolanaUsdcStoragePayment — real helper return shape", () => {
  /**
   * `solanaJsonRpc()` unwraps the JSON-RPC envelope (`return data.result`), so
   * `getSolanaTransaction()` resolves to the TRANSACTION OBJECT — never
   * `{ result: {...} }`.
   *
   * The verifier previously read `transaction.result`, which type-checked
   * against an envelope-shaped interface but was always `undefined` at runtime,
   * so EVERY storage verification failed closed. These tests pin the real shape
   * and would fail if that indirection were reintroduced.
   */

  /** Exactly the shape production returned for the historical signature. */
  function canonicalTransaction() {
    return {
      slot: 449753313,
      blockTime: 1789747795,
      transaction: {
        message: {
          accountKeys: [
            { pubkey: PAYER, signer: true },
            { pubkey: "5pmqr29Bx7FtK1BVPFirwWj4aggdjMmYFvw5CTySh5Zj", signer: false },
          ],
        },
      },
      meta: {
        err: null,
        preTokenBalances: [
          {
            owner: DESTINATION,
            mint: MINT,
            uiTokenAmount: { amount: "603997844", decimals: 6 },
          },
          {
            owner: PAYER,
            mint: MINT,
            uiTokenAmount: { amount: "2161253", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            owner: DESTINATION,
            mint: MINT,
            uiTokenAmount: { amount: "603998079", decimals: 6 },
          },
          {
            owner: PAYER,
            mint: MINT,
            uiTokenAmount: { amount: "2161018", decimals: 6 },
          },
        ],
      },
    };
  }

  it("accepts a canonical transaction in the real (unwrapped) shape", async () => {
    getSolanaTransactionMock.mockResolvedValue(canonicalTransaction());

    const result = await verifySolanaUsdcStoragePayment(
      input(VALID_SIGNATURE)
    );

    // Passes signature validation AND payer/amount/mint/destination matching.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payer).toBe(PAYER);
      expect(result.amountAtomic).toBe("235");
      expect(result.mint).toBe(MINT);
      expect(result.destination).toBe(DESTINATION);
      expect(result.slot).toBe(449753313);
    }

    // No statuses fallback was needed — the transaction itself was used.
    expect(solanaJsonRpcMock).not.toHaveBeenCalled();
  });

  it("does not treat a `{ result: … }` envelope as a transaction", async () => {
    // The old (wrong) assumption: an envelope wrapper. The verifier must NOT
    // read through it — the helper never produces this shape.
    getSolanaTransactionMock.mockResolvedValue({
      result: canonicalTransaction(),
    });
    solanaJsonRpcMock.mockResolvedValue({ value: [null] });

    const result = await verifySolanaUsdcStoragePayment(
      input(VALID_SIGNATURE)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // No usable accountKeys through the wrapper -> fails closed.
      expect(result.reason).toBe("MALFORMED_TRANSACTION");
    }
  });

  it("still enforces every matching rule on the real shape", async () => {
    const cases: Array<[string, (tx: ReturnType<typeof canonicalTransaction>) => void, string]> = [
      [
        "payer",
        (tx) => {
          tx.transaction.message.accountKeys[0] = {
            pubkey: "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu",
            signer: true,
          };
        },
        "PAYER_MISMATCH",
      ],
      [
        "destination",
        (tx) => {
          tx.meta.postTokenBalances[0].owner =
            "AwCJWRPbZQLAfyCVD9GcMMA2cERmGfvUSog1Bv8pqdHv";
        },
        "DESTINATION_MISMATCH",
      ],
      [
        "mint",
        (tx) => {
          tx.meta.postTokenBalances[0].mint =
            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        },
        "DESTINATION_MISMATCH",
      ],
      [
        "amount",
        (tx) => {
          tx.meta.postTokenBalances[1].uiTokenAmount.amount = "2161019";
        },
        "AMOUNT_MISMATCH",
      ],
    ];

    for (const [label, mutate, expected] of cases) {
      const tx = canonicalTransaction();
      mutate(tx);
      getSolanaTransactionMock.mockResolvedValue(tx);

      const result = await verifySolanaUsdcStoragePayment(
        input(VALID_SIGNATURE)
      );

      expect(result.ok, `${label} must be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.reason, label).toBe(expected);
      }
    }
  });

  it("reports TRANSACTION_FAILED for a failed on-chain transaction", async () => {
    const tx = canonicalTransaction();
    (tx.meta as { err: unknown }).err = { InstructionError: [0, "Custom"] };
    getSolanaTransactionMock.mockResolvedValue(tx);

    const result = await verifySolanaUsdcStoragePayment(
      input(VALID_SIGNATURE)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("TRANSACTION_FAILED");
    }
  });
});

describe("verifySolanaUsdcStoragePayment — null lookup distinction", () => {
  it("B. getTransaction null + signature status present -> TRANSACTION_PENDING", async () => {
    getSolanaTransactionMock.mockResolvedValue(null);
    solanaJsonRpcMock.mockResolvedValue({
      value: [
        {
          slot: 449753313,
          err: null,
          confirmationStatus: "finalized",
        },
      ],
    });

    const result = await verifySolanaUsdcStoragePayment(
      input(VALID_SIGNATURE)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("TRANSACTION_PENDING");
    }

    // The cross-check uses the history-searching variant.
    expect(solanaJsonRpcMock).toHaveBeenCalledTimes(1);
    expect(solanaJsonRpcMock.mock.calls[0]![1]).toBe("getSignatureStatuses");
    expect(solanaJsonRpcMock.mock.calls[0]![2]).toEqual([
      [VALID_SIGNATURE],
      { searchTransactionHistory: true },
    ]);
  });

  it("C. getTransaction null + signature status absent -> TRANSACTION_NOT_FOUND", async () => {
    getSolanaTransactionMock.mockResolvedValue(null);
    solanaJsonRpcMock.mockResolvedValue({ value: [null] });

    const result = await verifySolanaUsdcStoragePayment(
      input(VALID_SIGNATURE)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("TRANSACTION_NOT_FOUND");
    }
  });

  it("fails closed to TRANSACTION_NOT_FOUND when the status cross-check errors", async () => {
    getSolanaTransactionMock.mockResolvedValue(null);
    solanaJsonRpcMock.mockRejectedValue(new Error("RPC_HTTP_ERROR_429"));

    const result = await verifySolanaUsdcStoragePayment(
      input(VALID_SIGNATURE)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("TRANSACTION_NOT_FOUND");
    }
  });
});
