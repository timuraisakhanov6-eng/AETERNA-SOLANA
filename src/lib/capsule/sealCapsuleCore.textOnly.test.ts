import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * TEXT-ONLY VAULT-ONLY PATH — seal-level branch proof.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * The media channel is decided by the capsule's OWN chunk metadata BEFORE
 * any upload is attempted:
 *
 *   A. text-only (chunkMetadata = []) → NO container upload, NO container
 *      claim; the Vault upload proceeds and the seal flow succeeds.
 *   B. media (chunkMetadata > 0)      → the Container V1 path still runs:
 *      EXACTLY ONE container upload, and NO legacy per-chunk fallback.
 *   C. mixed text+media (chunkMetadata > 0) → the container path runs with
 *      the FULL chunk set (text lives only in the Vault).
 *
 * NON-VACUOUS: every "container did NOT run" assertion is paired with the
 * media case proving the same adapter WOULD have recorded a container call,
 * so the assertion cannot pass just because the spy is broken.
 *
 * No live network, no wallet, no Irys, no payment, no KV.
 */

import { sealCapsuleCore } from "./sealCapsuleCore";

import { createLocalVaultPointer } from "@/lib/runtime/localVaultPointer";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import type { StorageAdapter } from "@/lib/storage/storageAdapter";

import type { ChunkMetadata } from "@/types/vault";

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const VAULT_SHA256 = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const RECIPIENT_SECRET = "e".repeat(64);
const UPLOAD_TOKEN = "f".repeat(43);
const LIFECYCLE_ID = "lifecycle-" + "1".repeat(20);
const IDENTITY_ID = "0".repeat(32);

const VAULT_BYTES = new Uint8Array([1, 2, 3, 4]);

function buildRuntime(): RuntimeStorage {
  return {
    open: async () => {},
    store: async () => {},
    read: async () => new Uint8Array([9, 8, 7, 6]),
    remove: async () => {},
    storeVault: async () => {},
    readVault: async () => VAULT_BYTES,
    removeVault: async () => {},
    clear: async () => {},
  } as unknown as RuntimeStorage;
}

interface RecordingAdapter {
  adapter: StorageAdapter;
  uploadCalls: number;
  uploadContainerCalls: number;
  lastContainerChunkIds: readonly string[] | null;
}

/**
 * A StorageAdapter that records which upload channels were used. Both
 * `upload()` (Vault) and `uploadContainer()` (media) resolve with
 * well-formed values so the flow can reach the post-upload POSTs.
 */
function buildRecordingStorage(): RecordingAdapter {
  const rec: RecordingAdapter = {
    uploadCalls: 0,
    uploadContainerCalls: 0,
    lastContainerChunkIds: null,
    adapter: null as unknown as StorageAdapter,
  };

  rec.adapter = {
    name: "recording-adapter",
    async upload() {
      rec.uploadCalls++;
      return { txId: "tx".padEnd(43, "Z") };
    },
    async uploadContainer(
      _runtime: unknown,
      chunkMetadata: readonly { chunkId: string }[]
    ) {
      rec.uploadContainerCalls++;
      rec.lastContainerChunkIds = chunkMetadata.map((c) => c.chunkId);
      return {
        containerTxId: "ch".padEnd(43, "Z"),
        chunkIds: chunkMetadata.map((c) => c.chunkId),
        layoutDigest: "a".repeat(64),
      };
    },
    async download() {
      throw new Error("[test] download not used");
    },
  } as unknown as StorageAdapter;

  return rec;
}

function chunkMeta(n: number): readonly ChunkMetadata[] {
  return Array.from({ length: n }, (_, i) => ({
    chunkId: `chunk-${i}`.padEnd(64, "x"),
    mediaId: `media-${i}`,
    index: 0,
    size: 1024,
  })) as unknown as readonly ChunkMetadata[];
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

function installFetchRouter(
  handlers: Record<string, () => Promise<Response>>
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);

    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) {
      return Promise.resolve(jsonResponse(404, { error: "NO_HANDLER" }));
    }
    return handlers[key]();
  }) as unknown as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const OK_HANDLERS = {
  "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
  "/api/publication/verify": async () =>
    jsonResponse(200, { ok: true, state: "VERIFIED" }),
  "/api/capsule/seal": async () => jsonResponse(200, { ok: true }),
  "/api/seal/verify": async () =>
    jsonResponse(200, { ok: true, state: "VERIFIED" }),
  "/api/creator/finalize-credit": async () =>
    jsonResponse(200, { ok: true, outcome: "CONSUMED" }),
};

function baseParams(
  runtime: RuntimeStorage,
  storage: StorageAdapter,
  chunkMetadata: readonly ChunkMetadata[]
): Parameters<typeof sealCapsuleCore>[0] {
  return {
    capsuleId: CAPSULE_ID,
    saltBase: SALT_BASE,
    recipientSecret: RECIPIENT_SECRET,
    creatorAuthority: CREATOR_AUTHORITY,
    // Comfortably above the 1-day heartbeat minimum: the seal time is
    // read from trusted time AFTER this fixture is built, so an exact
    // 86,400,000 ms boundary would drift below the minimum and be
    // (correctly) rejected by the client fail-fast guard.
    openAt: Date.now() + 3 * 86_400_000,
    uploadToken: UPLOAD_TOKEN,
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: IDENTITY_ID,
    storage,
    encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
    encryptedSizeBytes: VAULT_BYTES.byteLength,
    vaultSha256: VAULT_SHA256,
    runtime,
    chunkMetadata,
  };
}

describe("sealCapsuleCore — text-only vault-only branch", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    try {
      sessionStorage.clear();
    } catch {
      // sessionStorage may be absent in node env; the flow tolerates it.
    }
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("A. text-only ([]) → NO container upload, NO claim; Vault upload proceeds and the seal succeeds", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const storage = buildRecordingStorage();
    const runtime = buildRuntime();

    const result = await sealCapsuleCore(
      baseParams(runtime, storage.adapter, [])
    );

    // The Vault upload DID run (the content-bearing channel for text-only).
    expect(storage.uploadCalls).toBe(1);

    // The container channel was NEVER attempted and NO claim was made.
    expect(storage.uploadContainerCalls).toBe(0);
    expect(
      router.calls.some((u) => u.includes("/api/publication/claim"))
    ).toBe(false);

    // The seal flow completed normally.
    expect(result.finalized).toBe(true);
    expect(router.calls.some((u) => u.includes("/api/capsule/seal"))).toBe(
      true
    );
  });

  it("B. media (>0) → container path runs EXACTLY ONCE and there is NO per-chunk fallback", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const storage = buildRecordingStorage();
    const runtime = buildRuntime();

    const meta = chunkMeta(2);

    const result = await sealCapsuleCore(
      baseParams(runtime, storage.adapter, meta)
    );

    // EXACTLY ONE container upload, carrying the full chunk set.
    expect(storage.uploadContainerCalls).toBe(1);
    expect(storage.lastContainerChunkIds).toHaveLength(2);

    // Still exactly one Vault upload — no per-chunk upload path exists.
    expect(storage.uploadCalls).toBe(1);

    expect(result.finalized).toBe(true);
  });

  it("C. mixed text+media (>0) → ONE container for the media chunks (same container behavior)", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const storage = buildRecordingStorage();
    const runtime = buildRuntime();

    // The Vault (not this test) holds the text item; the flat chunk
    // metadata only carries media chunks.
    const meta = chunkMeta(1);

    const result = await sealCapsuleCore(
      baseParams(runtime, storage.adapter, meta)
    );

    expect(storage.uploadContainerCalls).toBe(1);
    expect(storage.lastContainerChunkIds).toHaveLength(1);
    expect(storage.uploadCalls).toBe(1);
    expect(result.finalized).toBe(true);
  });

  it("B/C CONTROL. the recording spy is non-vacuous — the media case really records a container call", async () => {
    // Guards the A assertions above: if `uploadContainerCalls` could never
    // increment, test A's `toBe(0)` would be meaningless. This control proves
    // the same spy DOES increment for a chunk-bearing capsule.
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const storage = buildRecordingStorage();
    await sealCapsuleCore(
      baseParams(buildRuntime(), storage.adapter, chunkMeta(1))
    );

    expect(storage.uploadContainerCalls).toBeGreaterThan(0);
  });
});
