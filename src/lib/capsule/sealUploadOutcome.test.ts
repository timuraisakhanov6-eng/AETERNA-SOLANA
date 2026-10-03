/**
 * Seal upload-outcome contract tests.
 *
 * Container V1 is the ONLY media model: N logical chunks → 1 container
 * publication record. The legacy per-chunk outcome no longer exists.
 */
import { describe, it, expect } from "vitest";

import type { ChunkMetadata } from "@/types/vault";

import { assertSealUploadOutcome } from "./sealUploadOutcome";

function chunk(mediaId: string, index: number): ChunkMetadata {
  return { chunkId: `${mediaId}:${index}`, mediaId, index, size: 100 };
}

const EXPECTED = [chunk("A", 0), chunk("A", 1), chunk("B", 0)];
const IDS = EXPECTED.map((c) => c.chunkId);

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
      assertSealUploadOutcome(null as never, { mode: "container", containerChunkIds: [] })
    ).toThrow("[AETERNA] Invalid chunk metadata");
  });
});
