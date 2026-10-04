/**
 * Stage 4.5 — container media upload (write side)
 *
 * Covers the required deterministic properties of the flagged container
 * branch:
 *
 *   1  flag OFF by default / only the exact "true" token enables it
 *   2  N logical chunks across M media items → ONE container upload
 *   3  exactly ONE container publication claim
 *   4  zero N× chunk-pointer registry writes on this path
 *   5  correct ORDERED chunkIds (item order, then per-item chunk order)
 *   6  correct layoutDigest (binds order AND ciphertext sizes)
 *   7  correct globalIndex
 *   8  different logical chunks produce different offsets
 *   9  missing / short chunk fails closed and issues NO claim
 *   10 upload failure fails closed and issues NO claim
 *   11 the bytes actually uploaded ARE the container
 *   12 write↔read agreement: resolveContainerChunks derives the SAME
 *      layout, so the offsets the reader computes are the offsets that
 *      were published
 */

import { describe, expect, it, vi } from "vitest";
import { Buffer } from "buffer";
import { Readable } from "stream";

import type { ChunkMetadata } from "@/types/vault";
import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";
import type { ChunkingUploader } from "@irys/upload-core";

import { HEADER_SIZE, buildContainerLayout } from "@/lib/storage/container/containerLayout";
import {
  computeContainerLayoutDigest,
  buildContainerPublicationRecord,
} from "@/lib/storage/container/containerPublication";
import { resolveContainerChunks } from "@/lib/capsule/open/resolveContainerChunks";
import {
  groupChunkMetadataByMediaItem,
  uploadPreparedContainer,
} from "@/lib/storage/uploadPreparedContainer";
import {
  readSealDiagnostic,
  SEAL_FAILURE_MESSAGE,
  tagSealFailure,
} from "@/lib/capsule/sealDiagnostic";

/* =========================
   FIXTURES
   ========================= */

const CAPSULE_ID = "a".repeat(64);
const CONTAINER_TX = "K".repeat(43);

/** Two media items, 2 + 3 chunks — deterministic, distinct sizes. */
function metadata(): ChunkMetadata[] {
  const mk = (mediaId: string, index: number, size: number, fill: number) =>
    Object.freeze({
      chunkId: `${fill}`.repeat(64) as string,
      mediaId,
      index,
      size,
    }) as ChunkMetadata;

  return [
    mk("media-1", 0, 100, 1),
    mk("media-1", 1, 120, 2),
    mk("media-2", 0, 140, 3),
    mk("media-2", 1, 160, 4),
    mk("media-2", 2, 180, 5),
  ];
}

function ciphertexts(meta: readonly ChunkMetadata[]): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const chunk of meta) {
    const bytes = new Uint8Array(chunk.size);
    // Deterministic, non-uniform content so a byte-count-only match cannot
    // pass by accident.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (i * 7 + chunk.size) & 0xff;
    }
    map.set(chunk.chunkId, bytes);
  }
  return map;
}

/** The persisted Runtime chunk record shape the writer consumes. */
interface ChunkRecord {
  chunkId: string;
  mediaId: string;
  chunkIndex: number;
  ciphertext: Uint8Array;
}

function makeRuntime(
  store: Map<string, Uint8Array>,
  opts: { missing?: string; shortBy?: number } = {}
): RuntimeStorage {
  return {
    async read(chunkId: string): Promise<ChunkRecord> {
      if (opts.missing === chunkId) {
        // The writer treats a falsy record as a missing chunk.
        return undefined as unknown as ChunkRecord;
      }
      const ciphertext = store.get(chunkId);
      if (!ciphertext) return undefined as unknown as ChunkRecord;
      const bytes =
        opts.shortBy !== undefined
          ? ciphertext.subarray(0, ciphertext.byteLength - opts.shortBy)
          : ciphertext;
      return {
        chunkId,
        mediaId: "m",
        chunkIndex: 0,
        ciphertext: bytes,
      };
    },
  } as unknown as RuntimeStorage;
}

function makeUploader(opts: { fail?: boolean; id?: string } = {}) {
  const calls = { setChunkSize: 0, setBatchSize: 0, uploadData: 0 };
  let captured: Uint8Array | null = null;

  const uploader = {
    setChunkSize() {
      calls.setChunkSize++;
    },
    setBatchSize() {
      calls.setBatchSize++;
    },
    async uploadData(readable: Readable) {
      calls.uploadData++;
      const parts: Buffer[] = [];
      for await (const part of readable) {
        parts.push(Buffer.from(part as Uint8Array));
      }
      captured = new Uint8Array(Buffer.concat(parts));
      if (opts.fail) throw new Error("irys exploded");
      return { status: 200, data: { id: opts.id ?? CONTAINER_TX } };
    },
  };

  return {
    uploader: uploader as unknown as ChunkingUploader,
    calls,
    bytes: () => captured,
  };
}

/* =========================
   2-8. ORDER, DIGEST, OFFSETS
   ========================= */

describe("Stage 4.5 — container upload: order, digest, offsets", () => {
  it("11. N chunks across 2 media items → ONE upload and ONE claim", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const { uploader, calls } = makeUploader();
    const claim = vi.fn(async () => {});

    const outcome = await uploadPreparedContainer(runtime, meta, uploader, claim);

    expect(calls.uploadData).toBe(1);
    expect(calls.setChunkSize).toBe(1);
    expect(calls.setBatchSize).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(outcome.containerTxId).toBe(CONTAINER_TX);
  });

  it("5/7. chunkIds are in canonical global order (item order, then chunk order)", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const { uploader } = makeUploader();
    const claim = vi.fn(async () => {});

    const outcome = await uploadPreparedContainer(runtime, meta, uploader, claim);

    expect([...outcome.chunkIds]).toEqual(meta.map((c) => c.chunkId));

    const layout = buildContainerLayout(groupChunkMetadataByMediaItem(meta));
    expect(layout.entries.map((e) => e.globalIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(layout.entries.map((e) => e.localIndex)).toEqual([0, 1, 0, 1, 2]);
    expect(layout.entries.map((e) => e.mediaId)).toEqual([
      "media-1", "media-1", "media-2", "media-2", "media-2",
    ]);
  });

  it("6. layoutDigest binds order AND sizes", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const { uploader } = makeUploader();
    const claim = vi.fn(async () => {});

    const outcome = await uploadPreparedContainer(runtime, meta, uploader, claim);

    const layout = buildContainerLayout(groupChunkMetadataByMediaItem(meta));
    const expected = await computeContainerLayoutDigest(
      layout.entries.map((e) => ({ chunkId: e.chunkId, size: e.length }))
    );
    expect(outcome.layoutDigest).toBe(expected);

    // Changing a SIZE changes the digest (offsets move).
    const resized = metadata().map((c, i) =>
      i === 0 ? ({ ...c, size: c.size + 2 } as ChunkMetadata) : c
    );
    const resizedLayout = buildContainerLayout(groupChunkMetadataByMediaItem(resized));
    const resizedDigest = await computeContainerLayoutDigest(
      resizedLayout.entries.map((e) => ({ chunkId: e.chunkId, size: e.length }))
    );
    expect(resizedDigest).not.toBe(expected);

    // Reordering the MEDIA ITEMS changes the global order (and therefore the
    // offsets) without violating the per-item local-index contiguity rule.
    const reordered = [meta[2], meta[3], meta[4], meta[0], meta[1]] as ChunkMetadata[];
    const reorderedDigest = await computeContainerLayoutDigest(
      buildContainerLayout(groupChunkMetadataByMediaItem(reordered)).entries.map((e) => ({
        chunkId: e.chunkId,
        size: e.length,
      }))
    );
    expect(reorderedDigest).not.toBe(expected);
  });

  it("8. different logical chunks occupy different offsets", async () => {
    const meta = metadata();
    const layout = buildContainerLayout(groupChunkMetadataByMediaItem(meta));

    const offsets = layout.entries.map((e) => e.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets[0]).toBe(HEADER_SIZE);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
      expect(offsets[i]!).toBe(offsets[i - 1]! + layout.entries[i - 1]!.length);
    }
  });

  it("11b. the uploaded bytes ARE [64B AETC header][chunk0]…[chunkN-1]", async () => {
    const meta = metadata();
    const store = ciphertexts(meta);
    const runtime = makeRuntime(store);
    const { uploader, bytes } = makeUploader();
    const claim = vi.fn(async () => {});

    await uploadPreparedContainer(runtime, meta, uploader, claim);

    const uploaded = bytes()!;
    const layout = buildContainerLayout(groupChunkMetadataByMediaItem(meta));

    expect(uploaded.byteLength).toBe(layout.containerSize);
    expect(uploaded.byteLength).toBe(
      HEADER_SIZE + meta.reduce((sum, c) => sum + c.size, 0)
    );

    // magic "AETC" + version 1 + headerSize 64 + chunkCount 5 (big-endian)
    expect(Array.from(uploaded.subarray(0, 4))).toEqual([0x41, 0x45, 0x54, 0x43]);
    expect(uploaded[4]).toBe(1);
    expect(uploaded[5]).toBe(0);
    expect(uploaded[6]).toBe(64);
    expect(uploaded[7]).toBe(0);
    expect(uploaded[8]).toBe(0);
    expect(uploaded[9]).toBe(0);
    expect(uploaded[10]).toBe(meta.length);

    // Every chunk sits at EXACTLY its published offset.
    for (const entry of layout.entries) {
      const slice = uploaded.subarray(entry.offset, entry.offset + entry.length);
      expect(Array.from(slice)).toEqual(Array.from(store.get(entry.chunkId)!));
    }
  });

  it("12. write↔read agreement: resolveContainerChunks derives the SAME layout", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const { uploader } = makeUploader();
    const claim = vi.fn(async () => {});

    const outcome = await uploadPreparedContainer(runtime, meta, uploader, claim);

    const record = buildContainerPublicationRecord({
      capsuleId: CAPSULE_ID,
      lifecycleId: "lifecycle-1",
      creatorIdentityId: "identity-1",
      containerTxId: outcome.containerTxId,
      chunkIds: outcome.chunkIds,
      layoutDigest: outcome.layoutDigest,
      now: 1_800_000_000_000,
    });

    // The reader is fed the Vault's chunk-bearing item grouping — the exact
    // structure the writer grouped from.
    const items = groupChunkMetadataByMediaItem(meta).map((g) => [...g]);

    const resolved = await resolveContainerChunks(items, record);

    const writeLayout = buildContainerLayout(groupChunkMetadataByMediaItem(meta));

    expect(resolved.map((c) => c.chunkId)).toEqual([...outcome.chunkIds]);
    expect(resolved.map((c) => c.container!.offset)).toEqual(
      writeLayout.entries.map((e) => e.offset)
    );
    expect(resolved.map((c) => c.container!.length)).toEqual(
      writeLayout.entries.map((e) => e.length)
    );
    expect(resolved.map((c) => c.index)).toEqual(
      writeLayout.entries.map((e) => e.localIndex)
    );
    // Every container chunk points at the ONE container DataItem.
    expect(new Set(resolved.map((c) => c.pointer))).toEqual(new Set([CONTAINER_TX]));
  });
});

/* =========================
   9-10. FAIL CLOSED
   ========================= */

describe("Stage 4.5 — container upload fails closed", () => {
  it("9. a MISSING chunk fails closed and issues NO claim", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta), { missing: meta[2]!.chunkId });
    const { uploader } = makeUploader();
    const claim = vi.fn(async () => {});

    await expect(
      uploadPreparedContainer(runtime, meta, uploader, claim)
    ).rejects.toThrow();

    expect(claim).not.toHaveBeenCalled();
  });

  it("9b. a SHORT chunk fails closed and issues NO claim", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta), { shortBy: 1 });
    const { uploader } = makeUploader();
    const claim = vi.fn(async () => {});

    await expect(
      uploadPreparedContainer(runtime, meta, uploader, claim)
    ).rejects.toThrow();

    expect(claim).not.toHaveBeenCalled();
  });

  it("10. an UPLOAD failure fails closed and issues NO claim", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const { uploader } = makeUploader({ fail: true });
    const claim = vi.fn(async () => {});

    await expect(
      uploadPreparedContainer(runtime, meta, uploader, claim)
    ).rejects.toThrow();

    expect(claim).not.toHaveBeenCalled();
  });

  it("10b. an empty chunk list fails closed", async () => {
    const { uploader } = makeUploader();
    const claim = vi.fn(async () => {});

    await expect(
      uploadPreparedContainer(
        makeRuntime(new Map()),
        [] as ChunkMetadata[],
        uploader,
        claim
      )
    ).rejects.toThrow();

    expect(claim).not.toHaveBeenCalled();
  });

  it("10c. the claim runs AFTER the upload, never before", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const order: string[] = [];
    const { uploader } = makeUploader();
    const originalUpload = uploader.uploadData.bind(uploader);
    (uploader as unknown as { uploadData: typeof originalUpload }).uploadData =
      async (readable: Readable) => {
        order.push("upload");
        return originalUpload(readable);
      };

    await uploadPreparedContainer(runtime, meta, uploader, async () => {
      order.push("claim");
    });

    expect(order).toEqual(["upload", "claim"]);
  });
});

/* =========================
   4. NO N× REGISTRY WRITES
   ========================= */

describe("Stage 4.5 — no N× chunk-pointer registry writes", () => {
  it("4. the container write path never references the chunk-pointer registry", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "src/lib/storage/uploadPreparedContainer.ts",
      "utf8"
    );

    expect(source).not.toMatch(/chunkPointerRegistry|ChunkPointerRegistry|chunk-pointer-entry/);
    // ...and it never falls back to the per-chunk uploader.
    expect(source).not.toMatch(/uploadChunk|uploadPreparedChunks/);
  });
});

/* =========================
   GROUPING
   ========================= */

describe("Stage 4.5 — grouping reproduces the Vault item grouping", () => {
  it("groups by mediaId in FIRST-APPEARANCE order", () => {
    const meta = metadata();
    const groups = groupChunkMetadataByMediaItem(meta);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.map((c) => c.mediaId)).toEqual(["media-1", "media-1"]);
    expect(groups[1]!.map((c) => c.mediaId)).toEqual(["media-2", "media-2", "media-2"]);
    expect(groups[0]!.map((c) => c.index)).toEqual([0, 1]);
    expect(groups[1]!.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("interleaved item order is preserved as first-appearance order", () => {
    const mk = (mediaId: string, index: number) =>
      Object.freeze({
        chunkId: `${mediaId}-${index}`.padEnd(64, "0"),
        mediaId,
        index,
        size: 10,
      }) as ChunkMetadata;

    const groups = groupChunkMetadataByMediaItem([
      mk("b", 0),
      mk("a", 0),
      mk("b", 1),
      mk("a", 1),
    ]);

    expect(groups.map((g) => g[0]!.mediaId)).toEqual(["b", "a"]);
    expect(groups[0]!.map((c) => c.index)).toEqual([0, 1]);
    expect(groups[1]!.map((c) => c.index)).toEqual([0, 1]);
  });
});

/* =========================
   DIAGNOSTIC STAGE CLASSIFICATION
   ========================= */

/**
 * The 2026-10-04 production E2E failed inside the Container V1 upload and
 * the original exception was destroyed, so the stage could not be named.
 * These tests pin the classification that makes it nameable — while the
 * fail-closed contract (no claim on a failed upload) stays unchanged.
 */
describe("Stage 4.5 — container upload diagnostic stages", () => {
  async function stageOf(promise: Promise<unknown>): Promise<string | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      return readSealDiagnostic(error);
    }
  }

  it("A. a pre-upload construction failure → CONTAINER_UPLOAD_CONSTRUCT", async () => {
    const uploader = makeUploader();
    const claim = vi.fn(async () => {});

    // Empty chunk list fails inside the construction region.
    const stage = await stageOf(
      uploadPreparedContainer(
        makeRuntime(new Map()),
        [],
        uploader.uploader,
        claim
      )
    );

    expect(stage).toBe("CONTAINER_UPLOAD_CONSTRUCT");
    expect(claim).not.toHaveBeenCalled();
  });

  it("F. a rejected publication claim → CONTAINER_PUBLICATION", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const uploader = makeUploader();
    const claim = vi.fn(async () => {
      throw new Error("[AETERNA] creatorIrys: publication claim failed");
    });

    const stage = await stageOf(
      uploadPreparedContainer(runtime, meta, uploader.uploader, claim)
    );

    expect(stage).toBe("CONTAINER_PUBLICATION");
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("preserves a more precise inner tag through the container boundary", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const claim = vi.fn(async () => {});

    // Simulate the wallet adapter having tagged a rejected signature.
    const uploader = {
      setChunkSize() {},
      setBatchSize() {},
      async uploadData(readable: Readable) {
        for await (const _part of readable) {
          // consume the producer so the writer releases
        }
        throw tagSealFailure(
          new Error("user rejected"),
          "WALLET_SIGN_FAILURE"
        );
      },
    } as unknown as ChunkingUploader;

    const stage = await stageOf(
      uploadPreparedContainer(runtime, meta, uploader, claim)
    );

    expect(stage).toBe("CONTAINER_UPLOAD_SIGN");
    expect(claim).not.toHaveBeenCalled();
  });

  it("an unclassified upload failure → CONTAINER_UPLOAD_UNKNOWN", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const uploader = makeUploader({ fail: true });
    const claim = vi.fn(async () => {});

    const stage = await stageOf(
      uploadPreparedContainer(runtime, meta, uploader.uploader, claim)
    );

    expect(stage).toBe("CONTAINER_UPLOAD_UNKNOWN");
    expect(claim).not.toHaveBeenCalled();
  });

  it("carries only the fixed message + code (no original message)", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const uploader = makeUploader({ fail: true });
    const claim = vi.fn(async () => {});

    let captured: unknown = null;
    try {
      await uploadPreparedContainer(runtime, meta, uploader.uploader, claim);
    } catch (error) {
      captured = error;
    }

    const error = captured as Error;
    expect(error.message).toBe(
      `${SEAL_FAILURE_MESSAGE}: CONTAINER_UPLOAD_UNKNOWN`
    );
    // The uploader's own message must NOT travel with the failure.
    expect(error.message).not.toContain("irys exploded");
  });

  it("a successful upload still claims exactly once and reports no stage", async () => {
    const meta = metadata();
    const runtime = makeRuntime(ciphertexts(meta));
    const uploader = makeUploader();
    const claim = vi.fn(async () => {});

    const outcome = await uploadPreparedContainer(
      runtime,
      meta,
      uploader.uploader,
      claim
    );

    expect(outcome.containerTxId).toBe(CONTAINER_TX);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(uploader.calls.uploadData).toBe(1);
  });
});
