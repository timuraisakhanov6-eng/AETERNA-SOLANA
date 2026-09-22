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

/** Canonical on-chain constants the payment MUST keep using. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SETTLEMENT_WALLET = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";
const SETTLEMENT_USDC_ATA = "76vsLfHBGR5pHAMFeT9KwuB1HB4gKmPYhC7fpvs3h58Y";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const TOKEN_ACCOUNT_PATH = "/api/solana/token-account";
const BLOCKHASH_PATH = "/api/solana/blockhash";

/** Minimal structural view of a built Transaction (no `any`). */
interface InstructionView {
  programId: { toBase58(): string };
  keys: { pubkey: { toBase58(): string } }[];
  data: Uint8Array;
}
interface TransactionView {
  instructions: InstructionView[];
}

function readTransaction(tx: unknown): TransactionView {
  return tx as TransactionView;
}

function decodeTransferAmount(instruction: InstructionView): bigint {
  const view = new DataView(
    instruction.data.buffer,
    instruction.data.byteOffset,
    instruction.data.byteLength
  );
  return view.getBigUint64(1, true);
}

function isAtaCreateInstruction(instruction: InstructionView): boolean {
  return instruction.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM;
}

function isTransferInstruction(instruction: InstructionView): boolean {
  return (
    instruction.programId.toBase58() === TOKEN_PROGRAM &&
    instruction.data[0] === 3
  );
}

/**
 * Routes the two server proxies the payment uses. `destinationAtaExists`
 * drives the ATA-existence answer; everything else mirrors the canonical
 * blockhash response.
 */
function buildFetchImplementation(options: {
  destinationAtaExists: boolean;
  blockhash?: string;
  lastValidBlockHeight?: number;
}) {
  return async (input: unknown): Promise<Response> => {
    const url = String(input);

    if (url.startsWith(TOKEN_ACCOUNT_PATH)) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          exists: options.destinationAtaExists,
          owner: null,
        }),
      } as unknown as Response;
    }

    if (url === BLOCKHASH_PATH) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          blockhash: options.blockhash ?? FIXED_BLOCKHASH,
          lastValidBlockHeight:
            options.lastValidBlockHeight ?? FIXED_LAST_VALID_BLOCK_HEIGHT,
        }),
      } as unknown as Response;
    }

    return { ok: true, json: async () => ({}) } as unknown as Response;
  };
}

/**
 * Installs a properly-typed fetch mock.
 *
 * `global.fetch as unknown as typeof vi.fn` loses the Mock type, so `.mock`
 * and `.mockImplementation` degrade to untyped/erroring access. Going through
 * `vi.fn(implementation)` keeps the call history and assertions type-checked.
 */
function installFetchMock(
  implementation: (input: unknown) => Promise<Response>
) {
  const mock = vi.fn(implementation);
  global.fetch = mock as unknown as typeof fetch;
  return mock;
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
    const fetchMock = installFetchMock(
      buildFetchImplementation({ destinationAtaExists: true })
    );

    const signature = await sendSolanaUSDCPayment({
      destination: FIXED_DESTINATION,
      amountAtomic: "1000000",
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
      getSignatureStatus: async () => ({ confirmationStatus: "confirmed" }),
    });

    expect(signature).toBe(FIXED_SIGNATURE);
    expect(fetchMock).toHaveBeenCalledWith(BLOCKHASH_PATH, expect.anything());
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("requests a fresh blockhash on each payment attempt", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    let blockhashCallCount = 0;

    const fetchMock = installFetchMock(async (input: unknown) => {
      const url = String(input)

      if (url.startsWith(TOKEN_ACCOUNT_PATH)) {
        return {
          ok: true,
          json: async () => ({ ok: true, exists: true, owner: null }),
        } as unknown as Response;
      }

      if (url === BLOCKHASH_PATH) {
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
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: true })
    );

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
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: true })
    );

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
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: true })
    );

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
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: true })
    );

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
    const fetchMock = vi.fn(
      buildFetchImplementation({ destinationAtaExists: true })
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

/**
 * Settlement USDC ATA provisioning.
 *
 * The settlement wallet's USDC associated token account may not exist yet. An
 * SPL Token `Transfer` into a non-existent token account cannot be simulated
 * or executed, so wallets refuse to sign. The account must therefore be
 * created in the SAME atomic transaction — and ONLY when it is absent, since
 * an unconditional create fails once the account exists.
 *
 * These tests use the DEFAULT destination/amount so they pin the canonical
 * settlement wallet, mint, ATA and 1 USDC amount.
 */
describe("sendSolanaUSDCPayment — settlement ATA provisioning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A: missing settlement ATA -> ATA creation instruction precedes the transfer, in ONE transaction", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: false })
    );

    const signature = await sendSolanaUSDCPayment({
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    expect(signature).toBe(FIXED_SIGNATURE);

    // ONE atomic transaction, ONE wallet send.
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);

    const tx = readTransaction(signAndSendTransaction.mock.calls[0]?.[0]);
    expect(tx.instructions).toHaveLength(2);
    // Order matters: create the account, then move the funds.
    expect(isAtaCreateInstruction(tx.instructions[0]!)).toBe(true);
    expect(isTransferInstruction(tx.instructions[1]!)).toBe(true);
  });

  it("B: existing settlement ATA -> NO ATA creation instruction", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: true })
    );

    await sendSolanaUSDCPayment({
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    const tx = readTransaction(signAndSendTransaction.mock.calls[0]?.[0]);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions.some(isAtaCreateInstruction)).toBe(false);
    expect(isTransferInstruction(tx.instructions[0]!)).toBe(true);
  });

  it("C: the transfer is exactly 1 USDC (1_000_000 atomic units)", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: false })
    );

    await sendSolanaUSDCPayment({
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    const tx = readTransaction(signAndSendTransaction.mock.calls[0]?.[0]);
    const transfer = tx.instructions.find(isTransferInstruction);

    expect(transfer).toBeTruthy();
    expect(decodeTransferAmount(transfer!)).toBe(1_000_000n);
  });

  it("D: canonical USDC mint and settlement recipient are unchanged", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    installFetchMock(
      buildFetchImplementation({ destinationAtaExists: false })
    );

    await sendSolanaUSDCPayment({
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    const tx = readTransaction(signAndSendTransaction.mock.calls[0]?.[0]);
    const transfer = tx.instructions.find(isTransferInstruction)!;
    const ataCreate = tx.instructions.find(isAtaCreateInstruction)!;

    // Transfer destination is the settlement wallet's USDC ATA.
    expect(transfer.keys[1]!.pubkey.toBase58()).toBe(SETTLEMENT_USDC_ATA);

    // The ATA being created is owned by the settlement wallet, for USDC.
    const ataKeys = ataCreate.keys.map((k) => k.pubkey.toBase58());
    expect(ataKeys).toContain(SETTLEMENT_WALLET);
    expect(ataKeys).toContain(USDC_MINT);
    expect(ataKeys).toContain(SETTLEMENT_USDC_ATA);
  });

  it("E/F: exactly one atomic transaction through signAndSendTransaction only", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = installFetchMock(
      buildFetchImplementation({ destinationAtaExists: false })
    );

    await sendSolanaUSDCPayment({
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    // One send call, one Transaction object, both instructions inside it.
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
    const sent = signAndSendTransaction.mock.calls[0]?.[0];
    expect(sent).toBeTruthy();
    expect(readTransaction(sent).instructions).toHaveLength(2);

    // The ATA check and the blockhash both went through the server proxies.
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u === BLOCKHASH_PATH)).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith(TOKEN_ACCOUNT_PATH))).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith(TOKEN_ACCOUNT_PATH))[0]).toContain(
      SETTLEMENT_USDC_ATA
    );
  });

  it("fail-closed: an inconclusive ATA check aborts before any transaction is built or sent", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = installFetchMock(async (input: unknown) => {
      if (String(input).startsWith(TOKEN_ACCOUNT_PATH)) {
        return {
          ok: false,
          json: async () => ({ ok: false, error: "RPC_UNAVAILABLE" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as unknown as Response;
    });

    await expect(
      sendSolanaUSDCPayment({
        publicKey: FIXED_PUBLIC_KEY,
        signAndSendTransaction,
      })
    ).rejects.toThrow("RPC_UNAVAILABLE");

    expect(signAndSendTransaction).not.toHaveBeenCalled();
    // The blockhash proxy is never reached — nothing was built.
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).not.toContain(BLOCKHASH_PATH);
  });

  it("fail-closed: a malformed ATA check response aborts the payment", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    installFetchMock(async (input: unknown) => {
      if (String(input).startsWith(TOKEN_ACCOUNT_PATH)) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as unknown as Response;
    });

    await expect(
      sendSolanaUSDCPayment({
        publicKey: FIXED_PUBLIC_KEY,
        signAndSendTransaction,
      })
    ).rejects.toThrow("Invalid token account response.");

    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });
});
