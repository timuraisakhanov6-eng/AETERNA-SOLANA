import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  FakeRequest,
  CreateQuoteEnv,
} from "./harness";
import { onRequestPost as sealPostRaw } from "./../api/capsule/seal";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface SealEnv {
  CAPSULE_MANIFESTS: ReturnType<typeof createFakeKV>;
  VERIFIED_PAYMENTS: ReturnType<typeof createFakeKV>;
  UPLOAD_TOKENS: ReturnType<typeof createFakeKV>;
  AUTHORITY_TOKENS: ReturnType<typeof createFakeKV>;
  BUSINESS_QUOTES: ReturnType<typeof createFakeKV>;
  PUBLICATION_VERIFICATIONS?: ReturnType<typeof createFakeKV>;
  DEBUG?: "true" | "false";
}

interface SealContext {
  request: FakeRequest;
  env: SealEnv;
}

const sealPost = sealPostRaw as unknown as (
  context: SealContext
) => Promise<Response>;

function buildSealEnv(overrides?: Partial<SealEnv>): SealEnv {
  return {
    CAPSULE_MANIFESTS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    AUTHORITY_TOKENS: createFakeKV(),
    BUSINESS_QUOTES: createFakeKV(),
    ...overrides,
  };
}

function buildSealContext(env: SealEnv, body: unknown): SealContext {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return {
    request,
    env,
  };
}

function validManifest(
  capsuleId: string,
  vaultTxId: string,
  sealedAt: number,
  openAt: number,
  encryptedSizeBytes: number
) {
  return {
    version: 1,
    capsuleId,
    saltBase: "a".repeat(32),
    vaultTxId,
    openAt,
    sealedAt,
    encryptedSizeBytes,
    heartbeatInterval: 86400000,
    ext: { vaultSha256: "a".repeat(64) },
  };
}

function seedVerifiedPayment(
  kv: ReturnType<typeof createFakeKV>,
  paymentIntentId: string,
  evidenceId: string,
  expiresAt: number
) {
  kv.put(
    `verified-payment:${paymentIntentId}:${evidenceId}`,
    JSON.stringify({
      ok: true,
      paymentIntentId,
      transactionId: evidenceId,
      expiresAt,
    })
  );
  kv.put(
    `payment-intent:${paymentIntentId}:latest`,
    evidenceId
  );
}

function seedUploadToken(
  kv: ReturnType<typeof createFakeKV>,
  paymentIntentId: string,
  lifecycleId: string,
  creatorIdentityId: string,
  token = "a".repeat(32)
) {
  kv.put(
    token,
    JSON.stringify({
      canonicalLifecycleId: lifecycleId,
      creatorIdentityId,
      paymentIntentId,
      permissions: { uploadVault: true },
    })
  );
  return token;
}

describe("Seal-Once invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubVaultFetch() {
    const mock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "content-length": "1024" },
      })
    );
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("FIRST SEAL SUCCEEDS: persists manifest and consumes payment authority", async () => {
    stubVaultFetch();

    const capsuleId = "a".repeat(64);
    const vaultTxId = "a".repeat(43);
    const sealedAt = Date.now();
    const openAt = sealedAt + 1000;
    const encryptedSizeBytes = 1024;
    const manifest = validManifest(
      capsuleId,
      vaultTxId,
      sealedAt,
      openAt,
      encryptedSizeBytes
    );
    const creatorAuthorityFragment = "a".repeat(64);
    const paymentIntentId = "intent-1";
    const evidenceId = "evidence-1";

    const env = buildSealEnv({
      PUBLICATION_VERIFICATIONS: createFakeKV(),
    });
    env.PUBLICATION_VERIFICATIONS!.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId,
        creatorIdentityId: "creator-1",
        state: "VERIFIED",
        expectedTxId: vaultTxId,
        expectedVaultSha256: manifest.ext.vaultSha256,
        evidenceIds: [vaultTxId],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        verifiedAt: Date.now(),
      })
    );

    seedVerifiedPayment(
      env.VERIFIED_PAYMENTS,
      paymentIntentId,
      evidenceId,
      Date.now() + 60_000
    );
    const uploadToken = seedUploadToken(
      env.UPLOAD_TOKENS,
      paymentIntentId,
      "lifecycle-1",
      "creator-1",
      "a".repeat(32)
    );

    const body = {
      uploadToken,
      manifest,
      creatorAuthorityFragment,
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);

    expect(res.status).toBe(200);

    const stored = await env.CAPSULE_MANIFESTS.get(capsuleId);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).toEqual(manifest);

    expect(await env.AUTHORITY_TOKENS.get(capsuleId)).toBe(
      JSON.stringify({ fragment: creatorAuthorityFragment })
    );

    expect(await env.VERIFIED_PAYMENTS.get(`verified-payment:${paymentIntentId}:${evidenceId}`)).toBeNull();
    expect(await env.VERIFIED_PAYMENTS.get(`payment-intent:${paymentIntentId}:latest`)).toBeNull();
    expect(await env.UPLOAD_TOKENS.get(uploadToken)).toBeNull();
  });

  it("IDENTICAL RETRY IS IDEMPOTENT: returns 200 without modifying manifest", async () => {
    const capsuleId = "a".repeat(64);
    const vaultTxId = "a".repeat(43);
    const sealedAt = Date.now();
    const openAt = sealedAt + 1000;
    const encryptedSizeBytes = 1024;
    const manifest = validManifest(
      capsuleId,
      vaultTxId,
      sealedAt,
      openAt,
      encryptedSizeBytes
    );
    const normalized = JSON.stringify(manifest);

    const env = buildSealEnv({
      PUBLICATION_VERIFICATIONS: createFakeKV(),
    });
    env.PUBLICATION_VERIFICATIONS!.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId,
        creatorIdentityId: "creator-1",
        state: "VERIFIED",
        expectedTxId: vaultTxId,
        expectedVaultSha256: manifest.ext.vaultSha256,
        evidenceIds: [vaultTxId],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        verifiedAt: Date.now(),
      })
    );
    await env.CAPSULE_MANIFESTS.put(capsuleId, normalized);

    const body = {
      uploadToken: "a".repeat(32),
      manifest,
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);

    expect(res.status).toBe(200);
    expect(await env.CAPSULE_MANIFESTS.get(capsuleId)).toBe(normalized);
  });

  it("CONFLICTING MANIFEST IS REJECTED: different manifest for same capsuleId returns 409", async () => {
    const capsuleId = "a".repeat(64);
    const existingManifest = validManifest(
      capsuleId,
      "a".repeat(43),
      Date.now(),
      Date.now() + 1000,
      1024
    );
    const conflictingManifest = validManifest(
      capsuleId,
      "b".repeat(43),
      Date.now(),
      Date.now() + 1000,
      2048
    );

    const env = buildSealEnv();
    await env.CAPSULE_MANIFESTS.put(
      capsuleId,
      JSON.stringify(existingManifest)
    );

    const body = {
      uploadToken: "a".repeat(32),
      manifest: conflictingManifest,
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);

    expect(res.status).toBe(409);
    expect(await env.CAPSULE_MANIFESTS.get(capsuleId)).toBe(
      JSON.stringify(existingManifest)
    );
  });

  it("EXISTING MANIFEST CANNOT BE OVERWRITTEN: second seal attempt leaves manifest unchanged", async () => {
    const capsuleId = "a".repeat(64);
    const original = validManifest(
      capsuleId,
      "a".repeat(43),
      Date.now(),
      Date.now() + 1000,
      1024
    );
    const overwrite = validManifest(
      capsuleId,
      "b".repeat(43),
      Date.now(),
      Date.now() + 1000,
      2048
    );

    const env = buildSealEnv();
    await env.CAPSULE_MANIFESTS.put(capsuleId, JSON.stringify(original));

    const body = {
      uploadToken: "a".repeat(32),
      manifest: overwrite,
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);

    expect(res.status).toBe(409);
    expect(await env.CAPSULE_MANIFESTS.get(capsuleId)).toBe(
      JSON.stringify(original)
    );
  });

  it("AUTHORITY MUST NOT BE INCORRECTLY REPLACED: conflicting seal does not alter authority tokens", async () => {
    const capsuleId = "a".repeat(64);
    const original = validManifest(
      capsuleId,
      "a".repeat(43),
      Date.now(),
      Date.now() + 1000,
      1024
    );
    const conflicting = validManifest(
      capsuleId,
      "b".repeat(43),
      Date.now(),
      Date.now() + 1000,
      2048
    );

    const env = buildSealEnv();
    await env.CAPSULE_MANIFESTS.put(capsuleId, JSON.stringify(original));
    await env.AUTHORITY_TOKENS.put(
      capsuleId,
      JSON.stringify({ fragment: "original-fragment" })
    );

    const body = {
      uploadToken: "a".repeat(32),
      manifest: conflicting,
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);

    expect(res.status).toBe(409);
    expect(await env.AUTHORITY_TOKENS.get(capsuleId)).toBe(
      JSON.stringify({ fragment: "original-fragment" })
    );
  });

  it("UPLOAD AUTHORIZATION: rejects empty upload token", async () => {
    const body = {
      uploadToken: "",
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(buildSealEnv(), body);
    const res = await sealPost(context);
    expect(res.status).toBe(400);
  });

  it("UPLOAD AUTHORIZATION: rejects token with mismatched permissions", async () => {
    const env = buildSealEnv();
    const token = "a".repeat(32);
    env.UPLOAD_TOKENS.put(
      token,
      JSON.stringify({ canonicalLifecycleId: "lifecycle-1", creatorIdentityId: "creator-1", permissions: { uploadVault: false } })
    );

    const body = {
      uploadToken: token,
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);
    expect(res.status).toBe(403);
  });

  it("PAYMENT AUTHORIZATION: rejects when verified payment is missing", async () => {
    const env = buildSealEnv();
    const uploadToken = "a".repeat(32);
    env.UPLOAD_TOKENS.put(
      uploadToken,
      JSON.stringify({
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-1",
        permissions: { uploadVault: true },
      })
    );

    const body = {
      uploadToken,
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);
    expect(res.status).toBe(402);
  });

  it("PAYMENT AUTHORIZATION: rejects invalid payment record", async () => {
    const env = buildSealEnv();
    const evidenceId = "evidence-1";
    env.VERIFIED_PAYMENTS.put(`payment-intent:intent-1:latest`, evidenceId);
    env.VERIFIED_PAYMENTS.put(
      `verified-payment:intent-1:${evidenceId}`,
      JSON.stringify({ ok: false })
    );

    const uploadToken = "a".repeat(32);
    env.UPLOAD_TOKENS.put(
      uploadToken,
      JSON.stringify({
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-1",
        paymentIntentId: "intent-1",
        permissions: { uploadVault: true },
      })
    );

    const body = {
      uploadToken,
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);
    expect(res.status).toBe(402);
  });

  it("PAYMENT AUTHORIZATION: rejects expired payment", async () => {
    const env = buildSealEnv();
    const evidenceId = "evidence-1";
    seedVerifiedPayment(env.VERIFIED_PAYMENTS, "intent-1", evidenceId, Date.now() - 1000);

    const uploadToken = seedUploadToken(
      env.UPLOAD_TOKENS,
      "intent-1",
      "lifecycle-1",
      "creator-1",
      "a".repeat(32)
    );

    const body = {
      uploadToken,
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);
    expect(res.status).toBe(402);
  });

  it("FAIL-CLOSED: rejects when CAPSULE_MANIFESTS binding missing", async () => {
    const body = {
      uploadToken: "a".repeat(32),
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(
      {
        ...buildSealEnv(),
        CAPSULE_MANIFESTS: undefined,
      },
      body
    );
    const res = await sealPost(context);
    expect(res.status).toBe(503);
  });

  it("FAIL-CLOSED: rejects malformed JSON body", async () => {
    const request = createFakeRequest({
      headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      body: "not-json",
    });
    request.json = async () => {
      throw new Error("parse");
    };

    const context = makeEventContext({
      request,
      env: buildSealEnv(),
    });

    const res = await sealPost(context);
    expect(res.status).toBe(400);
  });

  it("FAIL-CLOSED: rejects invalid origin", async () => {
    const body = {
      uploadToken: "a".repeat(32),
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const request = createFakeRequest({
      headers: { origin: "https://evil.example.com", "content-type": "application/json" },
      body,
    });

    const context = makeEventContext({
      request,
      env: buildSealEnv(),
    });

    const res = await sealPost(context);
    expect(res.status).toBe(403);
  });

  it("FAIL-CLOSED: rejects invalid creatorAuthorityFragment", async () => {
    const body = {
      uploadToken: "a".repeat(32),
      manifest: validManifest("a".repeat(64), "a".repeat(43), Date.now(), Date.now() + 1000, 1024),
      creatorAuthorityFragment: "not-a-fragment",
    };

    const context = buildSealContext(buildSealEnv(), body);
    const res = await sealPost(context);
    expect(res.status).toBe(400);
  });

  it("SEAL-ONCE INVARIANT: after successful seal, retry same manifest returns 200 and different returns 409", async () => {
    stubVaultFetch();

    const capsuleId = "a".repeat(64);
    const vaultTxId = "a".repeat(43);
    const sealedAt = Date.now();
    const openAt = sealedAt + 1000;
    const encryptedSizeBytes = 1024;
    const manifest = validManifest(
      capsuleId,
      vaultTxId,
      sealedAt,
      openAt,
      encryptedSizeBytes
    );
    const normalized = JSON.stringify(
      Object.keys(manifest).sort().reduce((acc, key) => {
        acc[key] = manifest[key as keyof typeof manifest];
        return acc;
      }, {} as typeof manifest)
    );
    const evidenceId = "evidence-1";

    const env = buildSealEnv({
      PUBLICATION_VERIFICATIONS: createFakeKV(),
    });
    env.PUBLICATION_VERIFICATIONS!.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId,
        creatorIdentityId: "creator-1",
        state: "VERIFIED",
        expectedTxId: vaultTxId,
        expectedVaultSha256: manifest.ext.vaultSha256,
        evidenceIds: [vaultTxId],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        verifiedAt: Date.now(),
      })
    );
    seedVerifiedPayment(env.VERIFIED_PAYMENTS, "intent-1", evidenceId, Date.now() + 60_000);
    const uploadToken = seedUploadToken(
      env.UPLOAD_TOKENS,
      "intent-1",
      "lifecycle-1",
      "creator-1",
      "a".repeat(32)
    );

    const body = {
      uploadToken,
      manifest,
      creatorAuthorityFragment: "a".repeat(64),
    };

    function makeContext() {
      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body,
      });
      return makeEventContext({
        request,
        env,
      });
    }

    const first = await sealPost(makeContext());
    expect(first.status).toBe(200);

    const retry = await sealPost(makeContext());
    expect(retry.status).toBe(200);

    const conflictingBody = {
      uploadToken,
      manifest: validManifest(capsuleId, "b".repeat(43), sealedAt, openAt, encryptedSizeBytes),
      creatorAuthorityFragment: "a".repeat(64),
    };

    const conflictingRequest = createFakeRequest({
      headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      body: conflictingBody,
    });

    const conflictingContext = makeEventContext({
      request: conflictingRequest,
      env,
    });

    const conflict = await sealPost(conflictingContext);
    expect(conflict.status).toBe(409);

    expect(await env.CAPSULE_MANIFESTS.get(capsuleId)).toBe(normalized);
  });
});
