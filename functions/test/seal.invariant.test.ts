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

/**
 * F-2 — expected server-side authority digest for a fragment.
 * Mirrors the canonical seal.ts write: SHA-256 over the UTF-8 bytes.
 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
    `payment-intent:${paymentIntentId}`,
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

    /**
     * F-2 — the authority token is persisted as a SHA-256 DIGEST of the
     * fragment, never as the plaintext fragment.
     */
    const storedAuthority = await env.AUTHORITY_TOKENS.get(capsuleId);
    expect(storedAuthority).toBe(
      JSON.stringify({
        digest: await sha256Hex(creatorAuthorityFragment),
      })
    );
    expect(storedAuthority).not.toContain(creatorAuthorityFragment);

    expect(await env.VERIFIED_PAYMENTS.get(`verified-payment:${paymentIntentId}:${evidenceId}`)).toBeNull();
    expect(await env.VERIFIED_PAYMENTS.get(`payment-intent:${paymentIntentId}`)).toBeNull();
    expect(await env.UPLOAD_TOKENS.get(uploadToken)).toBeNull();
  });

  /**
   * Regression: the active Irys-on-Solana rail returns a 44-char base58
   * data-item id. A file-local copy of the pointer regex lived in
   * seal.ts at exact-{43} and validated `manifest.vaultTxId` with it,
   * so every real seal was rejected with INVALID_MANIFEST — after the
   * creator had already paid. The manifest gate now anchors to the
   * canonical STORAGE_POINTER_REGEX from the registry, which accepts
   * both encodings of the same 32-byte id.
   */
  it("ACCEPTS a 44-char base58 Irys vaultTxId (registry-anchored pointer gate)", async () => {
    stubVaultFetch();

    const capsuleId = "a".repeat(64);
    // The exact id captured from a real production Irys-on-Solana upload.
    const vaultTxId = "4M2b1xjKeoE11NbkGCLo4HsuvDQHuQqTyLrKnRLSDQZw";
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
    const paymentIntentId = "intent-44";
    const evidenceId = "evidence-44";

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

    const res = await sealPost(
      buildSealContext(env, { uploadToken, manifest, creatorAuthorityFragment })
    );

    expect(res.status).toBe(200);

    // Persisted verbatim — the pointer is opaque and is never re-encoded.
    const stored = await env.CAPSULE_MANIFESTS.get(capsuleId);
    expect(JSON.parse(stored!).vaultTxId).toBe(vaultTxId);
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
    // F-2 — the persisted authority record is a digest, not a fragment.
    const originalAuthority = JSON.stringify({
      digest: await sha256Hex("original-fragment"),
    });
    await env.AUTHORITY_TOKENS.put(capsuleId, originalAuthority);

    const body = {
      uploadToken: "a".repeat(32),
      manifest: conflicting,
      creatorAuthorityFragment: "a".repeat(64),
    };

    const context = buildSealContext(env, body);
    const res = await sealPost(context);

    expect(res.status).toBe(409);
    expect(await env.AUTHORITY_TOKENS.get(capsuleId)).toBe(
      originalAuthority
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
    env.VERIFIED_PAYMENTS.put(`payment-intent:intent-1`, evidenceId);
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

  it("PAYMENT AUTHORITY: absent intent->evidence pointer fails closed", async () => {
    const env = buildSealEnv();
    // The verified payment record exists, but the canonical intent->evidence
    // pointer does NOT. Seal must not guess which evidence belongs to the
    // intent, and must fail closed.
    env.VERIFIED_PAYMENTS.put(
      `verified-payment:intent-1:evidence-1`,
      JSON.stringify({
        ok: true,
        paymentIntentId: "intent-1",
        transactionId: "evidence-1",
        expiresAt: Date.now() + 60_000,
      })
    );
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

    const res = await sealPost(buildSealContext(env, body));
    expect(res.status).toBe(402);
  });

  it("PAYMENT AUTHORITY: mismatched intent->evidence pointer fails closed", async () => {
    const env = buildSealEnv();
    // The pointer names evidence-other, but only evidence-1 exists for this
    // intent: a substituted pointer must not resolve to a valid payment.
    env.VERIFIED_PAYMENTS.put(`payment-intent:intent-1`, "evidence-other");
    env.VERIFIED_PAYMENTS.put(
      `verified-payment:intent-1:evidence-1`,
      JSON.stringify({
        ok: true,
        paymentIntentId: "intent-1",
        transactionId: "evidence-1",
        expiresAt: Date.now() + 60_000,
      })
    );
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

    const res = await sealPost(buildSealContext(env, body));
    expect(res.status).toBe(402);
  });

  it("PAYMENT AUTHORITY: successful verification authorizes seal even with NO Business Quote", async () => {
    stubVaultFetch();

    const capsuleId = "a".repeat(64);
    const vaultTxId = "a".repeat(43);
    const sealedAt = Date.now();
    const openAt = sealedAt + 1000;
    const manifest = validManifest(capsuleId, vaultTxId, sealedAt, openAt, 1024);
    const paymentIntentId = "intent-1";
    const evidenceId = "evidence-1";

    const env = buildSealEnv({ PUBLICATION_VERIFICATIONS: createFakeKV() });
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

    // BUSINESS_QUOTES is deliberately left EMPTY. The Business Quote TTL gates
    // payment verification only; a later quote expiry (or its complete
    // absence) must NOT invalidate the VerifiedPayment / Credit / seal
    // authority.
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
      creatorAuthorityFragment: "a".repeat(64),
    };

    const res = await sealPost(buildSealContext(env, body));
    expect(res.status).toBe(200);
    expect(await env.CAPSULE_MANIFESTS.get(capsuleId)).toBeTruthy();
  });

  it("HEARTBEAT UNITS: server accepts canonical milliseconds and rejects minutes", async () => {
    // 1. Canonical MILLISECONDS (1 day) is accepted end-to-end.
    {
      stubVaultFetch();

      const capsuleId = "a".repeat(64);
      const vaultTxId = "a".repeat(43);
      const sealedAt = Date.now();
      const manifest = validManifest(capsuleId, vaultTxId, sealedAt, sealedAt + 1000, 1024);
      expect(manifest.heartbeatInterval).toBe(86_400_000);

      const env = buildSealEnv({ PUBLICATION_VERIFICATIONS: createFakeKV() });
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
        "intent-1",
        "evidence-1",
        Date.now() + 60_000
      );
      const uploadToken = seedUploadToken(
        env.UPLOAD_TOKENS,
        "intent-1",
        "lifecycle-1",
        "creator-1",
        "a".repeat(32)
      );

      const res = await sealPost(
        buildSealContext(env, {
          uploadToken,
          manifest,
          creatorAuthorityFragment: "a".repeat(64),
        })
      );
      expect(res.status).toBe(200);
      expect(await env.CAPSULE_MANIFESTS.get(capsuleId)).toBeTruthy();
    }

    // 2. The pre-fix MINUTES shape (7 days -> 10080) is rejected fail-closed.
    {
      const capsuleId = "a".repeat(64);
      const vaultTxId = "a".repeat(43);
      const sealedAt = Date.now();
      const manifest = {
        ...validManifest(capsuleId, vaultTxId, sealedAt, sealedAt + 1000, 1024),
        heartbeatInterval: 10080,
      };

      const env = buildSealEnv();
      const uploadToken = seedUploadToken(
        env.UPLOAD_TOKENS,
        "intent-1",
        "lifecycle-1",
        "creator-1",
        "a".repeat(32)
      );

      const res = await sealPost(
        buildSealContext(env, {
          uploadToken,
          manifest,
          creatorAuthorityFragment: "a".repeat(64),
        })
      );

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe(
        "INVALID_HEARTBEAT"
      );
      expect(await env.CAPSULE_MANIFESTS.get(capsuleId)).toBeNull();
    }
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

/**
 * Grammar boundaries for the two grammars the seal endpoint validates:
 * the storage pointer (`manifest.vaultTxId`) and the upload token.
 *
 * Both are now anchored to the canonical registry in
 * src/lib/crypto/validators — the endpoint no longer defines local
 * copies. These tests pin the exact accepted/rejected boundary of each,
 * which previously had no coverage: the suite only ever used a 43-char
 * `vaultTxId` and a 32-char token, which is why a stale exact-{43} copy
 * could reject every real Irys id undetected.
 *
 * Gate order matters for the rejection cases: the token FORMAT check
 * (seal.ts INVALID_UPLOAD_TOKEN) runs BEFORE the manifest checks, and the
 * token KV lookup runs AFTER them — so a format rejection never reaches
 * the manifest gate, and a manifest rejection never needs the token
 * seeded.
 */
describe("Seal grammar boundaries (storage pointer + upload token)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The exact id captured from a real production Irys-on-Solana upload. */
  const REAL_IRYS_ID = "4M2b1xjKeoE11NbkGCLo4HsuvDQHuQqTyLrKnRLSDQZw";
  /** A real upload token as issued by upload-token.ts (32 bytes → 43 base64url). */
  const GENERATED_TOKEN = "dMGA14uqIwoKA9Nnh8x5AsLmpIyvaelCf29Lkzu6s5o";
  const CAPSULE_ID = "a".repeat(64);
  const AUTHORITY_FRAGMENT = "a".repeat(64);
  const PAYMENT_INTENT = "intent-boundary";
  const EVIDENCE = "evidence-boundary";

  /**
   * Drives a complete seal with the given token + vaultTxId.
   *
   * `seedAuthority = false` skips the publication / payment / token-KV
   * seeding. That is correct for the format-rejection cases, whose gates
   * all fire before any KV lookup.
   */
  async function sealWith(
    token: string,
    vaultTxId: string,
    seedAuthority = true
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "content-length": "1024" },
        })
      )
    );

    const sealedAt = Date.now();
    const manifest = validManifest(
      CAPSULE_ID,
      vaultTxId,
      sealedAt,
      sealedAt + 1000,
      1024
    );

    const env = buildSealEnv({ PUBLICATION_VERIFICATIONS: createFakeKV() });

    if (seedAuthority) {
      env.PUBLICATION_VERIFICATIONS!.put(
        `creator:publication:lifecycle-1`,
        JSON.stringify({
          lifecycleId: "lifecycle-1",
          capsuleId: CAPSULE_ID,
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
        PAYMENT_INTENT,
        EVIDENCE,
        Date.now() + 60_000
      );
      seedUploadToken(
        env.UPLOAD_TOKENS,
        PAYMENT_INTENT,
        "lifecycle-1",
        "creator-1",
        token
      );
    }

    const res = await sealPost(
      buildSealContext(env, {
        uploadToken: token,
        manifest,
        creatorAuthorityFragment: AUTHORITY_FRAGMENT,
      })
    );

    return { res, env };
  }

  /* ─────────── A. storage pointer (manifest.vaultTxId) ─────────── */

  it("A1. accepts the 43-char canonical base64url vaultTxId", async () => {
    const canonical = "V".repeat(43);
    const { res, env } = await sealWith(GENERATED_TOKEN, canonical);

    expect(res.status).toBe(200);
    const stored = await env.CAPSULE_MANIFESTS.get(CAPSULE_ID);
    expect(JSON.parse(stored!).vaultTxId).toBe(canonical);
  });

  it("A2. accepts the real 44-char base58 Irys vaultTxId and persists it verbatim", async () => {
    const { res, env } = await sealWith(GENERATED_TOKEN, REAL_IRYS_ID);

    expect(res.status).toBe(200);
    const stored = await env.CAPSULE_MANIFESTS.get(CAPSULE_ID);
    // Verbatim: the pointer is opaque and is never re-encoded.
    expect(JSON.parse(stored!).vaultTxId).toBe(REAL_IRYS_ID);
  });

  it("A3. rejects a 42-char vaultTxId", async () => {
    const { res } = await sealWith(GENERATED_TOKEN, "V".repeat(42), false);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_MANIFEST");
  });

  it("A4. rejects a 45-char vaultTxId", async () => {
    const { res } = await sealWith(GENERATED_TOKEN, "V".repeat(45), false);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_MANIFEST");
  });

  it("A5. rejects vaultTxId characters outside [A-Za-z0-9_-]", async () => {
    for (const bad of [`${"V".repeat(42)}+`, `${"V".repeat(43)}!`, `${"V".repeat(42)}=`]) {
      const { res } = await sealWith(GENERATED_TOKEN, bad, false);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_MANIFEST");
    }
  });

  /* ─────────── B. upload token ─────────── */

  it("B1. accepts a 32-char token (contract lower bound)", async () => {
    const { res } = await sealWith("a".repeat(32), "V".repeat(43));
    expect(res.status).toBe(200);
  });

  it("B2. accepts a real generated token (32 bytes → 43 base64url chars)", async () => {
    expect(GENERATED_TOKEN).toHaveLength(43);
    const { res } = await sealWith(GENERATED_TOKEN, "V".repeat(43));
    expect(res.status).toBe(200);
  });

  it("B3. accepts a 256-char token (contract upper bound)", async () => {
    const { res } = await sealWith("a".repeat(256), "V".repeat(43));
    expect(res.status).toBe(200);
  });

  it("B4. rejects a 257-char token (above the contract upper bound)", async () => {
    const { res } = await sealWith("a".repeat(257), "V".repeat(43), false);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_UPLOAD_TOKEN");
  });

  it("B5. rejects malformed token characters", async () => {
    for (const bad of [`${"a".repeat(31)}+`, `${"a".repeat(31)}!`, "a".repeat(31) + " "]) {
      const { res } = await sealWith(bad, "V".repeat(43), false);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_UPLOAD_TOKEN");
    }
  });

  it("B6. rejects a 31-char token (below the contract lower bound)", async () => {
    const { res } = await sealWith("a".repeat(31), "V".repeat(43), false);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_UPLOAD_TOKEN");
  });

  it("B7. the existing valid token flow still seals (regression guard)", async () => {
    // Mirrors the original FIRST SEAL SUCCEEDS shape: 32-char token,
    // 43-char pointer — must remain accepted end-to-end.
    const { res, env } = await sealWith("a".repeat(32), "V".repeat(43));
    expect(res.status).toBe(200);
    expect(await env.CAPSULE_MANIFESTS.get(CAPSULE_ID)).toBeTruthy();
  });
});
