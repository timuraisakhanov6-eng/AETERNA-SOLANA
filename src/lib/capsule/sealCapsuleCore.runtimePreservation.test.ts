/**
 * R9-A92 F2 — prepared Runtime preservation across incomplete seal exits.
 *
 * THE PRODUCTION DEFECT THIS PINS (R9-A91/R9-A92 investigation)
 * -------------------------------------------------------------
 * `CapsuleHold` released the Runtime in an unconditional `finally`, so a
 * publication failure BEFORE the Vault upload destroyed the ONLY client
 * copy of the prepared encrypted Vault payload
 * (`destroyRuntime` → `runtime.clear()` → `<capsuleId>:__vault__` and
 * every chunk record). The existing 3BM-R6 retry cache covers only the
 * case where the Vault was ALREADY uploaded; a failure at the container
 * claim (the November 7 incident) therefore became unrecoverable.
 *
 * THE CONTRACT UNDER TEST
 * -----------------------
 * `shouldReleaseRuntimeAfterSeal(result, capsuleId)` is the single
 * cleanup decision: the Runtime is released ONLY for a result of THIS
 * capsule whose finalization completed. Every incomplete exit must leave
 * the prepared encrypted Vault payload and the cached container
 * transaction available for a legitimate later continuation.
 *
 * No network, no wallet, no Irys, no payment, no KV.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  sealCapsuleCore,
  shouldReleaseRuntimeAfterSeal,
  type SealCapsuleResult,
} from "./sealCapsuleCore";
import { createLocalVaultPointer } from "@/lib/runtime/localVaultPointer";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";
import type { StorageAdapter, ContainerUploadOutcome } from "@/lib/storage/storageAdapter";
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

const CONTAINER_CACHE_KEY = `aeterna-container-upload:${CAPSULE_ID}`;
const VAULT_CACHE_KEY = `aeterna-vault-txid:${CAPSULE_ID}`;

/**
 * A Runtime double that behaves like the real persistent layer for the
 * purposes of this contract: storeVault/readVault/clear operate on a
 * store, so a test can assert the payload SURVIVES a failed attempt and
 * is GONE after the (component-driven) release.
 */
function buildPersistentRuntime(): RuntimeStorage & {
  vaultStore: Map<string, Uint8Array>;
  cleared: number;
} {
  const vaultStore = new Map<string, Uint8Array>([
    [`${CAPSULE_ID}:__vault__`, VAULT_BYTES],
  ]);
  let cleared = 0;

  return {
    vaultStore,
    get cleared() {
      return cleared;
    },
    open: async () => {},
    store: async () => {},
    read: async () => new Uint8Array([9, 8, 7, 6]),
    remove: async () => {},
    storeVault: async (_capsuleId: string, ciphertext: Uint8Array) => {
      vaultStore.set(`${CAPSULE_ID}:__vault__`, ciphertext);
    },
    readVault: async () => {
      const bytes = vaultStore.get(`${CAPSULE_ID}:__vault__`);
      if (!bytes) throw new Error("[test] vault payload missing");
      return bytes;
    },
    removeVault: async () => {
      vaultStore.delete(`${CAPSULE_ID}:__vault__`);
    },
    clear: async () => {
      cleared++;
      vaultStore.delete(`${CAPSULE_ID}:__vault__`);
    },
  } as unknown as RuntimeStorage & {
    vaultStore: Map<string, Uint8Array>;
    cleared: number;
  };
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

interface Recorder {
  adapter: StorageAdapter;
  uploadContainerCalls: number;
  claimCalls: number;
  claimedTxIds: string[];
  vaultUploads: number;
}

/**
 * A claim that fails on the FIRST call (definitive 409 conflict, the
 * November 7 shape) and succeeds afterwards — without re-signing.
 */
function buildRecoveringRecorder(): Recorder & { setClaimOk(): void } {
  const rec = {
    uploadContainerCalls: 0,
    claimCalls: 0,
    claimedTxIds: [] as string[],
    vaultUploads: 0,
    claimOk: false,
    adapter: null as unknown as StorageAdapter,
    setClaimOk() {
      rec.claimOk = true;
    },
  };

  rec.adapter = {
    name: "recovering-adapter",
    async upload() {
      rec.vaultUploads++;
      return { txId: "vault".padEnd(43, "V") };
    },
    async uploadContainer(
      _runtime: unknown,
      chunkMetadata: readonly { chunkId: string }[]
    ): Promise<ContainerUploadOutcome> {
      rec.uploadContainerCalls++;
      const txId = `container-${rec.uploadContainerCalls}`.padEnd(43, "Z");
      return {
        containerTxId: txId,
        chunkIds: chunkMetadata.map((c) => c.chunkId),
        layoutDigest: "a".repeat(64),
      };
    },
    async claimContainerUpload(outcome: ContainerUploadOutcome) {
      rec.claimCalls++;
      rec.claimedTxIds.push(outcome.containerTxId);
      if (!rec.claimOk) {
        const error = new Error(
          "[AETERNA] creatorIrys: publication claim failed: LIFECYCLE_NOT_RESERVED"
        );
        Object.defineProperty(error, "sealRetryPolicy", {
          value: "terminal",
          enumerable: true,
        });
        throw error;
      }
    },
    async download() {
      throw new Error("[test] download not used");
    },
  } as unknown as StorageAdapter;

  return rec as unknown as Recorder & { setClaimOk(): void };
}

function handlers(opts: { verifyOk?: boolean } = {}) {
  const verifyOk = opts.verifyOk ?? true;
  return {
    "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
    "/api/publication/verify": async () =>
      verifyOk
        ? jsonResponse(200, { ok: true, state: "VERIFIED" })
        : jsonResponse(500, { ok: false, error: "PUBLICATION_NOT_VERIFIED" }),
    "/api/capsule/seal": async () => jsonResponse(200, { ok: true }),
    "/api/seal/verify": async () => jsonResponse(200, { ok: true, state: "VERIFIED" }),
    "/api/creator/finalize-credit": async () =>
      jsonResponse(200, { ok: true, outcome: "CONSUMED" }),
  };
}

function installFetchRouter(specs: Record<string, () => Promise<Response>>) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = Object.keys(specs).find((k) => url.includes(k));
    if (!key) return Promise.resolve(jsonResponse(404, { error: "NO_HANDLER" }));
    return specs[key]!();
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

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

function readContainerCache(): { containerTxId: string } | null {
  const raw = sessionStorage.getItem(CONTAINER_CACHE_KEY);
  return raw ? (JSON.parse(raw) as { containerTxId: string }) : null;
}

describe("R9-A92 F2 — shouldReleaseRuntimeAfterSeal (the cleanup decision)", () => {
  it("releases ONLY a finalized result of the SAME capsule", () => {
    const result: SealCapsuleResult = {
      capsuleId: CAPSULE_ID,
      manifest: {} as never,
      recipientLink: "",
      confirmationLink: "",
      finalized: true,
      finalizationPending: false,
    };
    expect(shouldReleaseRuntimeAfterSeal(result, CAPSULE_ID)).toBe(true);
  });

  it("keeps the Runtime when finalization is PENDING", () => {
    const result: SealCapsuleResult = {
      capsuleId: CAPSULE_ID,
      manifest: {} as never,
      recipientLink: "",
      confirmationLink: "",
      finalized: false,
      finalizationPending: true,
    };
    expect(shouldReleaseRuntimeAfterSeal(result, CAPSULE_ID)).toBe(false);
  });

  it("keeps the Runtime when there is no result (failure)", () => {
    expect(shouldReleaseRuntimeAfterSeal(null, CAPSULE_ID)).toBe(false);
  });

  it("keeps the Runtime when the result belongs to a DIFFERENT capsule", () => {
    const result: SealCapsuleResult = {
      capsuleId: "b".repeat(64),
      manifest: {} as never,
      recipientLink: "",
      confirmationLink: "",
      finalized: true,
      finalizationPending: false,
    };
    expect(shouldReleaseRuntimeAfterSeal(result, CAPSULE_ID)).toBe(false);
  });
});

describe("R9-A92 F2 — incomplete exits preserve the prepared Runtime", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    installSessionStoragePolyfill();
    try {
      sessionStorage.clear();
    } catch {
      /* tolerated */
    }
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("1. a failure BEFORE container upload preserves the prepared Vault payload", async () => {
    const runtime = buildPersistentRuntime();
    const rec = buildRecoveringRecorder();
    // Force the container upload itself to fail (before any claim).
    (rec.adapter as unknown as { uploadContainer: () => Promise<never> }).uploadContainer =
      async () => {
        rec.uploadContainerCalls++;
        throw new Error("[test] container upload failed");
      };
    restoreFetch = installFetchRouter(handlers());

    await expect(
      sealCapsuleCore(baseParams(runtime, rec.adapter, chunkMeta(2)))
    ).rejects.toThrow();

    // The prepared encrypted Vault payload SURVIVES.
    await expect(runtime.readVault(CAPSULE_ID)).resolves.toEqual(VAULT_BYTES);
  });

  it("2. a publication-claim failure preserves the Vault payload AND the container transaction", async () => {
    const runtime = buildPersistentRuntime();
    const rec = buildRecoveringRecorder();
    restoreFetch = installFetchRouter(handlers());

    await expect(
      sealCapsuleCore(baseParams(runtime, rec.adapter, chunkMeta(2)))
    ).rejects.toThrow(/CONTAINER_PUBLICATION/);

    await expect(runtime.readVault(CAPSULE_ID)).resolves.toEqual(VAULT_BYTES);

    const cached = readContainerCache();
    expect(cached).not.toBeNull();
    expect(cached!.containerTxId).toBe(rec.claimedTxIds[0]);

    // The Vault was never uploaded, so there is no vault txId cache —
    // the payload itself is the only way forward.
    expect(sessionStorage.getItem(VAULT_CACHE_KEY)).toBeNull();
  });

  it("3. a later continuation reuses the SAME container transaction and needs NO re-sign", async () => {
    const runtime = buildPersistentRuntime();
    const rec = buildRecoveringRecorder();
    restoreFetch = installFetchRouter(handlers());

    await expect(
      sealCapsuleCore(baseParams(runtime, rec.adapter, chunkMeta(2)))
    ).rejects.toThrow();

    const firstTxId = rec.claimedTxIds[0];
    expect(rec.uploadContainerCalls).toBe(1);

    rec.setClaimOk();
    const result = await sealCapsuleCore(
      baseParams(runtime, rec.adapter, chunkMeta(2))
    );

    // No second DataItem, no second signature: the cached outcome is
    // reused and the SAME txId is claimed again.
    expect(rec.uploadContainerCalls).toBe(1);
    expect(rec.claimCalls).toBe(2);
    expect(rec.claimedTxIds[1]).toBe(firstTxId);
    expect(result.finalized).toBe(true);
    expect(shouldReleaseRuntimeAfterSeal(result, CAPSULE_ID)).toBe(true);
  });

  it("4. the cleanup decision at the component boundary matches the contract (source)", async () => {
    // The component's finally must consult the decision helper instead of
    // releasing the Runtime unconditionally.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../pages/capsule/CapsuleHold.tsx"),
      "utf8"
    );
    expect(src).toContain("shouldReleaseRuntimeAfterSeal(");
    expect(src).toContain("await destroyRuntime(");
    // The unconditional release is gone: destroyRuntime appears exactly
    // once, inside the guarded block.
    const occurrences = src.split("await destroyRuntime(").length - 1;
    expect(occurrences).toBe(1);
  });
});
