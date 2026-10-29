/**
 * AETERNA — creatorIrysStorage wallet gate (Phase 3BM-R7-F1).
 *
 * The wallet is a LAZY prerequisite of the adapter: it is consumed ONLY
 * by `upload()` / `uploadContainer()` (new Irys uploads + signatures).
 * Wallet-free operations — `claimContainerUpload` and the whole
 * cached-resume path — run WITHOUT a wallet, so a dropped wallet session
 * can no longer block a fully cached resume (3BM-R7 diagnosis).
 *
 * Pinned here:
 *   - constructing the adapter with `wallet: null` succeeds;
 *   - `claimContainerUpload` works without a wallet (mocked server);
 *   - `upload()` / `uploadContainer()` without a wallet fail closed with
 *     STORAGE_WALLET_UNAVAILABLE BEFORE any network or Irys interaction.
 *
 * Node environment; fetch is stubbed; no wallet, no Irys, no production.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const CAPSULE_ID = "a".repeat(64);
const CONTAINER_TX_ID = "C".repeat(43);
const LAYOUT_DIGEST = "b".repeat(64);

const fetchCalls: string[] = [];

const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input);
  fetchCalls.push(url);
  if (url.includes("/api/publication/claim")) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error("UNEXPECTED_FETCH:" + url);
});

import { createCreatorIrysStorage } from "./creatorIrysStorage";

function adapterWithoutWallet() {
  return createCreatorIrysStorage({
    wallet: null,
    creatorIdentityId: "creator-1",
    lifecycleId: "lifecycle-1",
    capsuleId: CAPSULE_ID,
    storagePaymentId: "storage-payment-1",
  });
}

const containerOutcome = {
  containerTxId: CONTAINER_TX_ID,
  chunkIds: ["chunk-1"],
  layoutDigest: LAYOUT_DIGEST,
};

describe("creatorIrysStorage wallet gate (3BM-R7-F1)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs the adapter with an absent wallet (null)", () => {
    const adapter = adapterWithoutWallet();
    expect(adapter.name).toBe("creator-irys");
    expect(typeof adapter.upload).toBe("function");
    expect(typeof adapter.uploadContainer).toBe("function");
    expect(typeof adapter.claimContainerUpload).toBe("function");
  });

  it("claimContainerUpload succeeds WITHOUT a wallet (pure server HTTP)", async () => {
    const adapter = adapterWithoutWallet();

    await expect(
      adapter.claimContainerUpload!(
        containerOutcome,
        "t".repeat(40) as never
      )
    ).resolves.toBeUndefined();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("/api/publication/claim");
  });

  it("upload() without a wallet fails closed with STORAGE_WALLET_UNAVAILABLE and zero network", async () => {
    const adapter = adapterWithoutWallet();

    await expect(
      adapter.upload(new Uint8Array([1, 2, 3]), "t".repeat(40) as never)
    ).rejects.toThrow(
      /\[AETERNA\] Capsule sealing failed: STORAGE_WALLET_UNAVAILABLE/
    );

    expect(fetchCalls).toHaveLength(0);
  });

  it("uploadContainer() without a wallet fails closed with STORAGE_WALLET_UNAVAILABLE and zero network", async () => {
    const adapter = adapterWithoutWallet();

    await expect(
      adapter.uploadContainer!(
        {} as never,
        [{ chunkId: "chunk-1", mediaId: "media-1", index: 0, size: 16 }],
        "t".repeat(40) as never
      )
    ).rejects.toThrow(
      /\[AETERNA\] Capsule sealing failed: STORAGE_WALLET_UNAVAILABLE/
    );

    expect(fetchCalls).toHaveLength(0);
  });
});
