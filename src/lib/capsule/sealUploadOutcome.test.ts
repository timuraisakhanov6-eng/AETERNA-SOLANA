/**
 * Stage 4 — seal upload-outcome contract tests.
 *
 * Proves the seal logic can distinguish LEGACY (N chunks → N records) from
 * CONTAINER (N logical chunks → 1 publication record), and that the previous
 * count-only check is now a real set-membership check.
 */
import { describe, it, expect } from "vitest";

import type { ChunkMetadata } from "@/types/vault";

import { assertSealUploadOutcome } from "./sealUploadOutcome";

function chunk(mediaId: string, index: number): ChunkMetadata {
  return { chunkId: `${mediaId}:${index}`, mediaId, index, size: 100 };
}

const EXPECTED = [chunk("A", 0), chunk("A", 1), chunk("B", 0)];
const IDS = EXPECTED.map((c) => c.chunkId);

describe("seal upload outcome — LEGACY (N chunks → N records)", () => {
  it("accepts an exact N/N cover", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "legacy",
        uploadedChunks: IDS.map((chunkId) => ({ chunkId })),
      })
    ).not.toThrow();
  });

  it("accepts a single chunk", () => {
    const one = [chunk("A", 0)];
    expect(() =>
      assertSealUploadOutcome(one, {
        mode: "legacy",
        uploadedChunks: [{ chunkId: one[0]!.chunkId }],
      })
    ).not.toThrow();
  });

  it("rejects a count mismatch with the legacy message", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "legacy",
        uploadedChunks: [{ chunkId: IDS[0]! }],
      })
    ).toThrow("[AETERNA] Chunk upload count mismatch");
  });

  it("rejects a duplicate with the legacy message", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "legacy",
        uploadedChunks: [{ chunkId: IDS[0]! }, { chunkId: IDS[0]! }, { chunkId: IDS[2]! }],
      })
    ).toThrow("[AETERNA] Duplicate chunk upload");
  });

  it("STRENGTHENED: rejects a same-count but WRONG identity set", () => {
    // The previous inline check compared counts + uniqueness only, so this
    // would have passed while covering the wrong chunks.
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "legacy",
        uploadedChunks: [{ chunkId: IDS[0]! }, { chunkId: IDS[1]! }, { chunkId: "other" }],
      })
    ).toThrow("[AETERNA] Chunk upload count mismatch");
  });
});

describe("seal upload outcome — CONTAINER (N logical chunks → 1 record)", () => {
  it("accepts a container covering every expected chunk", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "container",
        containerChunkIds: IDS,
      })
    ).not.toThrow();
  });

  it("accepts a container for a single-chunk capsule", () => {
    const one = [chunk("A", 0)];
    expect(() =>
      assertSealUploadOutcome(one, {
        mode: "container",
        containerChunkIds: [one[0]!.chunkId],
      })
    ).not.toThrow();
  });

  it("rejects a container that omits an expected chunk", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "container",
        containerChunkIds: IDS.slice(0, 2),
      })
    ).toThrow("[AETERNA] Container publication chunk set mismatch");
  });

  it("rejects a container carrying an unexpected chunk", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "container",
        containerChunkIds: [...IDS.slice(0, 2), "other"],
      })
    ).toThrow("[AETERNA] Container publication chunk set mismatch");
  });

  it("rejects duplicate logical chunks in a container", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "container",
        containerChunkIds: [IDS[0]!, IDS[0]!, IDS[2]!],
      })
    ).toThrow("[AETERNA] Duplicate chunk in container publication");
  });

  it("rejects a multi-chunk capsule published as a single-chunk container", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, {
        mode: "container",
        containerChunkIds: [IDS[0]!],
      })
    ).toThrow("[AETERNA] Container publication covers too few chunks");
  });
});

describe("seal upload outcome — malformed input", () => {
  it("rejects an unknown mode", () => {
    expect(() =>
      assertSealUploadOutcome(EXPECTED, { mode: "wat" } as never)
    ).toThrow("[AETERNA] Unknown upload outcome mode");
  });

  it("rejects a missing outcome", () => {
    expect(() => assertSealUploadOutcome(EXPECTED, null as never)).toThrow(
      "[AETERNA] Invalid upload outcome"
    );
  });

  it("rejects invalid expected metadata", () => {
    expect(() =>
      assertSealUploadOutcome(null as never, { mode: "legacy", uploadedChunks: [] })
    ).toThrow("[AETERNA] Invalid chunk metadata");
  });
});
