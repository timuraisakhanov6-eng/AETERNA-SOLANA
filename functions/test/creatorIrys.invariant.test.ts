/**
 * Phase A — creatorIrys module capability test (isolated).
 * NO real Irys transactions, NO funding, NO payments:
 * only import success, builder instantiation, and fail-closed paths.
 */

import { describe, expect, it } from "vitest";
import {
  getCreatorIrysUploadPrice,
  getCreatorIrysDestination,
  uploadCreatorPaid,
  type CreatorIrysWallet,
} from "./../../src/lib/storage/creatorIrys";

function walletWithSigner(): CreatorIrysWallet {
  return {
    publicKey: { toBuffer: () => new Uint8Array(32) },
    signMessage: async (m: Uint8Array) => m,
  };
}

describe("creatorIrys (Phase A capability)", () => {
  it("module imports and exposes the Phase A interface", async () => {
    const mod = await import("./../../src/lib/storage/creatorIrys");
    expect(typeof mod.getCreatorIrysUploadPrice).toBe("function");
    expect(typeof mod.getCreatorIrysDestination).toBe("function");
    expect(typeof mod.uploadCreatorPaid).toBe("function");
  });

  it("fails closed without a wallet", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(uploadCreatorPaid(bytes, undefined as never)).rejects.toThrow(
      /wallet is required/
    );
    await expect(
      getCreatorIrysUploadPrice(bytes.byteLength, undefined as never)
    ).rejects.toThrow(/wallet is required/);
  });

  it("fails closed when the wallet has no publicKey", async () => {
    await expect(
      uploadCreatorPaid(new Uint8Array([1]), {} as never)
    ).rejects.toThrow(/wallet.publicKey is required/);
  });

  it("fails closed on invalid payload size", async () => {
    await expect(
      getCreatorIrysUploadPrice(0, walletWithSigner())
    ).rejects.toThrow(/invalid payload size/);
  });

  it("builder chain instantiates with the Solana USDC token config", async () => {
    const { WebUploader } = await import("@irys/web-upload");
    const { WebUSDCSolana } = await import("@irys/web-upload-solana");
    const builder = WebUploader({ url: "https://node1.irys.xyz", token: "usdc-solana" })
      .withProvider(walletWithSigner() as never);
    expect(typeof builder.withAdapter).toBe("function");
    expect(typeof builder.build).toBe("function");
    expect(() => new WebUSDCSolana({} as never)).not.toThrow();
  });

  it("upload without a proper Irys session fails closed (no silent success)", async () => {
    // A wallet whose funding/upload path cannot complete must never
    // produce a success result. Node environment has no injected
    // provider, so the build/fund/upload chain must reject.
    const bytes = new Uint8Array([7, 7, 7]);
    await expect(uploadCreatorPaid(bytes, walletWithSigner())).rejects.toThrow();
  });
});
