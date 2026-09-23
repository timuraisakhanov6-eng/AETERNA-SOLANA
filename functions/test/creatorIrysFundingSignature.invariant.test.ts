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

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const calls: {
  priceArgs: number[];
  fundArgs: unknown[];
  uploadArgs: Uint8Array[];
  tokenClass?: unknown;
  bundlerUrl?: unknown;
  provider?: unknown;
  rpcUrl?: unknown;
} = { priceArgs: [], fundArgs: [], uploadArgs: [] };

const FUNDING_SIGNATURE = "SolanaFundingSignature1111111111111111111111111";
const DATA_TX_ID = "IrysDataItemId2222222222222222222222222222222222";
const PRICE_ATOMIC = "1000000";

/**
 * Models the REAL installed contract: `@irys/web-upload` exports
 * `WebUploader` as its `Builder`, whose ONLY parameter is a token CLASS
 * (`ConstructableWebToken`).
 *
 * The previous mock declared `(config: { url: string; token: string })` —
 * it encoded the WRONG contract in its own type signature, which is why the
 * production defect "this.token is not a constructor" passed this suite.
 */
vi.mock("@irys/web-upload", () => ({
  WebUploader: (tokenClass: unknown) => {
    calls.tokenClass = tokenClass;
    return {
      withProvider: (provider: unknown) => {
        calls.provider = provider;
        return {
          withRpc: (rpc: unknown) => {
            calls.rpcUrl = rpc;
            return {
              bundlerUrl: (url: unknown) => {
                calls.bundlerUrl = url;
                return { build: async () => fakeIrys };
              },
            };
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
    // creatorIrys is browser-only and derives its Solana RPC from the page
    // origin; the node test environment has no `location`, so the origin the
    // browser would provide is stubbed here.
    vi.stubGlobal("location", { origin: "https://aeterna-solana.pages.dev" });
    calls.priceArgs = [];
    calls.fundArgs = [];
    calls.uploadArgs = [];
    fundImpl = async (amount) => ({
      id: FUNDING_SIGNATURE,
      target: "irys-node-address",
      quantity: amount.toString(),
    });
    uploadImpl = async () => ({ id: DATA_TX_ID });
    delete calls.provider;
    delete calls.rpcUrl;
    delete calls.tokenClass;
    delete calls.bundlerUrl;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("binds the REAL WebUSDCSolana token CLASS to the builder (regression: this.token is not a constructor)", async () => {
    const { WebUSDCSolana } = await import("@irys/web-upload-solana");
    await uploadCreatorPaid(PAYLOAD, wallet());

    // The builder stores the token class as `this.token` and later evaluates
    // `new this.token({...})` — so this MUST be a constructor, never a config
    // object.
    expect(calls.tokenClass).toBe(WebUSDCSolana);
    expect(typeof calls.tokenClass).toBe("function");
    expect(calls.bundlerUrl).toBe("https://uploader.irys.xyz");
  });

  it("routes Solana reads through the SAME-ORIGIN AETERNA proxy, never a public RPC", async () => {
    await uploadCreatorPaid(PAYLOAD, wallet());

    expect(calls.rpcUrl).toBe(
      "https://aeterna-solana.pages.dev/api/solana/rpc"
    );
    expect(calls.rpcUrl).not.toContain("api.mainnet-beta.solana.com");
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
