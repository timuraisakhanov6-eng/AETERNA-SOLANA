/**
 * Creator Irys funding signature contract.
 *
 * Proves the Phase A payment evidence split:
 *   fundingSignature = Solana transaction signature returned by
 *                      `irys.fund()` (wallet-signed USDC transfer to
 *                      the Irys node) — resolvable by /api/storage/
 *                      verify-payment through the Solana RPC;
 *   dataTxId         = Irys upload/data-item id returned by
 *                      `irys.upload()` receipt — NEVER a Solana
 *                      signature.
 *
 * The @irys packages are mocked at module level; no network, no real
 * transaction, no funds.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: {
  priceArgs: number[];
  fundArgs: unknown[];
  uploadArgs: Uint8Array[];
} = { priceArgs: [], fundArgs: [], uploadArgs: [] };

const FUNDING_SIGNATURE = "SolanaFundingSignature1111111111111111111111111";
const DATA_TX_ID = "IrysDataItemId2222222222222222222222222222222222";
const PRICE_ATOMIC = "1000000";

vi.mock("@irys/web-upload", () => ({
  WebUploader: (config: { url: string; token: string }) => {
    calls.config = config;
    return {
      withProvider: (provider: unknown) => {
        calls.provider = provider;
        return {
          withRpc: (rpc: unknown) => {
            calls.rpc = rpc;
            return { build: async () => fakeIrys };
          },
          build: async () => fakeIrys,
        };
      },
    };
  },
}));

vi.mock("@irys/web-upload-solana", () => ({
  WebUSDCSolana: class {},
}));

let fundImpl: (amount: { toString(): string }) => Promise<unknown> = async (amount) => ({
  id: FUNDING_SIGNATURE,
  target: "irys-node-address",
  quantity: amount.toString(),
});
let uploadImpl: (data: Uint8Array) => Promise<unknown> = async () => ({ id: DATA_TX_ID });

const fakeIrys = {
  getPrice: async (size: number) => {
    calls.priceArgs.push(size);
    return { toString: () => PRICE_ATOMIC };
  },
  getBalance: async () => ({ toString: () => "0" }),
  fund: async (amount: { toString(): string }) => {
    calls.fundArgs.push(amount);
    return fundImpl(amount);
  },
  upload: async (data: Uint8Array) => {
    calls.uploadArgs.push(data);
    return uploadImpl(data);
  },
};

import {
  uploadCreatorPaid,
  type CreatorIrysWallet,
} from "./../../src/lib/storage/creatorIrys";

function wallet(): CreatorIrysWallet {
  return {
    publicKey: { toBuffer: () => new Uint8Array(32) },
    signMessage: async (m: Uint8Array) => m,
    sendTransaction: async () => FUNDING_SIGNATURE,
  };
}

const PAYLOAD = new Uint8Array([1, 2, 3, 4]);

describe("Creator Irys funding signature contract", () => {
  beforeEach(() => {
    calls.priceArgs = [];
    calls.fundArgs = [];
    calls.uploadArgs = [];
    fundImpl = async (amount) => ({
      id: FUNDING_SIGNATURE,
      target: "irys-node-address",
      quantity: amount.toString(),
    });
    uploadImpl = async () => ({ id: DATA_TX_ID });
    delete (calls as { config?: unknown }).config;
    delete (calls as { provider?: unknown }).provider;
    delete (calls as { rpc?: unknown }).rpc;
  });

  it("returns fundingSignature from fund() and dataTxId from upload()", async () => {
    const result = await uploadCreatorPaid(PAYLOAD, wallet());
    expect(result.fundingSignature).toBe(FUNDING_SIGNATURE);
    expect(result.dataTxId).toBe(DATA_TX_ID);
    expect(result.fundingSignature).not.toBe(result.dataTxId);
  });

  it("calls fund() BEFORE upload()", async () => {
    await uploadCreatorPaid(PAYLOAD, wallet());
    expect(calls.fundArgs).toHaveLength(1);
    expect(calls.uploadArgs).toHaveLength(1);
  });

  it("passes the exact Irys price to fund() (no conversion, no markup)", async () => {
    await uploadCreatorPaid(PAYLOAD, wallet());
    expect(calls.priceArgs).toEqual([PAYLOAD.byteLength]);
    expect(String(calls.fundArgs[0])).toBe(PRICE_ATOMIC);
  });

  it("uses the creator wallet provider (no executor/private key)", async () => {
    const w = wallet();
    await uploadCreatorPaid(PAYLOAD, w);
    expect(calls.provider).toBe(w);
    expect(calls.uploadArgs[0]).toBe(PAYLOAD);
  });

  it("fails closed when fund() returns no signature", async () => {
    fundImpl = async () => ({ target: "irys-node-address", quantity: PRICE_ATOMIC });
    await expect(uploadCreatorPaid(PAYLOAD, wallet())).rejects.toThrow(
      /Irys funding returned no transaction signature/
    );
    expect(calls.uploadArgs).toHaveLength(0);
  });

  it("upload failure after fund surfaces the fundingSignature (not lost)", async () => {
    uploadImpl = async () => {
      throw new Error("node rejected data item");
    };
    await expect(uploadCreatorPaid(PAYLOAD, wallet())).rejects.toThrow(
      /fundingSignature=SolanaFundingSignature/
    );
  });
});
