import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as publicationVerifyPost } from "./../api/publication/verify";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface PublicationVerifyEnv {
  CREATOR_CREDITS: ReturnType<typeof createFakeKV>;
  PUBLICATION_VERIFICATIONS: ReturnType<typeof createFakeKV>;
}

function buildEnv(overrides?: Partial<PublicationVerifyEnv>): PublicationVerifyEnv {
  return {
    CREATOR_CREDITS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    ...overrides,
  };
}

function buildContext(env: PublicationVerifyEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

describe("Publication verification boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("REJECTS when provider cannot verify publication", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const mock = vi.fn().mockRejectedValue(new Error("gateway unreachable"));
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(502);
    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    const stored = JSON.parse(storedRaw!) as { state: string };
    expect(stored.state).toBe("PENDING");
  });

  it("is idempotent for same lifecycle", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const mock = vi.fn().mockRejectedValue(new Error("gateway unreachable"));
    vi.stubGlobal("fetch", mock);

    const body = {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    };

    const first = await publicationVerifyPost(buildContext(env, body));
    expect(first.status).toBe(502);

    const second = await publicationVerifyPost(buildContext(env, body));
    expect(second.status).toBe(502);
    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    const stored = JSON.parse(storedRaw!) as { state: string };
    expect(stored.state).toBe("PENDING");
  });

  it("REJECTS when lifecycle is not reserved", async () => {
    const env = buildEnv();
    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "pub-1",
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(409);
  });

  it("REJECTS when Credit is not CONSUMING", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "AVAILABLE",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "pub-1",
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(409);
  });

  it("REJECTS verification when no publication record exists", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "pub-1",
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PUBLICATION_NOT_CLAIMED");
  });

  it("VERIFIES PENDING publication using authoritative expectedTxId and server-computed hash", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const payloadText = "ciphertext-bytes";
    const payloadBytes = new TextEncoder().encode(payloadText);
    const computedHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", payloadBytes)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const mock = vi.fn().mockResolvedValue(
      new Response(payloadText, {
        status: 200,
        headers: { "content-length": String(payloadBytes.byteLength) },
      })
    );
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state).toBe("VERIFIED");
    expect(json.expectedTxId).toBe(authoritativeTxId);
    expect(json.expectedVaultSha256).toBe(computedHash);

    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    expect(storedRaw).toBeTruthy();
    const stored = JSON.parse(storedRaw!) as { state: string; expectedTxId: string; expectedVaultSha256: string };
    expect(stored.state).toBe("VERIFIED");
    expect(stored.expectedTxId).toBe(authoritativeTxId);
    expect(stored.expectedVaultSha256).toBe(computedHash);
  });

  it("REJECTS foreign client publicationId when it does not match authoritative expectedTxId", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const mock = vi.fn().mockResolvedValue(
      new Response("ciphertext", {
        status: 200,
        headers: { "content-length": "10" },
      })
    );
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "foreign-tx-1",
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(409);
  });

  it("REJECTS on gateway 404 and keeps publication record unchanged", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const mock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(409);

    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    const stored = JSON.parse(storedRaw!) as { state: string };
    expect(stored.state).toBe("REJECTED");
  });

  it("PRESERVES PENDING on gateway timeout/transport failure", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const mock = vi.fn().mockRejectedValue(new Error("network timeout"));
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(502);

    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    const stored = JSON.parse(storedRaw!) as { state: string };
    expect(stored.state).toBe("PENDING");
  });

  it("PRESERVES PENDING on gateway 5xx", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const mock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(502);

    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    const stored = JSON.parse(storedRaw!) as { state: string };
    expect(stored.state).toBe("PENDING");
  });

  it("REJECTS empty body response and marks record REJECTED", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const mock = vi.fn().mockResolvedValue(
      new Response("", {
        status: 200,
        headers: { "content-length": "0" },
      })
    );
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(409);

    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    const stored = JSON.parse(storedRaw!) as { state: string };
    expect(stored.state).toBe("REJECTED");
  });

  it("RETURNS existing VERIFIED record and does not mutate it", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "VERIFIED",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: "existing-hash",
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
        verifiedAt: now,
      })
    );

    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "any-tx",
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state).toBe("VERIFIED");
    expect(json.expectedTxId).toBe(authoritativeTxId);
    expect(json.expectedVaultSha256).toBe("existing-hash");

    expect(mock).not.toHaveBeenCalled();
  });

  it("RETURNS existing REJECTED record and does not mutate it", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "REJECTED",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
        rejectedAt: now,
      })
    );

    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "any-tx",
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state).toBe("REJECTED");

    expect(mock).not.toHaveBeenCalled();
  });

  it("COMPUTES exact SHA-256 for known ciphertext and stores it as expectedVaultSha256", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        capsuleId: "capsule-1",
      })
    );

    const authoritativeTxId = "authoritative-tx-1";
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:lifecycle-1`,
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        creatorIdentityId: "creator-1",
        state: "PENDING",
        expectedTxId: authoritativeTxId,
        expectedVaultSha256: null,
        evidenceIds: [authoritativeTxId],
        createdAt: now,
        updatedAt: now,
      })
    );

    const knownPayload = new TextEncoder().encode("hello world");
    const expectedHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", knownPayload)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const mock = vi.fn().mockResolvedValue(
      new Response(knownPayload, {
        status: 200,
        headers: { "content-length": String(knownPayload.byteLength) },
      })
    );
    vi.stubGlobal("fetch", mock);

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: authoritativeTxId,
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state).toBe("VERIFIED");
    expect(json.expectedVaultSha256).toBe(expectedHash);

    const storedRaw = await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:lifecycle-1`);
    const stored = JSON.parse(storedRaw!) as { expectedVaultSha256: string };
    expect(stored.expectedVaultSha256).toBe(expectedHash);
  });
});
