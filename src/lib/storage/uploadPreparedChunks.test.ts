/**
 * AETERNA — bounded concurrency (C=2) in `uploadPreparedChunks`.
 *
 * This file tests ONLY the client scheduler/function behavior of
 * `src/lib/storage/uploadPreparedChunks.ts`. It uses a faithful
 * in-memory Runtime fake and a controllable StorageAdapter fake — no
 * network, no Irys, no wallet, no signing, no payment.
 *
 * Invariants proven here:
 *
 *   A. EMPTY      — frozen empty array, zero I/O
 *   B. SINGLE     — one chunk completes correctly
 *   C. CONCURRENCY— two chunks actually overlap; active reaches 2
 *   D. HARD CAP   — with 5 chunks, active never exceeds 2
 *   E. ORDER      — out-of-order completion still returns input order
 *   F. FAILURE    — one rejection rejects the whole operation
 *   G. STOP       — after the first failure, no new chunk starts
 *   H. SETTLE     — an already-running worker still finishes its job
 *   I. UNHANDLED  — all worker promises settle; no unhandled rejection
 *   J. REMOVE     — `remove` only after upload + pointer assertion
 *   K. WIPE       — each started ciphertext wiped exactly once
 *   L. WIPE-FAIL  — a failed job still wipes its ciphertext
 *   M. LEAK       — returned metadata carries no ciphertext reference
 *   N. ORDER[+n]  — result ordering by original input position
 */

import { describe, expect, it, vi } from "vitest";

import { uploadPreparedChunks } from "../storage/uploadPreparedChunks";
import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";
import type { RuntimeChunkRecord } from "@/lib/runtime/runtimeTypes";
import type {
  StorageAdapter,
  StoragePointer,
  UploadToken,
} from "@/lib/storage/storageAdapter";
import type { ChunkMetadata } from "@/types/vault";

const TOKEN = "t".repeat(43) as UploadToken;

/* ================= FAKE RUNTIME ================= */

interface FakeRuntime extends RuntimeStorage {
  wipeCount: ReadonlyMap<string, number>;
  readOrder: string[];
  removeOrder: string[];
  calls: { read: number; remove: number };
}

/**
 * Faithful Runtime fake.
 *
 * Mirrors the real implementations:
 *   - `read` returns a FRESH CLONE of the stored ciphertext
 *     (indexedDbRuntimeStorage: `record.ciphertext.slice(0)`;
 *      memoryRuntimeStorage: `record.ciphertext.slice()`);
 *   - `remove` throws when the chunk is absent;
 *   - `remove` (memory impl) also wipes the STORED copy.
 *
 * `wipeCount` tracks how many times each JOB-OWNED clone was wiped, so
 * a double wipe or a missing wipe is observable.
 */
function createFakeRuntime(
  chunkIds: readonly string[]
): FakeRuntime {
  const stored = new Map<string, Uint8Array>();
  for (const id of chunkIds) {
    // Deterministic non-zero ciphertext so wipe is observable.
    stored.set(id, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).fill(id.charCodeAt(0) % 251 + 1));
  }

  const wipeCount = new Map<string, number>();
  const readOrder: string[] = [];
  const removeOrder: string[] = [];
  const calls = { read: 0, remove: 0 };

  return {
    wipeCount,
    readOrder,
    removeOrder,
    calls,

    async open() {},

    async store(record: RuntimeChunkRecord) {
      stored.set(record.chunkId, record.ciphertext.slice());
    },

    async read(chunkId: string): Promise<RuntimeChunkRecord> {
      calls.read += 1;
      readOrder.push(chunkId);

      const bytes = stored.get(chunkId);
      if (!bytes) {
        throw new Error("[AETERNA] Runtime chunk not found.");
      }

      // Per-job clone, exactly like the real implementations.
      const clone = bytes.slice();

      // Count the wipe of THIS clone (the buffer the job owns).
      const originalFill = clone.fill.bind(clone);
      (clone as Uint8Array & { fill: typeof clone.fill }).fill = (
        value: number
      ) => {
        if (value === 0) {
          wipeCount.set(chunkId, (wipeCount.get(chunkId) ?? 0) + 1);
        }
        return originalFill(value);
      };

      return Object.freeze({
        chunkId,
        mediaId: `m-${chunkId}`,
        chunkIndex: 0,
        ciphertext: clone,
      });
    },

    async remove(chunkId: string) {
      calls.remove += 1;
      removeOrder.push(chunkId);
      const bytes = stored.get(chunkId);
      if (!bytes) {
        throw new Error("[AETERNA] Runtime chunk not found.");
      }
      bytes.fill(0);
      stored.delete(chunkId);
    },

    async storeVault() {},
    async readVault() {
      return new Uint8Array();
    },
    async removeVault() {},
    async clear() {
      stored.clear();
    },
  };
}

/* ================= FAKE ADAPTER ================= */

interface FakeAdapter extends StorageAdapter {
  active: number;
  maxActive: number;
  starts: string[];
  hooks: Map<
    string,
    {
      defer?: Promise<void>;
      fail?: Error;
      onStart?: () => void;
      onFinish?: () => void;
    }
  >;
}

function createFakeAdapter(): FakeAdapter {
  const hooks = new Map<
    string,
    {
      defer?: Promise<void>;
      fail?: Error;
      onStart?: () => void;
      onFinish?: () => void;
    }
  >();

  const adapter: FakeAdapter = {
    name: "fake",
    active: 0,
    maxActive: 0,
    starts: [],
    hooks,

    async uploadChunk(data, chunkId, _token: UploadToken) {
      // The scheduler must pass the caller's ciphertext through
      // unchanged; `data` is intentionally unread here.
      void data;

      const hook = hooks.get(chunkId);

      adapter.active += 1;
      adapter.starts.push(chunkId);
      if (adapter.active > adapter.maxActive) {
        adapter.maxActive = adapter.active;
      }

      hook?.onStart?.();

      try {
        if (hook?.defer) {
          await hook.defer;
        }
        if (hook?.fail) {
          throw hook.fail;
        }
        // Mirror the contract: the return value is a txId STRING that
        // the caller validates with assertStoragePointer.
        return { txId: `P${chunkId}`.padEnd(43, "x") };
      } finally {
        adapter.active -= 1;
        hook?.onFinish?.();
      }
    },

    async upload(data, _token) {
      void data;
      return { txId: "V".repeat(43) as StoragePointer };
    },

    async download() {
      return new Uint8Array();
    },
  };

  return adapter;
}

/* ================= METADATA ================= */

/**
 * Strict index accessor.
 *
 * `noUncheckedIndexedAccess` types `arr[i]` as `T | undefined`. Tests
 * assert on positions known to exist, so this helper makes that
 * explicit (and throws loudly rather than silently passing
 * `undefined`) without weakening the check.
 */
function at<T>(arr: readonly T[], i: number): T {
  const value = arr[i];
  if (value === undefined) {
    throw new Error(`[test] missing index ${i}`);
  }
  return value;
}

/**
 * Deterministic, unambiguous chunk id for position `i`.
 * Length/padding is irrelevant to the unit under test (it does not
 * validate chunkId), but ids must be distinct and stable.
 */
function id(i: number): string {
  return `chunk-${i}`;
}

function chunkMeta(
  n: number,
  overrides: Partial<ChunkMetadata> = {}
): ChunkMetadata {
  return {
    chunkId: id(n) as ChunkMetadata["chunkId"],
    mediaId: `media-${n}`,
    index: n,
    size: 8,
    ...overrides,
  };
}

function metaFor(ids: readonly string[]): ChunkMetadata[] {
  return ids.map((cid, i) => ({
    chunkId: cid as ChunkMetadata["chunkId"],
    mediaId: `media-${i}`,
    index: i,
    size: 8,
  }));
}

function idsFor(n: number): string[] {
  return Array.from({ length: n }, (_v, i) => id(i));
}

/* ================= TESTS ================= */

describe("uploadPreparedChunks — bounded concurrency C=2", () => {

  it("A. EMPTY — returns frozen empty array and performs no I/O", async () => {
    const runtime = createFakeRuntime([]);
    const adapter = createFakeAdapter();

    const result = await uploadPreparedChunks(
      runtime,
      [],
      TOKEN,
      adapter
    );

    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(runtime.calls.read).toBe(0);
    expect(runtime.calls.remove).toBe(0);
    expect(adapter.starts).toHaveLength(0);
  });

  it("B. SINGLE — one chunk completes correctly with one worker", async () => {
    const runtime = createFakeRuntime([id(0)]);
    const adapter = createFakeAdapter();

    const result = await uploadPreparedChunks(
      runtime,
      [chunkMeta(0)],
      TOKEN,
      adapter
    );

    expect(result).toHaveLength(1);
    expect(at(result, 0).chunkId).toBe(id(0));
    expect(at(result, 0).pointer).toBe(`P${id(0)}`.padEnd(43, "x"));
    expect(adapter.maxActive).toBe(1);
    expect(runtime.calls.remove).toBe(1);
  });

  it("C. CONCURRENCY — two chunks overlap; active reaches 2", async () => {
    const ids = idsFor(2);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    // Gate both jobs so neither can finish until both have started.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    adapter.hooks.set(at(ids, 0), { defer: gate });
    adapter.hooks.set(at(ids, 1), { defer: gate });

    const pending = uploadPreparedChunks(
      runtime,
      metaFor(ids),
      TOKEN,
      adapter
    );

    // Give both workers a chance to start and block on the gate.
    await vi.waitFor(() => {
      expect(adapter.active).toBe(2);
    });

    release();
    const result = await pending;

    expect(result).toHaveLength(2);
    expect(adapter.maxActive).toBe(2);
  });

  it("D. HARD CAP — with 5 chunks, active never exceeds 2", async () => {
    const ids = idsFor(5);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    // A short per-chunk delay maximizes overlap opportunity so an
    // accidental unbounded pool would be caught.
    for (const id of ids) {
      adapter.hooks.set(id, {
        defer: new Promise((r) => setTimeout(r, 5)),
      });
    }

    const result = await uploadPreparedChunks(
      runtime,
      metaFor(ids),
      TOKEN,
      adapter
    );

    expect(result).toHaveLength(5);
    expect(adapter.maxActive).toBeLessThanOrEqual(2);
    expect(adapter.maxActive).toBe(2);
    expect(adapter.starts).toHaveLength(5);
  });

  it("E. ORDER — out-of-order completion still returns input order", async () => {
    const ids = idsFor(2);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    const completions: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    // ids[0] is held on `firstGate`; ids[1] completes immediately and
    // releases ids[0] on finish.
    adapter.hooks.set(at(ids, 0), { defer: firstGate });
    adapter.hooks.set(at(ids, 1), {
      onFinish: () => {
        completions.push(at(ids, 1));
        releaseFirst();
      },
    });

    const result = await uploadPreparedChunks(
      runtime,
      metaFor(ids),
      TOKEN,
      adapter
    );

    // ids[1] completed FIRST — genuinely out of input order.
    completions.push(at(ids, 0));
    expect(completions).toEqual([at(ids, 1), at(ids, 0)]);

    // Yet the result is in INPUT order.
    expect(result.map((r) => r.chunkId)).toEqual(ids);
  });

  it("F. FAILURE — one worker rejecting rejects the whole operation", async () => {
    const ids = idsFor(2);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    const boom = new Error("upload boom");
    adapter.hooks.set(at(ids, 0), { fail: boom });

    await expect(
      uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter)
    ).rejects.toBe(boom);
  });

  it("G. STOP DISPATCH — after the first failure no new chunk starts", async () => {
    const ids = idsFor(6);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    // c1 fails immediately; c2 is slow so the pool cannot race ahead.
    const boom = new Error("first fails");
    adapter.hooks.set(at(ids, 0), { fail: boom });
    adapter.hooks.set(at(ids, 1), {
      defer: new Promise((r) => setTimeout(r, 30)),
    });

    await expect(
      uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter)
    ).rejects.toBe(boom);

    // Only the two initially-dispatched positions may have started —
    // never chunks 3..6 after the failure.
    expect(adapter.starts.length).toBeLessThanOrEqual(2);
    expect(adapter.starts).not.toContain(at(ids, 2));
    expect(adapter.starts).not.toContain(at(ids, 3));
    expect(adapter.starts).not.toContain(at(ids, 4));
    expect(adapter.starts).not.toContain(at(ids, 5));
  });

  it("H. WORKER SETTLE — an in-flight worker finishes its job after a failure", async () => {
    const ids = idsFor(2);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    let secondFinished = false;
    adapter.hooks.set(at(ids, 0), { fail: new Error("fast fail") });
    adapter.hooks.set(at(ids, 1), {
      defer: new Promise((r) => setTimeout(r, 20)),
      onFinish: () => {
        secondFinished = true;
      },
    });

    await expect(
      uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter)
    ).rejects.toThrow("fast fail");

    // The already-running worker settled (not force-cancelled).
    expect(secondFinished).toBe(true);
    // Its runtime record was removed → the job ran to completion.
    expect(runtime.removeOrder).toContain(at(ids, 1));
  });

  it("I. NO UNHANDLED REJECTION — all workers settle before rejecting", async () => {
    const ids = idsFor(3);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    adapter.hooks.set(at(ids, 0), { fail: new Error("boom") });
    adapter.hooks.set(at(ids, 1), { fail: new Error("boom2") });

    try {
      await expect(
        uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter)
      ).rejects.toThrow("boom");

      // Let any stray microtask rejection surface.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("J. REMOVE ORDER — remove only after upload + pointer assertion", async () => {
    const ids = idsFor(2);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    const events: string[] = [];
    const realUpload = adapter.uploadChunk.bind(adapter);
    adapter.uploadChunk = async (data, chunkId, token) => {
      events.push(`upload:${chunkId}`);
      return realUpload(data, chunkId, token);
    };
    const realRemove = runtime.remove.bind(runtime);
    runtime.remove = async (chunkId) => {
      events.push(`remove:${chunkId}`);
      return realRemove(chunkId);
    };

    await uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter);

    // For each chunk, its upload precedes its remove.
    for (const id of ids) {
      expect(events.indexOf(`upload:${id}`)).toBeLessThan(
        events.indexOf(`remove:${id}`)
      );
    }
  });

  it("J2. REMOVE ORDER — a bad pointer prevents removal", async () => {
    const ids = idsFor(1);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    // Structurally-invalid txId → assertStoragePointer throws.
    adapter.uploadChunk = async () => ({ txId: "not-a-pointer" });

    await expect(
      uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter)
    ).rejects.toThrow(/Invalid storage pointer/);

    expect(runtime.removeOrder).toHaveLength(0);
  });

  it("K. WIPE — each started ciphertext wiped exactly once", async () => {
    const ids = idsFor(3);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    await uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter);

    for (const cid of ids) {
      expect(runtime.wipeCount.get(cid)).toBe(1);
    }
  });

  it("L. WIPE ON FAILURE — a failed job still wipes its ciphertext", async () => {
    const ids = idsFor(2);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    adapter.hooks.set(at(ids, 0), { fail: new Error("nope") });
    adapter.hooks.set(at(ids, 1), { fail: new Error("nope2") });

    await expect(
      uploadPreparedChunks(runtime, metaFor(ids), TOKEN, adapter)
    ).rejects.toThrow("nope");

    expect(runtime.wipeCount.get(at(ids, 0))).toBe(1);
    expect(runtime.wipeCount.get(at(ids, 1))).toBe(1);
  });

  it("M. NO RESULT BUFFER LEAK — returned metadata has no ciphertext", async () => {
    const ids = idsFor(2);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    const result = await uploadPreparedChunks(
      runtime,
      metaFor(ids),
      TOKEN,
      adapter
    );

    for (const entry of result) {
      expect(Object.prototype.hasOwnProperty.call(entry, "ciphertext")).toBe(
        false
      );
      expect(entry).not.toHaveProperty("ciphertext");
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("N. INPUT ORDER — 5 chunks out of order still return input order", async () => {
    const ids = idsFor(5);
    const runtime = createFakeRuntime(ids);
    const adapter = createFakeAdapter();

    // Reverse the completion delays: later chunks finish sooner.
    ids.forEach((cid, i) => {
      adapter.hooks.set(cid, {
        defer: new Promise((r) => setTimeout(r, (ids.length - i) * 4)),
      });
    });

    const result = await uploadPreparedChunks(
      runtime,
      metaFor(ids),
      TOKEN,
      adapter
    );

    expect(result.map((r) => r.chunkId)).toEqual(ids);
  });

});
