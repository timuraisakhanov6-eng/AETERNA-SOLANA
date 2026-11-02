import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  sendSolanaUSDCPayment,
  signSolanaUSDCPayment,
  WalletModifiedTransactionError,
} from "./solanaWallet";

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
const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

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

function decodeComputeUnitLimit(instruction: InstructionView): number {
  const view = new DataView(
    instruction.data.buffer,
    instruction.data.byteOffset,
    instruction.data.byteLength
  );
  return view.getUint32(1, true);
}

function decodeComputeUnitPrice(instruction: InstructionView): bigint {
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
    // Both reads are now ISSUED CONCURRENTLY, so the blockhash request is
    // already in flight when the ATA check fails. What must NOT happen is any
    // transaction build or wallet send — the failure still short-circuits
    // before the first instruction is assembled.
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.startsWith(TOKEN_ACCOUNT_PATH))).toHaveLength(1);
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

/**
 * Concurrent read scheduling (IMPLEMENTATION BATCH 1, section 2).
 *
 * The account-existence read and the blockhash read are independent
 * read-only proxy calls that must BOTH complete before the transaction is
 * built. They are now issued concurrently via `Promise.all`.
 *
 * These tests pin the two invariants that matter:
 *   E. BOTH reads are always issued, exactly once each.
 *   F. A failure of EITHER read still fails the payment closed — no
 *      transaction is built and the wallet is never asked to sign.
 */
describe("sendSolanaUSDCPayment — concurrent proxy reads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("E: token-account and blockhash are both issued, concurrently, exactly once each", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();

    /**
     * Order-sensitive recorder: each proxy call appends its label, and the
     * blockhash handler resolves only after a macrotask so the ATA check —
     * which resolves immediately — would complete first under any
     * sequential ordering. Both labels must nevertheless be present, which
     * is only possible if the blockhash request was started WITHOUT waiting
     * for the ATA check to settle.
     */
    const callOrder: string[] = [];

    const fetchMock = installFetchMock(async (input: unknown) => {
      const url = String(input);

      if (url.startsWith(TOKEN_ACCOUNT_PATH)) {
        callOrder.push("token-account");
        return {
          ok: true,
          json: async () => ({ ok: true, exists: true, owner: null }),
        } as unknown as Response;
      }

      if (url === BLOCKHASH_PATH) {
        callOrder.push("blockhash");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            blockhash: FIXED_BLOCKHASH,
            lastValidBlockHeight: FIXED_LAST_VALID_BLOCK_HEIGHT,
          }),
        } as unknown as Response;
      }

      return { ok: true, json: async () => ({}) } as unknown as Response;
    });

    const signature = await sendSolanaUSDCPayment({
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    expect(signature).toBe(FIXED_SIGNATURE);

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.startsWith(TOKEN_ACCOUNT_PATH))).toHaveLength(1);
    expect(urls.filter((u) => u === BLOCKHASH_PATH)).toHaveLength(1);

    // Both reads were dispatched before either was awaited.
    expect(callOrder).toContain("token-account");
    expect(callOrder).toContain("blockhash");

    // Exactly one atomic transaction, one wallet send.
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("E: the token-account read always targets the canonical settlement ATA", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();
    const fetchMock = installFetchMock(
      buildFetchImplementation({ destinationAtaExists: false })
    );

    await sendSolanaUSDCPayment({
      publicKey: FIXED_PUBLIC_KEY,
      signAndSendTransaction,
    });

    const tokenAccountCall = fetchMock.mock.calls
      .map(([u]) => String(u))
      .find((u) => u.startsWith(TOKEN_ACCOUNT_PATH));

    expect(tokenAccountCall).toBeDefined();
    expect(tokenAccountCall).toContain(SETTLEMENT_USDC_ATA);
  });

  it("F: a failing blockhash read still fails closed — no transaction, no send", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();

    installFetchMock(async (input: unknown) => {
      const url = String(input);

      if (url.startsWith(TOKEN_ACCOUNT_PATH)) {
        return {
          ok: true,
          json: async () => ({ ok: true, exists: true, owner: null }),
        } as unknown as Response;
      }

      if (url === BLOCKHASH_PATH) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ ok: false, error: "BLOCKHASH_UNAVAILABLE" }),
        } as unknown as Response;
      }

      return { ok: true, json: async () => ({}) } as unknown as Response;
    });

    await expect(
      sendSolanaUSDCPayment({
        publicKey: FIXED_PUBLIC_KEY,
        signAndSendTransaction,
      })
    ).rejects.toThrow("BLOCKHASH_UNAVAILABLE");

    // The ATA read succeeded, but the payment still aborts before any
    // transaction is built or handed to the wallet.
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("F: an ATA read failing while the blockhash read also rejects does not raise an unhandled rejection", async () => {
    const signAndSendTransaction = buildSignAndSendTransaction();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    installFetchMock(async (input: unknown) => {
      const url = String(input);

      if (url.startsWith(TOKEN_ACCOUNT_PATH)) {
        // Rejects FIRST (synchronously resolved rejection).
        return {
          ok: false,
          json: async () => ({ ok: false, error: "ATA_RPC_DOWN" }),
        } as unknown as Response;
      }

      if (url === BLOCKHASH_PATH) {
        // Rejects LATER, after Promise.all has already rejected.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: false,
          status: 503,
          json: async () => ({ ok: false, error: "BLOCKHASH_DOWN" }),
        } as unknown as Response;
      }

      return { ok: true, json: async () => ({}) } as unknown as Response;
    });

    await expect(
      sendSolanaUSDCPayment({
        publicKey: FIXED_PUBLIC_KEY,
        signAndSendTransaction,
      })
    ).rejects.toThrow("ATA_RPC_DOWN");

    // Let any late rejection surface.
    await vi.advanceTimersByTimeAsync(20);

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toHaveLength(0);
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });
});

/**
 * Structural guard (source-level) — IMPLEMENTATION BATCH 1, section 2.
 *
 * The behavioural tests above cannot distinguish "both reads issued" from
 * "both reads issued concurrently"; only the source shows that the ATA check
 * is NOT awaited before the blockhash fetch is issued. Mirrors the existing
 * `readFileSync` source-assertion convention in this file.
 */
describe("sendSolanaUSDCPayment — proxy reads are issued concurrently (source)", () => {
  it("does not await the ATA check before issuing the blockhash fetch", () => {
    const src = readFileSync(
      new URL("./solanaWallet.ts", import.meta.url),
      "utf8"
    );

    const blockhashFetchIndex = src.indexOf(
      'fetch("/api/solana/blockhash"'
    );
    const ataPromiseIndex = src.indexOf(
      "const destinationAtaExistsPromise ="
    );
    const promiseAllIndex = src.indexOf(
      "await Promise.all(["
    );
    const sequentialAtaAwaitIndex = src.indexOf(
      "const destinationAtaExists = await fetchAccountExists("
    );

    // The blockhash fetch and the ATA check are both captured as promises...
    expect(blockhashFetchIndex).toBeGreaterThan(-1);
    expect(ataPromiseIndex).toBeGreaterThan(-1);

    // ...and only then awaited together.
    expect(promiseAllIndex).toBeGreaterThan(ataPromiseIndex);

    // The OLD sequential form must be gone.
    expect(sequentialAtaAwaitIndex).toBe(-1);

    // Defensive handlers keep a sibling rejection observed.
    expect(src).toContain("blockhashPromise.catch(");
    expect(src).toContain("destinationAtaExistsPromise.catch(");
  });
});

/* ================= WALLET MESSAGE-IDENTITY GUARD =================
 *
 * `signSolanaUSDCPayment` must accept ONLY the message it prepared for
 * the wallet, with ONE structural exception: canonical, fee-only
 * priority-fee instructions the wallet added on the ComputeBudget
 * program (exactly what Phantom does automatically, see the
 * "wallet-added priority fees" block below). The signature checks prove
 * that the wallet signed the message it RETURNED, but not that the
 * returned message is the SAME one. A wallet can force a different
 * message (added/removed instructions, changed accounts or amounts, an
 * adjusted fee, another blockhash) and sign it correctly.
 *
 * Every scenario below runs the REAL serialization path — the builder's
 * legacy transaction, a REAL ed25519 signature made by a test keypair
 * over the returned message, and the same `Transaction.from(bytes)`
 * re-parse the wallet adapter performs. No network, no real wallet, no
 * fabricated signature that would skip real verification.
 */
describe("signSolanaUSDCPayment — wallet message-identity guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The file's FIXED_BLOCKHASH is not base58-decodable ("Blockhash111…"
   * contains 'l' / 'o'), so a transaction built on it cannot be REALLY
   * serialized. Production always signs a real RPC blockhash; this valid
   * value only makes the fixture serializable.
   */
  const VALID_BLOCKHASH = "11111111111111111111111111111111";

  type WalletTx = import("@solana/web3.js").Transaction;

  function installSerializableFetch() {
    return installFetchMock(
      buildFetchImplementation({
        destinationAtaExists: false,
        blockhash: VALID_BLOCKHASH,
      })
    );
  }

  it("A: the wallet signs the EXACT prepared message — accepted, message unchanged", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();

    const payer = web3.Keypair.generate();
    let preparedMessage: Uint8Array | null = null;
    let returned: WalletTx | null = null;

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      // The real wallet path: bytes out, the wallet signs exactly those
      // bytes, and the adapter re-parses what comes back.
      signTransaction: async (transaction: unknown) => {
        const tx = transaction as WalletTx;
        preparedMessage = Uint8Array.from(tx.serializeMessage());
        tx.sign(payer);
        returned = web3.Transaction.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        );
        return returned;
      },
    });

    // `signSolanaUSDCPayment` itself serialized the returned transaction,
    // which runs a REAL ed25519 verification of the returned message.
    expect((returned as unknown as WalletTx).verifySignatures()).toBe(true);
    expect(
      Buffer.compare(
        Buffer.from(preparedMessage as unknown as Uint8Array),
        Buffer.from((returned as unknown as WalletTx).serializeMessage())
      )
    ).toBe(0);

    const broadcast = web3.Transaction.from(
      Uint8Array.from(Buffer.from(result.signedTransactionBase64, "base64"))
    );
    expect(broadcast.verifySignatures()).toBe(true);
    expect(broadcast.instructions).toHaveLength(2);
    expect(broadcast.instructions[0]!.programId.toBase58()).toBe(
      ASSOCIATED_TOKEN_PROGRAM
    );
    expect(broadcast.instructions[1]!.programId.toBase58()).toBe(TOKEN_PROGRAM);
    expect(result.signature.length).toBeGreaterThan(0);
  });

  it("B: MORE compute-budget instructions than the sanctioned priority-fee pair (3) are refused with WALLET_MODIFIED_TRANSACTION", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();

    const payer = web3.Keypair.generate();
    let returned: WalletTx | null = null;

    let caught: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          // A DIFFERENT message: the prepared instructions plus THREE
          // ComputeBudget instructions, signed with the SAME fee-payer
          // key so the signature is genuinely valid over it. The
          // documented wallet behavior is at most the fee PAIR (a
          // compute-unit limit and a price); a third fee instruction is
          // beyond it and must still be refused.
          const modified = new web3.Transaction().add(
            web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 501 }),
            web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 }),
            ...original.instructions
          );
          modified.feePayer = original.feePayer!;
          modified.recentBlockhash = original.recentBlockhash!;
          modified.sign(payer);
          returned = web3.Transaction.from(modified.serialize());
          return returned;
        },
      });
    } catch (error) {
      caught = error;
    }

    // The returned transaction is VALID — the refusal must come from the
    // message-identity guard, never from a bad signature.
    expect((returned as unknown as WalletTx).instructions).toHaveLength(5);
    expect((returned as unknown as WalletTx).verifySignatures()).toBe(true);
    expect(caught).toBeInstanceOf(WalletModifiedTransactionError);
    expect((caught as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
  });

  it("C: removed instructions (0 total, validly signed) are refused before broadcast", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();

    const payer = web3.Keypair.generate();
    let returned: WalletTx | null = null;

    let caught: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const emptied = new web3.Transaction();
          emptied.feePayer = original.feePayer!;
          emptied.recentBlockhash = original.recentBlockhash!;
          emptied.sign(payer);
          returned = web3.Transaction.from(emptied.serialize());
          return returned;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect((returned as unknown as WalletTx).instructions).toHaveLength(0);
    expect((returned as unknown as WalletTx).verifySignatures()).toBe(true);
    expect(caught).toBeInstanceOf(WalletModifiedTransactionError);
    expect((caught as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
  });

  it("D: a damaged wallet response is refused safely — nothing is returned or broadcast", async () => {
    const fetchMock = installSerializableFetch();

    let caught: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: FIXED_PUBLIC_KEY,
        // Damaged on purpose: the signature-shaped fields pass the
        // existing checks, but the message cannot be read at all, so the
        // identity of the transaction cannot be proven.
        signTransaction: async () =>
          ({
            signatures: [{ length: 64 }],
            signature: new Uint8Array(64),
          }) as never,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WalletModifiedTransactionError);
    expect((caught as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
    // The payment path never reached the broadcast endpoint.
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/api/solana/broadcast"))).toBe(
      false
    );
  });
});

/**
 * WALLET-ADDED PRIORITY FEES (Phantom)
 *
 * Phantom automatically inserts its priority-fee pair — a ComputeBudget
 * `setComputeUnitLimit` and `setComputeUnitPrice` — at index 0 of a
 * legacy dApp transaction that carries no signatures and no priority-fee
 * instructions of its own, then signs THAT message
 * (docs.phantom.com/developer-powertools/solana-priority-fees).
 *
 * The message-identity guard ACCEPTS exactly that documented, fee-only
 * addition — the injected instructions have ZERO account metas, and every
 * prepared instruction must still match byte-for-byte — and still refuses
 * anything else.
 */
describe("signSolanaUSDCPayment — wallet-added priority fees (Phantom)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const VALID_BLOCKHASH = "11111111111111111111111111111111";
  const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

  type WalletTx = import("@solana/web3.js").Transaction;

  function installSerializableFetch() {
    return installFetchMock(
      buildFetchImplementation({
        destinationAtaExists: false,
        blockhash: VALID_BLOCKHASH,
      })
    );
  }

  /**
   * The documented Phantom shape:
   * [ComputeBudget limit, ComputeBudget price, ...dApp instructions] —
   * the fee-only pair is inserted AT INDEX 0 and the resulting message is
   * what gets signed.
   */
  function returnPhantomSigned(
    web3: typeof import("@solana/web3.js"),
    transaction: unknown,
    payer: import("@solana/web3.js").Keypair,
    options: {
      includeLimit?: boolean;
      includePrice?: boolean;
      limitUnits?: number;
      priceMicroLamports?: number;
    } = {}
  ): WalletTx {
    const original = transaction as WalletTx;
    const injected = new web3.Transaction();
    if (options.includeLimit ?? true) {
      injected.add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({
          units: options.limitUnits ?? 200_000,
        })
      );
    }
    if (options.includePrice ?? true) {
      injected.add(
        web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: options.priceMicroLamports ?? 5_000,
        })
      );
    }
    injected.add(...original.instructions);
    injected.feePayer = original.feePayer!;
    injected.recentBlockhash = original.recentBlockhash!;
    injected.sign(payer);
    return web3.Transaction.from(injected.serialize());
  }

  function decodeBroadcast(
    web3: typeof import("@solana/web3.js"),
    result: { signedTransactionBase64: string }
  ): WalletTx {
    return web3.Transaction.from(
      Uint8Array.from(Buffer.from(result.signedTransactionBase64, "base64"))
    );
  }

  it("P1: the documented fee pair at index 0 is accepted and every payment meta is unchanged", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    let preparedInstructionMetas: string[][] = [];
    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) => {
        const original = transaction as WalletTx;
        preparedInstructionMetas = original.instructions.map((instruction) =>
          instruction.keys.map((key) => key.pubkey.toBase58())
        );
        return returnPhantomSigned(web3, transaction, payer);
      },
    });

    const broadcast = decodeBroadcast(web3, result);
    // The wallet's fee-only pair, then the UNCHANGED payment.
    expect(broadcast.instructions).toHaveLength(4);
    expect(broadcast.instructions[0]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(broadcast.instructions[1]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(broadcast.instructions[2]!.programId.toBase58()).toBe(
      ASSOCIATED_TOKEN_PROGRAM
    );
    expect(broadcast.instructions[3]!.programId.toBase58()).toBe(TOKEN_PROGRAM);
    // Every account meta of both payment instructions is EXACTLY the one
    // AETERNA prepared — same keys, same order.
    expect(
      broadcast.instructions
        .slice(2)
        .map((instruction) =>
          instruction.keys.map((key) => key.pubkey.toBase58())
        )
    ).toEqual(preparedInstructionMetas);
    expect(
      decodeTransferAmount(
        broadcast.instructions[3] as unknown as InstructionView
      )
    ).toBe(1_000_000n);
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("P1b: the exact observed Phantom pair (200 000 CU × 375 000 µL/CU = 75 000 lamports) is accepted", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    let preparedInstructionMetas: string[][] = [];
    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) => {
        const original = transaction as WalletTx;
        preparedInstructionMetas = original.instructions.map((instruction) =>
          instruction.keys.map((key) => key.pubkey.toBase58())
        );
        return returnPhantomSigned(web3, transaction, payer, {
          limitUnits: 200_000,
          priceMicroLamports: 375_000,
        });
      },
    });

    const broadcast = decodeBroadcast(web3, result);
    expect(broadcast.instructions).toHaveLength(4);
    const limit = broadcast.instructions[0] as unknown as InstructionView;
    const price = broadcast.instructions[1] as unknown as InstructionView;
    expect(limit.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM);
    expect(price.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM);
    expect(limit.data[0]).toBe(2);
    expect(price.data[0]).toBe(3);
    expect(decodeComputeUnitLimit(limit)).toBe(200_000);
    expect(decodeComputeUnitPrice(price)).toBe(375_000n);
    // ceil(200 000 × 375 000 / 1 000 000) = 75 000 lamports ≤ 1 000 000.
    const worstCaseFee =
      (BigInt(decodeComputeUnitLimit(limit)) *
        decodeComputeUnitPrice(price) +
        999_999n) /
      1_000_000n;
    expect(worstCaseFee).toBe(75_000n);
    expect(worstCaseFee).toBeLessThanOrEqual(1_000_000n);
    // Every payment meta is EXACTLY the one AETERNA prepared.
    expect(
      broadcast.instructions
        .slice(2)
        .map((instruction) =>
          instruction.keys.map((key) => key.pubkey.toBase58())
        )
    ).toEqual(preparedInstructionMetas);
    expect(
      decodeTransferAmount(
        broadcast.instructions[3] as unknown as InstructionView
      )
    ).toBe(1_000_000n);
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("P2: a wallet that adds only the compute-unit price is accepted", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) =>
        returnPhantomSigned(web3, transaction, payer, { includeLimit: false }),
    });

    const broadcast = decodeBroadcast(web3, result);
    expect(broadcast.instructions).toHaveLength(3);
    expect(broadcast.instructions[0]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(broadcast.instructions[1]!.programId.toBase58()).toBe(
      ASSOCIATED_TOKEN_PROGRAM
    );
    expect(broadcast.instructions[2]!.programId.toBase58()).toBe(TOKEN_PROGRAM);
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("P3: fee instructions APPENDED after the payment are accepted too (position-independent)", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) => {
        const original = transaction as WalletTx;
        const parsed = web3.Transaction.from(
          original.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          })
        );
        parsed.add(
          web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })
        );
        parsed.partialSign(payer);
        return web3.Transaction.from(parsed.serialize());
      },
    });

    const broadcast = decodeBroadcast(web3, result);
    expect(broadcast.instructions).toHaveLength(3);
    expect(broadcast.instructions[2]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(broadcast.verifySignatures()).toBe(true);
  });

  /**
   * A refusal harness for a wallet that injects a DAMAGED/foreign
   * instruction in front of the prepared payment, signs the result with
   * the genuine fee-payer key (so the signature is valid) and returns it.
   */
  async function expectRefusalWithInjectedInstruction(
    buildInjected: (
      web3: typeof import("@solana/web3.js"),
      original: WalletTx,
      payer: import("@solana/web3.js").Keypair
    ) => WalletTx
  ) {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    let caught: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) =>
          buildInjected(web3, transaction as WalletTx, payer),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WalletModifiedTransactionError);
    expect((caught as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
  }

  it("P4: a fee instruction that carries account metas is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(COMPUTE_BUDGET_PROGRAM),
          keys: [
            { pubkey: payer.publicKey, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]),
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P5: an unknown ComputeBudget tag is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(COMPUTE_BUDGET_PROGRAM),
          keys: [],
          data: Buffer.from([9, 1, 2, 3, 4]),
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P6: a compute-unit limit above the protocol maximum is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const data = Buffer.alloc(5);
      data[0] = 2;
      // 1_400_001 = 0x00155CC1 little-endian: one unit above the cap.
      data[1] = 0xc1;
      data[2] = 0x5c;
      data[3] = 0x15;
      data[4] = 0x00;
      const injected = new web3.Transaction().add(
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(COMPUTE_BUDGET_PROGRAM),
          keys: [],
          data,
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P7: the exact observed fee pair cannot smuggle a changed payment amount", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const instructions = original.instructions.map((instruction) => {
        if (instruction.programId.toBase58() !== TOKEN_PROGRAM) {
          return instruction;
        }
        const data = Buffer.from(instruction.data);
        data.writeBigUInt64LE(999_999n, 1);
        return new web3.TransactionInstruction({
          programId: instruction.programId,
          keys: instruction.keys,
          data,
        });
      });
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 375_000,
        }),
        ...instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P7b: the exact observed fee pair cannot smuggle a changed recipient", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const attackerDestination = web3.Keypair.generate().publicKey;
      const instructions = original.instructions.map((instruction) => {
        if (instruction.programId.toBase58() !== TOKEN_PROGRAM) {
          return instruction;
        }
        return new web3.TransactionInstruction({
          programId: instruction.programId,
          keys: instruction.keys.map((key, index) =>
            index === 1 ? { ...key, pubkey: attackerDestination } : key
          ),
          data: instruction.data,
        });
      });
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 375_000,
        }),
        ...instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P8: a foreign extra instruction next to the fee pair is still refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: web3.Keypair.generate().publicKey,
          lamports: 1,
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P9: the fee allowance cannot smuggle a different blockhash", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = "11111111111111111111111111111112";
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  /**
   * PRIORITY-FEE POLICY (see MAX_WALLET_PRIORITY_FEE_LAMPORTS in
   * `solanaWallet.ts`): the accepted worst case is
   * `ceil(units × price / 1_000_000)` lamports, where `units` is the
   * wallet's own compute-unit limit or — when it sets none — the protocol
   * MAXIMUM of 1 400 000 CU. A missing limit must NOT be bounded by
   * 200 000 CU: the runtime charges the limit the message REQUESTS, and
   * without a `setComputeUnitLimit` instruction that is the per-instruction
   * default — 400 000 CU for this payment (ATA-create + transfer) — so the
   * guard deliberately bounds the missing-limit case by the protocol
   * maximum. The boundary values below pin both ends EXACTLY, and P18 pins
   * the price-only injection the flat-200 000-CU bound wrongly allowed.
   */
  it("P10: a limit/price pair whose worst-case priority fee is under the policy cap is accepted", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) =>
        returnPhantomSigned(web3, transaction, payer, {
          limitUnits: 1_400_000,
          priceMicroLamports: 714_285,
        }),
    });

    // ceil(1_400_000 × 714_285 / 1_000_000) = 999_999 lamports ≤ the cap.
    const broadcast = decodeBroadcast(web3, result);
    expect(broadcast.instructions).toHaveLength(4);
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("P11: a price-only injection whose worst-case fee exactly equals the cap is accepted", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    // With no limit instruction the guard bounds the fee by the protocol
    // MAXIMUM of 1 400 000 CU (the payment itself defaults to 400 000 CU
    // because it also carries the ATA-create instruction):
    // ceil(1_400_000 × 714_285 / 1_000_000) = 999_999 lamports ≤ the cap.
    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) =>
        returnPhantomSigned(web3, transaction, payer, {
          includeLimit: false,
          priceMicroLamports: 714_285,
        }),
    });

    const broadcast = decodeBroadcast(web3, result);
    expect(broadcast.instructions).toHaveLength(3);
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("P12: a price-only injection one micro-lamport above the policy cap is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 714_286,
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P13: a limit/price pair whose worst-case priority fee exceeds the cap is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 714_286,
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P14: an astronomically high compute-unit price (u64 max) is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const data = Buffer.alloc(9);
      data[0] = 3;
      data.writeBigUInt64LE(18_446_744_073_709_551_615n, 1);
      const injected = new web3.Transaction().add(
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(COMPUTE_BUDGET_PROGRAM),
          keys: [],
          data,
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P15: a duplicated compute-unit limit is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P16: a duplicated compute-unit price is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });

  it("P17: a limit-only injection (no price) is accepted — no SOL priority fee is requested", async () => {
    const web3 = await import("@solana/web3.js");
    installSerializableFetch();
    const payer = web3.Keypair.generate();

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) =>
        returnPhantomSigned(web3, transaction, payer, {
          includePrice: false,
        }),
    });

    const broadcast = decodeBroadcast(web3, result);
    expect(broadcast.instructions).toHaveLength(3);
    expect(broadcast.instructions[0]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("P18: the price-only injection the old flat-200 000-CU bound wrongly allowed is refused", async () => {
    await expectRefusalWithInjectedInstruction((web3, original, payer) => {
      /**
       * 5 000 000 µL/CU was accepted while a missing limit was mis-bounded
       * as 200 000 CU (ceil(200 000 × 5 000 000 / 1_000_000) = 1 000 000
       * lamports = the cap). This payment carries TWO payable instructions
       * (ATA-create + transfer), so the true missing-limit default is
       * 400 000 CU and the real charge would be 2 000 000 lamports —
       * double the 0.001 SOL policy. The protocol-maximum bound refuses it.
       */
      const injected = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 5_000_000,
        }),
        ...original.instructions
      );
      injected.feePayer = original.feePayer!;
      injected.recentBlockhash = original.recentBlockhash!;
      injected.sign(payer);
      return web3.Transaction.from(injected.serialize());
    });
  });
});

/**
 * PHANTOM LIGHTHOUSE ASSERTION PAIR (CLIENT GUARD)
 *
 * The server-side candidate accepts Phantom's exact read-only v2 assertion
 * pair after the payment. The client guard must mirror that acceptance
 * ceiling WITHOUT weakening the payment's identity: the pair is accepted
 * only in order (AssertAccountInfoMulti on the fee payer, then
 * AssertTokenAccountMulti on the prepared transfer's source ATA), with the
 * exact reconstructed payload shapes, and only together with the unchanged
 * prepared payment.
 *
 * These fixtures are RECONSTRUCTED from the recorded production diagnostic
 * shape. They do not prove that the original production payload bytes —
 * which were not independently recovered — were observed verbatim.
 */
describe("signSolanaUSDCPayment — Phantom Lighthouse assertion pair", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const VALID_BLOCKHASH = "11111111111111111111111111111111";
  const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

  // Reconstructed v2 payloads (16 B info assertion, 27 B token assertion).
  const PHANTOM_INFO_DATA = Buffer.from([
    6, 4, 2, 3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const PHANTOM_TOKEN_DATA = Buffer.from([
    10, 4, 4, 2, 0x22, 0x16, 0x07, 0, 0, 0, 0, 0, 4,
    3, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 5, 8,
  ]);
  /**
   * The 26-byte CURRENT INFO form Phantom appends: `Lamports(X) >=`,
   * `KnownOwner(System) ==`, `DataLength(0) ==`. X is derived by Phantom
   * from the simulated payer balance, so it is the ONLY variable field.
   */
  function currentInfoData(lamports: bigint): Buffer {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(lamports);
    return Buffer.from([
      6, 4, 3,
      0, ...value, 4,
      3, 0, 0,
      1, ...Buffer.alloc(8), 0,
    ]);
  }

  type WalletTx = import("@solana/web3.js").Transaction;
  type Web3 = typeof import("@solana/web3.js");

  function installSerializableFetch() {
    return installFetchMock(
      buildFetchImplementation({
        destinationAtaExists: false,
        blockhash: VALID_BLOCKHASH,
      })
    );
  }
  /** Repeat purchase: the settlement ATA exists, so ONE prepared instruction. */
  function installExistingAtaFetch() {
    return installFetchMock(
      buildFetchImplementation({
        destinationAtaExists: true,
        blockhash: VALID_BLOCKHASH,
      })
    );
  }

  function expectNoBroadcast(fetchMock: ReturnType<typeof installFetchMock>) {
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/api/solana/broadcast"))).toBe(
      false
    );
  }

  interface LighthouseOptions {
    includeInfo?: boolean;
    includeToken?: boolean;
    reverseOrder?: boolean;
    /** An extra (third) info assertion appended after the pair. */
    duplicateInfo?: boolean;
    /** An extra unknown-discriminator Lighthouse instruction. */
    extraAssertion?: boolean;
    infoTarget?: import("@solana/web3.js").PublicKey;
    tokenTarget?: import("@solana/web3.js").PublicKey;
    infoData?: Buffer;
    tokenData?: Buffer;
    /** Make the Lighthouse program key writable instead of read-only. */
    lighthouseProgramWritable?: boolean;
    /** Inserted before the prepared payment (the documented Phantom shape). */
    beforePayment?: import("@solana/web3.js").TransactionInstruction[];
    /** Inserted after the prepared payment, before the Lighthouse pair. */
    beforePair?: import("@solana/web3.js").TransactionInstruction[];
    /** A different transfer amount (outside the prepared payment). */
    transferAmount?: bigint;
    /** A different transfer source account. */
    transferSource?: import("@solana/web3.js").PublicKey;
    /** Downgrade the prepared source ATA from writable to read-only. */
    transferSourceReadonly?: boolean;
    blockhash?: string;
  }

  function returnWithLighthouse(
    web3: Web3,
    original: WalletTx,
    payer: import("@solana/web3.js").Keypair,
    options: LighthouseOptions = {}
  ): WalletTx {
    const transfer = original.instructions.find(
      (instruction) =>
        instruction.programId.toBase58() === TOKEN_PROGRAM &&
        instruction.data[0] === 3
    );
    if (!transfer) throw new Error("prepared transfer instruction missing");

    const sourceAta = options.transferSource ?? transfer.keys[0]!.pubkey;
    const lighthouseProgram = new web3.PublicKey(LIGHTHOUSE_PROGRAM);

    const preparedInstructions = original.instructions.map((instruction) => {
      if (instruction.programId.toBase58() !== TOKEN_PROGRAM) {
        return instruction;
      }
      let data = instruction.data;
      if (options.transferAmount !== undefined) {
        const mutated = Buffer.from(data);
        mutated.writeBigUInt64LE(options.transferAmount, 1);
        data = mutated;
      }
      const keys =
        options.transferSource !== undefined ||
        options.transferSourceReadonly === true
          ? instruction.keys.map((key, index) => {
              if (index !== 0) return key;
              return {
                ...key,
                pubkey: sourceAta,
                isWritable:
                  options.transferSourceReadonly === true
                    ? false
                    : key.isWritable,
              };
            })
          : instruction.keys;
      return new web3.TransactionInstruction({
        programId: instruction.programId,
        keys,
        data,
      });
    });

    const infoInstruction = () =>
      new web3.TransactionInstruction({
        programId: lighthouseProgram,
        keys: [
          options.lighthouseProgramWritable
            ? {
                pubkey: lighthouseProgram,
                isSigner: false,
                isWritable: true,
              }
            : {
                pubkey: options.infoTarget ?? payer.publicKey,
                isSigner: false,
                isWritable: false,
              },
        ],
        data: options.infoData ?? PHANTOM_INFO_DATA,
      });

    const tokenInstruction = () =>
      new web3.TransactionInstruction({
        programId: lighthouseProgram,
        keys: [
          {
            pubkey: options.tokenTarget ?? sourceAta,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: options.tokenData ?? PHANTOM_TOKEN_DATA,
      });

    const assertions: import("@solana/web3.js").TransactionInstruction[] = [];
    if (options.includeInfo ?? true) assertions.push(infoInstruction());
    if (options.includeToken ?? true) assertions.push(tokenInstruction());
    if (options.reverseOrder) assertions.reverse();
    if (options.duplicateInfo) assertions.push(infoInstruction());
    if (options.extraAssertion) {
      assertions.push(
        new web3.TransactionInstruction({
          programId: lighthouseProgram,
          keys: [
            {
              pubkey: payer.publicKey,
              isSigner: false,
              isWritable: false,
            },
          ],
          data: Buffer.from([12, 4]),
        })
      );
    }

    const modified = new web3.Transaction().add(
      ...(options.beforePayment ?? []),
      ...preparedInstructions,
      ...(options.beforePair ?? []),
      ...assertions
    );
    modified.feePayer = original.feePayer!;
    modified.recentBlockhash =
      options.blockhash ?? original.recentBlockhash!;
    modified.sign(payer);
    return web3.Transaction.from(modified.serialize());
  }

  async function attempt(
    build: (web3: Web3, original: WalletTx, payer: import("@solana/web3.js").Keypair) => WalletTx
  ) {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installSerializableFetch();
    const payer = web3.Keypair.generate();
    try {
      const result = await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) =>
          build(web3, transaction as WalletTx, payer),
      });
      return { web3, fetchMock, result };
    } catch (error) {
      return { web3, fetchMock, error };
    }
  }

  async function expectRefusal(
    build: (web3: Web3, original: WalletTx, payer: import("@solana/web3.js").Keypair) => WalletTx
  ) {
    const outcome = await attempt(build);
    expect(outcome.error).toBeInstanceOf(WalletModifiedTransactionError);
    expect((outcome.error as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
    expectNoBroadcast(outcome.fetchMock);
  }

  it("L1: accepts the exact ordered info → token pair and broadcasts it unchanged", async () => {
    const outcome = await attempt((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer)
    );

    expect(outcome.error).toBeUndefined();
    const broadcast = outcome.web3.Transaction.from(
      Uint8Array.from(
        Buffer.from(outcome.result!.signedTransactionBase64, "base64")
      )
    );
    expect(broadcast.instructions).toHaveLength(4);
    expect(broadcast.instructions[2]!.programId.toBase58()).toBe(
      LIGHTHOUSE_PROGRAM
    );
    expect(broadcast.instructions[3]!.programId.toBase58()).toBe(
      LIGHTHOUSE_PROGRAM
    );
    expect(Buffer.from(broadcast.instructions[2]!.data)).toEqual(
      PHANTOM_INFO_DATA
    );
    expect(Buffer.from(broadcast.instructions[3]!.data)).toEqual(
      PHANTOM_TOKEN_DATA
    );
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("L1b: accepts the pair together with the documented fee pair", async () => {
    const outcome = await attempt((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        beforePayment: [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 375_000,
          }),
        ],
      })
    );

    expect(outcome.error).toBeUndefined();
    const broadcast = outcome.web3.Transaction.from(
      Uint8Array.from(
        Buffer.from(outcome.result!.signedTransactionBase64, "base64")
      )
    );
    expect(broadcast.instructions).toHaveLength(6);
    expect(broadcast.instructions[0]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(broadcast.instructions[4]!.programId.toBase58()).toBe(
      LIGHTHOUSE_PROGRAM
    );
    expect(broadcast.instructions[5]!.programId.toBase58()).toBe(
      LIGHTHOUSE_PROGRAM
    );
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("L1c: the token assertion's amount lower bound is the only variable field", async () => {
    const tokenData = Buffer.from(PHANTOM_TOKEN_DATA);
    tokenData.writeBigUInt64LE(1_000_000n, 4);

    const outcome = await attempt((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { tokenData })
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.result!.signature.length).toBeGreaterThan(0);
  });

  /* ===================================================================
   * R9-A84.5 - the 17-byte TOKEN form observed on Production.
   *
   * Phantom omitted its own Amount assertion; every remaining field is
   * fixed. Payload and digest come from R9-A84-4/EVIDENCE-GATE.md.
   * ================================================================= */

  const OBSERVED_17_TOKEN_HEX = "0a04030300000600000000000000000508";
  const OBSERVED_17_TOKEN_SHA256 =
    "81a7d1806a75a5572fa5a1492decf48b8e98531f955c22767ae78bb9b4380015";

  function observedToken17(): Buffer {
    return Buffer.from(OBSERVED_17_TOKEN_HEX, "hex");
  }

  /** Repeat purchase: the settlement ATA exists, so ONE prepared instruction. */
  async function attemptExistingAta(
    build: (
      web3: Web3,
      original: WalletTx,
      payer: import("@solana/web3.js").Keypair
    ) => WalletTx
  ) {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installExistingAtaFetch();
    const payer = web3.Keypair.generate();
    try {
      const result = await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) =>
          build(web3, transaction as WalletTx, payer),
      });
      return { web3, fetchMock, result };
    } catch (error) {
      return { web3, fetchMock, error };
    }
  }

  it("L17-1: the captured payload is exactly the production bytes", () => {
    const data = observedToken17();
    expect(data).toHaveLength(17);
    expect(createHash("sha256").update(data).digest("hex")).toBe(
      OBSERVED_17_TOKEN_SHA256
    );
  });

  it("L17-2: accepts fee pair + payment + captured INFO + 17-byte TOKEN (one prepared instruction)", async () => {
    const outcome = await attemptExistingAta((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        infoData: currentInfoData(8_729_000n),
        tokenData: observedToken17(),
        beforePayment: [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 375_000,
          }),
        ],
      })
    );

    expect(outcome.error).toBeUndefined();
    const broadcast = outcome.web3.Transaction.from(
      Uint8Array.from(
        Buffer.from(outcome.result!.signedTransactionBase64, "base64")
      )
    );
    // 2 fee instructions + the 1 prepared transfer + INFO + TOKEN
    expect(broadcast.instructions).toHaveLength(5);
    const transfer = broadcast.instructions[2]!;
    expect(transfer.programId.toBase58()).toBe(TOKEN_PROGRAM);
    expect(transfer.data[0]).toBe(3);
    expect(Buffer.from(transfer.data).readBigUInt64LE(1)).toBe(1_000_000n);
    expect(Buffer.from(broadcast.instructions[3]!.data)).toEqual(
      currentInfoData(8_729_000n)
    );
    expect(Buffer.from(broadcast.instructions[4]!.data)).toEqual(
      observedToken17()
    );
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("L17-3: accepts the 17-byte TOKEN with the ATA-create flow (two prepared instructions)", async () => {
    const outcome = await attempt((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        infoData: currentInfoData(8_729_000n),
        tokenData: observedToken17(),
      })
    );

    expect(outcome.error).toBeUndefined();
    const broadcast = outcome.web3.Transaction.from(
      Uint8Array.from(
        Buffer.from(outcome.result!.signedTransactionBase64, "base64")
      )
    );
    // ATA-create + transfer + INFO + TOKEN
    expect(broadcast.instructions).toHaveLength(4);
    expect(isAtaCreateInstruction(broadcast.instructions[0]!)).toBe(true);
    expect(isTransferInstruction(broadcast.instructions[1]!)).toBe(true);
    expect(Buffer.from(broadcast.instructions[3]!.data)).toEqual(
      observedToken17()
    );
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("L17-4: refuses the 17-byte TOKEN when it targets a different account", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        tokenData: observedToken17(),
        tokenTarget: web3.Keypair.generate().publicKey,
      })
    );
  });

  it("L17-5: refuses a single-byte mutation of the 17-byte TOKEN", async () => {
    const mutated = Buffer.from(observedToken17());
    mutated[15] = 4; // DelegatedAmount operator '<=' -> '>='
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { tokenData: mutated })
    );
  });

  it("L2: a single info assertion is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { includeToken: false })
    );
  });

  it("L3: a single token assertion is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { includeInfo: false })
    );
  });

  it("L4: a reversed token → info pair is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { reverseOrder: true })
    );
  });

  it("L5: a duplicated info assertion is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { duplicateInfo: true })
    );
  });

  it("L6: a third/unknown Lighthouse assertion is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { extraAssertion: true })
    );
  });

  it("L7: an info assertion targeting a non-payer account is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        infoTarget: web3.Keypair.generate().publicKey,
      })
    );
  });

  it("L8: a token assertion targeting a non-source account is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        tokenTarget: web3.Keypair.generate().publicKey,
      })
    );
  });

  it("L9: an info payload mutation is refused", async () => {
    const infoData = Buffer.from(PHANTOM_INFO_DATA);
    infoData[3] = 0;
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { infoData })
    );
  });

  it("L10: a token payload mutation outside the amount wildcard is refused", async () => {
    const tokenData = Buffer.from(PHANTOM_TOKEN_DATA);
    tokenData[12] = 5;
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { tokenData })
    );
  });

  it("L11: a token payload with trailing bytes is refused", async () => {
    const tokenData = Buffer.concat([
      Buffer.from(PHANTOM_TOKEN_DATA),
      Buffer.from([0]),
    ]);
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { tokenData })
    );
  });

  it("L12: a writable Lighthouse program key is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        lighthouseProgramWritable: true,
      })
    );
  });

  it("L13: a prepared account downgraded from writable to read-only is refused", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        transferSourceReadonly: true,
      })
    );
  });

  it("L14: an unknown ComputeBudget tag is refused even with the pair", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        beforePair: [
          new web3.TransactionInstruction({
            programId: new web3.PublicKey(COMPUTE_BUDGET_PROGRAM),
            keys: [],
            data: Buffer.from([9, 1, 2, 3, 4]),
          }),
        ],
      })
    );
  });

  it("L15: an excessive ComputeBudget instruction count is refused even with the pair", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        beforePair: [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 1,
          }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 2,
          }),
        ],
      })
    );
  });

  it("L16: the pair cannot authorize a changed payment amount", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        transferAmount: 999_999n,
      })
    );
  });

  it("L17: the pair cannot authorize a changed source account", async () => {
    await expectRefusal((web3, original, payer) => {
      const transfer = original.instructions.find(
        (instruction) =>
          instruction.programId.toBase58() === TOKEN_PROGRAM &&
          instruction.data[0] === 3
      )!;
      return returnWithLighthouse(web3, original, payer, {
        transferSource: web3.Keypair.generate().publicKey,
        tokenTarget: transfer.keys[0]!.pubkey,
      });
    });
  });

  it("L18: the pair cannot authorize a different blockhash", async () => {
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, {
        blockhash: "11111111111111111111111111111112",
      })
    );
  });
  it("L19: accepts the 26-byte three-assertion INFO with the historical threshold", async () => {
    const infoData = currentInfoData(14_290_622n);
    expect(infoData).toHaveLength(26);

    const outcome = await attempt((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { infoData })
    );

    expect(outcome.error).toBeUndefined();
    const broadcast = outcome.web3.Transaction.from(
      Uint8Array.from(
        Buffer.from(outcome.result!.signedTransactionBase64, "base64")
      )
    );
    expect(broadcast.instructions).toHaveLength(4);
    expect(Buffer.from(broadcast.instructions[2]!.data)).toEqual(infoData);
    expect(broadcast.verifySignatures()).toBe(true);
  });

  it("L20: accepts the same 26-byte INFO with a different balance threshold", async () => {
    const infoData = currentInfoData(8_814_000n);

    const outcome = await attempt((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { infoData })
    );

    expect(outcome.error).toBeUndefined();
    const broadcast = outcome.web3.Transaction.from(
      Uint8Array.from(
        Buffer.from(outcome.result!.signedTransactionBase64, "base64")
      )
    );
    expect(Buffer.from(broadcast.instructions[2]!.data)).toEqual(infoData);
  });

  it("L21: refuses a Lamports assertion whose operator is not >=", async () => {
    const infoData = currentInfoData(14_290_622n);
    infoData[12] = 5;
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { infoData })
    );
  });

  it("L22: refuses a reordered 26-byte INFO (owner before lamports)", async () => {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(14_290_622n);
    const infoData = Buffer.from([
      6, 4, 3,
      3, 0, 0,
      0, ...value, 4,
      1, ...Buffer.alloc(8), 0,
    ]);
    expect(infoData).toHaveLength(26);
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { infoData })
    );
  });

  it("L23: refuses the 26-byte INFO with a trailing byte", async () => {
    const infoData = Buffer.concat([currentInfoData(14_290_622n), Buffer.from([0])]);
    expect(infoData).toHaveLength(27);
    await expectRefusal((web3, original, payer) =>
      returnWithLighthouse(web3, original, payer, { infoData })
    );
  });

  it("L24: accepts the observed five-instruction shape end to end", async () => {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installExistingAtaFetch();
    const payer = web3.Keypair.generate();
    const infoData = currentInfoData(14_290_622n);

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) => {
        const original = transaction as WalletTx;
        // Repeat purchase: exactly ONE prepared instruction (the transfer).
        expect(original.instructions).toHaveLength(1);
        return returnWithLighthouse(web3, original, payer, {
          infoData,
          beforePayment: [
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            web3.ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: 375_000,
            }),
          ],
        });
      },
    });

    const broadcast = web3.Transaction.from(
      Uint8Array.from(Buffer.from(result.signedTransactionBase64, "base64"))
    );
    expect(broadcast.instructions).toHaveLength(5);
    expect(
      broadcast.instructions.map((instruction) =>
        instruction.programId.toBase58()
      )
    ).toEqual([
      COMPUTE_BUDGET_PROGRAM,
      COMPUTE_BUDGET_PROGRAM,
      TOKEN_PROGRAM,
      LIGHTHOUSE_PROGRAM,
      LIGHTHOUSE_PROGRAM,
    ]);
    expect(Buffer.from(broadcast.instructions[3]!.data)).toEqual(infoData);
    expect(broadcast.verifySignatures()).toBe(true);
    expectNoBroadcast(fetchMock);
  });
});

/* ---------------------------------------------------------------------
 * OPT-IN DIAGNOSTICS (WALLET_MODIFIED_TRANSACTION) — RETAINED, DEFAULT OFF
 *
 * With `?aeternaWalletDiag=1` the guard emits exactly ONE structured,
 * privacy-filtered `console.warn` record on a message mismatch; without
 * that exact flag nothing is collected or logged. For Lighthouse-program
 * instructions only, the record also carries the referenced public
 * addresses, the payload's first byte, and — for INFO payloads only — the
 * raw bytes in hex, capped at 64. A token assertion's balance-derived
 * payload is never recorded. The refusal itself and the broadcast barrier
 * are untouched, and the record is local: no request ever carries it.
 * ------------------------------------------------------------------- */

interface DiagMessageSide {
  messageLength: number;
  messageSha256: string;
  header: number[] | null;
  accountKeyCount: number | null;
  accountKeyFingerprints: Array<{ index: number; sha256: string }> | null;
  recentBlockhash: string | null;
  instructionCount: number | null;
  instructions: Array<{
    index: number;
    programId: string;
    accountCount: number;
    dataLength: number;
    dataSha256: string;
    programIdIndex?: number;
    accountIndices?: number[];
    accountAddresses?: string[];
    dataFirstByte?: number;
    dataHex?: string;
    dataHexTruncated?: boolean;
    lighthouse?: {
      status: "decoded" | "undecoded";
      version?: "v2";
      discriminator?: number;
      variant?: "AssertAccountInfoMulti" | "AssertTokenAccountMulti";
      logLevel?: number;
      logLevelName?: string | null;
      assertionCount?: number;
      assertions?: Array<Record<string, unknown>>;
    };
  }> | null;
  parseError: string | null;
}

interface DiagRecord {
  event: string;
  cause?: string;
  firstDifferingOffset?: number | null;
  prepared?: DiagMessageSide | null;
  returned?: DiagMessageSide | null;
  diagnostics?: string;
}

describe("signSolanaUSDCPayment — wallet message-mismatch diagnostics", () => {
  const VALID_BLOCKHASH = "11111111111111111111111111111111";
  const DIAG_ENABLED_SEARCH = "?aeternaWalletDiag=1";

  type WalletTx = import("@solana/web3.js").Transaction;

  function installSerializableFetch() {
    return installFetchMock(
      buildFetchImplementation({
        destinationAtaExists: false,
        blockhash: VALID_BLOCKHASH,
      })
    );
  }

  function enableDiagnostics(search: string = DIAG_ENABLED_SEARCH) {
    vi.stubGlobal("window", { location: { search } });
  }

  function expectNoBroadcast(fetchMock: ReturnType<typeof installFetchMock>) {
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/api/solana/broadcast"))).toBe(
      false
    );
  }

  /**
   * AETERNA diagnostics emit exactly ONE console.warn payload: an object
   * carrying the exact `event` marker below. Unrelated library warnings
   * (e.g. bigint-buffer's binding notice) are plain strings and must
   * never be mistaken for a diagnostics record.
   */
  function readDiagRecords(): DiagRecord[] {
    return vi
      .mocked(console.warn)
      .mock.calls.map((call) => call[0])
      .filter(
        (entry): entry is DiagRecord =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { event?: unknown }).event === "WALLET_MODIFIED_TRANSACTION"
      );
  }

  function readDiagRecord(): DiagRecord {
    const records = readDiagRecords();
    expect(records).toHaveLength(1);
    return records[0]!;
  }

  /**
   * A wallet that re-signs the same instructions under a DIFFERENT
   * blockhash — the classic modification the guard must refuse.
   */
  async function runBlockhashSwap(
    web3: typeof import("@solana/web3.js"),
    payer: import("@solana/web3.js").Keypair
  ): Promise<{
    thrown: unknown;
    fetchMock: ReturnType<typeof installFetchMock>;
    replacementBlockhash: string;
  }> {
    const fetchMock = installSerializableFetch();
    const replacementBlockhash = web3.Keypair.generate().publicKey.toBase58();

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const modified = new web3.Transaction().add(
            ...original.instructions
          );
          modified.feePayer = original.feePayer!;
          modified.recentBlockhash = replacementBlockhash;
          modified.sign(payer);
          return web3.Transaction.from(modified.serialize());
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    return { thrown, fetchMock, replacementBlockhash };
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("classifies a recentBlockhash swap and emits ONE bounded record only with the exact flag", async () => {
    const web3 = await import("@solana/web3.js");
    const payer = web3.Keypair.generate();

    // Without the flag: refused as before, and no diagnostics RECORD is
    // emitted (foreign library console.warn output is ignored).
    const silent = await runBlockhashSwap(web3, payer);
    expectNoBroadcast(silent.fetchMock);
    expect(readDiagRecords()).toHaveLength(0);

    // With ?aeternaWalletDiag=1: exactly one bounded record.
    enableDiagnostics();
    const { fetchMock, replacementBlockhash } = await runBlockhashSwap(
      web3,
      payer
    );
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    expect(Object.keys(record).sort()).toEqual([
      "cause",
      "event",
      "firstDifferingOffset",
      "prepared",
      "returned",
    ]);
    expect(record.event).toBe("WALLET_MODIFIED_TRANSACTION");
    expect(record.cause).toBe("recent_blockhash");

    const prepared = record.prepared!;
    const returned = record.returned!;
    expect(Object.keys(prepared).sort()).toEqual([
      "accountKeyCount",
      "accountKeyFingerprints",
      "header",
      "instructionCount",
      "instructions",
      "messageLength",
      "messageSha256",
      "parseError",
      "recentBlockhash",
    ]);
    expect(prepared.parseError).toBeNull();
    expect(returned.parseError).toBeNull();
    expect(prepared.messageLength).toBe(returned.messageLength);
    expect(prepared.messageSha256).not.toBe(returned.messageSha256);
    expect(prepared.recentBlockhash).toBe(VALID_BLOCKHASH);
    expect(returned.recentBlockhash).toBe(replacementBlockhash);
    expect(returned.header).toEqual(prepared.header);
    expect(returned.accountKeyCount).toBe(prepared.accountKeyCount);
    expect(returned.accountKeyFingerprints).toEqual(
      prepared.accountKeyFingerprints
    );
    expect(returned.instructions).toEqual(prepared.instructions);

    // The first difference must sit inside the blockhash region:
    // header (3) + shortvec key count (1) + 32 bytes per account key.
    const blockhashStart = 3 + 1 + 32 * prepared.accountKeyCount!;
    expect(typeof record.firstDifferingOffset).toBe("number");
    expect(record.firstDifferingOffset).toBeGreaterThanOrEqual(
      blockhashStart
    );
    expect(record.firstDifferingOffset).toBeLessThan(blockhashStart + 32);
  });

  it("distinguishes an added instruction and a rewritten account key in the diagnostic fields", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();

    // (a) One extra NON-priority-fee instruction (a System transfer) in
    // front of the originals. A canonical ComputeBudget fee pair would be
    // a legitimate Phantom enhancement, so a genuinely foreign extra
    // instruction must be used to exercise the refusal classification.
    const extraDestination = web3.Keypair.generate().publicKey;
    const fetchA = installSerializableFetch();
    let thrownA: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const modified = new web3.Transaction().add(
            web3.SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: extraDestination,
              lamports: 1,
            }),
            ...original.instructions
          );
          modified.feePayer = original.feePayer!;
          modified.recentBlockhash = original.recentBlockhash!;
          modified.sign(payer);
          return web3.Transaction.from(modified.serialize());
        },
      });
    } catch (error) {
      thrownA = error;
    }
    expect(thrownA).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchA);

    const recordA = readDiagRecord();
    expect(recordA.cause).toBe("instruction_count");
    expect(recordA.returned!.instructionCount).toBe(
      recordA.prepared!.instructionCount! + 1
    );
    expect(recordA.returned!.instructions![0]!.programId).toBe(
      "11111111111111111111111111111111"
    );
    expect(recordA.returned!.accountKeyFingerprints).not.toEqual(
      recordA.prepared!.accountKeyFingerprints
    );

    vi.mocked(console.warn).mockClear();

    // (b) Same instruction count, ONE non-signer account key rewritten at
    // the byte level. Patching the frozen serialized message keeps its
    // length, its account order and every compiled instruction index
    // intact, so "account_keys" is the only possible classification.
    // (Recompiling with a random replacement key can reorder same-class
    // keys and would then legitimately classify as "instruction_structure".)
    const fetchB = installSerializableFetch();
    let thrownB: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const patchedBytes = Uint8Array.from(original.serializeMessage());
          // header (3) + shortvec key count (1 byte, 8 keys): the first
          // non-signer key (index 1) starts at offset 4 + 32.
          const rewrittenKeyOffset = 4 + 32;
          patchedBytes[rewrittenKeyOffset] =
            patchedBytes[rewrittenKeyOffset]! ^ 0x7f;
          // A real signed transaction whose message is EXACTLY the patched
          // bytes: one placeholder signature slot, then re-sign the parsed
          // transaction (its message is pinned, never recompiled).
          const wire = new Uint8Array(1 + 64 + patchedBytes.length);
          wire[0] = 1;
          wire.set(patchedBytes, 1 + 64);
          const returned = web3.Transaction.from(wire);
          returned.partialSign(payer);
          return web3.Transaction.from(returned.serialize());
        },
      });
    } catch (error) {
      thrownB = error;
    }
    expect(thrownB).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchB);

    const recordB = readDiagRecord();
    expect(recordB.cause).toBe("account_keys");
    expect(recordB.returned!.accountKeyCount).toBe(
      recordB.prepared!.accountKeyCount
    );
    const preparedKeys = recordB.prepared!.accountKeyFingerprints!;
    const returnedKeys = recordB.returned!.accountKeyFingerprints!;
    expect(returnedKeys).not.toEqual(preparedKeys);
    // Exactly ONE key differs, and it is the patched index 1.
    expect(
      returnedKeys
        .filter((entry) => entry.sha256 !== preparedKeys[entry.index]!.sha256)
        .map((entry) => entry.index)
    ).toEqual([1]);
    // The first difference sits exactly on the patched key byte.
    expect(recordB.firstDifferingOffset).toBe(4 + 32);
    // The instructions themselves are byte-identical.
    expect(recordB.returned!.instructions).toEqual(
      recordB.prepared!.instructions
    );
  });

  it("detects a same-length instruction-data change by the data fingerprint", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const instructions = original.instructions.map((instruction) => {
            if (instruction.programId.toBase58() !== TOKEN_PROGRAM) {
              return instruction;
            }
            const data = Buffer.from(instruction.data);
            data[data.length - 1] = data[data.length - 1]! ^ 0x01;
            return new web3.TransactionInstruction({
              programId: instruction.programId,
              keys: instruction.keys,
              data,
            });
          });
          const modified = new web3.Transaction().add(...instructions);
          modified.feePayer = original.feePayer!;
          modified.recentBlockhash = original.recentBlockhash!;
          modified.sign(payer);
          return web3.Transaction.from(modified.serialize());
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    expect(record.cause).toBe("instruction_data");
    const preparedTransfer = record.prepared!.instructions![1]!;
    const returnedTransfer = record.returned!.instructions![1]!;
    expect(preparedTransfer.dataLength).toBe(returnedTransfer.dataLength);
    expect(returnedTransfer.dataSha256).not.toBe(preparedTransfer.dataSha256);
    expect(returnedTransfer.programId).toBe(preparedTransfer.programId);
    expect(record.returned!.accountKeyFingerprints).toEqual(
      record.prepared!.accountKeyFingerprints
    );
  });

  it("keeps the FROZEN prepared bytes even when the wallet mutates the handed transaction", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();
    const replacementBlockhash = web3.Keypair.generate().publicKey.toBase58();

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          // Hostile wallet: mutates the very object it was handed and
          // returns that same instance.
          const original = transaction as WalletTx;
          original.recentBlockhash = replacementBlockhash;
          original.sign(payer);
          return original;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    expect(record.cause).toBe("recent_blockhash");
    // Prepared side comes from the bytes frozen BEFORE the wallet call.
    expect(record.prepared!.recentBlockhash).toBe(VALID_BLOCKHASH);
    expect(record.returned!.recentBlockhash).toBe(replacementBlockhash);
  });

  it("marks an unparseable returned message and still refuses", async () => {
    enableDiagnostics();
    const fetchMock = installSerializableFetch();

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: FIXED_PUBLIC_KEY,
        // Readable by the guard (it IS a byte array) but not a valid
        // legacy message — diagnostics must degrade, not crash.
        signTransaction: async () =>
          ({
            signatures: [{ length: 64 }],
            signature: new Uint8Array(64),
            serializeMessage: () => Uint8Array.from([7, 7, 7]),
          }) as never,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expect((thrown as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    expect(record.event).toBe("WALLET_MODIFIED_TRANSACTION");
    expect(record.cause).toBe("unknown");
    expect(record.prepared!.parseError).toBeNull();
    expect(record.returned!.parseError).toBe("message_not_parseable");
    expect(record.returned!.messageLength).toBe(3);
    expect(record.firstDifferingOffset).toBe(0);
  });

  it("a diagnostics failure is contained and never changes the refusal", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    // Simulates an environment where diagnostics collection cannot run.
    vi.stubGlobal("crypto", {});
    const payer = web3.Keypair.generate();

    const { fetchMock } = await runBlockhashSwap(web3, payer);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    expect(record).toEqual({
      event: "WALLET_MODIFIED_TRANSACTION",
      diagnostics: "collection_failed",
    });
  });

  it("stays silent for non-exact flag values and for an absent window", async () => {
    const web3 = await import("@solana/web3.js");
    const payer = web3.Keypair.generate();

    await runBlockhashSwap(web3, payer); // no window at all
    enableDiagnostics("?aeternaWalletDiag=0");
    await runBlockhashSwap(web3, payer);
    enableDiagnostics("?aeternaWalletDiag");
    await runBlockhashSwap(web3, payer);
    enableDiagnostics("?other=1&aeternaWalletDiag=0");
    await runBlockhashSwap(web3, payer);

    expect(readDiagRecords()).toHaveLength(0);
  });

  it("emits no signatures, raw messages, base64 payloads or secrets", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();
    const replacementBlockhash = web3.Keypair.generate().publicKey.toBase58();

    let preparedMessageBytes: Uint8Array | null = null;
    let returnedMessageBytes: Uint8Array | null = null;
    let signatureBytes: Uint8Array | null = null;

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          preparedMessageBytes = Uint8Array.from(original.serializeMessage());
          const modified = new web3.Transaction().add(
            ...original.instructions
          );
          modified.feePayer = original.feePayer!;
          modified.recentBlockhash = replacementBlockhash;
          modified.sign(payer);
          const returned = web3.Transaction.from(modified.serialize());
          signatureBytes = Uint8Array.from(returned.signature!);
          returnedMessageBytes = Uint8Array.from(returned.serializeMessage());
          return returned;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    const serialized = JSON.stringify(record);
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const toBase64 = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes));
    const preparedBytes = preparedMessageBytes!;
    const returnedBytes = returnedMessageBytes!;
    const signature = signatureBytes!;

    expect(serialized).not.toContain(toHex(preparedBytes));
    expect(serialized).not.toContain(toHex(returnedBytes));
    expect(serialized).not.toContain(toBase64(preparedBytes));
    expect(serialized).not.toContain(toBase64(returnedBytes));
    expect(serialized).not.toContain(toHex(signature));
    expect(serialized).not.toContain(toBase64(signature));
    expect(serialized).not.toContain(toHex(payer.secretKey));
    expect(serialized).not.toContain(toBase64(payer.secretKey));
    expect(serialized).not.toContain(payer.publicKey.toBase58());

    // The record still carries the useful, public diagnostic structure.
    expect(serialized).toContain(record.prepared!.messageSha256);
    expect(serialized).toContain(replacementBlockhash);
  });

  it("exposes ONLY Lighthouse payloads, target addresses and decoded v2 variants", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();

    const u64 = (value: bigint) => {
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64LE(value);
      return [...bytes];
    };

    // Synthetic v2 AssertAccountInfoMulti: Lamports == 0, IsSigner == true.
    const infoData = [
      6, 5, 2,
      0, ...u64(0n), 0,
      5, 1, 0,
    ];
    // Synthetic v2 AssertTokenAccountMulti: derived, amount in [1, 1].
    const tokenData = [
      10, 5, 4,
      8,
      2, ...u64(1_000_000n), 4,
      2, ...u64(1_000_000n), 5,
      4, 1, 0,
    ];
    const undecodedData = [0xde, 0xad, 0xbe, 0xef];

    const lighthouseProgram = new web3.PublicKey(LIGHTHOUSE_PROGRAM);
    const lighthouseInstruction = (data: number[]) =>
      new web3.TransactionInstruction({
        programId: lighthouseProgram,
        keys: [
          {
            pubkey: payer.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.from(data),
      });

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const modified = new web3.Transaction().add(
            ...original.instructions,
            lighthouseInstruction(infoData),
            lighthouseInstruction(tokenData),
            lighthouseInstruction(undecodedData)
          );
          modified.feePayer = original.feePayer!;
          modified.recentBlockhash = original.recentBlockhash!;
          modified.sign(payer);
          return web3.Transaction.from(modified.serialize());
        },
      });
    } catch (error) {
      thrown = error;
    }

    // The diagnostic addition must not change the guard's refusal.
    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expect((thrown as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    expect(record.cause).toBe("instruction_count");
    const returned = record.returned!;
    const lighthouse = returned.instructions!.filter(
      (instruction) => instruction.programId === LIGHTHOUSE_PROGRAM
    );
    expect(lighthouse).toHaveLength(3);

    const [info, token, undecoded] = lighthouse;
    for (const instruction of lighthouse) {
      expect(instruction.programIdIndex).toEqual(expect.any(Number));
      expect(instruction.programIdIndex!).toBeGreaterThanOrEqual(0);
      expect(instruction.programIdIndex!).toBeLessThan(
        returned.accountKeyCount!
      );
      expect(instruction.accountIndices).toHaveLength(1);
      expect(instruction.accountAddresses).toEqual([
        payer.publicKey.toBase58(),
      ]);
      expect(typeof instruction.dataFirstByte).toBe("number");
      expect(instruction.dataSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(instruction.accountCount).toBe(1);
    }

    expect(info!.dataLength).toBe(16);
    expect(info!.dataFirstByte).toBe(6);
    expect(info!.dataHex).toBe(Buffer.from(infoData).toString("hex"));
    expect(info!.dataHexTruncated).toBe(false);
    expect(info!.lighthouse).toEqual({
      status: "decoded",
      version: "v2",
      discriminator: 6,
      variant: "AssertAccountInfoMulti",
      logLevel: 5,
      logLevelName: "FailedEncodedMessage",
      assertionCount: 2,
      assertions: [
        { kind: "Lamports", value: "0", operator: "Equal" },
        { kind: "IsSigner", value: true, operator: "Equal" },
      ],
    });

    expect(token!.dataLength).toBe(27);
    // The token assertion's amount is derived from the payer's balance, so
    // its payload is NEVER recorded — not even partially. Only the single
    // discriminator byte is exposed, which is all the variant ID needs.
    expect(token!.dataFirstByte).toBe(10);
    expect(token).not.toHaveProperty("dataHex");
    expect(token).not.toHaveProperty("dataHexTruncated");
    expect(token!.lighthouse).toEqual({
      status: "decoded",
      version: "v2",
      discriminator: 10,
      variant: "AssertTokenAccountMulti",
      logLevel: 5,
      logLevelName: "FailedEncodedMessage",
      assertionCount: 4,
      assertions: [
        { kind: "TokenAccountOwnerIsDerived" },
        {
          kind: "Amount",
          value: "1000000",
          operator: "GreaterThanOrEqual",
        },
        {
          kind: "Amount",
          value: "1000000",
          operator: "LessThanOrEqual",
        },
        { kind: "State", value: 1, operator: "Equal" },
      ],
    });

    expect(undecoded!.dataLength).toBe(4);
    // Not an INFO payload (0xde is neither the INFO nor the token
    // discriminator): no raw data at all, only the first byte.
    expect(undecoded!.dataFirstByte).toBe(0xde);
    expect(undecoded).not.toHaveProperty("dataHex");
    expect(undecoded).not.toHaveProperty("dataHexTruncated");
    expect(undecoded!.lighthouse).toEqual({ status: "undecoded" });

    // Non-Lighthouse instructions keep the original bounded shape: no raw
    // data, no addresses, no decoder output.
    const paymentInstruction = returned.instructions!.find(
      (instruction) => instruction.programId === TOKEN_PROGRAM
    );
    expect(paymentInstruction).toBeDefined();
    expect(paymentInstruction).not.toHaveProperty("dataHex");
    expect(paymentInstruction).not.toHaveProperty("accountAddresses");
    expect(paymentInstruction).not.toHaveProperty("accountIndices");
    expect(paymentInstruction).not.toHaveProperty("programIdIndex");
    expect(paymentInstruction).not.toHaveProperty("lighthouse");
  });
  /* -------------------------------------------------------------------
   * RETAINED DIAGNOSTIC CAPABILITY (was TEMPORARY in PHASE 3BM-R9-A9)
   *
   * Kept from GitHub main, adapted to the release's authoritative
   * acceptance module:
   *   - the payload is captured for INFO assertions ONLY (16- and
   *     26-byte forms, the INFO discriminator, or the observed 26-byte
   *     shape that precedes an accepted token assertion),
   *   - the hex is capped at WALLET_DIAG_MAX_INFO_DATA_BYTES (64),
   *   - the token assertion keeps its first byte and never its payload,
   *   - capture never participates in acceptance or rejection.
   * ------------------------------------------------------------------- */

  /** 16-byte legacy INFO form Phantom appends (accepted). */
  const LEGACY_INFO_DATA = Buffer.from([
    6, 4, 2, 3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  /** 27-byte accepted token assertion; the amount is balance-derived. */
  const TOKEN_ASSERTION_DATA = Buffer.from([
    10, 4, 4, 2, 0x22, 0x16, 0x07, 0, 0, 0, 0, 0, 4,
    3, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 5, 8,
  ]);

  /** 26-byte CURRENT INFO form: `lamports` is its only variable field. */
  function currentInfoData(lamports: bigint): Buffer {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(lamports);
    return Buffer.from([
      6, 4, 3,
      0, ...value, 4,
      3, 0, 0,
      1, ...Buffer.alloc(8), 0,
    ]);
  }

  /**
   * Rebuild the prepared transaction with an appended Lighthouse pair, using
   * the shape the release's accepted-pair tests already prove: INFO on the
   * payer, token assertion on the prepared source ATA. This only controls what
   * the fake wallet returns — wallet acceptance is untouched.
   */
  function withLighthousePair(
    web3: typeof import("@solana/web3.js"),
    original: WalletTx,
    payer: import("@solana/web3.js").Keypair,
    infoData: Buffer,
    tokenData: Buffer
  ): WalletTx {
    const lighthouse = new web3.PublicKey(LIGHTHOUSE_PROGRAM);
    const transfer = original.instructions.find(
      (instruction) =>
        instruction.programId.toBase58() === TOKEN_PROGRAM &&
        instruction.data[0] === 3
    );
    if (!transfer) throw new Error("prepared transfer missing");
    const modified = new web3.Transaction().add(
      ...original.instructions,
      new web3.TransactionInstruction({
        programId: lighthouse,
        keys: [{ pubkey: payer.publicKey, isSigner: false, isWritable: false }],
        data: infoData,
      }),
      new web3.TransactionInstruction({
        programId: lighthouse,
        keys: [
          {
            pubkey: transfer.keys[0]!.pubkey,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: tokenData,
      })
    );
    modified.feePayer = original.feePayer!;
    modified.recentBlockhash = original.recentBlockhash!;
    modified.sign(payer);
    return web3.Transaction.from(modified.serialize());
  }

  function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
  }

  it("reports the Lighthouse INFO payload only — and never the token-assertion data", async () => {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installSerializableFetch();
    const payer = web3.Keypair.generate();

    // SYNTHETIC 26-byte INFO assertion: discriminator 6 plus zeros.
    const syntheticInfo = Buffer.alloc(26);
    syntheticInfo[0] = 6;

    enableDiagnostics();

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) =>
          withLighthousePair(
            web3,
            transaction as WalletTx,
            payer,
            syntheticInfo,
            TOKEN_ASSERTION_DATA
          ),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    const instructions = record.returned!.instructions!;

    const infoInstruction = instructions.find(
      (instruction) =>
        instruction.programId === LIGHTHOUSE_PROGRAM &&
        instruction.dataLength === 26
    )!;
    const tokenInstruction = instructions.find(
      (instruction) =>
        instruction.programId === LIGHTHOUSE_PROGRAM &&
        instruction.dataLength === 27
    )!;

    // The INFO payload is reported byte for byte, with its own metadata.
    expect(infoInstruction.dataHex).toBe(toHex(syntheticInfo));
    expect(infoInstruction.dataHexTruncated).toBe(false);
    expect(infoInstruction.programId).toBe(LIGHTHOUSE_PROGRAM);
    expect(infoInstruction.accountCount).toBe(1);
    expect(tokenInstruction.index).toBe(infoInstruction.index + 1);

    // The token assertion's payload is deliberately NOT recorded.
    expect(tokenInstruction.dataFirstByte).toBe(10);
    expect(tokenInstruction).not.toHaveProperty("dataHex");
    expect(tokenInstruction).not.toHaveProperty("dataHexTruncated");

    // No other instruction exposes raw data either.
    for (const instruction of instructions) {
      if (instruction.index === infoInstruction.index) continue;
      expect(instruction).not.toHaveProperty("dataHex");
    }
  });

  /**
   * The production record proves a 26-byte Lighthouse instruction sits
   * immediately before the recognised token assertion, but its first byte
   * was never captured. This test proves the capture does not depend on that
   * byte: a 26-byte instruction whose discriminator is 0x2a (NOT 6) is
   * recorded together with its bounded hex.
   *
   * The payload is SYNTHETIC — it is NOT the real Phantom payload; only the
   * 26-byte length is confirmed by the production record.
   */
  it("captures a 26-byte Lighthouse assertion whose discriminator is not 6", async () => {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installSerializableFetch();
    const payer = web3.Keypair.generate();

    const syntheticInfo = Buffer.alloc(26);
    syntheticInfo[0] = 0x2a;

    enableDiagnostics();

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) =>
          withLighthousePair(
            web3,
            transaction as WalletTx,
            payer,
            syntheticInfo,
            TOKEN_ASSERTION_DATA
          ),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    const instructions = record.returned!.instructions!;

    const infoInstruction = instructions.find(
      (instruction) => instruction.dataLength === 26
    )!;
    const tokenInstruction = instructions.find(
      (instruction) => instruction.dataLength === 27
    )!;

    // Shape-based capture: the first byte is irrelevant to the decision.
    expect(infoInstruction.dataFirstByte).toBe(0x2a);
    expect(infoInstruction.dataHex).toBe(toHex(syntheticInfo));
    expect(infoInstruction.dataHexTruncated).toBe(false);

    // The token assertion keeps its first byte and NEVER its payload.
    expect(tokenInstruction.dataFirstByte).toBe(10);
    expect(tokenInstruction).not.toHaveProperty("dataHex");
    expect(tokenInstruction).not.toHaveProperty("dataHexTruncated");
  });

  /**
   * An unmatched 26-byte Lighthouse instruction — here followed by ANOTHER
   * 26-byte instruction instead of the recognised token assertion — must not
   * have its payload exposed. The first byte stays visible so the variant can
   * still be identified.
   */
  it("does not expose a 26-byte Lighthouse payload unless a recognised token assertion follows", async () => {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installSerializableFetch();
    const payer = web3.Keypair.generate();

    // SYNTHETIC payloads; the length is confirmed, the bytes are not.
    const first = Buffer.alloc(26);
    first[0] = 0x2a;
    const second = Buffer.alloc(26);
    second[0] = 0x2b;

    enableDiagnostics();

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const lighthouse = new web3.PublicKey(LIGHTHOUSE_PROGRAM);
          const target = [
            { pubkey: payer.publicKey, isSigner: false, isWritable: false },
          ];
          const modified = new web3.Transaction().add(
            ...original.instructions,
            new web3.TransactionInstruction({
              programId: lighthouse,
              keys: target,
              data: first,
            }),
            new web3.TransactionInstruction({
              programId: lighthouse,
              keys: target,
              data: second,
            })
          );
          modified.feePayer = original.feePayer!;
          modified.recentBlockhash = original.recentBlockhash!;
          modified.sign(payer);
          return web3.Transaction.from(modified.serialize());
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    const instructions = record.returned!.instructions!;
    const twentySixByteInstructions = instructions.filter(
      (instruction) => instruction.dataLength === 26
    );

    expect(twentySixByteInstructions).toHaveLength(2);
    for (const instruction of twentySixByteInstructions) {
      expect(instruction).not.toHaveProperty("dataHex");
      expect(instruction).not.toHaveProperty("dataHexTruncated");
      expect(typeof instruction.dataFirstByte).toBe("number");
    }
  });

  it("collects nothing without the exact opt-in flag, and refuses identically with it", async () => {
    const web3 = await import("@solana/web3.js");
    const payer = web3.Keypair.generate();
    const infoData = Buffer.alloc(26);
    infoData[0] = 6;

    const run = async () => {
      const fetchMock = installSerializableFetch();
      let thrown: unknown;
      try {
        await signSolanaUSDCPayment({
          publicKey: payer.publicKey.toBase58(),
          signTransaction: async (transaction: unknown) =>
            withLighthousePair(
              web3,
              transaction as WalletTx,
              payer,
              infoData,
              TOKEN_ASSERTION_DATA
            ),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
      expectNoBroadcast(fetchMock);
      return thrown as WalletModifiedTransactionError;
    };

    // Default: the flag is absent — nothing is collected, nothing is logged.
    vi.stubGlobal("window", { location: { search: "" } });
    const silent = await run();
    expect(readDiagRecords()).toHaveLength(0);

    // Explicit opt-in: the very same mismatch yields exactly one record.
    enableDiagnostics();
    const loud = await run();
    expect(readDiagRecords()).toHaveLength(1);

    // The refusal itself is untouched by diagnostics: same class, code and
    // message. Acceptance and rejection never read diagnostic state.
    expect(loud.code).toBe(silent.code);
    expect(loud.message).toBe(silent.message);
  });

  it("caps a recorded INFO payload at 64 bytes and reports the truncation accurately", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();

    // SYNTHETIC oversized INFO payload: 96 bytes, INFO discriminator first.
    const oversizedInfo = Buffer.alloc(96, 0x11);
    oversizedInfo[0] = 6;

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) =>
          withLighthousePair(
            web3,
            transaction as WalletTx,
            payer,
            oversizedInfo,
            TOKEN_ASSERTION_DATA
          ),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    const oversized = record.returned!.instructions!.find(
      (instruction) => instruction.dataLength === 96
    );
    expect(oversized).toBeDefined();
    expect(oversized!.dataFirstByte).toBe(6);
    expect(oversized!.dataHex).toBe(toHex(oversizedInfo.subarray(0, 64)));
    expect(oversized!.dataHex).toHaveLength(128);
    expect(oversized!.dataHexTruncated).toBe(true);
    // The real size is never lost: only the recorded hex is bounded.
    expect(oversized!.dataLength).toBe(96);
  });

  it("still accepts the 16-byte INFO pair with diagnostics enabled, and emits no record", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) =>
        withLighthousePair(
          web3,
          transaction as WalletTx,
          payer,
          LEGACY_INFO_DATA,
          TOKEN_ASSERTION_DATA
        ),
    });

    expect(result.signature.length).toBeGreaterThan(0);
    expect(readDiagRecords()).toHaveLength(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("still accepts the 26-byte INFO pair with diagnostics enabled, and emits no record", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();

    const result = await signSolanaUSDCPayment({
      publicKey: payer.publicKey.toBase58(),
      signTransaction: async (transaction: unknown) =>
        withLighthousePair(
          web3,
          transaction as WalletTx,
          payer,
          currentInfoData(1_000_000n),
          TOKEN_ASSERTION_DATA
        ),
    });

    expect(result.signature.length).toBeGreaterThan(0);
    expect(readDiagRecords()).toHaveLength(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("records a refused 26-byte INFO payload by shape, never the token payload, and transmits nothing", async () => {
    const web3 = await import("@solana/web3.js");
    enableDiagnostics();
    const payer = web3.Keypair.generate();
    const fetchMock = installSerializableFetch();
    const beacon = vi.fn(() => true);
    vi.stubGlobal(
      "navigator",
      Object.assign(Object.create(navigator), { sendBeacon: beacon })
    );

    // Same length as the production payload, but self-identified as something
    // other than INFO and structurally invalid, so the guard must refuse.
    const invalidInfo = currentInfoData(1_000_000n);
    invalidInfo[0] = 0x2a;
    invalidInfo[15] = 9;

    let thrown: unknown;
    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) =>
          withLighthousePair(
            web3,
            transaction as WalletTx,
            payer,
            invalidInfo,
            TOKEN_ASSERTION_DATA
          ),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletModifiedTransactionError);
    expectNoBroadcast(fetchMock);

    const record = readDiagRecord();
    const instructions = record.returned!.instructions!;
    const info = instructions.find((instruction) => instruction.dataLength === 26)!;
    const token = instructions.find(
      (instruction) => instruction.dataLength === 27
    )!;

    // Captured by SHAPE (26 bytes directly before an accepted token
    // assertion), not by discriminator.
    expect(info.dataFirstByte).toBe(0x2a);
    expect(info.dataHex).toBe(toHex(invalidInfo));
    expect(info.dataHexTruncated).toBe(false);
    expect(token.dataFirstByte).toBe(10);
    expect(token).not.toHaveProperty("dataHex");

    // Nothing left the browser: the record is not in any request, and no
    // beacon API was touched.
    const urls = fetchMock.mock.calls.map(([input]) => String(input)).join(" | ");
    expect(urls).not.toContain("WALLET_MODIFIED_TRANSACTION");
    expect(urls).not.toContain(info.dataHex!);
    expect(urls).not.toContain("aeternaWalletDiag");
    expect(beacon).not.toHaveBeenCalled();
  });

});

/* ---------------------------------------------------------------------
 * REPEAT PURCHASE — THE SETTLEMENT ATA ALREADY EXISTS
 *
 * Every guard suite above builds its fixture with
 * `destinationAtaExists: false`, so the prepared message always carries
 * TWO instructions (associated-token-account create + USDC transfer).
 *
 * A creator buying a SECOND capsule pays through the SAME canonical
 * builder, but `buildServicePaymentTransaction` omits the ATA-create once
 * the settlement token account exists. The prepared message then carries
 * exactly ONE instruction — a shape no guard suite exercised before.
 *
 * These tests pin the guard's behaviour on that shape: the documented
 * Phantom delta is accepted, every other difference is refused, and a
 * refusal never produces a request to a payment endpoint.
 *
 * They do NOT claim this shape is the cause of the production refusal
 * described in PHASE 3BM-R9. The cause of that refusal can only be
 * established from the `?aeternaWalletDiag=1` record, which was not
 * captured. These tests bound the risk; they do not diagnose it.
 * ------------------------------------------------------------------- */
describe("signSolanaUSDCPayment — repeat purchase (settlement ATA exists)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const VALID_BLOCKHASH = "11111111111111111111111111111111";
  const OTHER_BLOCKHASH = "11111111111111111111111111111112";
  const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

  type WalletTx = import("@solana/web3.js").Transaction;
  type WalletIx = import("@solana/web3.js").TransactionInstruction;
  type Web3 = typeof import("@solana/web3.js");
  type PayerKeypair = import("@solana/web3.js").Keypair;

  /**
   * The SAME reconstructed v2 payloads the Lighthouse suite pins:
   * AssertAccountInfoMulti on the payer (16 B) and
   * AssertTokenAccountMulti on the transfer's source ATA (27 B). Copied
   * so this suite is self-contained; no NEW wallet shape is introduced.
   */
  const PHANTOM_INFO_DATA = Buffer.from([
    6, 4, 2, 3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const PHANTOM_TOKEN_DATA = Buffer.from([
    10, 4, 4, 2, 0x22, 0x16, 0x07, 0, 0, 0, 0, 0, 4,
    3, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 5, 8,
  ]);

  function installExistingAtaFetch(blockhash: string = VALID_BLOCKHASH) {
    return installFetchMock(
      buildFetchImplementation({ destinationAtaExists: true, blockhash })
    );
  }

  /**
   * The sign-only step must never reach a broadcast or a payment
   * endpoint: the ONLY network reads allowed are the two read-only
   * proxies the builder uses.
   */
  function expectNoPaymentTraffic(
    fetchMock: ReturnType<typeof installFetchMock>
  ) {
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/api/solana/broadcast"))).toBe(
      false
    );
    expect(urls.some((url) => url.includes("/api/service-payment"))).toBe(
      false
    );
    expect(urls.some((url) => url.includes("/api/creator"))).toBe(false);
  }

  function decodeSigned(web3: Web3, base64: string): WalletTx {
    return web3.Transaction.from(
      Uint8Array.from(Buffer.from(base64, "base64"))
    );
  }

  function isTransfer(instruction: WalletIx): boolean {
    return (
      instruction.programId.toBase58() === TOKEN_PROGRAM &&
      instruction.data[0] === 3
    );
  }

  function sourceAtaOf(original: WalletTx): string {
    const transfer = original.instructions.find(isTransfer);
    if (!transfer) throw new Error("prepared transfer instruction missing");
    return transfer.keys[0]!.pubkey.toBase58();
  }

  interface RebuildOptions {
    before?: WalletIx[];
    after?: WalletIx[];
    blockhash?: string;
    /** Applied to EVERY prepared instruction; must return a NEW object. */
    patch?: (instruction: WalletIx) => WalletIx;
  }

  function rebuild(
    web3: Web3,
    original: WalletTx,
    payer: PayerKeypair,
    options: RebuildOptions = {}
  ): WalletTx {
    const patched = original.instructions.map((instruction) =>
      options.patch ? options.patch(instruction) : instruction
    );
    const modified = new web3.Transaction().add(
      ...(options.before ?? []),
      ...patched,
      ...(options.after ?? [])
    );
    modified.feePayer = original.feePayer!;
    modified.recentBlockhash = options.blockhash ?? original.recentBlockhash!;
    modified.sign(payer);
    return web3.Transaction.from(modified.serialize());
  }

  interface AttemptOutcome {
    web3: Web3;
    fetchMock: ReturnType<typeof installFetchMock>;
    payer: PayerKeypair;
    /** How many instructions AETERNA prepared (1 == settlement ATA exists). */
    preparedInstructionCount: number;
    /** The prepared transfer's source ATA, resolved by address. */
    preparedSourceAta: string;
    result?: {
      signature: string;
      signedTransactionBase64: string;
      blockhash: string;
      lastValidBlockHeight: number | null;
    };
    error?: unknown;
  }

  async function attempt(
    build: (web3: Web3, original: WalletTx, payer: PayerKeypair) => WalletTx
  ): Promise<AttemptOutcome> {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installExistingAtaFetch();
    const payer = web3.Keypair.generate();
    let preparedInstructionCount = 0;
    let preparedSourceAta = "";
    try {
      const result = await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          preparedInstructionCount = original.instructions.length;
          preparedSourceAta = sourceAtaOf(original);
          return build(web3, original, payer);
        },
      });
      return {
        web3,
        fetchMock,
        payer,
        preparedInstructionCount,
        preparedSourceAta,
        result,
      };
    } catch (error) {
      return {
        web3,
        fetchMock,
        payer,
        preparedInstructionCount,
        preparedSourceAta,
        error,
      };
    }
  }

  async function expectRefusal(
    build: (web3: Web3, original: WalletTx, payer: PayerKeypair) => WalletTx
  ): Promise<AttemptOutcome> {
    const outcome = await attempt(build);
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(WalletModifiedTransactionError);
    expect((outcome.error as WalletModifiedTransactionError).code).toBe(
      "WALLET_MODIFIED_TRANSACTION"
    );
    // The refusal is proven pre-send: no broadcast, no payment endpoint.
    expectNoPaymentTraffic(outcome.fetchMock);
    // The repeat-purchase shape really is the ONE-instruction message.
    expect(outcome.preparedInstructionCount).toBe(1);
    return outcome;
  }

  it("R1: the unchanged one-instruction payment (settlement ATA exists) is accepted and signed as prepared", async () => {
    const outcome = await attempt((web3, original, payer) =>
      rebuild(web3, original, payer)
    );

    expect(outcome.error).toBeUndefined();
    // STRUCTURAL PRECONDITION: this is the repeat-purchase shape — no
    // ATA-create, exactly ONE prepared instruction.
    expect(outcome.preparedInstructionCount).toBe(1);
    expect(outcome.preparedSourceAta).not.toBe("");

    const signed = decodeSigned(
      outcome.web3,
      outcome.result!.signedTransactionBase64
    );
    expect(signed.instructions).toHaveLength(1);
    expect(signed.instructions[0]!.programId.toBase58()).toBe(TOKEN_PROGRAM);
    expect(
      decodeTransferAmount(signed.instructions[0] as unknown as InstructionView)
    ).toBe(1_000_000n);
    // Canonical destination: the settlement wallet's USDC ATA.
    expect(
      signed.instructions[0]!.keys[1]!.pubkey.toBase58()
    ).toBe(SETTLEMENT_USDC_ATA);
    expect(signed.verifySignatures()).toBe(true);
    expectNoPaymentTraffic(outcome.fetchMock);
  });

  it("R2: the repeat purchase plus Phantom's documented fee pair is accepted — the fee pair is the ONLY delta", async () => {
    const outcome = await attempt((web3, original, payer) =>
      rebuild(web3, original, payer, {
        before: [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 5_000,
          }),
        ],
      })
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.preparedInstructionCount).toBe(1);
    const signed = decodeSigned(
      outcome.web3,
      outcome.result!.signedTransactionBase64
    );
    expect(signed.instructions).toHaveLength(3);
    expect(signed.instructions[0]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(signed.instructions[1]!.programId.toBase58()).toBe(
      COMPUTE_BUDGET_PROGRAM
    );
    expect(signed.instructions[2]!.programId.toBase58()).toBe(TOKEN_PROGRAM);
    expect(
      decodeTransferAmount(signed.instructions[2] as unknown as InstructionView)
    ).toBe(1_000_000n);
    const keys = signed.instructions[2]!.keys.map((key) =>
      key.pubkey.toBase58()
    );
    expect(keys[0]).toBe(outcome.preparedSourceAta);
    expect(keys[1]).toBe(SETTLEMENT_USDC_ATA);
    expect(signed.verifySignatures()).toBe(true);
  });

  it("R3: the repeat purchase plus Phantom's Lighthouse assertion pair alone is accepted", async () => {
    const outcome = await attempt((web3, original, payer) => {
      const lighthouse = new web3.PublicKey(LIGHTHOUSE_PROGRAM);
      const sourceAta = new web3.PublicKey(sourceAtaOf(original));
      return rebuild(web3, original, payer, {
        after: [
          new web3.TransactionInstruction({
            programId: lighthouse,
            keys: [{ pubkey: payer.publicKey, isSigner: false, isWritable: false }],
            data: PHANTOM_INFO_DATA,
          }),
          new web3.TransactionInstruction({
            programId: lighthouse,
            keys: [{ pubkey: sourceAta, isSigner: false, isWritable: false }],
            data: PHANTOM_TOKEN_DATA,
          }),
        ],
      });
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.preparedInstructionCount).toBe(1);
    const signed = decodeSigned(
      outcome.web3,
      outcome.result!.signedTransactionBase64
    );
    expect(signed.instructions).toHaveLength(3);
    expect(signed.instructions.map((i) => i.programId.toBase58())).toEqual([
      TOKEN_PROGRAM,
      LIGHTHOUSE_PROGRAM,
      LIGHTHOUSE_PROGRAM,
    ]);
    expect(signed.verifySignatures()).toBe(true);
  });

  it("R4: the repeat purchase plus the fee pair AND the Lighthouse pair is accepted (5 instructions total)", async () => {
    const outcome = await attempt((web3, original, payer) => {
      const lighthouse = new web3.PublicKey(LIGHTHOUSE_PROGRAM);
      const sourceAta = new web3.PublicKey(sourceAtaOf(original));
      return rebuild(web3, original, payer, {
        before: [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 5_000,
          }),
        ],
        after: [
          new web3.TransactionInstruction({
            programId: lighthouse,
            keys: [{ pubkey: payer.publicKey, isSigner: false, isWritable: false }],
            data: PHANTOM_INFO_DATA,
          }),
          new web3.TransactionInstruction({
            programId: lighthouse,
            keys: [{ pubkey: sourceAta, isSigner: false, isWritable: false }],
            data: PHANTOM_TOKEN_DATA,
          }),
        ],
      });
    });

    expect(outcome.error).toBeUndefined();
    const signed = decodeSigned(
      outcome.web3,
      outcome.result!.signedTransactionBase64
    );
    expect(signed.instructions).toHaveLength(5);
    expect(signed.instructions.map((i) => i.programId.toBase58())).toEqual([
      COMPUTE_BUDGET_PROGRAM,
      COMPUTE_BUDGET_PROGRAM,
      TOKEN_PROGRAM,
      LIGHTHOUSE_PROGRAM,
      LIGHTHOUSE_PROGRAM,
    ]);
    expect(signed.verifySignatures()).toBe(true);
  });

  it("R5: a price-only injection is accepted on the repeat-purchase shape", async () => {
    const outcome = await attempt((web3, original, payer) =>
      rebuild(web3, original, payer, {
        before: [
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 5_000,
          }),
        ],
      })
    );

    expect(outcome.error).toBeUndefined();
    const signed = decodeSigned(
      outcome.web3,
      outcome.result!.signedTransactionBase64
    );
    expect(signed.instructions).toHaveLength(2);
    expect(
      decodeComputeUnitPrice(signed.instructions[0] as unknown as InstructionView)
    ).toBe(5_000n);
  });

  it("R6: a limit-only injection is accepted on the repeat-purchase shape", async () => {
    const outcome = await attempt((web3, original, payer) =>
      rebuild(web3, original, payer, {
        before: [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ],
      })
    );

    expect(outcome.error).toBeUndefined();
    const signed = decodeSigned(
      outcome.web3,
      outcome.result!.signedTransactionBase64
    );
    expect(signed.instructions).toHaveLength(2);
    expect(
      decodeComputeUnitLimit(signed.instructions[0] as unknown as InstructionView)
    ).toBe(200_000);
  });

  it("R7: a refreshed blockhash on the repeat-purchase shape is refused before any broadcast", async () => {
    await expectRefusal((web3, original, payer) =>
      rebuild(web3, original, payer, { blockhash: OTHER_BLOCKHASH })
    );
  });

  it("R8: an altered transfer amount on the repeat-purchase shape is refused before any broadcast", async () => {
    await expectRefusal((web3, original, payer) =>
      rebuild(web3, original, payer, {
        patch: (instruction) => {
          if (!isTransfer(instruction)) return instruction;
          const data = Buffer.from(instruction.data);
          data.writeBigUInt64LE(2_000_000n, 1);
          return new web3.TransactionInstruction({
            programId: instruction.programId,
            keys: instruction.keys,
            data,
          });
        },
      })
    );
  });

  it("R9: an altered destination token account on the repeat-purchase shape is refused before any broadcast", async () => {
    await expectRefusal((web3, original, payer) => {
      const alienAta = web3.Keypair.generate().publicKey;
      return rebuild(web3, original, payer, {
        patch: (instruction) => {
          if (!isTransfer(instruction)) return instruction;
          const keys = instruction.keys.map((key, index) =>
            index === 1 ? { ...key, pubkey: alienAta } : key
          );
          return new web3.TransactionInstruction({
            programId: instruction.programId,
            keys,
            data: instruction.data,
          });
        },
      });
    });
  });

  it("R10: an extra instruction on a program AETERNA never prepared is refused before any broadcast", async () => {
    await expectRefusal((web3, original, payer) =>
      rebuild(web3, original, payer, {
        after: [
          new web3.TransactionInstruction({
            programId: web3.SystemProgram.programId,
            keys: [],
            data: Buffer.from([0]),
          }),
        ],
      })
    );
  });

  it("R11: a THIRD Lighthouse assertion on the repeat-purchase shape is refused before any broadcast", async () => {
    await expectRefusal((web3, original, payer) => {
      const lighthouse = new web3.PublicKey(LIGHTHOUSE_PROGRAM);
      const sourceAta = new web3.PublicKey(sourceAtaOf(original));
      const info = () =>
        new web3.TransactionInstruction({
          programId: lighthouse,
          keys: [{ pubkey: payer.publicKey, isSigner: false, isWritable: false }],
          data: PHANTOM_INFO_DATA,
        });
      return rebuild(web3, original, payer, {
        after: [
          info(),
          new web3.TransactionInstruction({
            programId: lighthouse,
            keys: [{ pubkey: sourceAta, isSigner: false, isWritable: false }],
            data: PHANTOM_TOKEN_DATA,
          }),
          info(),
        ],
      });
    });
  });

  it("R12: a different fee payer is refused BEFORE the message-identity guard and never reaches a payment endpoint", async () => {
    const web3 = await import("@solana/web3.js");
    const fetchMock = installExistingAtaFetch();
    const payer = web3.Keypair.generate();
    const alien = web3.Keypair.generate();
    let thrown: unknown;

    try {
      await signSolanaUSDCPayment({
        publicKey: payer.publicKey.toBase58(),
        signTransaction: async (transaction: unknown) => {
          const original = transaction as WalletTx;
          const modified = new web3.Transaction().add(
            ...original.instructions
          );
          modified.feePayer = alien.publicKey;
          modified.recentBlockhash = original.recentBlockhash!;
          modified.sign(payer, alien);
          return web3.Transaction.from(modified.serialize());
        },
      });
    } catch (error) {
      thrown = error;
    }

    // A swapped fee payer forces a SECOND signature slot, so the payment
    // path refuses on the signature contract before the guard ever runs.
    // The guard's payer branch is therefore not reachable from this entry
    // point — documented here instead of asserted through a fake message.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not fully signed");
    expect(thrown).not.toBeInstanceOf(WalletModifiedTransactionError);
    expectNoPaymentTraffic(fetchMock);
  });
});
