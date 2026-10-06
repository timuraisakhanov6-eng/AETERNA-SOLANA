import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * HEARTBEAT MINIMUM BOUNDARY — sealCapsuleCore fail-fast proof.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * sealCapsuleCore computes heartbeatInterval = openAt - sealedAt and
 * MUST NOT POST a manifest whose interval is below the canonical
 * minimum (HEARTBEAT_INTERVAL_MIN_MS = 1 day): the seal endpoint would
 * reject it with 400 INVALID_HEARTBEAT, and that request is guaranteed
 * unusable. The canonical client guard assertHeartbeatConsistency
 * (-> assertHeartbeatIntervalBounds) is invoked BEFORE the POST.
 *
 *   A. valid heartbeat (>= 1 day)  → POST /api/capsule/seal happens.
 *   B. invalid heartbeat (< 1 day) → NO POST at all; seal fails closed.
 *   C. exact boundary (== 86,400,000 ms) → POST happens (accepted).
 *   D. invalid heartbeat → no manifest is persisted locally either.
 *
 * NON-VACUOUS: (A) proves the spy records a real POST for a valid
 * interval, so (B)'s "no POST" cannot pass merely because the spy is
 * broken.
 *
 * No live network, no wallet, no Irys, no payment, no KV.
 */

import { sealCapsuleCore } from "./sealCapsuleCore";

import { createLocalVaultPointer } from "@/lib/runtime/localVaultPointer";

import { HEARTBEAT_INTERVAL_MIN_MS } from "@/shared/heartbeat/resolveEffectiveOpenAt";

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

/** Fixed trusted "now" reported by /api/time for every test. */
const TRUSTED_NOW = Date.UTC(2026, 9, 5, 16, 29, 46, 503);

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

function buildStorage(): StorageAdapter {
  return {
    name: "heartbeat-test-adapter",
    async upload() {
      return { txId: "tx".padEnd(43, "Z") };
    },
    async uploadContainer(
      _runtime: unknown,
      chunkMetadata: readonly { chunkId: string }[]
    ) {
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

interface CapturedCall {
  url: string;
}

function installFetchRouter(
  handlers: Record<string, () => Promise<Response>>
): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    calls.push({ url });

    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) {
      return Promise.resolve(jsonResponse(404, { error: "NO_HANDLER" }));
    }
    return handlers[key]!();
  }) as unknown as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Handlers with a FIXED trusted time so sealedAt is deterministic. */
function okHandlers() {
  return {
    "/api/time": async () => jsonResponse(200, { nowUtc: TRUSTED_NOW }),
    "/api/publication/verify": async () =>
      jsonResponse(200, { ok: true, state: "VERIFIED" }),
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
  chunkMetadata: readonly ChunkMetadata[],
  openAt: number
): Parameters<typeof sealCapsuleCore>[0] {
  return {
    capsuleId: CAPSULE_ID,
    saltBase: SALT_BASE,
    recipientSecret: RECIPIENT_SECRET,
    creatorAuthority: CREATOR_AUTHORITY,
    openAt,
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

function sealPosts(calls: CapturedCall[]): number {
  return calls.filter((c) => c.url.includes("/api/capsule/seal")).length;
}

describe("sealCapsuleCore — heartbeat minimum fail-fast", () => {
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

  it("A. valid heartbeat (> 1 day) → POST /api/capsule/seal happens", async () => {
    const router = installFetchRouter(okHandlers());
    restoreFetch = router.restore;

    // openAt 2 days after sealedAt -> interval 172,800,000 ms (valid).
    const openAt = TRUSTED_NOW + 2 * 86_400_000;

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), buildStorage(), [], openAt)
    );

    expect(result.finalized).toBe(true);
    expect(sealPosts(router.calls)).toBe(1);
  });

  it("B. invalid heartbeat (< 1 day) → NO POST at all; fails closed", async () => {
    const router = installFetchRouter(okHandlers());
    restoreFetch = router.restore;

    // The exact observed production case: Oct 6 12:00 UTC, ~20.9 h later.
    const openAt = Date.UTC(2026, 9, 6, 12, 0, 0, 0);
    expect(openAt - TRUSTED_NOW).toBeLessThan(HEARTBEAT_INTERVAL_MIN_MS);

    await expect(
      sealCapsuleCore(
        baseParams(buildRuntime(), buildStorage(), [], openAt)
      )
    ).rejects.toThrow();

    // The seal endpoint was NEVER contacted.
    expect(sealPosts(router.calls)).toBe(0);
    // Nor was the seal verification / finalization reached.
    expect(
      router.calls.some((c) => c.url.includes("/api/seal/verify"))
    ).toBe(false);
    expect(
      router.calls.some((c) => c.url.includes("/api/creator/finalize-credit"))
    ).toBe(false);
  });

  it("C. exact boundary (== 86,400,000 ms) → POST happens (accepted)", async () => {
    const router = installFetchRouter(okHandlers());
    restoreFetch = router.restore;

    // openAt exactly 1 day after sealedAt -> interval === MIN (valid).
    const openAt = TRUSTED_NOW + HEARTBEAT_INTERVAL_MIN_MS;
    expect(openAt - TRUSTED_NOW).toBe(HEARTBEAT_INTERVAL_MIN_MS);

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), buildStorage(), [], openAt)
    );

    expect(result.finalized).toBe(true);
    expect(sealPosts(router.calls)).toBe(1);
  });

  it("D. invalid heartbeat → no local manifest persisted before the guard", async () => {
    const router = installFetchRouter(okHandlers());
    restoreFetch = router.restore;

    // openAt 1 ms short of the minimum -> interval 86,399,999 ms (invalid).
    const openAt = TRUSTED_NOW + HEARTBEAT_INTERVAL_MIN_MS - 1;

    await expect(
      sealCapsuleCore(
        baseParams(buildRuntime(), buildStorage(), [], openAt)
      )
    ).rejects.toThrow();

    expect(sealPosts(router.calls)).toBe(0);
    // The retry-safe manifest cache must NOT have been written.
    let persisted: string | null = null;
    try {
      persisted = sessionStorage.getItem(`aeterna-seal-manifest:${CAPSULE_ID}`);
    } catch {
      persisted = null;
    }
    expect(persisted).toBeNull();
  });
});
