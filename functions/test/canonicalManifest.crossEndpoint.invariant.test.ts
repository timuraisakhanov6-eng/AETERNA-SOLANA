import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as sealPostRaw } from "./../api/capsule/seal";
import { onRequestPost as sealVerifyPostRaw } from "./../api/seal/verify";

/**
 * Cross-endpoint manifest identity invariant.
 *
 * The decisive production failure was:
 *   /api/capsule/seal         persisted canonicalStringify(manifest)
 *   /api/seal/verify          hashed both sides with JSON.stringify
 * so an identical semantic manifest produced two different hashes and
 * the seal failed closed with 409 MANIFEST_MISMATCH.
 *
 * These tests drive BOTH real endpoint handlers and assert the shared
 * canonical serializer keeps stored/submitted identity equal — while
 * genuinely different manifests stay fail-closed.
 */

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

type FakeKV = ReturnType<typeof createFakeKV>;

interface SealEnv {
  CAPSULE_MANIFESTS: FakeKV;
  VERIFIED_PAYMENTS: FakeKV;
  UPLOAD_TOKENS: FakeKV;
  AUTHORITY_TOKENS: FakeKV;
  BUSINESS_QUOTES: FakeKV;
  PUBLICATION_VERIFICATIONS: FakeKV;
  CREATOR_CREDITS: FakeKV;
  SEAL_VERIFICATIONS: FakeKV;
}

const sealPost = sealPostRaw as unknown as (context: {
  request: ReturnType<typeof createFakeRequest>;
  env: SealEnv;
}) => Promise<Response>;

const sealVerifyPost = sealVerifyPostRaw as unknown as (context: unknown) => Promise<Response>;

function buildEnv(): SealEnv {
  return {
    CAPSULE_MANIFESTS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    AUTHORITY_TOKENS: createFakeKV(),
    BUSINESS_QUOTES: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    CREATOR_CREDITS: createFakeKV(),
    SEAL_VERIFICATIONS: createFakeKV(),
  };
}

function request(body: unknown) {
  return createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });
}

/** Manifest in CLIENT DECLARATION ORDER (what sealCapsuleCore sends). */
function clientManifest(capsuleId: string, vaultTxId: string) {
  return {
    version: 1,
    capsuleId,
    saltBase: "a".repeat(32),
    sealedAt: 1791207079008,
    openAt: 1791374400000,
    vaultTxId,
    encryptedSizeBytes: 550,
    heartbeatInterval: 167320992,
    ext: { vaultSha256: "a".repeat(64) },
  };
}

/** Manifest in KEY-SORTED ORDER (what CAPSULE_MANIFESTS holds). */
function sortedManifest(capsuleId: string, vaultTxId: string) {
  return {
    capsuleId,
    encryptedSizeBytes: 550,
    ext: { vaultSha256: "a".repeat(64) },
    heartbeatInterval: 167320992,
    openAt: 1791374400000,
    saltBase: "a".repeat(32),
    sealedAt: 1791207079008,
    vaultTxId,
    version: 1,
  };
}

function seedCreditAndPublication(env: SealEnv, capsuleId: string) {
  env.CREATOR_CREDITS.put(
    "creator:credit:lifecycle:creator-1:lifecycle-1",
    JSON.stringify({
      id: "credit-1",
      status: "CONSUMING",
      creatorIdentityId: "creator-1",
      capsuleId,
    })
  );
  env.PUBLICATION_VERIFICATIONS.put(
    "creator:publication:lifecycle-1",
    JSON.stringify({
      lifecycleId: "lifecycle-1",
      capsuleId,
      state: "VERIFIED",
    })
  );
}

describe("cross-endpoint manifest identity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("5. stored manifest (canonical) and submitted manifest (declaration order) hash identically at /api/seal/verify", async () => {
    const env = buildEnv();
    const capsuleId = "c".repeat(64);
    const vaultTxId = "v".repeat(43);

    seedCreditAndPublication(env, capsuleId);
    // Simulate the persisted canonical (key-sorted) manifest.
    env.CAPSULE_MANIFESTS.put(
      capsuleId,
      JSON.stringify(sortedManifest(capsuleId, vaultTxId))
    );

    const res = await sealVerifyPost(
      makeEventContext({
        request: request({
          creatorIdentityId: "creator-1",
          lifecycleId: "lifecycle-1",
          capsuleId,
          // Client submits DECLARATION order — must still match.
          manifest: clientManifest(capsuleId, vaultTxId),
        }),
        env,
      })
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).state).toBe(
      "VERIFIED"
    );
  });

  it("7. genuinely different manifest stays fail-closed at /api/seal/verify", async () => {
    const env = buildEnv();
    const capsuleId = "c".repeat(64);

    seedCreditAndPublication(env, capsuleId);
    env.CAPSULE_MANIFESTS.put(
      capsuleId,
      JSON.stringify(sortedManifest(capsuleId, "v".repeat(43)))
    );

    const res = await sealVerifyPost(
      makeEventContext({
        request: request({
          creatorIdentityId: "creator-1",
          lifecycleId: "lifecycle-1",
          capsuleId,
          manifest: clientManifest(capsuleId, "w".repeat(43)),
        }),
        env,
      })
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "MANIFEST_MISMATCH"
    );
  });

  it("6a. /api/capsule/seal idempotency: identical manifest in different key order -> 200", async () => {
    const env = buildEnv();
    const capsuleId = "c".repeat(64);
    const vaultTxId = "v".repeat(43);
    const manifest = clientManifest(capsuleId, vaultTxId);

    // Persist the canonical form exactly as the endpoint would.
    env.CAPSULE_MANIFESTS.put(
      capsuleId,
      JSON.stringify(sortedManifest(capsuleId, vaultTxId))
    );

    const res = await sealPost({
      request: request({
        uploadToken: "a".repeat(32),
        manifest,
        creatorAuthorityFragment: "a".repeat(64),
      }),
      env,
    });

    expect(res.status).toBe(200);
  });

  it("6b. /api/capsule/seal idempotency: different manifest -> 409 MANIFEST_ALREADY_EXISTS_DIFFERENT", async () => {
    const env = buildEnv();
    const capsuleId = "c".repeat(64);

    env.CAPSULE_MANIFESTS.put(
      capsuleId,
      JSON.stringify(sortedManifest(capsuleId, "v".repeat(43)))
    );

    const res = await sealPost({
      request: request({
        uploadToken: "a".repeat(32),
        manifest: clientManifest(capsuleId, "w".repeat(43)),
        creatorAuthorityFragment: "a".repeat(64),
      }),
      env,
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "MANIFEST_ALREADY_EXISTS_DIFFERENT"
    );
  });
});
