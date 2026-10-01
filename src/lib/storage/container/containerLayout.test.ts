/**
 * =========================================================
 * AETERNA — Container layout unit tests (Stage 2)
 * =========================================================
 *
 * Covers: header representation, global ordering, offset/length
 * arithmetic, exact container size, determinism, fail-closed paths,
 * and the module's purity (no fs / network / Irys / crypto).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import type { ChunkMetadata } from "@/types/vault";
import { MAX_ENCRYPTED_CHUNK_SIZE } from "@/lib/crypto/constants";

import {
  HEADER_SIZE,
  CONTAINER_MAGIC,
  CONTAINER_VERSION,
  HEADER_MAGIC_OFFSET,
  HEADER_VERSION_OFFSET,
  HEADER_HEADER_SIZE_OFFSET,
  HEADER_CHUNK_COUNT_OFFSET,
  HEADER_RESERVED_OFFSET,
  HEADER_RESERVED_LENGTH,
  buildContainerLayout,
  offsetOf,
  lengthOf,
  entryOf,
  entryAtByteOffset,
  serializeContainerHeader,
  parseContainerHeader,
} from "./containerLayout";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(__dirname, "containerLayout.ts");

/** Canonical ciphertext length for a chunk of `plaintext` bytes. */
const OVERHEAD = 12 + 16;
function ciphertextSize(plaintext: number): number {
  return plaintext + OVERHEAD;
}

function chunk(
  mediaId: string,
  index: number,
  size: number
): ChunkMetadata {
  return { chunkId: `${mediaId}:${index}`, mediaId, index, size };
}

function item(mediaId: string, sizes: readonly number[]): ChunkMetadata[] {
  return sizes.map((size, index) => chunk(mediaId, index, size));
}

/* ------------------------------------------------------------------ *
 * 1. Header representation
 * ------------------------------------------------------------------ */

describe("container header — canonical representation", () => {
  it("has the canonical fixed size and field offsets", () => {
    expect(HEADER_SIZE).toBe(64);
    expect(HEADER_MAGIC_OFFSET).toBe(0);
    expect(HEADER_VERSION_OFFSET).toBe(4);
    expect(HEADER_HEADER_SIZE_OFFSET).toBe(5);
    expect(HEADER_CHUNK_COUNT_OFFSET).toBe(7);
    expect(HEADER_RESERVED_OFFSET).toBe(11);
    expect(HEADER_RESERVED_LENGTH).toBe(53);
    // The declared regions must exactly tile the fixed header.
    expect(HEADER_RESERVED_OFFSET + HEADER_RESERVED_LENGTH).toBe(HEADER_SIZE);
  });

  it("uses the canonical magic and version", () => {
    expect(Array.from(CONTAINER_MAGIC)).toEqual([0x41, 0x45, 0x54, 0x43]);
    expect(CONTAINER_VERSION).toBe(1);
  });

  it("serializes a fixed-size big-endian header", () => {
    const bytes = serializeContainerHeader(3);

    expect(bytes.byteLength).toBe(HEADER_SIZE);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x41, 0x45, 0x54, 0x43]);
    expect(bytes[HEADER_VERSION_OFFSET]).toBe(CONTAINER_VERSION);

    const view = new DataView(bytes.buffer);
    expect(view.getUint16(HEADER_HEADER_SIZE_OFFSET, false)).toBe(HEADER_SIZE);
    expect(view.getUint32(HEADER_CHUNK_COUNT_OFFSET, false)).toBe(3);
  });

  it("zero-fills the reserved region", () => {
    const bytes = serializeContainerHeader(7);

    for (let i = HEADER_RESERVED_OFFSET; i < HEADER_SIZE; i++) {
      expect(bytes[i]).toBe(0);
    }
  });

  it("round-trips through parse", () => {
    const parsed = parseContainerHeader(serializeContainerHeader(12345));

    expect(parsed).toEqual({
      version: CONTAINER_VERSION,
      headerSize: HEADER_SIZE,
      chunkCount: 12345,
    });
  });

  it("is deterministic — identical bytes for identical input", () => {
    const a = serializeContainerHeader(42);
    const b = serializeContainerHeader(42);

    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("serializes the empty container header", () => {
    const parsed = parseContainerHeader(serializeContainerHeader(0));

    expect(parsed.chunkCount).toBe(0);
  });
});

describe("container header — fails closed", () => {
  it("rejects a bad magic", () => {
    const bytes = serializeContainerHeader(1);
    bytes[0] = 0x00;

    expect(() => parseContainerHeader(bytes)).toThrow(
      "[AETERNA] Invalid container magic"
    );
  });

  it("rejects an unsupported version", () => {
    const bytes = serializeContainerHeader(1);
    bytes[HEADER_VERSION_OFFSET] = 99;

    expect(() => parseContainerHeader(bytes)).toThrow(
      "[AETERNA] Unsupported container version"
    );
  });

  it("rejects an unexpected header size", () => {
    const bytes = serializeContainerHeader(1);
    new DataView(bytes.buffer).setUint16(HEADER_HEADER_SIZE_OFFSET, 32, false);

    expect(() => parseContainerHeader(bytes)).toThrow(
      "[AETERNA] Unsupported container header size"
    );
  });

  it("rejects a non-zero reserved byte", () => {
    const bytes = serializeContainerHeader(1);
    bytes[HEADER_SIZE - 1] = 1;

    expect(() => parseContainerHeader(bytes)).toThrow(
      "[AETERNA] Non-zero container header reserved byte"
    );
  });

  it("rejects a truncated buffer", () => {
    const bytes = serializeContainerHeader(1).slice(0, HEADER_SIZE - 1);

    expect(() => parseContainerHeader(bytes)).toThrow(
      "[AETERNA] Invalid container header"
    );
  });

  it("rejects a non-byte input", () => {
    expect(() => parseContainerHeader("AETC")).toThrow(
      "[AETERNA] Invalid container header"
    );
    expect(() => parseContainerHeader(null)).toThrow(
      "[AETERNA] Invalid container header"
    );
  });

  it("rejects an out-of-range chunk count on serialize", () => {
    for (const bad of [-1, 1.5, 0x100000000, Number.MAX_SAFE_INTEGER, NaN]) {
      expect(() => serializeContainerHeader(bad)).toThrow(
        "[AETERNA] Invalid container chunk count"
      );
    }
  });

  it("accepts the largest representable chunk count", () => {
    const parsed = parseContainerHeader(serializeContainerHeader(0xffffffff));

    expect(parsed.chunkCount).toBe(0xffffffff);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Empty / minimal containers
 * ------------------------------------------------------------------ */

describe("container layout — empty and minimal", () => {
  it("produces a deterministic, valid header-only container for no items", () => {
    const layout = buildContainerLayout([]);

    expect(layout.headerSize).toBe(HEADER_SIZE);
    expect(layout.chunkCount).toBe(0);
    expect(layout.containerSize).toBe(HEADER_SIZE);
    expect(layout.entries).toHaveLength(0);
    expect(parseContainerHeader(serializeContainerHeader(0)).chunkCount).toBe(0);
  });

  it("handles exactly one chunk", () => {
    const layout = buildContainerLayout([item("m0", [ciphertextSize(100)])]);

    expect(layout.chunkCount).toBe(1);
    expect(layout.offsetOf(0)).toBe(HEADER_SIZE);
    expect(layout.lengthOf(0)).toBe(ciphertextSize(100));
    expect(layout.containerSize).toBe(HEADER_SIZE + ciphertextSize(100));
  });

  it("handles many chunks", () => {
    const sizes = Array.from({ length: 25 }, (_, i) => ciphertextSize(1000 + i));
    const layout = buildContainerLayout([item("m0", sizes)]);

    expect(layout.chunkCount).toBe(25);
    expect(layout.containerSize).toBe(
      HEADER_SIZE + sizes.reduce((a, b) => a + b, 0)
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. Ordering, offsets, sizes
 * ------------------------------------------------------------------ */

describe("container layout — ordering and arithmetic", () => {
  it("places chunk 0 immediately after the header", () => {
    const layout = buildContainerLayout([item("m0", [100, 200].map(ciphertextSize))]);

    expect(offsetOf(layout, 0)).toBe(HEADER_SIZE);
    expect(layout.offsetOf(0)).toBe(HEADER_SIZE);
  });

  it("orders by items[] then each item's chunks[]", () => {
    const layout = buildContainerLayout([
      item("a", [ciphertextSize(10), ciphertextSize(20)]),
      item("b", [ciphertextSize(30)]),
      item("c", [ciphertextSize(40), ciphertextSize(50), ciphertextSize(60)]),
    ]);

    expect(layout.entries.map((e) => `${e.mediaId}#${e.localIndex}`)).toEqual([
      "a#0",
      "a#1",
      "b#0",
      "c#0",
      "c#1",
      "c#2",
    ]);
    expect(layout.entries.map((e) => e.globalIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps ChunkMetadata.index LOCAL — it is not the global index", () => {
    const layout = buildContainerLayout([
      item("a", [ciphertextSize(10), ciphertextSize(20)]),
      item("b", [ciphertextSize(30)]),
    ]);

    // Global 2 belongs to item "b" but its local index is 0.
    const entry = entryOf(layout, 2);
    expect(entry.globalIndex).toBe(2);
    expect(entry.localIndex).toBe(0);
    expect(entry.mediaId).toBe("b");

    // Every entry carries its own local index, never the global one.
    expect(layout.entries.map((e) => e.localIndex)).toEqual([0, 1, 0]);
  });

  it("makes offsets contiguous with no gaps and no overlaps", () => {
    const layout = buildContainerLayout([
      item("a", [ciphertextSize(7), ciphertextSize(1), ciphertextSize(999)]),
      item("b", [ciphertextSize(123456)]),
    ]);

    let expected = HEADER_SIZE;
    for (const entry of layout.entries) {
      expect(entry.offset).toBe(expected);
      expected += entry.length;
    }
    expect(expected).toBe(layout.containerSize);
  });

  it("gives every chunk its exact ciphertext length", () => {
    const sizes = [ciphertextSize(1), ciphertextSize(4096), ciphertextSize(1_000_000)];
    const layout = buildContainerLayout([item("m0", sizes)]);

    sizes.forEach((size, i) => {
      expect(layout.lengthOf(i)).toBe(size);
      expect(lengthOf(layout, i)).toBe(size);
      expect(entryOf(layout, i).length).toBe(size);
    });
  });

  it("computes containerSize as HEADER_SIZE + sum of all chunk sizes", () => {
    const groups = [
      item("a", [ciphertextSize(10), ciphertextSize(20)]),
      item("b", [ciphertextSize(30)]),
    ];
    const sum = groups.flat().reduce((a, c) => a + c.size, 0);

    const layout = buildContainerLayout(groups);

    expect(layout.containerSize).toBe(HEADER_SIZE + sum);
  });

  it("handles unequal chunk sizes, including the final short chunk", () => {
    const sizes = [
      ciphertextSize(10 * 1024 * 1024),
      ciphertextSize(10 * 1024 * 1024),
      ciphertextSize(1234),
    ] as const;
    const layout = buildContainerLayout([item("m0", sizes)]);

    expect(layout.lengthOf(0)).toBe(sizes[0]);
    expect(layout.lengthOf(1)).toBe(sizes[1]);
    expect(layout.lengthOf(2)).toBe(sizes[2]);
    expect(layout.offsetOf(2)).toBe(HEADER_SIZE + sizes[0] + sizes[1]);
    expect(layout.containerSize).toBe(HEADER_SIZE + sizes.reduce((a, b) => a + b, 0));
  });

  it("keeps arithmetic safe for a large layout", () => {
    const perChunk = MAX_ENCRYPTED_CHUNK_SIZE;
    const count = 100_000;
    const layout = buildContainerLayout([
      Array.from({ length: count }, (_, i) => chunk("big", i, perChunk)),
    ]);

    const expected = HEADER_SIZE + count * perChunk;

    expect(Number.isSafeInteger(expected)).toBe(true);
    expect(layout.chunkCount).toBe(count);
    expect(layout.containerSize).toBe(expected);
    expect(layout.offsetOf(count - 1)).toBe(HEADER_SIZE + (count - 1) * perChunk);
    expect(layout.offsetOf(count - 1) + layout.lengthOf(count - 1)).toBe(expected);
  });

  it("is deterministic — same metadata yields an identical layout", () => {
    const groups = [
      item("a", [ciphertextSize(5), ciphertextSize(6)]),
      item("b", [ciphertextSize(7)]),
    ];

    const first = buildContainerLayout(groups);
    const second = buildContainerLayout(groups);

    expect(JSON.stringify(first.entries)).toBe(JSON.stringify(second.entries));
    expect(first.containerSize).toBe(second.containerSize);
    expect(first.chunkCount).toBe(second.chunkCount);

    // A structurally equal but distinct input also matches.
    const third = buildContainerLayout([
      item("a", [ciphertextSize(5), ciphertextSize(6)]),
      item("b", [ciphertextSize(7)]),
    ]);
    expect(JSON.stringify(third.entries)).toBe(JSON.stringify(first.entries));
  });

  it("returns frozen, immutable results", () => {
    const layout = buildContainerLayout([item("m0", [ciphertextSize(10)])]);

    const firstEntry = layout.entries[0];
    expect(firstEntry).toBeDefined();

    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.entries)).toBe(true);
    expect(Object.isFrozen(firstEntry)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Byte-offset mapping
 * ------------------------------------------------------------------ */

describe("container layout — byte-offset mapping", () => {
  const layout = buildContainerLayout([
    item("a", [ciphertextSize(100), ciphertextSize(200)]),
    item("b", [ciphertextSize(300)]),
  ]);

  it("maps the first byte of each chunk to its entry", () => {
    expect(entryAtByteOffset(layout, layout.offsetOf(0)).globalIndex).toBe(0);
    expect(entryAtByteOffset(layout, layout.offsetOf(1)).globalIndex).toBe(1);
    expect(entryAtByteOffset(layout, layout.offsetOf(2)).globalIndex).toBe(2);
  });

  it("maps the last byte of each chunk to its entry", () => {
    for (const entry of layout.entries) {
      const lastByte = entry.offset + entry.length - 1;
      expect(entryAtByteOffset(layout, lastByte).globalIndex).toBe(entry.globalIndex);
    }
  });

  it("fails closed inside the header area", () => {
    expect(() => entryAtByteOffset(layout, 0)).toThrow(
      "[AETERNA] Container byte offset out of range"
    );
    expect(() => entryAtByteOffset(layout, HEADER_SIZE - 1)).toThrow(
      "[AETERNA] Container byte offset out of range"
    );
  });

  it("fails closed at and past the end of the container", () => {
    expect(() => entryAtByteOffset(layout, layout.containerSize)).toThrow(
      "[AETERNA] Container byte offset out of range"
    );
    expect(() => entryAtByteOffset(layout, layout.containerSize + 1)).toThrow(
      "[AETERNA] Container byte offset out of range"
    );
  });

  it("fails closed on unsafe offsets", () => {
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN]) {
      expect(() => entryAtByteOffset(layout, bad)).toThrow(
        "[AETERNA] Container byte offset out of range"
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. Fail-closed paths
 * ------------------------------------------------------------------ */

describe("container layout — fails closed", () => {
  it("rejects a non-array item list", () => {
    expect(() => buildContainerLayout(null as unknown as [])).toThrow(
      "[AETERNA] Invalid container item list"
    );
    expect(() => buildContainerLayout(undefined as unknown as [])).toThrow(
      "[AETERNA] Invalid container item list"
    );
  });

  it("rejects an item group that is not an array", () => {
    expect(() =>
      buildContainerLayout([null as unknown as ChunkMetadata[]])
    ).toThrow("[AETERNA] Invalid container item");
  });

  it("rejects an item group with zero chunks", () => {
    expect(() => buildContainerLayout([[]])).toThrow(
      "[AETERNA] Invalid container item"
    );
  });

  it("rejects malformed chunk metadata shapes", () => {
    for (const bad of [null, undefined, 42, "chunk", [], true]) {
      expect(() =>
        buildContainerLayout([[bad as unknown as ChunkMetadata]])
      ).toThrow("[AETERNA] Invalid container chunk metadata");
    }
  });

  it("rejects an empty or missing chunkId", () => {
    expect(() =>
      buildContainerLayout([
        [{ chunkId: "", mediaId: "m", index: 0, size: 100 } as ChunkMetadata],
      ])
    ).toThrow("[AETERNA] Invalid container chunk id");
  });

  it("rejects an empty or missing mediaId", () => {
    expect(() =>
      buildContainerLayout([
        [{ chunkId: "c", mediaId: "", index: 0, size: 100 } as ChunkMetadata],
      ])
    ).toThrow("[AETERNA] Invalid container media id");
  });

  it("rejects a non-contiguous or negative local index", () => {
    // index must run 0,1,2,... within the item
    expect(() =>
      buildContainerLayout([item("m", [ciphertextSize(10), ciphertextSize(10)])])
    ).not.toThrow();

    expect(() =>
      buildContainerLayout([
        [{ chunkId: "c", mediaId: "m", index: 1, size: 100 } as ChunkMetadata],
      ])
    ).toThrow("[AETERNA] Invalid container chunk index");

    expect(() =>
      buildContainerLayout([
        [
          { chunkId: "c0", mediaId: "m", index: 0, size: 100 } as ChunkMetadata,
          { chunkId: "c2", mediaId: "m", index: 2, size: 100 } as ChunkMetadata,
        ],
      ])
    ).toThrow("[AETERNA] Invalid container chunk index");

    expect(() =>
      buildContainerLayout([
        [{ chunkId: "c", mediaId: "m", index: -1, size: 100 } as ChunkMetadata],
      ])
    ).toThrow("[AETERNA] Invalid container chunk index");
  });

  it("rejects invalid chunk sizes", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, MAX_ENCRYPTED_CHUNK_SIZE + 1]) {
      expect(() =>
        buildContainerLayout([
          [{ chunkId: "c", mediaId: "m", index: 0, size: bad } as ChunkMetadata],
        ])
      ).toThrow("[AETERNA] Invalid container chunk size");
    }
  });

  it("accepts a chunk at exactly the maximum encrypted size", () => {
    const layout = buildContainerLayout([
      [{ chunkId: "c", mediaId: "m", index: 0, size: MAX_ENCRYPTED_CHUNK_SIZE } as ChunkMetadata],
    ]);

    expect(layout.lengthOf(0)).toBe(MAX_ENCRYPTED_CHUNK_SIZE);
  });

  it("rejects a duplicate (mediaId, index) position", () => {
    expect(() =>
      buildContainerLayout([
        item("m", [ciphertextSize(10)]),
        item("m", [ciphertextSize(10)]),
      ])
    ).toThrow("[AETERNA] Duplicate container chunk position");
  });

  it("rejects a duplicate chunkId", () => {
    expect(() =>
      buildContainerLayout([
        [
          { chunkId: "same", mediaId: "m", index: 0, size: 100 } as ChunkMetadata,
        ],
        [
          { chunkId: "same", mediaId: "n", index: 0, size: 100 } as ChunkMetadata,
        ],
      ])
    ).toThrow("[AETERNA] Duplicate container chunk id");
  });

  it("fails closed on out-of-range global indices", () => {
    const layout = buildContainerLayout([item("m", [ciphertextSize(10)])]);

    for (const bad of [-1, 1, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN]) {
      expect(() => layout.offsetOf(bad)).toThrow(
        "[AETERNA] Container index out of range"
      );
      expect(() => layout.lengthOf(bad)).toThrow(
        "[AETERNA] Container index out of range"
      );
      expect(() => entryOf(layout, bad)).toThrow(
        "[AETERNA] Container index out of range"
      );
    }
  });

  it("fails closed for any index in an empty container", () => {
    const layout = buildContainerLayout([]);

    expect(() => layout.offsetOf(0)).toThrow(
      "[AETERNA] Container index out of range"
    );
  });
});

/* ------------------------------------------------------------------ *
 * 6. Module purity — no fs / network / Irys / crypto mutation
 * ------------------------------------------------------------------ */

describe("container layout — module purity", () => {
  const source = readFileSync(MODULE_PATH, "utf8");

  /**
   * Comments deliberately NAME the things this module must not do
   * ("no filesystem, network or Irys access"), so the purity checks
   * must run against code only.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("performs no filesystem, network or Irys access", () => {
    for (const forbidden of [
      "fetch(",
      "XMLHttpRequest",
      "node:fs",
      "require(",
      "irys",
      "Irys",
      "WebSocket",
      "localStorage",
      "indexedDB",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("contains no clock or randomness (determinism)", () => {
    for (const forbidden of [
      "Date.now",
      "new Date",
      "Math.random",
      "performance.now",
      "crypto.randomUUID",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("imports no crypto implementation and no Vault/authority module", () => {
    const imports = source.match(/from\s+"[^"]+"/g) ?? [];

    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).toMatch(
        /^from\s+"(@\/types\/(manifest|vault)|@\/lib\/crypto\/constants)"$/
      );
    }
  });

  it("declares no cryptographic operation", () => {
    for (const forbidden of [
      "subtle",
      "encryptChunk",
      "decryptChunk",
      "deriveChunkIV",
      "PBKDF2",
      "AES",
      "GCM",
      "sha256",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
