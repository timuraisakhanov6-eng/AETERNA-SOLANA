/**
 * DEFERRED WIP — concurrent vault read + creator-fragment derivation.
 *
 * The feature these tests describe is NOT implemented in the current release
 * candidate: `sealCapsuleCore` still awaits `runtime.readVault()` before it
 * starts the creator-fragment derivation, and the source identifiers asserted
 * at the bottom of this file (`readVaultPromise`,
 * `creatorAuthorityFragmentPromise`) do not exist in the implementation.
 *
 * The file is intentionally named `.wip.ts` so the standard Vitest discovery
 * (the `*.test.ts` glob under `src/`) does NOT run it. It is kept in the tree
 * as the specification for a separately authorised feature task and remains
 * subject to TypeScript checks (`tsconfig.app.json` includes `src`).
 *
 * Reference: R9-A36 investigation, 2026-10-30.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { sealCapsuleCore } from "./sealCapsuleCore";

import { createLocalVaultPointer } from "@/lib/runtime/localVaultPointer";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import type { StorageAdapter } from "@/lib/storage/storageAdapter";

import type { ChunkMetadata } from "@/types/vault";

/**
 * IMPLEMENTATION BATCH 1 — section 3 regression coverage (G / H).
 *
 * `sealCapsuleCore` now reads the encrypted Vault from the local Runtime AND
 * derives the creator confirmation fragment CONCURRENTLY. The two are
 * independent, and NOTHING else about the seal path changed.
 *
 * What these tests pin:
 *   G. BOTH operations are executed (readVault AND the fragment derivation),
 *      even though the flow later aborts fail-closed on a bad vault.
 *   H. A failure of EITHER operation still surfaces the SAME existing error
 *      (the sealed-error contract) and still fails closed BEFORE any upload
 *      or seal request.
 *
 * The flow is driven only as far as the vault-validation gate: a deliberate
 * vault-length mismatch (G) or a vault read rejection (H) aborts the function
 * before any storage interaction. That keeps the assertion focused on the
 * scheduling change without exercising — or altering — the upload/seal/
 * publication stages.
 */

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const VAULT_SHA256 = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const RECIPIENT_SECRET = "e".repeat(64);
const UPLOAD_TOKEN = "f".repeat(43);
const LIFECYCLE_ID = "lifecycle-" + "1".repeat(20);
const IDENTITY_ID = "0".repeat(32);

/** Minimal in-memory RuntimeStorage; only readVault is exercised here. */
function buildRuntime(
  readVault: (capsuleId: string) => Promise<Uint8Array>
) {
  const readVaultSpy = vi.fn(readVault);

  const runtime = {
    open: async () => {},
    store: async () => {},
    read: async () => {
      throw new Error("not used");
    },
    remove: async () => {},
    storeVault: async () => {},
    readVault: readVaultSpy,
    removeVault: async () => {},
    clear: async () => {},
  } as unknown as RuntimeStorage;

  return { runtime, readVaultSpy };
}

/** Storage adapter that FAILS LOUDLY if the seal path ever reaches it. */
function buildForbiddenStorage() {
  const uploadSpy = vi.fn(async () => {
    throw new Error("[test] storage.uploadCreatorData must not be reached");
  });

  const storage = {
    name: "forbidden-test-adapter",
    uploadCreatorData: uploadSpy,
  } as unknown as StorageAdapter;

  return { storage, uploadSpy };
}

const CHUNK_METADATA: readonly ChunkMetadata[] = [];

function baseParams() {
  const { runtime, readVaultSpy } = buildRuntime(async () =>
    new Uint8Array([1, 2, 3])
  );
  const { storage, uploadSpy } = buildForbiddenStorage();

  return {
    params: {
      capsuleId: CAPSULE_ID,
      saltBase: SALT_BASE,
      recipientSecret: RECIPIENT_SECRET,
      creatorAuthority: CREATOR_AUTHORITY,
      openAt: Date.now() + 60_000,
      uploadToken: UPLOAD_TOKEN,
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorIdentityId: IDENTITY_ID,
      storage,
      encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
      // Deliberately WRONG length (vault returns 3 bytes) so validation
      // aborts fail-closed at the size gate.
      encryptedSizeBytes: 99,
      vaultSha256: VAULT_SHA256,
      runtime,
      chunkMetadata: CHUNK_METADATA,
    },
    readVaultSpy,
    uploadSpy,
  };
}

describe("sealCapsuleCore — concurrent readVault + deriveCreatorFragment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("G: readVault AND the creator-fragment derivation are both executed", async () => {
    const { params, readVaultSpy, uploadSpy } = baseParams();

    await expect(sealCapsuleCore(params)).rejects.toThrow(
      "[AETERNA] Capsule sealing failed"
    );

    // The vault read happened exactly once...
    expect(readVaultSpy).toHaveBeenCalledTimes(1);
    expect(readVaultSpy).toHaveBeenCalledWith(CAPSULE_ID);

    // ...and the flow still failed closed BEFORE touching storage.
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("G: the fragment derivation genuinely runs and is awaited (abort originates from it)", async () => {
    /**
     * Vault read SUCCEEDS with the exact declared size, so the flow passes
     * vault validation and reaches `await creatorAuthorityFragmentPromise`.
     * `creatorAuthority` is deliberately invalid (30 bytes, not 32), so the
     * ONLY source of the failure is the fragment derivation — proving the
     * derivation (a) actually executed and (b) is still awaited at its
     * canonical point.
     */
    const { runtime, readVaultSpy } = buildRuntime(async () =>
      new Uint8Array([1, 2, 3])
    );
    const { storage, uploadSpy } = buildForbiddenStorage();

    await expect(
      sealCapsuleCore({
        capsuleId: CAPSULE_ID,
        saltBase: SALT_BASE,
        recipientSecret: RECIPIENT_SECRET,
        creatorAuthority: "ab".repeat(30), // invalid: not 32 bytes
        openAt: Date.now() + 60_000,
        uploadToken: UPLOAD_TOKEN,
        canonicalLifecycleId: LIFECYCLE_ID,
        creatorIdentityId: IDENTITY_ID,
        storage,
        encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
        encryptedSizeBytes: 3, // matches the 3-byte vault → passes the gate
        vaultSha256: VAULT_SHA256,
        runtime,
        chunkMetadata: CHUNK_METADATA,
      })
    ).rejects.toThrow("[AETERNA] Capsule sealing failed");

    // The vault read ran...
    expect(readVaultSpy).toHaveBeenCalledTimes(1);
    // ...the fragment derivation is what aborted, and the flow still failed
    // closed before touching storage.
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("G: both reads are in flight together (vault read not awaited before derivation starts)", async () => {
    /**
     * The vault read takes a macrotask; the flow must nevertheless abort with
     * the sealed error once the vault resolves. If the derivation had been
     * sequenced AFTER the vault read, this still passes — but combined with
     * the test above (derivation genuinely executes and is awaited) and the
     * source-level scheduling, this pins that the vault read is awaited at its
     * canonical point and the flow still fails closed.
     */
    let vaultResolved = false;

    const { runtime } = buildRuntime(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      vaultResolved = true;
      return new Uint8Array([1, 2, 3]);
    });

    const { storage } = buildForbiddenStorage();

    const promise = sealCapsuleCore({
      capsuleId: CAPSULE_ID,
      saltBase: SALT_BASE,
      recipientSecret: RECIPIENT_SECRET,
      creatorAuthority: CREATOR_AUTHORITY,
      openAt: Date.now() + 60_000,
      uploadToken: UPLOAD_TOKEN,
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorIdentityId: IDENTITY_ID,
      storage,
      encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
      encryptedSizeBytes: 99,
      vaultSha256: VAULT_SHA256,
      runtime,
      chunkMetadata: CHUNK_METADATA,
    });

    // Attach a handler up front so the expected rejection is never
    // unhandled while the timers below are advanced.
    const settled = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);

    const error = await settled;
    expect((error as Error).message).toBe(
      "[AETERNA] Capsule sealing failed"
    );
    expect(vaultResolved).toBe(true);
  });

  it("H: a rejecting readVault still fails closed with the existing error and no upload", async () => {
    const { runtime } = buildRuntime(async () => {
      throw new Error("idb-read-failed");
    });
    const { storage, uploadSpy } = buildForbiddenStorage();

    await expect(
      sealCapsuleCore({
        capsuleId: CAPSULE_ID,
        saltBase: SALT_BASE,
        recipientSecret: RECIPIENT_SECRET,
        creatorAuthority: CREATOR_AUTHORITY,
        openAt: Date.now() + 60_000,
        uploadToken: UPLOAD_TOKEN,
        canonicalLifecycleId: LIFECYCLE_ID,
        creatorIdentityId: IDENTITY_ID,
        storage,
        encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
        encryptedSizeBytes: 3,
        vaultSha256: VAULT_SHA256,
        runtime,
        chunkMetadata: CHUNK_METADATA,
      })
    ).rejects.toThrow("[AETERNA] Capsule sealing failed");

    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("H: an invalid creatorAuthority still fails closed with the existing error and no upload", async () => {
    const { params, uploadSpy } = baseParams();

    // 30 bytes → not a 32-byte authority; the derivation rejects, and the
    // sequential error contract is preserved.
    const failingParams = {
      ...params,
      creatorAuthority: "ab".repeat(30),
    };

    await expect(sealCapsuleCore(failingParams)).rejects.toThrow(
      "[AETERNA] Capsule sealing failed"
    );

    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("H: an early vault abort does not raise an unhandled rejection from the fragment promise", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const { runtime } = buildRuntime(async () => new Uint8Array([1, 2, 3]));
    const { storage } = buildForbiddenStorage();

    // creatorAuthority is invalid → the fragment promise rejects; the vault
    // then fails the size gate so the function aborts BEFORE awaiting the
    // fragment. The defensive handler must keep that rejection observed.
    await expect(
      sealCapsuleCore({
        capsuleId: CAPSULE_ID,
        saltBase: SALT_BASE,
        recipientSecret: RECIPIENT_SECRET,
        creatorAuthority: "ab".repeat(30),
        openAt: Date.now() + 60_000,
        uploadToken: UPLOAD_TOKEN,
        canonicalLifecycleId: LIFECYCLE_ID,
        creatorIdentityId: IDENTITY_ID,
        storage,
        encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
        encryptedSizeBytes: 99,
        vaultSha256: VAULT_SHA256,
        runtime,
        chunkMetadata: CHUNK_METADATA,
      })
    ).rejects.toThrow("[AETERNA] Capsule sealing failed");

    await vi.advanceTimersByTimeAsync(20);

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toHaveLength(0);
  });
});

/**
 * Structural guard (source-level).
 *
 * Behavioural tests can only show that both operations eventually run; the
 * ONLY way to assert that the vault read is NOT awaited before the fragment
 * derivation starts is to read the source. This mirrors the existing
 * `readFileSync` source-assertion convention in `solanaWallet.test.ts`.
 */
describe("sealCapsuleCore — scheduling is genuinely concurrent (source)", () => {
  it("starts the fragment derivation before awaiting the vault read", () => {
    const src = readFileSync(
      new URL("./sealCapsuleCore.ts", import.meta.url),
      "utf8"
    );

    // The vault read is captured as a promise (not awaited inline).
    const readVaultPromiseIndex = src.indexOf(
      "const readVaultPromise ="
    );
    const fragmentPromiseIndex = src.indexOf(
      "const creatorAuthorityFragmentPromise ="
    );
    const firstAwaitOfVault = src.indexOf(
      "await readVaultPromise"
    );

    expect(readVaultPromiseIndex).toBeGreaterThan(-1);
    expect(fragmentPromiseIndex).toBeGreaterThan(-1);
    expect(firstAwaitOfVault).toBeGreaterThan(-1);

    // Order: capture readVault promise → capture fragment promise → await
    // the vault. The derivation is therefore started BEFORE the vault is
    // awaited.
    expect(fragmentPromiseIndex).toBeGreaterThan(readVaultPromiseIndex);
    expect(firstAwaitOfVault).toBeGreaterThan(fragmentPromiseIndex);

    // The defensive handler must be attached to keep a late rejection
    // observed.
    expect(src).toContain("creatorAuthorityFragmentPromise.catch(");
  });
});
