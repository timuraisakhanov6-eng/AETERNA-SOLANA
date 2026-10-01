/**
 * =========================================================
 * executorStorage.downloadRange — LIVE Irys read
 * =========================================================
 *
 * OPT-IN. Skipped unless AETERNA_LIVE_IRYS=1, so the default
 * suite never depends on the network.
 *
 * This is the Stage 1 "one explicit real range read" check:
 *
 *   offset = 0, length = the requested window
 *
 * and the returned bytes are compared against the object's own
 * prefix, obtained independently through a plain (non-Range)
 * GET of the full object.
 *
 * Read-only: no upload, no signing, no payment, no private keys.
 *
 * Run with:
 *   AETERNA_LIVE_IRYS=1 npx vitest run \
 *     src/lib/storage/executorStorage.downloadRange.live.test.ts
 */
import { describe, it, expect } from "vitest";

import type { StoragePointer } from "@/lib/storage/storageAdapter";
import { executorStorage } from "@/lib/storage/executorStorage";

const LIVE = import.meta.env["AETERNA_LIVE_IRYS"] === "1";

/**
 * A known public Irys object proven range-capable in Stage 0
 * (Gate A): 463_113_451 bytes total.
 */
const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

const OBJECT_BYTES = 463_113_451;

const URL_ = `https://gateway.irys.xyz/tx/${POINTER}/data`;

const WINDOW = 1024 * 1024;

describe.skipIf(!LIVE)("downloadRange — live Irys read", () => {
  it("returns exactly the requested window and matches the object prefix", async () => {
    // Path A — the primitive under test.
    const ranged = await executorStorage.downloadRange(POINTER, 0, WINDOW);
    expect(ranged.byteLength).toBe(WINDOW);

    // Path B — independent: a plain GET returns the FULL object.
    // Read only the first WINDOW bytes of its body, then cancel.
    const res = await fetch(URL_, { cache: "no-store" });
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    const whole = new Uint8Array(WINDOW);
    let got = 0;
    while (got < WINDOW) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, WINDOW - got);
      whole.set(value.subarray(0, take), got);
      got += take;
    }
    await reader.cancel();

    expect(got).toBe(WINDOW);

    // Byte-for-byte equality against the object's own prefix.
    let mismatch = -1;
    for (let i = 0; i < WINDOW; i++) {
      if (ranged[i] !== whole[i]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 180_000);

  it("fails closed for a window past the end of the object", async () => {
    await expect(
      executorStorage.downloadRange(POINTER, OBJECT_BYTES, 100)
    ).rejects.toThrow("[AETERNA] Range read failed");
  }, 120_000);
});
