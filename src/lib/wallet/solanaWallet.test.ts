import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
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

/**
 * REQUIRED callback contract (latent-defect regression).
 *
 * The module previously had an unreachable fallback that referenced an
 * undefined `connection` symbol (ReferenceError if ever reached). The
 * fallback is removed and `signAndSendTransaction` is now REQUIRED:
 *   - the valid callback path still signs and sends;
 *   - a missing callback is rejected with an explicit typed error, and the
 *     guard fires BEFORE any network work (fail-closed, never ReferenceError);
 *   - the source contains no reference to `connection` and no browser RPC.
 */
describe("sendSolanaUSDCPayment — required signAndSendTransaction contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("valid callback path still sends the transaction and returns its signature", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    // Locally-typed mock (no weak vi.fn cast) so this test adds no new type
    // errors.
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          ok: true,
          blockhash: FIXED_BLOCKHASH,
          lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT,
        }),
      }) as unknown as Response
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const signature = await sendSolanaUSDCPayment({
      destination: FIXED_DESTINATION,
      amountAtomic: "1000000",
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    expect(signature).toBe(FIXED_SIGNATURE);
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
    // The callback receives the assembled transaction object.
    expect(signAndSendTransaction.mock.calls[0]?.[0]).toBeTruthy();
  });

  it("rejects a missing callback explicitly — typed error, never ReferenceError, no network work", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await sendSolanaUSDCPayment({
        destination: FIXED_DESTINATION,
        amountAtomic: "1000000",
        publicKey: FIXED_PUBLIC_KEY,
        signAndSendTransaction: undefined as never,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).not.toBe("ReferenceError");
    expect((caught as Error).message).toContain(
      "signAndSendTransaction is required"
    );
    // Fail-closed BEFORE any transaction is built or any request is made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("source contains no reference to an undefined `connection` and no browser RPC", () => {
    const src = readFileSync(
      new URL("./solanaWallet.ts", import.meta.url),
      "utf8"
    );

    // No identifier access to `connection` (the old broken fallback).
    expect(src).not.toMatch(/\bconnection\s*\./);
    // No raw send / no self-opened RPC connection.
    expect(src).not.toContain("sendRawTransaction");
    expect(src).not.toMatch(/new\s+Connection\s*\(/);
  });
});
