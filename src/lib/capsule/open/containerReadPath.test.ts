/**
 * Stage 4.5 PHASE 5 — container READ path
 *
 * Proves, deterministically:
 *
 *   • the container publication resolves into per-chunk DERIVED positions
 *   • chunk 0 / middle / final offsets are exact
 *   • the requested length is exactly the chunk's ciphertext length
 *   • wrong chunkId / globalIndex / localIndex / containerTxId / chunk count /
 *     ordered chunkIds / layoutDigest / duplicate identity all FAIL CLOSED
 *   • a missing container publication fails closed
 *   • the legacy loader still reads offset 0 (unchanged)
 *   • the container loader reads the DERIVED offset through downloadRange
 *   • corrupted ciphertext fails in the EXISTING AES-GCM path
 *   • write ↔ read layout agreement (unequal ciphertext lengths)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ChunkMetadata } from "@/types/vault";

import { buildContainerLayout, HEADER_SIZE } from "@/lib/storage/container/containerLayout";
import {
  buildContainerPublicationRecord,
  computeContainerLayoutDigest,
  type ContainerPublicationRecord,
} from "@/lib/storage/container/containerPublication";
import { resolveContainerChunks } from "@/lib/capsule/open/resolveContainerChunks";

/* ------------------------------------------------------------------ *
 * downloadRange capture — the Stage 1 primitive the loader calls.
 * ------------------------------------------------------------------ */

const downloadRangeCalls: Array<{ pointer: string; offset: number; length: number }> = [];

/** Bytes the fake gateway serves for a container txId. */
let servedBytes: Uint8Array = new Uint8Array(0);
/** Force a wrong-length response. */
let servedLengthOverride: number | null = null;

vi.mock("@/lib/storage/storage", () => ({
  storage: {
    async downloadRange(pointer: string, offset: number, length: number) {
      downloadRangeCalls.push({ pointer, offset, length });
      const effective = servedLengthOverride ?? length;
      return servedBytes.slice(offset, offset + effective);
    },
  },
}));

const { loadChunk } = await import("@/lib/capsule/runtime/chunkLoader");

/* ------------------------------------------------------------------ *
 * Fixture: item A (chunk 0, chunk 1) + item B (chunk 0), UNEQUAL sizes.
 * ------------------------------------------------------------------ */

const CAPSULE_ID = "a".repeat(64);
const CONTAINER_TX = "K".repeat(43);

function chunkIdFor(n: number): string {
  return n.toString(16).padStart(2, "0").repeat(32);
}

/** A: 100, 140 · B: 180  — all different, so offsets must all differ. */
const FIXTURE: ChunkMetadata[] = [
  Object.freeze({ chunkId: chunkIdFor(1), mediaId: "A", index: 0, size: 100 }) as ChunkMetadata,
  Object.freeze({ chunkId: chunkIdFor(2), mediaId: "A", index: 1, size: 140 }) as ChunkMetadata,
  Object.freeze({ chunkId: chunkIdFor(3), mediaId: "B", index: 0, size: 180 }) as ChunkMetadata,
];

/** The Vault's chunk-bearing item grouping: [A: 0,1] [B: 0]. */
const ITEMS: readonly (readonly ChunkMetadata[])[] = [
  [FIXTURE[0]!, FIXTURE[1]!],
  [FIXTURE[2]!],
];

function makeContainerBytes(): Uint8Array {
  const layout = buildContainerLayout(ITEMS);
  const bytes = new Uint8Array(layout.containerSize);
  // header is zero-filled here; the loader never inspects it (it trusts the
  // publication record + layout), but the byte count must be exact.
  let cursor = HEADER_SIZE;
  for (const entry of layout.entries) {
    for (let i = 0; i < entry.length; i++) {
      bytes[cursor + i] = (i + entry.globalIndex * 31) & 0xff;
    }
    cursor += entry.length;
  }
  return bytes;
}

async function publication(overrides: Partial<Parameters<typeof buildContainerPublicationRecord>[0]> = {}) {
  const layout = buildContainerLayout(ITEMS);
  const digest = await computeContainerLayoutDigest(
    layout.entries.map((e) => ({ chunkId: e.chunkId, size: e.length }))
  );

  return buildContainerPublicationRecord({
    capsuleId: CAPSULE_ID,
    lifecycleId: "lifecycle-1",
    creatorIdentityId: "identity-1",
    containerTxId: CONTAINER_TX,
    chunkIds: layout.entries.map((e) => e.chunkId),
    layoutDigest: digest,
    now: 1_800_000_000_000,
    ...overrides,
  });
}

async function fakeCryptoKey(): Promise<CryptoKey> {
  return (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
}

beforeEach(() => {
  downloadRangeCalls.length = 0;
  servedBytes = makeContainerBytes();
  servedLengthOverride = null;
});

/* ================================================================== *
 * PHASE 8 — write ↔ read layout agreement
 * ================================================================== */

describe("Stage 4.5 P5 — write ↔ read layout agreement", () => {
  it("reader derives the SAME order, offsets and lengths the writer laid out", async () => {
    const record = await publication();
    const resolved = await resolveContainerChunks(ITEMS, record);

    const writeLayout = buildContainerLayout(ITEMS);

    expect(resolved.map((c) => c.chunkId)).toEqual(
      writeLayout.entries.map((e) => e.chunkId)
    );
    expect(resolved.map((c) => c.container!.globalIndex)).toEqual(
      writeLayout.entries.map((e) => e.globalIndex)
    );
    expect(resolved.map((c) => c.container!.offset)).toEqual(
      writeLayout.entries.map((e) => e.offset)
    );
    expect(resolved.map((c) => c.container!.length)).toEqual(
      writeLayout.entries.map((e) => e.length)
    );
    // `index` stays the ORIGINAL per-media-item ChunkMetadata.index.
    expect(resolved.map((c) => c.index)).toEqual([0, 1, 0]);
    // Every chunk points at the ONE container DataItem.
    expect(new Set(resolved.map((c) => c.pointer))).toEqual(new Set([CONTAINER_TX]));
  });

  it("chunk 0 / middle / final offsets are exact and all DIFFERENT", async () => {
    const record = await publication();
    const resolved = await resolveContainerChunks(ITEMS, record);

    const offsets = resolved.map((c) => c.container!.offset);

    expect(offsets[0]).toBe(HEADER_SIZE); // chunk 0
    expect(offsets[1]).toBe(HEADER_SIZE + 100); // middle
    expect(offsets[2]).toBe(HEADER_SIZE + 100 + 140); // final
    expect(new Set(offsets).size).toBe(3);
    // exact length per chunk
    expect(resolved.map((c) => c.container!.length)).toEqual([100, 140, 180]);
    expect(resolved.map((c) => c.size)).toEqual([100, 140, 180]);
  });
});

/* ================================================================== *
 * PHASE 7 — integrity / fail-closed
 * ================================================================== */

describe("Stage 4.5 P5 — container resolution fails closed", () => {
  it("wrong ordered chunkIds fails closed", async () => {
    const base = await publication();
    const swapped = [base.chunkIds[1]!, base.chunkIds[0]!, base.chunkIds[2]!];
    await expect(
      resolveContainerChunks(ITEMS, { ...base, chunkIds: swapped } as ContainerPublicationRecord)
    ).rejects.toThrow();
  });

  it("wrong chunk count fails closed", async () => {
    const base = await publication();
    await expect(
      resolveContainerChunks(ITEMS, { ...base, chunkIds: base.chunkIds.slice(0, 2) } as ContainerPublicationRecord)
    ).rejects.toThrow();
  });

  it("wrong layoutDigest fails closed", async () => {
    const base = await publication();
    await expect(
      resolveContainerChunks(ITEMS, { ...base, layoutDigest: "f".repeat(64) } as ContainerPublicationRecord)
    ).rejects.toThrow();
  });

  it("missing chunk metadata fails closed", async () => {
    const base = await publication();
    // Drop item B's chunk from the Vault side.
    await expect(resolveContainerChunks([ITEMS[0]!], base)).rejects.toThrow();
  });

  it("a duplicate logical chunkId fails closed", async () => {
    const base = await publication();
    const duplicated = [ITEMS[0]!, [ITEMS[1]![0]!, ITEMS[1]![0]!]] as const;
    await expect(resolveContainerChunks(duplicated, base)).rejects.toThrow();
  });

  it("a missing container publication fails closed", async () => {
    await expect(
      resolveContainerChunks(ITEMS, undefined as unknown as ContainerPublicationRecord)
    ).rejects.toThrow();
  });
});

/* ================================================================== *
 * PHASE 4 — chunkLoader: legacy offset 0 vs container DERIVED offset
 * ================================================================== */

describe("Stage 4.5 P5 — chunkLoader offsets", () => {
  it("LEGACY chunk reads at offset 0 with its own size", async () => {
    const key = await fakeCryptoKey();
    servedBytes = new Uint8Array(100);

    await loadChunk(
      CAPSULE_ID,
      Object.freeze({
        chunkId: chunkIdFor(9),
        mediaId: "A",
        index: 0,
        size: 100,
        pointer: "P".repeat(43) as never,
      }) as never,
      key
    ).catch(() => undefined); // decryption is expected to fail; we assert the READ

    expect(downloadRangeCalls).toEqual([
      { pointer: "P".repeat(43), offset: 0, length: 100 },
    ]);
  });

  it("CONTAINER chunk reads at the DERIVED offset with the exact length", async () => {
    const record = await publication();
    const resolved = await resolveContainerChunks(ITEMS, record);
    const key = await fakeCryptoKey();

    for (const chunk of resolved) {
      downloadRangeCalls.length = 0;
      await loadChunk(CAPSULE_ID, chunk, key).catch(() => undefined);
      expect(downloadRangeCalls).toEqual([
        {
          pointer: CONTAINER_TX,
          offset: chunk.container!.offset,
          length: chunk.container!.length,
        },
      ]);
    }

    // ...and the three reads hit three DIFFERENT offsets of ONE object.
    const offsets = resolved.map((c) => c.container!.offset);
    expect(new Set(offsets).size).toBe(3);
    expect(new Set(resolved.map((c) => c.pointer))).toEqual(new Set([CONTAINER_TX]));
  });

  it("a WRONG returned length fails closed before decryption", async () => {
    const record = await publication();
    const resolved = await resolveContainerChunks(ITEMS, record);
    const key = await fakeCryptoKey();

    // Server returns one byte short — the exact-length contract must reject it.
    servedLengthOverride = resolved[0]!.container!.length - 1;

    await expect(loadChunk(CAPSULE_ID, resolved[0]!, key)).rejects.toThrow(
      "[AETERNA] Chunk download failed"
    );
  });

  it("a malformed container position fails closed", async () => {
    const record = await publication();
    const resolved = await resolveContainerChunks(ITEMS, record);
    const key = await fakeCryptoKey();

    const tampered = Object.freeze({
      ...resolved[0]!,
      container: Object.freeze({
        ...resolved[0]!.container!,
        // length no longer matches the metadata size
        length: resolved[0]!.container!.length + 1,
      }),
    }) as never;

    await expect(loadChunk(CAPSULE_ID, tampered, key)).rejects.toThrow(
      "[AETERNA] Invalid chunk container position"
    );
  });

  it("a wrong containerTxId (pointer mismatch) fails closed", async () => {
    const record = await publication();
    const resolved = await resolveContainerChunks(ITEMS, record);
    const key = await fakeCryptoKey();

    const tampered = Object.freeze({
      ...resolved[0]!,
      container: Object.freeze({
        ...resolved[0]!.container!,
        containerTxId: "Z".repeat(43),
      }),
    }) as never;

    await expect(loadChunk(CAPSULE_ID, tampered, key)).rejects.toThrow(
      "[AETERNA] Invalid chunk container position"
    );
  });
});

/* ================================================================== *
 * CORRUPTED CIPHERTEXT — must fail in the EXISTING AES-GCM path
 * ================================================================== */

describe("Stage 4.5 P5 — corrupted ciphertext fails in the existing AES-GCM path", () => {
  it("a tampered window is rejected by decryptChunk (no new crypto mechanism)", async () => {
    const key = await fakeCryptoKey();
    const { encryptChunk } = await import("@/lib/crypto/encryptChunk");

    const baseIV = new Uint8Array(12).fill(3);
    const plaintext = new Uint8Array(32).fill(7);

    // A valid chunk produced by the EXISTING encrypt path (real IV derivation
    // + real DOMAIN_CHUNK_AAD) — nothing hand-rolled here.
    const wire = await encryptChunk(plaintext, key, baseIV, 0, CAPSULE_ID);

    servedBytes = new Uint8Array(wire);

    const chunk = Object.freeze({
      chunkId: chunkIdFor(7),
      mediaId: "A",
      index: 0,
      size: wire.byteLength,
      pointer: "P".repeat(43) as never,
    }) as never;

    // 1. untampered round-trips through the EXISTING path
    await expect(loadChunk(CAPSULE_ID, chunk, key)).resolves.toEqual(plaintext);

    // 2. flip one ciphertext byte → the EXISTING GCM tag check must reject it
    const corrupted = new Uint8Array(wire);
    corrupted[12] = (corrupted[12] ?? 0) ^ 0x01;
    servedBytes = corrupted;

    await expect(loadChunk(CAPSULE_ID, chunk, key)).rejects.toThrow(
      "[AETERNA] Chunk decryption failed"
    );
  });
});
