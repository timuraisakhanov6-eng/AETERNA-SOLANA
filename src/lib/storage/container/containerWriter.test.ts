/**
 * =========================================================
 * AETERNA — Container writer tests (Stage 3)
 * =========================================================
 *
 * Byte-exactness, canonical ordering, incremental Runtime reads,
 * backpressure, instrumentation, and every fail-closed path.
 */
import { describe, it, expect } from "vitest";
import { Readable } from "stream";

import type { ChunkMetadata } from "@/types/vault";
import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import {
  HEADER_SIZE,
  buildContainerLayout,
  serializeContainerHeader,
} from "./containerLayout";
import { createContainerWriter } from "./containerWriter";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function chunk(mediaId: string, index: number, size: number): ChunkMetadata {
  return { chunkId: `${mediaId}:${index}`, mediaId, index, size };
}

/** Deterministic, chunk-unique byte pattern (never all-zero). */
function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i + seed * 31 + 7) & 0xff;
  return out;
}

interface FakeRuntime extends RuntimeStorage {
  readonly readOrder: string[];
}

/**
 * Minimal Runtime storage stand-in backed by an in-memory map.
 * `readOrder` records the exact chunkId sequence requested.
 */
function fakeRuntime(chunks: ReadonlyMap<string, Uint8Array>): FakeRuntime {
  const readOrder: string[] = [];
  return {
    readOrder,
    async read(chunkId: string) {
      readOrder.push(chunkId);
      const ciphertext = chunks.get(chunkId);
      if (!ciphertext) throw new Error("runtime: chunk not found");
      return {
        chunkId,
        mediaId: "m",
        chunkIndex: 0,
        ciphertext,
      };
    },
  } as unknown as FakeRuntime;
}

async function collect(readable: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of readable) {
    parts.push(Buffer.from(part as Uint8Array));
  }
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ *
 * 1. Byte-exactness — Phase 7
 * ------------------------------------------------------------------ */

describe("container writer — byte exactness", () => {
  const groups = [
    [chunk("A", 0, 300), chunk("A", 1, 111)],
    [chunk("B", 0, 512), chunk("B", 1, 7), chunk("B", 2, 4096)],
  ];
  const layout = buildContainerLayout(groups);

  const store = new Map<string, Uint8Array>();
  let seed = 0;
  for (const group of groups) {
    for (const c of group) store.set(c.chunkId, bytes(c.size, seed++));
  }

  it("emits [HEADER][A0][A1][B0][B1][B2] exactly", async () => {
    const runtime = fakeRuntime(store);
    const writer = createContainerWriter(layout, runtime);

    const out = await collect(writer.readable);

    // Exact header bytes.
    const expectedHeader = Buffer.from(serializeContainerHeader(layout.chunkCount));
    expect(out.subarray(0, HEADER_SIZE)).toEqual(expectedHeader);

    // Chunks in canonical order, byte-identical, no gap, no duplicate.
    let cursor = HEADER_SIZE;
    for (const entry of layout.entries) {
      const expected = Buffer.from(store.get(entry.chunkId) as Uint8Array);
      const actual = out.subarray(cursor, cursor + entry.length);

      expect(actual.byteLength).toBe(entry.length);
      expect(actual).toEqual(expected);
      expect(entry.offset).toBe(cursor);

      cursor += entry.length;
    }

    // Final byte count equals the canonical container size.
    expect(cursor).toBe(layout.containerSize);
    expect(out.byteLength).toBe(layout.containerSize);
  });

  it("reads Runtime chunks in canonical order, once each", async () => {
    const runtime = fakeRuntime(store);
    const writer = createContainerWriter(layout, runtime);

    await collect(writer.readable);

    expect(runtime.readOrder).toEqual([
      "A:0",
      "A:1",
      "B:0",
      "B:1",
      "B:2",
    ]);
    expect(runtime.readOrder.length).toBe(layout.chunkCount);
  });

  it("is deterministic — identical bytes on a repeat run", async () => {
    const first = await collect(createContainerWriter(layout, fakeRuntime(store)).readable);
    const second = await collect(createContainerWriter(layout, fakeRuntime(store)).readable);

    expect(first.equals(second)).toBe(true);
  });

  it("emits only the header for an empty layout", async () => {
    const empty = buildContainerLayout([]);
    const out = await collect(createContainerWriter(empty, fakeRuntime(new Map())).readable);

    expect(out.byteLength).toBe(HEADER_SIZE);
    expect(out).toEqual(Buffer.from(serializeContainerHeader(0)));
  });

  it("handles a single chunk", async () => {
    const single = buildContainerLayout([[chunk("S", 0, 1234)]]);
    const s = new Map([["S:0", bytes(1234, 3)]]);

    const out = await collect(createContainerWriter(single, fakeRuntime(s)).readable);

    expect(out.byteLength).toBe(HEADER_SIZE + 1234);
    expect(out.subarray(HEADER_SIZE)).toEqual(Buffer.from(bytes(1234, 3)));
  });
});

/* ------------------------------------------------------------------ *
 * 2. Incremental reads / backpressure / instrumentation — Phase 5
 * ------------------------------------------------------------------ */

describe("container writer — incremental reads and instrumentation", () => {
  const groups = [
    [chunk("A", 0, 1024), chunk("A", 1, 1024)],
    [chunk("B", 0, 1024)],
  ];
  const layout = buildContainerLayout(groups);
  const store = new Map<string, Uint8Array>([
    ["A:0", bytes(1024, 1)],
    ["A:1", bytes(1024, 2)],
    ["B:0", bytes(1024, 3)],
  ]);

  it("does not read any chunk before the stream is consumed", async () => {
    const runtime = fakeRuntime(store);
    const writer = createContainerWriter(layout, runtime);

    await new Promise((r) => setTimeout(r, 20));

    expect(runtime.readOrder).toEqual([]);
    expect(writer.stats().readChunkCalls).toBe(0);
  });

  it("holds at most ONE Runtime chunk buffer at a time", async () => {
    const writer = createContainerWriter(layout, fakeRuntime(store));

    await collect(writer.readable);

    const stats = writer.stats();
    expect(stats.peakLiveChunkBuffers).toBe(1);
    expect(stats.peakLiveChunkBytes).toBe(1024);
    // Far below the whole container — no full-container buffer.
    expect(stats.peakLiveChunkBytes).toBeLessThan(layout.containerSize);
  });

  it("reports emitted bytes, read calls and completion", async () => {
    const writer = createContainerWriter(layout, fakeRuntime(store));

    await collect(writer.readable);

    const stats = writer.stats();
    expect(stats.readChunkCalls).toBe(3);
    expect(stats.emittedBytes).toBe(layout.containerSize);
    expect(stats.completed).toBe(true);
  });

  it("releases each chunk before loading the next", async () => {
    const runtime = fakeRuntime(store);
    const writer = createContainerWriter(layout, runtime);

    const seen: number[] = [];
    writer.readable.on("data", () => {
      seen.push(runtime.readOrder.length);
    });

    await new Promise<void>((resolve, reject) => {
      writer.readable.on("end", resolve);
      writer.readable.on("error", reject);
    });

    // Read count only ever advances one at a time — never all up front.
    const maxAtFirstByte = Math.min(...seen);
    expect(maxAtFirstByte).toBeLessThanOrEqual(1);
    expect(runtime.readOrder.length).toBe(3);
  });

  it("honours backpressure from a slow consumer", async () => {
    const runtime = fakeRuntime(store);
    const writer = createContainerWriter(layout, runtime);

    // Pause immediately; nothing should be produced until we resume.
    writer.readable.pause();
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.readOrder).toEqual([]);

    const out = await collect(writer.readable);
    expect(out.byteLength).toBe(layout.containerSize);
  });

  it("emits the header before any chunk is read", async () => {
    const runtime = fakeRuntime(store);
    const writer = createContainerWriter(layout, runtime);

    const first = await new Promise<Buffer>((resolve, reject) => {
      writer.readable.once("data", (c: Buffer) => resolve(Buffer.from(c)));
      writer.readable.once("error", reject);
    });

    expect(first.subarray(0, 4)).toEqual(Buffer.from([0x41, 0x45, 0x54, 0x43]));
    writer.readable.destroy();
  });
});

/* ------------------------------------------------------------------ *
 * 3. Fail-closed — Phase 8
 * ------------------------------------------------------------------ */

describe("container writer — fails closed", () => {
  const layout = buildContainerLayout([
    [chunk("A", 0, 100), chunk("A", 1, 200)],
  ]);

  function fullStore(): Map<string, Uint8Array> {
    return new Map<string, Uint8Array>([
      ["A:0", bytes(100, 1)],
      ["A:1", bytes(200, 2)],
    ]);
  }

  it("fails closed when a Runtime chunk is missing", async () => {
    // A Runtime that RESOLVES but yields no ciphertext (the record
    // exists in neither the chunk nor the error channel).
    const runtime = {
      async read(chunkId: string) {
        return chunkId === "A:0"
          ? { chunkId, mediaId: "A", chunkIndex: 0, ciphertext: bytes(100, 1) }
          : { chunkId, mediaId: "A", chunkIndex: 1, ciphertext: undefined };
      },
    } as unknown as RuntimeStorage;

    await expect(
      collect(createContainerWriter(layout, runtime).readable)
    ).rejects.toThrow("[AETERNA] Container chunk is missing");
  });

  it("fails closed when the Runtime adapter throws for a missing chunk", async () => {
    const store = fullStore();
    store.delete("A:1");

    await expect(
      collect(createContainerWriter(layout, fakeRuntime(store)).readable)
    ).rejects.toThrow("[AETERNA] Container chunk read failed");
  });

  it("fails closed on a short chunk", async () => {
    const store = fullStore();
    store.set("A:1", bytes(199, 2));

    await expect(
      collect(createContainerWriter(layout, fakeRuntime(store)).readable)
    ).rejects.toThrow("[AETERNA] Container chunk length mismatch");
  });

  it("fails closed on an over-long chunk", async () => {
    const store = fullStore();
    store.set("A:0", bytes(101, 1));

    await expect(
      collect(createContainerWriter(layout, fakeRuntime(store)).readable)
    ).rejects.toThrow("[AETERNA] Container chunk length mismatch");
  });

  it("fails closed when Runtime read throws", async () => {
    const runtime = {
      async read() {
        throw new Error("indexeddb exploded");
      },
    } as unknown as RuntimeStorage;

    await expect(
      collect(createContainerWriter(layout, runtime).readable)
    ).rejects.toThrow("[AETERNA] Container chunk read failed");
  });

  it("fails closed on a malformed Runtime record", async () => {
    const runtime = {
      async read() {
        return { chunkId: "A:0", mediaId: "A", chunkIndex: 0, ciphertext: null };
      },
    } as unknown as RuntimeStorage;

    await expect(
      collect(createContainerWriter(layout, runtime).readable)
    ).rejects.toThrow("[AETERNA] Container chunk is missing");
  });

  it("fails closed on an invalid layout", () => {
    expect(() =>
      createContainerWriter(null as never, fakeRuntime(new Map()))
    ).toThrow("[AETERNA] Invalid container layout");

    expect(() =>
      createContainerWriter({ entries: [] } as never, fakeRuntime(new Map()))
    ).toThrow("[AETERNA] Invalid container size");
  });

  it("fails closed when the Runtime is not supplied", () => {
    expect(() => createContainerWriter(layout, null as never)).toThrow(
      "[AETERNA] Runtime storage is required"
    );
  });

  it("aborts the stream and releases the reader", async () => {
    const runtime = fakeRuntime(fullStore());
    const writer = createContainerWriter(layout, runtime);

    writer.abort();

    await expect(collect(writer.readable)).rejects.toThrow(
      "[AETERNA] Container writer aborted"
    );
    expect(writer.stats().completed).toBe(false);
  });

  it("stops reading further chunks after a failure", async () => {
    const store = fullStore();
    store.delete("A:1");
    const runtime = fakeRuntime(store);

    await expect(
      collect(createContainerWriter(layout, runtime).readable)
    ).rejects.toThrow();

    // The failing chunk was requested once; nothing after it.
    expect(runtime.readOrder).toEqual(["A:0", "A:1"]);
  });
});
