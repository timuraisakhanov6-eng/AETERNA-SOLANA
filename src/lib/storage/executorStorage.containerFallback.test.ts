/**
 * =========================================================
 * Phase F3.3 — BOUNDED FULL-CONTAINER FALLBACK
 * =========================================================
 *
 * Drives the REAL `executorStorage.downloadRange` (through the real
 * `storage` façade and the real `chunkLoader`) with only `fetch` stubbed,
 * and proves the bounded full-container fallback:
 *
 *   • triggers ONLY on a confirmed status-gate rejection
 *     (`status-not-206` — the `PREVIEW_RANGE_STATUS_REJECTED` condition);
 *   • performs a SEPARATE ordinary GET (no `Range` header);
 *   • is capped at 20 MiB BEFORE any network I/O;
 *   • streams the body with a running byte counter (never
 *     arrayBuffer-then-check);
 *   • validates exact length + header + `chunkCount` against the TRUSTED,
 *     digest-verified layout;
 *   • serves every chunk of one container from ONE fetch;
 *   • preserves the original typed error whenever the fallback cannot
 *     apply or cannot succeed;
 *   • never caches a failed/partial/aborted body.
 *
 * The container bytes are synthetic; the AES-GCM path is the REAL one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ChunkMetadata } from "@/types/vault";
import type { StoragePointer } from "@/lib/storage/storageAdapter";

import {
  buildContainerLayout,
  serializeContainerHeader,
  HEADER_SIZE,
  CONTAINER_MAGIC,
  CONTAINER_VERSION,
} from "@/lib/storage/container/containerLayout";
import {
  buildContainerPublicationRecord,
  computeContainerLayoutDigest,
  type ContainerPublicationRecord,
} from "@/lib/storage/container/containerPublication";
import { resolveContainerChunks } from "@/lib/capsule/open/resolveContainerChunks";
import { loadChunk } from "@/lib/capsule/runtime/chunkLoader";
import { storage } from "@/lib/storage/storage";
import { STORAGE_FAILURE_MESSAGE } from "@/lib/storage/storageRangeFailure";
import { CONTAINER_FULL_FALLBACK_MAX_BYTES } from "@/lib/storage/executorStorage";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const CAPSULE_ID = "a".repeat(64);

let pointerSeq = 0;
/** A fresh, valid, UNIQUE pointer per test — the module-level cache is
 * keyed by pointer, so uniqueness gives per-test isolation. */
function freshPointer(): StoragePointer {
  pointerSeq += 1;
  const body = `P${String(pointerSeq).padStart(20, "0")}`;
  return (body + "X".repeat(43 - body.length)) as StoragePointer;
}

function chunkIdFor(n: number): string {
  return n.toString(16).padStart(2, "0").repeat(32);
}

/** Two chunks of UNEQUAL ciphertext length. */
const CHUNK_A = 4_000;
const CHUNK_B = 2_500;

const ITEMS: readonly (readonly ChunkMetadata[])[] = [
  [
    Object.freeze({
      chunkId: chunkIdFor(1),
      mediaId: "A",
      index: 0,
      size: CHUNK_A,
    }) as ChunkMetadata,
  ],
  [
    Object.freeze({
      chunkId: chunkIdFor(2),
      mediaId: "B",
      index: 0,
      size: CHUNK_B,
    }) as ChunkMetadata,
  ],
];

/** Builds a well-formed container whose chunk bytes are recognisable. */
function makeContainerBytes(items = ITEMS): Uint8Array {
  const layout = buildContainerLayout(items);
  const bytes = new Uint8Array(layout.containerSize);
  bytes.set(serializeContainerHeader(layout.chunkCount), 0);
  let cursor = HEADER_SIZE;
  for (const entry of layout.entries) {
    for (let i = 0; i < entry.length; i++) {
      bytes[cursor + i] = (i + entry.globalIndex * 17) & 0xff;
    }
    cursor += entry.length;
  }
  return bytes;
}

async function publicationFor(
  txId: string,
  items = ITEMS
): Promise<ContainerPublicationRecord> {
  const layout = buildContainerLayout(items);
  const digest = await computeContainerLayoutDigest(
    layout.entries.map((e) => ({ chunkId: e.chunkId, size: e.length }))
  );
  return buildContainerPublicationRecord({
    capsuleId: CAPSULE_ID,
    lifecycleId: "lifecycle-1",
    creatorIdentityId: "identity-1",
    containerTxId: txId,
    chunkIds: layout.entries.map((e) => e.chunkId),
    layoutDigest: digest,
    now: 1_800_000_000_000,
  });
}

/* ------------------------------------------------------------------ *
 * fetch stub
 * ------------------------------------------------------------------ */

interface StubOptions {
  /** Status returned for the RANGE attempt. */
  rangeStatus?: number;
  /** Status returned for the plain (fallback) GET. */
  fullStatus?: number;
  /** Body chunks for the plain GET (streamed one by one). */
  fullChunks?: readonly Uint8Array[];
  /** `content-type` for the plain GET. */
  fullContentType?: string;
  /** `content-length` for the plain GET (early-reject path). */
  fullContentLength?: string | null;
  /** Never resolve the plain GET (for cancellation tests). */
  holdFull?: boolean;
  /** Reject the plain GET at the transport layer. */
  fullRejects?: boolean;
}

let fetchMock: ReturnType<typeof vi.fn>;
let options: StubOptions;
let heldResolvers: Array<() => void>;

function fullCallCount(): number {
  return fetchMock.mock.calls.filter(
    (c) => (c[1] as RequestInit | undefined)?.headers === undefined
  ).length;
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]);
      i += 1;
    },
  });
}

function makeResponse(init: {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  contentType?: string;
  contentLength?: string | null;
}): Response {
  const headers = new Map<string, string>();
  if (init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
  }
  if (init.contentLength !== undefined && init.contentLength !== null) {
    headers.set("content-length", init.contentLength);
  }
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    body: init.body ?? null,
    arrayBuffer: async () => {
      throw new Error("arrayBuffer() must never be used by the fallback");
    },
  } as unknown as Response;
}

beforeEach(() => {
  options = {};
  heldResolvers = [];
  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? undefined) as
      | Record<string, string>
      | undefined;

    // ── RANGE attempt (carries a Range header) ──────────────────────
    if (headers !== undefined) {
      return Promise.resolve(
        makeResponse({
          status: options.rangeStatus ?? 200,
          contentType: "application/octet-stream",
        })
      );
    }

    // ── PLAIN fallback GET (no Range header) ───────────────────────
    if (options.fullRejects) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }

    if (options.holdFull) {
      return new Promise<Response>((resolve) => {
        heldResolvers.push(() =>
          resolve(
            makeResponse({
              status: options.fullStatus ?? 200,
              body: streamOf(options.fullChunks ?? []),
            })
          )
        );
      });
    }

    return Promise.resolve(
      makeResponse({
        status: options.fullStatus ?? 200,
        body: streamOf(options.fullChunks ?? []),
        contentType: options.fullContentType ?? "application/octet-stream",
        contentLength: options.fullContentLength,
      })
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ================================================================== *
 * POSITIVE
 * ================================================================== */

describe("F3.3 — fallback triggers on a confirmed status rejection", () => {
  it("serves the requested window from a plain GET after a 200 range rejection", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };

    const bytes = await storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
      size: container.byteLength,
      chunkCount: 2,
    });

    expect(bytes.byteLength).toBe(CHUNK_A);
    expect(Array.from(bytes)).toEqual(
      Array.from(container.subarray(HEADER_SIZE, HEADER_SIZE + CHUNK_A))
    );
    // A separate ordinary GET was issued (no Range header).
    expect(fullCallCount()).toBe(1);
  });

  it("serves BOTH chunks of one container from ONE plain GET", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 403, fullChunks: [container] };
    const hint = { size: container.byteLength, chunkCount: 2 };

    const first = await storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, hint);
    const second = await storage.downloadRange(
      pointer,
      HEADER_SIZE + CHUNK_A,
      CHUNK_B,
      hint
    );

    expect(first.byteLength).toBe(CHUNK_A);
    expect(second.byteLength).toBe(CHUNK_B);
    // The second window came from the cache — only ONE plain GET total.
    expect(fullCallCount()).toBe(1);
  });

  it("parallel reads of the SAME container share one plain GET (single flight)", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };
    const hint = { size: container.byteLength, chunkCount: 2 };

    const [a, b] = await Promise.all([
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, hint),
      storage.downloadRange(pointer, HEADER_SIZE + CHUNK_A, CHUNK_B, hint),
    ]);

    expect(a.byteLength).toBe(CHUNK_A);
    expect(b.byteLength).toBe(CHUNK_B);
    expect(fullCallCount()).toBe(1);
  });

  it("the real 13,613,786-byte container is within the limit and is served", async () => {
    const pointer = freshPointer();
    const FIRST = 10_485_760;
    const SECOND = 3_127_962; // 64 + FIRST + SECOND = 13,613,786
    const items: readonly (readonly ChunkMetadata[])[] = [
      [
        Object.freeze({
          chunkId: chunkIdFor(3),
          mediaId: "A",
          index: 0,
          size: FIRST,
        }) as ChunkMetadata,
      ],
      [
        Object.freeze({
          chunkId: chunkIdFor(4),
          mediaId: "B",
          index: 0,
          size: SECOND,
        }) as ChunkMetadata,
      ],
    ];
    const container = makeContainerBytes(items);
    expect(container.byteLength).toBe(13_613_786);
    expect(container.byteLength).toBeLessThanOrEqual(
      CONTAINER_FULL_FALLBACK_MAX_BYTES
    );

    options = { rangeStatus: 200, fullChunks: [container] };

    const bytes = await storage.downloadRange(pointer, HEADER_SIZE, FIRST, {
      size: container.byteLength,
      chunkCount: 2,
    });

    expect(bytes.byteLength).toBe(FIRST);
    expect(fullCallCount()).toBe(1);
  });
});

/* ================================================================== *
 * END-TO-END: the REAL AES-GCM path is preserved
 * ================================================================== */

describe("F3.3 — end-to-end through chunkLoader keeps the real crypto", () => {
  it("decrypts a container chunk fetched by the fallback", async () => {
    const pointer = freshPointer();
    const key = (await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    )) as CryptoKey;

    const { encryptChunk } = await import("@/lib/crypto/encryptChunk");
    const plaintext = new Uint8Array(64).fill(9);
    const wire = await encryptChunk(
      plaintext,
      key,
      new Uint8Array(12).fill(5),
      0,
      CAPSULE_ID
    );

    const items: readonly (readonly ChunkMetadata[])[] = [
      [
        Object.freeze({
          chunkId: chunkIdFor(7),
          mediaId: "A",
          index: 0,
          size: wire.byteLength,
        }) as ChunkMetadata,
      ],
    ];

    const record = await publicationFor(pointer, items);
    const resolved = await resolveContainerChunks(items, record);
    expect(resolved).toHaveLength(1);

    // Build the container with the REAL ciphertext at the derived offset.
    const layout = buildContainerLayout(items);
    const container = new Uint8Array(layout.containerSize);
    container.set(serializeContainerHeader(layout.chunkCount), 0);
    container.set(wire, HEADER_SIZE);

    options = { rangeStatus: 200, fullChunks: [container] };

    const out = await loadChunk(CAPSULE_ID, resolved[0]!, key);

    expect(Array.from(out)).toEqual(Array.from(plaintext));
    expect(fullCallCount()).toBe(1);
  });
});

/* ================================================================== *
 * NEGATIVE — size / integrity
 * ================================================================== */

describe("F3.3 — integrity failures fall through to the original error", () => {
  async function expectOriginalError(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toThrow(STORAGE_FAILURE_MESSAGE);
  }

  it("a SHORTER body than expected is rejected", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = {
      rangeStatus: 200,
      fullChunks: [container.subarray(0, container.byteLength - 1)],
    };
    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    );
  });

  it("a LONGER body than expected is rejected", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    const longer = new Uint8Array(container.byteLength + 8);
    longer.set(container, 0);
    options = { rangeStatus: 200, fullChunks: [longer] };
    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    );
  });

  it("a body exceeding the 20 MiB ceiling DURING streaming is cancelled and rejected", async () => {
    const pointer = freshPointer();
    // Trusted size is small, so the fallback starts; the SERVER then streams
    // more than the ceiling — the streaming counter must stop it.
    const big = new Uint8Array(CONTAINER_FULL_FALLBACK_MAX_BYTES + 1024);
    options = { rangeStatus: 200, fullChunks: [big] };

    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: 64 + CHUNK_A,
        chunkCount: 1,
      })
    );
  });

  it("a bad MAGIC is rejected", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    container[0] = 0x00;
    options = { rangeStatus: 200, fullChunks: [container] };
    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    );
  });

  it("a bad VERSION is rejected", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    container[4] = CONTAINER_VERSION + 1;
    options = { rangeStatus: 200, fullChunks: [container] };
    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    );
  });

  it("a non-zero RESERVED byte is rejected", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    container[20] = 0x7f;
    options = { rangeStatus: 200, fullChunks: [container] };
    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    );
  });

  it("a header chunkCount that DISAGREES with the trusted layout is rejected", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };
    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        // Trusted layout says 2; a container claiming 1 must not be trusted.
        chunkCount: 1,
      })
    );
  });

  it("a container larger than 20 MiB never triggers a plain GET", async () => {
    const pointer = freshPointer();
    options = { rangeStatus: 200, fullChunks: [] };

    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: CONTAINER_FULL_FALLBACK_MAX_BYTES + 1,
        chunkCount: 3,
      })
    );

    expect(fullCallCount()).toBe(0);
  });

  it("a structural-only hint (no safe integers) never triggers a plain GET", async () => {
    const pointer = freshPointer();
    options = { rangeStatus: 200, fullChunks: [] };

    await expectOriginalError(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: Number.NaN,
        chunkCount: 2,
      } as never)
    );

    expect(fullCallCount()).toBe(0);
  });
});

/* ================================================================== *
 * NEGATIVE — non-status causes must NOT be masked
 * ================================================================== */

describe("F3.3 — non-status failures are never masked by the fallback", () => {
  it("a plain network failure keeps range-network and issues no plain GET", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { fullChunks: [container] };
    fetchMock.mockImplementation(() =>
      Promise.reject(new TypeError("Failed to fetch"))
    );

    let caught: unknown;
    try {
      await storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      });
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).toBe(STORAGE_FAILURE_MESSAGE);
    expect(fullCallCount()).toBe(0);
  });

  it("a MIXED rejection (status + body-short) does NOT trigger the fallback", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { fullChunks: [container] };

    let call = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? undefined) as
        | Record<string, string>
        | undefined;
      if (headers === undefined) {
        return Promise.resolve(
          makeResponse({ status: 200, body: streamOf([container]) })
        );
      }
      call += 1;
      // #1 status rejection, #2 a 206 with a SHORT body → mixed reasons.
      return Promise.resolve(
        makeResponse({
          status: call === 1 ? 200 : 206,
          contentType: "application/octet-stream",
        })
      );
    });

    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    ).rejects.toThrow(STORAGE_FAILURE_MESSAGE);

    expect(fullCallCount()).toBe(0);
  });

  it("a failed plain GET does not leave the container cached", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    // 1st: short body → fallback fails.
    options = {
      rangeStatus: 200,
      fullChunks: [container.subarray(0, container.byteLength - 1)],
    };
    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    ).rejects.toThrow(STORAGE_FAILURE_MESSAGE);

    // 2nd: a good body → must issue a NEW plain GET (nothing was cached).
    options = { rangeStatus: 200, fullChunks: [container] };
    const bytes = await storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
      size: container.byteLength,
      chunkCount: 2,
    });

    expect(bytes.byteLength).toBe(CHUNK_A);
    // 2 plain GETs for the failed first read (one per gateway), then 1 for
    // the successful second read — nothing was cached from the failure.
    expect(fullCallCount()).toBe(3);
  });
});

/* ================================================================== *
 * CANCELLATION
 * ================================================================== */

describe("F3.3 — cancellation and resource release", () => {
  it("a transport-rejecting plain GET falls through and caches nothing", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullRejects: true };

    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      })
    ).rejects.toThrow(STORAGE_FAILURE_MESSAGE);

    // Nothing was cached — a subsequent good read issues a fresh plain GET.
    options = { rangeStatus: 200, fullChunks: [container] };
    const bytes = await storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
      size: container.byteLength,
      chunkCount: 2,
    });
    expect(bytes.byteLength).toBe(CHUNK_A);
    // 2 rejected plain GETs (one per gateway) + 1 successful read.
    expect(fullCallCount()).toBe(3);
  });

  it("two DIFFERENT containers are fetched independently (cache is keyed)", async () => {
    const pointerA = freshPointer();
    const pointerB = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };

    await storage.downloadRange(pointerA, HEADER_SIZE, CHUNK_A, {
      size: container.byteLength,
      chunkCount: 2,
    });
    await storage.downloadRange(pointerB, HEADER_SIZE, CHUNK_A, {
      size: container.byteLength,
      chunkCount: 2,
    });

    // A different container must never be served from the previous one.
    expect(fullCallCount()).toBe(2);
  });

  it("an earlier read does not corrupt a LATER read of the same container", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = { rangeStatus: 200, fullChunks: [container] };
    const hint = { size: container.byteLength, chunkCount: 2 };

    // First read succeeds and settles the cache.
    const first = await storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, hint);
    expect(first.byteLength).toBe(CHUNK_A);

    // A later read is served correctly (the cache was not zeroized by the
    // earlier read's own buffer wipe).
    const second = await storage.downloadRange(
      pointer,
      HEADER_SIZE + CHUNK_A,
      CHUNK_B,
      hint
    );
    expect(second.byteLength).toBe(CHUNK_B);
    expect(Array.from(second)).toEqual(
      Array.from(container.subarray(HEADER_SIZE + CHUNK_A, container.byteLength))
    );
  });
});

/* ================================================================== *
 * SAFETY
 * ================================================================== */

describe("F3.3 — safety of the fallback surface", () => {
  it("no pointer / URL / hex / plaintext is rendered by a fallback failure", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    options = {
      rangeStatus: 200,
      fullChunks: [container.subarray(0, container.byteLength - 1)],
    };

    let caught: unknown;
    try {
      await storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A, {
        size: container.byteLength,
        chunkCount: 2,
      });
    } catch (err) {
      caught = err;
    }

    const message = (caught as Error).message;
    expect(message).toBe(STORAGE_FAILURE_MESSAGE);
    expect(message).not.toContain(pointer);
    expect(message).not.toMatch(/https?:|blob:|[0-9a-f]{20,}/i);
  });

  it("never accepts a 200 range response as the window (no Range path change)", async () => {
    const pointer = freshPointer();
    const container = makeContainerBytes();
    // Range returns 200 WITH a plausible body, but NO hint is supplied →
    // the pure fail-closed behaviour must stand.
    options = { rangeStatus: 200, fullChunks: [container] };

    await expect(
      storage.downloadRange(pointer, HEADER_SIZE, CHUNK_A)
    ).rejects.toThrow(STORAGE_FAILURE_MESSAGE);

    expect(fullCallCount()).toBe(0);
  });

  it("exposes the canonical magic for the container it validates", () => {
    expect(CONTAINER_MAGIC).toEqual([0x41, 0x45, 0x54, 0x43]);
    expect(HEADER_SIZE).toBe(64);
  });
});
