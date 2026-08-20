import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as sealVerifyPost } from "./../api/seal/verify";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface SealVerifyEnv {
  CAPSULE_MANIFESTS: ReturnType<typeof createFakeKV>;
  PUBLICATION_VERIFICATIONS: ReturnType<typeof createFakeKV>;
  CREATOR_CREDITS: ReturnType<typeof createFakeKV>;
  SEAL_VERIFICATIONS: ReturnType<typeof createFakeKV>;
}

function buildEnv(overrides?: Partial<SealVerifyEnv>): SealVerifyEnv {
  return {
    CAPSULE_MANIFESTS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    CREATOR_CREDITS: createFakeKV(),
    SEAL_VERIFICATIONS: createFakeKV(),
    ...overrides,
  };
}

function buildContext(env: SealVerifyEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

function seedCredit(env: SealVerifyEnv) {
  env.CREATOR_CREDITS.put(
    "creator:credit:lifecycle:creator-1:lifecycle-1",
    JSON.stringify({
      id: "credit-1",
      status: "CONSUMING",
      creatorIdentityId: "creator-1",
      capsuleId: "capsule-1",
    })
  );
}

function seedPublication(env: SealVerifyEnv) {
  env.PUBLICATION_VERIFICATIONS.put(
    "creator:publication:lifecycle-1",
    JSON.stringify({
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      state: "VERIFIED",
    })
  );
}

function seedManifest(env: SealVerifyEnv, manifest: unknown) {
  env.CAPSULE_MANIFESTS.put("capsule-1", JSON.stringify(manifest));
}

describe("Seal verification boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("REJECTS when publication is not verified", async () => {
    const env = buildEnv();
    seedCredit(env);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      manifest: {},
    });

    const res = await sealVerifyPost(context);
    expect(res.status).toBe(409);
  });

  it("REJECTS when manifest does not match stored manifest", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedPublication(env);
    seedManifest(env, { capsuleId: "capsule-1", vaultTxId: "vault-1" });

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      manifest: { capsuleId: "capsule-1", vaultTxId: "vault-2" },
    });

    const res = await sealVerifyPost(context);
    expect(res.status).toBe(409);
  });

  it("RETURNS VERIFIED when all authoritative conditions are satisfied", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedPublication(env);
    const manifest = { capsuleId: "capsule-1", vaultTxId: "vault-1" };
    seedManifest(env, manifest);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      manifest,
    });

    const res = await sealVerifyPost(context);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("VERIFIED");
  });

  it("is idempotent for same lifecycle", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedPublication(env);
    const manifest = { capsuleId: "capsule-1", vaultTxId: "vault-1" };
    seedManifest(env, manifest);

    const body = {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      manifest,
    };

    const first = await sealVerifyPost(buildContext(env, body));
    expect(first.status).toBe(200);

    const second = await sealVerifyPost(buildContext(env, body));
    expect(second.status).toBe(200);
    expect((await second.json()).state).toBe("VERIFIED");
  });

  it("REJECTS cross-capsule manifest", async () => {
    const env = buildEnv();
    seedCredit(env);
    seedPublication(env);
    seedManifest(env, { capsuleId: "capsule-1", vaultTxId: "vault-1" });

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-other",
      manifest: { capsuleId: "capsule-other", vaultTxId: "vault-1" },
    });

    const res = await sealVerifyPost(context);
    expect(res.status).toBe(409);
  });
});
