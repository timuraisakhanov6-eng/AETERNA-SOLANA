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

  it("binds the REAL WebUSDCSolana token CLASS to the builder (regression: this.token is not a constructor)", async () => {
    const { WebUploader } = await import("@irys/web-upload");
    const { WebUSDCSolana } = await import("@irys/web-upload-solana");

    // REAL package, REAL contract: `WebUploader` is the package's `Builder`,
    // and its ONLY parameter is a token CLASS (ConstructableWebToken).
    // Passing a config object here is the production defect.
    const builder = WebUploader(WebUSDCSolana);

    // The builder stores that argument as `this.token`, and `build()`
    // evaluates `new this.token({...})`.
    expect(typeof builder.token).toBe("function");
    expect(builder.token).toBe(WebUSDCSolana);

    // The precise expression `build()` performs internally must succeed.
    const constructed = new builder.token({} as never);
    expect(constructed).toBeInstanceOf(WebUSDCSolana);

    // The full production chain shape.
    const chained = builder
      .withProvider(walletWithSigner() as never)
      .withRpc("https://api.mainnet-beta.solana.com")
      .bundlerUrl("https://uploader.irys.xyz");
    expect(typeof chained.build).toBe("function");
    expect(typeof builder.withAdapter).toBe("function");

    // A real build() attempt must never fail with the constructor defect.
    // It performs live I/O (Irys node + Solana RPC), so any OTHER failure is
    // tolerated here — only the regression itself is forbidden.
    const outcome = await chained.build().then(
      () => null,
      (e: unknown) => e
    );
    if (outcome instanceof Error) {
      expect(outcome.message).not.toContain("is not a constructor");
    }
  });

  it("uses the Irys L1 mainnet bundler host, never the legacy Arweave bundler", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/storage/creatorIrys.ts", "utf8")
    );
    expect(source).toContain('"https://uploader.irys.xyz"');
    expect(source).not.toContain('"https://node1.irys.xyz"');
  });

  it("upload without a proper Irys session fails closed (no silent success)", async () => {
    // A wallet whose funding/upload path cannot complete must never
    // produce a success result. Node environment has no injected
    // provider, so the build/fund/upload chain must reject.
    const bytes = new Uint8Array([7, 7, 7]);
    await expect(uploadCreatorPaid(bytes, walletWithSigner())).rejects.toThrow();
  });
});
