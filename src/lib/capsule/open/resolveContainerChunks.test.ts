/**
 * Stage 4 — container read resolution tests.
 *
 * Proves the derived mapping matches the Stage 2 layout exactly, that no
 * offset is persisted anywhere, and that every mismatch fails closed.
 */
import { describe, it, expect } from "vitest";

import type { ChunkMetadata } from "@/types/vault";

import {
  buildContainerLayout,
  HEADER_SIZE,
} from "@/lib/storage/container/containerLayout";
import {
  buildContainerPublicationRecord,
  computeContainerLayoutDigest,
} from "@/lib/storage/container/containerPublication";

import { resolveContainerChunks } from "./resolveContainerChunks";

const CAPSULE = "a".repeat(64);
const TX = "K".repeat(43);

/**
 * Real `ChunkMetadata.chunkId` is a 64-char lowercase sha256 hex, and the
 * container publication record validates exactly that. This helper produces a
 * STABLE 64-hex id per (mediaId, index) so fixtures can be rebuilt without
 * drifting.
 */
function hexId(seed: string): string {
  let out = "";
  for (let i = 0; i < 64; i++) {
    const c = seed.charCodeAt(i % seed.length);
    out += ((c * 7 + i * 13 + seed.length) % 16).toString(16);
  }
  return out;
}

function chunk(mediaId: string, index: number, size: number): ChunkMetadata {
  return { chunkId: hexId(`${mediaId}#${index}`), mediaId, index, size };
}

/** Two media items with unequal chunk sizes + a chunk-less text item. */
const ITEMS: readonly (readonly ChunkMetadata[])[] = [
  [chunk("A", 0, 300), chunk("A", 1, 111)],
  [],
  [chunk("B", 0, 512), chunk("B", 1, 7), chunk("B", 2, 4096)],
];

const FLAT = [chunk("A", 0, 300), chunk("A", 1, 111), chunk("B", 0, 512), chunk("B", 1, 7), chunk("B", 2, 4096)];

async function publicationFor(items: readonly (readonly ChunkMetadata[])[]) {
  const flat = items.flat();
  return buildContainerPublicationRecord({
    capsuleId: CAPSULE,
    lifecycleId: "lifecycle-1",
    creatorIdentityId: "f".repeat(32),
    containerTxId: TX,
    chunkIds: flat.map((c) => c.chunkId),
    layoutDigest: await computeContainerLayoutDigest(
      flat.map((c) => ({ chunkId: c.chunkId, size: c.size }))
    ),
    now: 1_800_000_000_000,
  });
}

describe("resolveContainerChunks — derived mapping", () => {
  it("reproduces the Stage 2 layout offsets exactly", async () => {
    const publication = await publicationFor(ITEMS);
    const resolved = await resolveContainerChunks(ITEMS, publication);

    const layout = buildContainerLayout([
      [chunk("A", 0, 300), chunk("A", 1, 111)],
      [chunk("B", 0, 512), chunk("B", 1, 7), chunk("B", 2, 4096)],
    ]);

    expect(resolved.length).toBe(layout.chunkCount);

    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const e = layout.entries[i];
      if (!r || !e || !r.container) throw new Error("missing");

      expect(r.container.globalIndex).toBe(e.globalIndex);
      expect(r.container.offset).toBe(e.offset);
      expect(r.container.length).toBe(e.length);
      expect(r.container.containerTxId).toBe(TX);
      expect(r.chunkId).toBe(e.chunkId);
      expect(r.mediaId).toBe(e.mediaId);
      // LOCAL index preserved — never the global one.
      expect(r.index).toBe(e.localIndex);
      expect(r.size).toBe(e.length);
    }
  });

  it("first chunk starts at HEADER_SIZE and the map is contiguous", async () => {
    const publication = await publicationFor(ITEMS);
    const resolved = await resolveContainerChunks(ITEMS, publication);

    expect(resolved[0]?.container?.offset).toBe(HEADER_SIZE);

    let cursor = HEADER_SIZE;
    for (const r of resolved) {
      expect(r.container?.offset).toBe(cursor);
      cursor += r.container?.length ?? 0;
    }
  });

  it("preserves canonical item order, skipping chunk-less items", async () => {
    const publication = await publicationFor(ITEMS);
    const resolved = await resolveContainerChunks(ITEMS, publication);

    expect(resolved.map((r) => r.chunkId)).toEqual(FLAT.map((c) => c.chunkId));
  });

  it("points every chunk at the ONE container txId", async () => {
    const publication = await publicationFor(ITEMS);
    const resolved = await resolveContainerChunks(ITEMS, publication);

    for (const r of resolved) {
      expect(r.pointer).toBe(TX);
    }
  });

  it("is deterministic across repeated resolution", async () => {
    const publication = await publicationFor(ITEMS);
    const a = await resolveContainerChunks(ITEMS, publication);
    const b = await resolveContainerChunks(ITEMS, publication);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("persists no offsets (they are derived)", async () => {
    const publication = await publicationFor(ITEMS);
    const serialised = JSON.stringify(publication);

    expect(serialised).not.toContain("offset");
    expect(serialised).not.toContain("pointer");
  });
});

describe("resolveContainerChunks — fails closed", () => {
  it("rejects a chunk count mismatch", async () => {
    const publication = await publicationFor(ITEMS);
    await expect(
      resolveContainerChunks(ITEMS.slice(0, 2), publication)
    ).rejects.toThrow("[AETERNA] Container chunk count mismatch");
  });

  it("rejects a reordered chunk set", async () => {
    const publication = await publicationFor(ITEMS);
    const reordered: readonly (readonly ChunkMetadata[])[] = [
      [chunk("B", 0, 512), chunk("B", 1, 7), chunk("B", 2, 4096)],
      [chunk("A", 0, 300), chunk("A", 1, 111)],
    ];
    await expect(resolveContainerChunks(reordered, publication)).rejects.toThrow(
      "[AETERNA] Container chunk identity mismatch"
    );
  });

  it("rejects a layout digest mismatch (same ids, different sizes)", async () => {
    const publication = await publicationFor(ITEMS);
    const altered: readonly (readonly ChunkMetadata[])[] = [
      [chunk("A", 0, 301), chunk("A", 1, 111)],
      [chunk("B", 0, 512), chunk("B", 1, 7), chunk("B", 2, 4096)],
    ];
    await expect(resolveContainerChunks(altered, publication)).rejects.toThrow(
      "[AETERNA] Container layout digest mismatch"
    );
  });

  it("rejects a missing publication", async () => {
    await expect(resolveContainerChunks(ITEMS, null as never)).rejects.toThrow(
      "[AETERNA] Container publication record is required"
    );
  });

  it("rejects invalid chunk metadata", async () => {
    const publication = await publicationFor(ITEMS);
    await expect(
      resolveContainerChunks(null as never, publication)
    ).rejects.toThrow("[AETERNA] Invalid capsule chunk metadata");
  });
});
