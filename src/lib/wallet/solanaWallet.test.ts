import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sendSolanaUSDCPayment } from "./solanaWallet";

const FIXED_PUBLIC_KEY = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FIXED_DESTINATION = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const FIXED_BLOCKHASH = "Blockhash111111111111111111111111111111111111111";
const FIXED_LAST_VALID_BLOCK_HEIGHT = 123456789;
const FIXED_SIGNATURE = "TxSignature1111111111111111111111111111111111111111111111111111111111111";

function buildSignAndSendTransaction() {
  return vi.fn().mockResolvedValue({
    signature: FIXED_SIGNATURE,
  });
}

describe("sendSolanaUSDCPayment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests blockhash from /api/solana/blockhash and signs transaction", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = global.fetch as unknown as typeof vi.fn;

    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/solana/blockhash") {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              blockhash: FIXED_BLOCKHASH,
              lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT,
            }),
        } as unknown as Response;
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
      } as unknown as Response;
    });

    const signature = await sendSolanaUSDCPayment({
      destination: FIXED_DESTINATION,
      amountAtomic: "1000000",
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
      getSignatureStatus: async () => ({ confirmationStatus: "confirmed" }),
    });

    expect(signature).toBe(FIXED_SIGNATURE);
    expect(fetchMock).toHaveBeenCalledWith("/api/solana/blockhash", expect.anything());
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("requests a fresh blockhash on each payment attempt", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = global.fetch as unknown as typeof vi.fn;
    let blockhashCallCount = 0;

    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/solana/blockhash") {
        blockhashCallCount += 1;
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              blockhash: `${FIXED_BLOCKHASH}-${blockhashCallCount}`,
              lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT + blockhashCallCount,
            }),
        } as unknown as Response;
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
      } as unknown as Response;
    });

    const firstSignature = await sendSolanaUSDCPayment({
      destination: FIXED_DESTINATION,
      amountAtomic: "1000000",
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
      getSignatureStatus: async () => ({ confirmationStatus: "confirmed" }),
    });

    expect(firstSignature).toBe(FIXED_SIGNATURE);

    const secondSignature = await sendSolanaUSDCPayment({
      destination: FIXED_DESTINATION,
      amountAtomic: "1000000",
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
      getSignatureStatus: async () => ({ confirmationStatus: "confirmed" }),
    });

    expect(secondSignature).toBe(FIXED_SIGNATURE);

    const fetchCalls = fetchMock.mock.calls;
    const blockhashCalls = fetchCalls.filter(
      ([url]) => url === "/api/solana/blockhash"
    );

    expect(blockhashCalls).toHaveLength(2);
    expect(signAndSendTransaction).toHaveBeenCalledTimes(2);
  });

  it("returns exact signature when provider signature is confirmed", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = global.fetch as unknown as typeof vi.fn;

    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          blockhash: FIXED_BLOCKHASH,
          lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT,
        }),
    } as unknown as Response);

    const signature = await sendSolanaUSDCPayment({
      destination: FIXED_DESTINATION,
      amountAtomic: "1000000",
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
      getSignatureStatus: async () => ({ confirmationStatus: "confirmed" }),
    });

    expect(signature).toBe(FIXED_SIGNATURE);
  });

  it("throws when signature status reports a transaction error", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = global.fetch as unknown as typeof vi.fn;

    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          blockhash: FIXED_BLOCKHASH,
          lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT,
        }),
    } as unknown as Response);

    await expect(
      sendSolanaUSDCPayment({
        destination: FIXED_DESTINATION,
        amountAtomic: "1000000",
        publicKey: FIXED_PUBLIC_KEY,
        signAndSendTransaction,
        getSignatureStatus: async () => ({ confirmationStatus: "confirmed", err: "SomeTxError" }),
      })
    ).rejects.toThrow("Transaction failed");

    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws when confirmation lookup fails", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = global.fetch as unknown as typeof vi.fn;

    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          blockhash: FIXED_BLOCKHASH,
          lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT,
        }),
    } as unknown as Response);

    await expect(
      sendSolanaUSDCPayment({
        destination: FIXED_DESTINATION,
        amountAtomic: "1000000",
        publicKey: FIXED_PUBLIC_KEY,
        signAndSendTransaction,
        getSignatureStatus: async () => {
          throw new Error("rpc-down");
        },
      })
    ).rejects.toThrow("Transaction status lookup failed.");
  });

  it("returns exact signature when getSignatureStatus is absent", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = global.fetch as unknown as typeof vi.fn;

    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          blockhash: FIXED_BLOCKHASH,
          lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT,
        }),
    } as unknown as Response);

    const signature = await sendSolanaUSDCPayment({
      destination: FIXED_DESTINATION,
      amountAtomic: "1000000",
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    expect(signature).toBe(FIXED_SIGNATURE);
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
  });
});
