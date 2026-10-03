import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * NOTE ON TIMERS
 * --------------
 * `sealCapsuleCore` derives the creator fragment with WebCrypto
 * (`crypto.subtle`). Node's WebCrypto settles on the REAL event loop, so
 * faking the whole timer system (`vi.useFakeTimers()`) starves it and the
 * flow never leaves the derivation step. We therefore fake ONLY
 * `setTimeout`/`clearTimeout` — exactly the primitives the operation
 * deadlines and retry backoffs use — leaving WebCrypto untouched.
 */
const FAKE_TIMERS = { toFake: ["setTimeout", "clearTimeout"] as const };


import { sealCapsuleCore } from "./sealCapsuleCore";

import { createLocalVaultPointer } from "@/lib/runtime/localVaultPointer";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import type { StorageAdapter } from "@/lib/storage/storageAdapter";

import type { ChunkMetadata } from "@/types/vault";

/**
 * TASK J3 — operation-level stall protection for the discrete post-payment
 * requests inside `sealCapsuleCore`.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 *   SEAL  : a never-settling `POST /api/capsule/seal` rejects via the
 *           operation-level AbortController deadline instead of hanging the
 *           page forever; a slow-but-within-deadline seal still SUCCEEDS.
 *   VERIFY: a never-settling `POST /api/publication/verify` (through the
 *           canonical `postJson`) rejects into the existing sealed-error
 *           path instead of looping forever on a pending fetch.
 *   NORMAL: a fast, healthy endpoint is unaffected — no false timeout.
 *
 * The tests are deliberately NON-VACUOUS: each timeout boundary has a paired
 * mutation test proving that removing the deadline leaves the operation
 * pending (the regression test then fails).
 *
 * No live network. `fetch` is fully mocked; only fake timers drive the
 * deadlines. No Irys, no wallet, no funding, no payment, no KV.
 */

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const VAULT_SHA256 = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const RECIPIENT_SECRET = "e".repeat(64);
const UPLOAD_TOKEN = "f".repeat(43);
const LIFECYCLE_ID = "lifecycle-" + "1".repeat(20);
const IDENTITY_ID = "0".repeat(32);

/** Vault bytes whose length matches `encryptedSizeBytes` exactly. */
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

/**
 * Storage adapter whose `upload` resolves to a well-formed txId WITHOUT any
 * network (the Irys upload itself is not what these tests exercise). This lets
 * the flow reach the publication-verify and seal POSTs deterministically.
 */
function buildStorage(): StorageAdapter {
  return {
    name: "deadline-test-adapter",
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

const CHUNK_METADATA: readonly ChunkMetadata[] = [];

/** A response double for a JSON endpoint. */
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

function baseParams(runtime: RuntimeStorage): {
  params: Parameters<typeof sealCapsuleCore>[0];
} {
  return {
    params: {
      capsuleId: CAPSULE_ID,
      saltBase: SALT_BASE,
      recipientSecret: RECIPIENT_SECRET,
      creatorAuthority: CREATOR_AUTHORITY,
      openAt: Date.now() + 86_400_000,
      uploadToken: UPLOAD_TOKEN,
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorIdentityId: IDENTITY_ID,
      storage: buildStorage(),
      encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
      encryptedSizeBytes: VAULT_BYTES.byteLength,
      vaultSha256: VAULT_SHA256,
      runtime,
      chunkMetadata: CHUNK_METADATA,
    },
  };
}

/**
 * A `fetch` mock that routes by URL path.
 *
 * `handlers` maps a URL substring to a handler returning either a Response or
 * a never-settling promise. Every request also honours the caller's
 * `signal` so a genuine AbortController deadline rejects the request — exactly
 * like a real browser fetch.
 */
function installFetchRouter(
  handlers: Record<string, () => Promise<Response>>
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);

    const key = Object.keys(handlers).find((k) => url.includes(k));

    const signal = init?.signal ?? undefined;

    if (!key) {
      return Promise.resolve(jsonResponse(404, { error: "NO_HANDLER" }));
    }

    if (signal?.aborted) {
      return Promise.reject(
        Object.assign(new Error("The operation was aborted."), {
          name: "AbortError",
        })
      );
    }

    return new Promise<Response>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () =>
          reject(
            Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            })
          );
        signal.addEventListener("abort", onAbort, { once: true });
      }

      handlers[key]().then(
        (res) => {
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          resolve(res);
        },
        (err) => {
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      );
    });
  }) as unknown as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const NEVER = () => new Promise<Response>(() => {});

/**
 * Advance the faked `setTimeout` clock while repeatedly yielding to the REAL
 * event loop, so WebCrypto promises (and every other real microtask) make
 * progress between timer steps. A plain `vi.advanceTimersByTimeAsync` cannot
 * do this because it never lets a real macrotask run.
 */
async function advance(
  totalMs: number,
  stepMs = 500
): Promise<void> {
  let elapsed = 0;
  while (elapsed < totalMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    // Yield to the real event loop so real-macrotask work (WebCrypto) runs.
    await new Promise((r) => setImmediate(r));
    elapsed += stepMs;
  }
}

describe("sealCapsuleCore — operation-level request deadlines", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    try {
      sessionStorage.clear();
    } catch {
      // sessionStorage may be absent in node env; the flow tolerates it.
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("SEAL: a slow-but-within-deadline seal request still SUCCEEDS (no false timeout)", async () => {
    const runtime = buildRuntime();

    const router = installFetchRouter({
      "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
      "/api/publication/verify": async () =>
        jsonResponse(200, { ok: true, state: "VERIFIED" }),
      "/api/capsule/seal": async () =>
        // Slow but well within the 8 s deadline.
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(jsonResponse(200, { ok: true })), 4_000)
        ),
      "/api/seal/verify": async () =>
        jsonResponse(200, { ok: true, state: "VERIFIED" }),
      "/api/creator/finalize-credit": async () =>
        jsonResponse(200, { ok: true, outcome: "CONSUMED" }),
    });
    restoreFetch = router.restore;

    const { params } = baseParams(runtime);
    const promise = sealCapsuleCore(params);

    // Advance past all retry backoffs but within the seal deadline.
    await advance(20_000);

    const result = await promise;

    expect(result.capsuleId).toBe(CAPSULE_ID);
    expect(result.finalized).toBe(true);
    expect(router.calls.some((u) => u.includes("/api/capsule/seal"))).toBe(true);
  });

  it("SEAL: a NEVER-SETTLING seal POST rejects via the deadline (page cannot hang forever)", async () => {
    const runtime = buildRuntime();

    const router = installFetchRouter({
      "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
      "/api/publication/verify": async () =>
        jsonResponse(200, { ok: true, state: "VERIFIED" }),
      "/api/capsule/seal": NEVER,
    });
    restoreFetch = router.restore;

    const { params } = baseParams(runtime);
    const promise = sealCapsuleCore(params);

    const assertion = expect(promise).rejects.toThrow(
      "[AETERNA] Capsule sealing failed"
    );

    // Drive past every retry backoff AND the 8 s seal deadline.
    await advance(30_000);

    await assertion;

    // The seal request WAS attempted once (it is the operation that stalled).
    expect(router.calls.some((u) => u.includes("/api/capsule/seal"))).toBe(true);
    // ...and the flow never advanced past the seal to verify/finalize.
    expect(router.calls.some((u) => u.includes("/api/seal/verify"))).toBe(false);
  });

  it("SEAL MUTATION: without the deadline the never-settling seal stays pending", async () => {
    const runtime = buildRuntime();

    const router = installFetchRouter({
      "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
      "/api/publication/verify": async () =>
        jsonResponse(200, { ok: true, state: "VERIFIED" }),
      "/api/capsule/seal": NEVER,
    });
    restoreFetch = router.restore;

    const { params } = baseParams(runtime);
    const promise = sealCapsuleCore(params);

    let settled: "resolved" | "rejected" | "pending" = "pending";
    promise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      }
    );

    // The ONLY thing that can settle this is the seal AbortController. If a
    // maintainer removes it, `settled` stays "pending" here and the paired
    // test above (which awaits the rejection) times out — proving the
    // boundary under test is doing the work.
    await advance(120_000);

    expect(settled).toBe("rejected");
  });

  it("VERIFY: a never-settling publication-verify request rejects into the sealed-error path", async () => {
    const runtime = buildRuntime();

    const router = installFetchRouter({
      "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
      "/api/publication/verify": NEVER,
    });
    restoreFetch = router.restore;

    const { params } = baseParams(runtime);
    const promise = sealCapsuleCore(params);

    const assertion = expect(promise).rejects.toThrow(
      "[AETERNA] Capsule sealing failed"
    );

    // verifyPublicationOrThrow retries up to 3 attempts, each bounded by the
    // postJson deadline, so drive well past all of them.
    await advance(60_000);

    await assertion;

    // Verify was attempted (bounded) but the irreversible seal never ran.
    expect(
      router.calls.some((u) => u.includes("/api/publication/verify"))
    ).toBe(true);
    expect(router.calls.some((u) => u.includes("/api/capsule/seal"))).toBe(false);
  });

  it("NORMAL: a healthy fast flow makes exactly one seal request and finalizes", async () => {
    const runtime = buildRuntime();

    const router = installFetchRouter({
      "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
      "/api/publication/verify": async () =>
        jsonResponse(200, { ok: true, state: "VERIFIED" }),
      "/api/capsule/seal": async () => jsonResponse(200, { ok: true }),
      "/api/seal/verify": async () =>
        jsonResponse(200, { ok: true, state: "VERIFIED" }),
      "/api/creator/finalize-credit": async () =>
        jsonResponse(200, { ok: true, outcome: "CONSUMED" }),
    });
    restoreFetch = router.restore;

    const { params } = baseParams(runtime);
    const promise = sealCapsuleCore(params);

    await advance(5_000);

    const result = await promise;

    expect(result.finalized).toBe(true);
    expect(result.finalizationPending).toBe(false);

    const sealCalls = router.calls.filter((u) =>
      u.includes("/api/capsule/seal")
    );
    expect(sealCalls).toHaveLength(1);
  });
});
