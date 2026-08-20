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

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "pub-1",
    });

    const res = await publicationVerifyPost(context);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("REJECTED");
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

    const body = {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
      publicationId: "pub-1",
    };

    const first = await publicationVerifyPost(buildContext(env, body));
    expect(first.status).toBe(200);

    const second = await publicationVerifyPost(buildContext(env, body));
    expect(second.status).toBe(200);
    expect((await second.json()).state).toBe("REJECTED");
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
});
