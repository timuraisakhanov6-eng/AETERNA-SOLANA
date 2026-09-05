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


type NodeRoute = { status: number; body?: Record<string, unknown>; reject?: Error };

/**
 * Routes stubbed fetch: node1.irys.xyz requests hit the configured
 * Node response; every other URL (gateways) falls through to the
 * gateway mock.
 */
function stubNodeAndGateway(
  mock: ReturnType<typeof vi.fn>,
  node: NodeRoute,
): void {
  const routing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://node1.irys.xyz/")) {
      if (node.reject) throw node.reject;
      return new Response(JSON.stringify(node.body ?? { id: "authoritative-tx-1" }), {
        status: node.status,
        headers: { "content-type": "application/json" },
      });
    }
    return mock(input as RequestInfo, init);
  });
  vi.stubGlobal("fetch", routing);
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
    stubNodeAndGateway(mock, { status: 200, reject: new Error("node unreachable") });

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
    stubNodeAndGateway(mock, { status: 200, reject: new Error("node unreachable") });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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
    stubNodeAndGateway(mock, { status: 200 });

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

  it("Node 404 marks the publication REJECTED without consulting gateways", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({ id: "credit-1", status: "CONSUMING", creatorIdentityId: "creator-1", capsuleId: "capsule-1" })
    );
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", creatorIdentityId: "creator-1", state: "PENDING", expectedTxId: "authoritative-tx-1", expectedVaultSha256: null, evidenceIds: ["authoritative-tx-1"], createdAt: now, updatedAt: now })
    );

    const gatewayMock = vi.fn();
    stubNodeAndGateway(gatewayMock, { status: 404 });

    const res = await publicationVerifyPost(buildContext(env, { creatorIdentityId: "creator-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PUBLICATION_NOT_CONFIRMED");
    expect(gatewayMock).not.toHaveBeenCalled();
    const stored = JSON.parse((await env.PUBLICATION_VERIFICATIONS.get("creator:publication:lifecycle-1"))!) as { state: string };
    expect(stored.state).toBe("REJECTED");
  });

  it("Node 5xx keeps PENDING and returns retryable 502", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({ id: "credit-1", status: "CONSUMING", creatorIdentityId: "creator-1", capsuleId: "capsule-1" })
    );
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", creatorIdentityId: "creator-1", state: "PENDING", expectedTxId: "authoritative-tx-1", expectedVaultSha256: null, evidenceIds: ["authoritative-tx-1"], createdAt: now, updatedAt: now })
    );

    stubNodeAndGateway(vi.fn(), { status: 503 });

    const res = await publicationVerifyPost(buildContext(env, { creatorIdentityId: "creator-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" }));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("PUBLICATION_NODE_UNAVAILABLE");
    const stored = JSON.parse((await env.PUBLICATION_VERIFICATIONS.get("creator:publication:lifecycle-1"))!) as { state: string };
    expect(stored.state).toBe("PENDING");
  });

  it("Node network failure keeps PENDING and returns retryable 502", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({ id: "credit-1", status: "CONSUMING", creatorIdentityId: "creator-1", capsuleId: "capsule-1" })
    );
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", creatorIdentityId: "creator-1", state: "PENDING", expectedTxId: "authoritative-tx-1", expectedVaultSha256: null, evidenceIds: ["authoritative-tx-1"], createdAt: now, updatedAt: now })
    );

    stubNodeAndGateway(vi.fn(), { status: 200, reject: new Error("node unreachable") });

    const res = await publicationVerifyPost(buildContext(env, { creatorIdentityId: "creator-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" }));

    expect(res.status).toBe(502);
    const stored = JSON.parse((await env.PUBLICATION_VERIFICATIONS.get("creator:publication:lifecycle-1"))!) as { state: string };
    expect(stored.state).toBe("PENDING");
  });

  it("Node body id mismatch fails closed as UNAVAILABLE (never VERIFIED)", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({ id: "credit-1", status: "CONSUMING", creatorIdentityId: "creator-1", capsuleId: "capsule-1" })
    );
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", creatorIdentityId: "creator-1", state: "PENDING", expectedTxId: "authoritative-tx-1", expectedVaultSha256: null, evidenceIds: ["authoritative-tx-1"], createdAt: now, updatedAt: now })
    );

    stubNodeAndGateway(vi.fn(), { status: 200, body: { id: "some-other-tx" } });

    const res = await publicationVerifyPost(buildContext(env, { creatorIdentityId: "creator-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" }));

    expect(res.status).toBe(502);
    const stored = JSON.parse((await env.PUBLICATION_VERIFICATIONS.get("creator:publication:lifecycle-1"))!) as { state: string };
    expect(stored.state).toBe("PENDING");
    expect(stored.expectedVaultSha256).toBeNull();
  });

  it("Node-confirmed tx with gateways unavailable stays PENDING (gateway cannot be skipped)", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({ id: "credit-1", status: "CONSUMING", creatorIdentityId: "creator-1", capsuleId: "capsule-1" })
    );
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", creatorIdentityId: "creator-1", state: "PENDING", expectedTxId: "authoritative-tx-1", expectedVaultSha256: null, evidenceIds: ["authoritative-tx-1"], createdAt: now, updatedAt: now })
    );

    const mock = vi.fn().mockRejectedValue(new Error("gateway unreachable"));
    stubNodeAndGateway(mock, { status: 200 });

    const res = await publicationVerifyPost(buildContext(env, { creatorIdentityId: "creator-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1" }));

    expect(res.status).toBe(502);
    const stored = JSON.parse((await env.PUBLICATION_VERIFICATIONS.get("creator:publication:lifecycle-1"))!) as { state: string };
    expect(stored.state).toBe("PENDING");
  });

  it("forged client txId never reaches Node lookup as authority (409 before Node)", async () => {
    const env = buildEnv();
    await env.CREATOR_CREDITS.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({ id: "credit-1", status: "CONSUMING", creatorIdentityId: "creator-1", capsuleId: "capsule-1" })
    );
    const now = Date.now();
    await env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", creatorIdentityId: "creator-1", state: "PENDING", expectedTxId: "authoritative-tx-1", expectedVaultSha256: null, evidenceIds: ["authoritative-tx-1"], createdAt: now, updatedAt: now })
    );

    const mock = vi.fn();
    const routing = vi.fn(async (input: RequestInfo | URL) => {
      // Even if the node WOULD confirm the forged tx, the lookup must
      // use the server-owned expectedTxId — assert that here.
      if (String(input).startsWith("https://node1.irys.xyz/")) {
        expect(String(input)).toBe("https://node1.irys.xyz/tx/authoritative-tx-1");
        return new Response(JSON.stringify({ id: "authoritative-tx-1" }), { status: 200 });
      }
      return mock(input as RequestInfo);
    });
    vi.stubGlobal("fetch", routing);

    const res = await publicationVerifyPost(buildContext(env, { creatorIdentityId: "creator-1", lifecycleId: "lifecycle-1", capsuleId: "capsule-1", publicationId: "forged-tx" }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PUBLICATION_ID_MISMATCH");
  });
});
