/**
 * Phase B — fund-only storage payment contract.
 *
 * fundCreatorPaidStorage must:
 *   - pass the EXACT server-quoted atomic amount to irys.fund();
 *   - return the Solana funding transaction signature;
 *   - NEVER call upload() (upload is Phase C/D);
 *   - fail closed on a malformed/non-server amount.
 *
 * Adapter: toCreatorIrysWallet must map the AETERNA wallet context
 * object onto the Irys injected-provider interface without exposing
 * keys.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

const calls: {
  fundArgs: unknown[];
  uploadCalls: number;
  priceArgs: number[];
  balanceValues: string[];
} = { fundArgs: [], uploadCalls: 0, priceArgs: [], balanceValues: [] };

let uploadShouldFail = false;

vi.mock("@irys/web-upload", () => ({
  WebUploader: () => ({
    withProvider: (provider: unknown) => {
      calls.provider = provider;
      return {
        withRpc: () => ({ build: async () => fakeIrys }),
        build: async () => fakeIrys,
      };
    },
  }),
}));

vi.mock("@irys/web-upload-solana", () => ({ WebUSDCSolana: class {} }));

const fakeIrys = {
  getPrice: async (size: number) => {
    calls.priceArgs.push(size);
    return { toString: () => "0" };
  },
  getBalance: async () => ({ toString: () => "0" }),
  fund: async (amount: { toString(): string }) => {
    calls.fundArgs.push(amount);
    if (uploadShouldFail) throw new Error("node down");
    return { id: "SolanaFundingSignature1111111111111111111111111" };
  },
  upload: async () => {
    calls.uploadCalls += 1;
    return { id: "SHOULD_NOT_BE_USED" };
  },
};

import {
  fundCreatorPaidStorage,
  toCreatorIrysWallet,
} from "./../../src/lib/storage/creatorIrys";

const WALLET_ACCOUNT = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function aeternaWallet(overrides: Record<string, unknown> = {}) {
  return {
    account: WALLET_ACCOUNT,
    signMessage: async (m: Uint8Array) => ({ signature: m }),
    signAndSendTransaction: async () => ({
      signature: "AdapterSignature111111111111111111111111111",
    }),
    ...overrides,
  };
}

describe("Phase B fund-only storage payment", () => {
  beforeEach(() => {
    calls.fundArgs = [];
    calls.uploadCalls = 0;
    calls.priceArgs = [];
    uploadShouldFail = false;
  });

  it("funds with the EXACT server-quoted atomic amount and returns the funding signature", async () => {
    const w = toCreatorIrysWallet(aeternaWallet());
    const result = await fundCreatorPaidStorage("1000000", w);
    expect(result.fundingSignature).toBe(
      "SolanaFundingSignature1111111111111111111111111"
    );
    expect(String(calls.fundArgs[0])).toBe("1000000");
  });

  it("NEVER calls upload (upload is Phase C/D)", async () => {
    const w = toCreatorIrysWallet(aeternaWallet());
    await fundCreatorPaidStorage("1000000", w);
    expect(calls.uploadCalls).toBe(0);
  });

  it("fails closed on a malformed / non-server atomic amount", async () => {
    const w = toCreatorIrysWallet(aeternaWallet());
    await expect(fundCreatorPaidStorage("1.5", w)).rejects.toThrow(
      /expectedAmountAtomic/
    );
    await expect(fundCreatorPaidStorage("0", w)).rejects.toThrow(
      /expectedAmountAtomic/
    );
    await expect(fundCreatorPaidStorage("-5", w)).rejects.toThrow(
      /expectedAmountAtomic/
    );
    expect(calls.fundArgs).toHaveLength(0);
  });

  it("fails closed when fund() returns no signature", async () => {
    uploadShouldFail = true;
    const w = toCreatorIrysWallet(aeternaWallet());
    await expect(fundCreatorPaidStorage("1000000", w)).rejects.toThrow(
      /Irys funding failed/
    );
  });

  it("adapter maps the AETERNA wallet onto the Irys provider interface", async () => {
    const w = toCreatorIrysWallet(aeternaWallet());
    expect((w.publicKey as PublicKey).toBuffer()).toBeDefined();
    expect((w.publicKey as PublicKey).toBase58()).toBe(WALLET_ACCOUNT);

    const msg = new Uint8Array([1, 2, 3]);
    const signed = await w.signMessage(msg);
    expect(signed).toBe(msg); // passthrough of the wallet signature bytes

    const sig = await w.sendTransaction({ fake: "tx" }, { fake: "connection" });
    expect(sig).toBe("AdapterSignature111111111111111111111111111");
  });

  it("adapter rejects a wallet without account", () => {
    expect(() => toCreatorIrysWallet({ account: "" } as never)).toThrow(
      /wallet account is required/
    );
  });
});
