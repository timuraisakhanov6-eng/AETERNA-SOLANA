import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * CONTAINER RETRY CACHE — no duplicate Container DataItem signing.
 *
 * ROOT CAUSE PINNED
 * -----------------
 * The Vault upload had a txId retry cache, but the Container upload did
 * NOT. A container DataItem is produced by ONE `uploadData()` call that
 * carries ONE creator signature. If the container upload SUCCEEDED but a
 * LATER stage (vault upload / publication verify / seal / seal verify)
 * failed, a retry re-entered the container branch and re-signed a NEW
 * container DataItem — an extra Phantom `signMessage` prompt for data
 * that was already published.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 *  A. first container upload            → EXACTLY ONE container signing.
 *  B. retry after a successful container upload → NO new signing.
 *  C. the containerTxId is REUSED (identical across the retry).
 *  D. no cache present                  → normal first upload runs.
 *  E. malformed / ambiguous cache       → fail closed (re-upload, never
 *     an invented txId).
 *  F. Vault behavior is UNCHANGED (still exactly one vault upload per run).
 *  G. NON-VACUITY: without the cache the retry WOULD re-sign — proven by
 *     clearing the cache between runs and observing a second signing.
 *
 * The "signing" signal is the adapter's `uploadContainer()` invocation
 * count: the real adapter signs inside `uploadContainer()` (ONE signature
 * per call), so call-count == container-signature-count at this boundary.
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
  claimCalls: number;
  claimedTxIds: string[];
  lastContainerChunkIds: readonly string[] | null;
  containerTxIds: string[];
}

/**
 * A StorageAdapter that records container uploads (== container
 * signatures at this boundary). Each successful uploadContainer() returns
 * a DISTINCT txId so a reuse vs a re-sign is observable.
 *
 * The upload/claim split is mirrored here: `uploadContainer()` creates the
 * DataItem (the signing event), and the separate `claimContainerUpload()`
 * records the claim for whatever txId the orchestrator passes — which, on
 * a retry, is the CACHED one.
 */
function buildRecordingStorage(): RecordingAdapter {
  const rec: RecordingAdapter = {
    uploadCalls: 0,
    uploadContainerCalls: 0,
    claimCalls: 0,
    claimedTxIds: [],
    lastContainerChunkIds: null,
    containerTxIds: [],
    adapter: null as unknown as StorageAdapter,
  };

  rec.adapter = {
    name: "recording-adapter",
    async upload() {
      rec.uploadCalls++;
      return { txId: "vault".padEnd(43, "V") };
    },
    async uploadContainer(
      _runtime: unknown,
      chunkMetadata: readonly { chunkId: string }[]
    ) {
      rec.uploadContainerCalls++;
      rec.lastContainerChunkIds = chunkMetadata.map((c) => c.chunkId);
      // Distinct txId per call — makes a REUSE vs a RE-SIGN observable.
      const txId = `container-${rec.uploadContainerCalls}`.padEnd(43, "Z");
      rec.containerTxIds.push(txId);
      return {
        containerTxId: txId,
        chunkIds: chunkMetadata.map((c) => c.chunkId),
        layoutDigest: "a".repeat(64),
      };
    },
    async claimContainerUpload(outcome: { containerTxId: string }) {
      rec.claimCalls++;
      rec.claimedTxIds.push(outcome.containerTxId);
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

/**
 * Handlers for the WHOLE seal flow. `publicationOk` flips the
 * PUBLICATION VERIFY stage, which runs AFTER the container + vault
 * uploads but BEFORE `persistSealManifest`. Failing HERE reproduces the
 * real bug shape: the container DataItem already exists, no manifest was
 * persisted, so a retry re-enters the container branch.
 *
 * (Failing at the later SEAL stage instead would take the persisted-
 * manifest reuse path, which skips the container branch entirely and
 * would prove nothing about the container cache.)
 */
function handlersWithPublicationOutcome(publicationOk: boolean) {
  return {
    "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
    "/api/publication/claim": async () =>
      jsonResponse(200, { ok: true, claimed: true }),
    "/api/publication/verify": async () =>
      publicationOk
        ? jsonResponse(200, { ok: true, state: "VERIFIED" })
        : jsonResponse(500, { ok: false, error: "PUBLICATION_NOT_VERIFIED" }),
    "/api/capsule/seal": async () => jsonResponse(200, { ok: true }),
    "/api/seal/verify": async () =>
      jsonResponse(200, { ok: true, state: "VERIFIED" }),
    "/api/creator/finalize-credit": async () =>
      jsonResponse(200, { ok: true, outcome: "CONSUMED" }),
  };
}

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

const CONTAINER_CACHE_KEY = `aeterna-container-upload:${CAPSULE_ID}`;

/**
 * The vitest default environment is `node` (no DOM Storage). Production
 * `sealCapsuleCore` guards every sessionStorage access in try/catch, but
 * these tests must SEED and INSPECT the cache, so a minimal in-memory
 * Storage is installed for the suite.
 */
function installSessionStoragePolyfill(): void {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
}

describe("sealCapsuleCore — container retry cache (no duplicate DataItem signing)", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    installSessionStoragePolyfill();
    try {
      sessionStorage.clear();
    } catch {
      // sessionStorage may be absent; the flow tolerates it.
    }
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("A. first container upload → EXACTLY ONE container signing", async () => {
    const router = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = router.restore;

    const storage = buildRecordingStorage();
    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), storage.adapter, chunkMeta(2))
    );

    expect(storage.uploadContainerCalls).toBe(1);
    expect(result.finalized).toBe(true);

    // Full finalization clears the cache (success is terminal).
    expect(sessionStorage.getItem(CONTAINER_CACHE_KEY)).toBeNull();
  });

  it("B+G. retry after a successful container upload → NO new signing (non-vacuous)", async () => {
    // ── Run 1: seal FAILS AFTER the container upload succeeded. ──
    const failing = installFetchRouter(handlersWithPublicationOutcome(false));
    restoreFetch = failing.restore;

    const storage = buildRecordingStorage();
    const params = baseParams(buildRuntime(), storage.adapter, chunkMeta(2));

    await expect(sealCapsuleCore(params)).rejects.toThrow();

    // The container signed exactly once, and the outcome was CACHED.
    expect(storage.uploadContainerCalls).toBe(1);
    expect(sessionStorage.getItem(CONTAINER_CACHE_KEY)).not.toBeNull();

    // ── Run 2: retry, seal now SUCCEEDS. ──
    failing.restore();
    const succeeding = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = succeeding.restore;

    const result = await sealCapsuleCore(params);

    // NO second container signing — the cache was reused.
    expect(storage.uploadContainerCalls).toBe(1);
    expect(result.finalized).toBe(true);
  });

  it("C. containerTxId is REUSED across the retry", async () => {
    const failing = installFetchRouter(handlersWithPublicationOutcome(false));
    restoreFetch = failing.restore;

    const storage = buildRecordingStorage();
    const params = baseParams(buildRuntime(), storage.adapter, chunkMeta(2));

    await expect(sealCapsuleCore(params)).rejects.toThrow();
    expect(storage.containerTxIds).toHaveLength(1);
    const firstTxId = storage.containerTxIds[0];

    const cached = JSON.parse(
      sessionStorage.getItem(CONTAINER_CACHE_KEY) as string
    ) as { containerTxId: string };
    expect(cached.containerTxId).toBe(firstTxId);

    failing.restore();
    const succeeding = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = succeeding.restore;

    await sealCapsuleCore(params);

    // Still only ONE physical txId ever created — reused, not re-signed.
    expect(storage.containerTxIds).toHaveLength(1);
    expect(storage.containerTxIds[0]).toBe(firstTxId);
  });

  it("D. no cache present → normal first upload runs", async () => {
    const router = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = router.restore;

    const storage = buildRecordingStorage();
    expect(sessionStorage.getItem(CONTAINER_CACHE_KEY)).toBeNull();

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), storage.adapter, chunkMeta(1))
    );

    expect(storage.uploadContainerCalls).toBe(1);
    expect(result.finalized).toBe(true);
  });

  it("E. malformed cache → fail closed to a normal upload (never an invented txId)", async () => {
    const router = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = router.restore;

    // A structurally invalid txId — must be rejected, not trusted.
    sessionStorage.setItem(
      CONTAINER_CACHE_KEY,
      JSON.stringify({
        containerTxId: "not-a-valid-pointer!!",
        chunkIds: ["chunk-0".padEnd(64, "x")],
        layoutDigest: "a".repeat(64),
      })
    );

    const storage = buildRecordingStorage();
    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), storage.adapter, chunkMeta(1))
    );

    // The malformed entry was ignored — a real upload ran.
    expect(storage.uploadContainerCalls).toBe(1);
    expect(result.finalized).toBe(true);
  });

  it("E. ambiguous cache (missing layoutDigest) → fail closed to a normal upload", async () => {
    const router = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = router.restore;

    sessionStorage.setItem(
      CONTAINER_CACHE_KEY,
      JSON.stringify({
        containerTxId: "x".repeat(43),
        chunkIds: ["chunk-0".padEnd(64, "x")],
        // layoutDigest intentionally absent
      })
    );

    const storage = buildRecordingStorage();
    await sealCapsuleCore(
      baseParams(buildRuntime(), storage.adapter, chunkMeta(1))
    );

    expect(storage.uploadContainerCalls).toBe(1);
  });

  it("E. stale cache (chunk set changed) → reused outcome fails closed at assertSealUploadOutcome", async () => {
    const router = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = router.restore;

    // Cache claims a container covering chunk-0 only…
    sessionStorage.setItem(
      CONTAINER_CACHE_KEY,
      JSON.stringify({
        containerTxId: "x".repeat(43),
        chunkIds: ["chunk-0".padEnd(64, "x")],
        layoutDigest: "a".repeat(64),
      })
    );

    const storage = buildRecordingStorage();

    // …but the capsule now has TWO chunks → the reused outcome must NOT
    // be silently accepted. Fail closed.
    await expect(
      sealCapsuleCore(
        baseParams(buildRuntime(), storage.adapter, chunkMeta(2))
      )
    ).rejects.toThrow();

    // No fresh container upload was attempted either — the ambiguous
    // state is a hard failure, never a silent re-sign.
    expect(storage.uploadContainerCalls).toBe(0);
  });

  it("F. Vault behavior unchanged — exactly one vault upload per successful run", async () => {
    const router = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = router.restore;

    const storage = buildRecordingStorage();
    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), storage.adapter, chunkMeta(2))
    );

    expect(storage.uploadCalls).toBe(1);
    expect(result.finalized).toBe(true);
  });

  it("G-NON-VACUITY. clearing the container cache between runs WOULD re-sign (control)", async () => {
    // Proves the B/C assertions are meaningful: if the cache is removed,
    // the retry DOES re-invoke uploadContainer (== re-sign). This is the
    // pre-fix behavior, reproduced intentionally as a control.
    const failing = installFetchRouter(handlersWithPublicationOutcome(false));
    restoreFetch = failing.restore;

    const storage = buildRecordingStorage();
    const params = baseParams(buildRuntime(), storage.adapter, chunkMeta(2));

    await expect(sealCapsuleCore(params)).rejects.toThrow();
    expect(storage.uploadContainerCalls).toBe(1);

    // Simulate the PRE-FIX condition: no container cache.
    sessionStorage.removeItem(CONTAINER_CACHE_KEY);
    expect(sessionStorage.getItem(CONTAINER_CACHE_KEY)).toBeNull();

    failing.restore();
    const succeeding = installFetchRouter(handlersWithPublicationOutcome(true));
    restoreFetch = succeeding.restore;

    await sealCapsuleCore(params);

    // With the cache absent, the container re-signed — exactly the bug.
    expect(storage.uploadContainerCalls).toBe(2);
  });
});
