import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";
import { onRequestPost as uploadTokenPost } from "./../api/upload-token";

vi.mock("./../lib/executorHot", () => ({
  assertExecutorHasBalance: vi.fn().mockResolvedValue(undefined),
  getExecutorAddress: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000000"),
  ExecutorUnavailableError: class extends Error {},
}));

const ORIGIN = "https://aeterna-solana-btt.pages.dev";

describe("Upload token boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("REJECTS when lifecycle credit is missing", async () => {
    const credits = createFakeKV();
    const tokens = createFakeKV();
    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: {
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-1",
      },
    });

    const ctx = makeEventContext({ request, env: { CREATOR_CREDITS: credits, UPLOAD_TOKENS: tokens } });
    const res = await uploadTokenPost(ctx);
    expect(res.status).toBe(403);
  });

  it("REJECTS when credit is not CONSUMING", async () => {
    const credits = createFakeKV();
    const tokens = createFakeKV();
    await credits.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "AVAILABLE",
        creatorIdentityId: "creator-1",
        paymentIntentId: "intent-1",
      })
    );

    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: {
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-1",
      },
    });

    const ctx = makeEventContext({ request, env: { CREATOR_CREDITS: credits, UPLOAD_TOKENS: tokens } });
    const res = await uploadTokenPost(ctx);
    expect(res.status).toBe(403);
  });

  it("REJECTS wrong creator identity", async () => {
    const credits = createFakeKV();
    const tokens = createFakeKV();
    await credits.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        paymentIntentId: "intent-1",
      })
    );

    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: {
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-other",
      },
    });

    const ctx = makeEventContext({ request, env: { CREATOR_CREDITS: credits, UPLOAD_TOKENS: tokens } });
    const res = await uploadTokenPost(ctx);
    expect(res.status).toBe(403);
  });

  it("REJECTS mismatched paymentIntentId when supplied", async () => {
    const credits = createFakeKV();
    const tokens = createFakeKV();
    await credits.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        paymentIntentId: "intent-1",
      })
    );

    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: {
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-1",
        paymentIntentId: "intent-other",
      },
    });

    const ctx = makeEventContext({ request, env: { CREATOR_CREDITS: credits, UPLOAD_TOKENS: tokens } });
    const res = await uploadTokenPost(ctx);
    expect(res.status).toBe(403);
  });

  it("ISSUES upload token without paymentIntentId runtime authorization input", async () => {
    const credits = createFakeKV();
    const tokens = createFakeKV();
    await credits.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        paymentIntentId: "intent-1",
      })
    );

    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: {
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-1",
      },
    });

    const ctx = makeEventContext({ request, env: { CREATOR_CREDITS: credits, UPLOAD_TOKENS: tokens } });
    const res = await uploadTokenPost(ctx);
    expect(res.status).toBe(200);

    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(typeof payload.uploadToken).toBe("string");
  });

  it("REJECTS unknown origin", async () => {
    const credits = createFakeKV();
    const tokens = createFakeKV();
    await credits.put(
      "creator:credit:lifecycle:creator-1:lifecycle-1",
      JSON.stringify({
        id: "credit-1",
        status: "CONSUMING",
        creatorIdentityId: "creator-1",
        paymentIntentId: "intent-1",
      })
    );

    const request = createFakeRequest({
      headers: { origin: "https://unknown.example", "content-type": "application/json" },
      body: {
        canonicalLifecycleId: "lifecycle-1",
        creatorIdentityId: "creator-1",
      },
    });

    const ctx = makeEventContext({ request, env: { CREATOR_CREDITS: credits, UPLOAD_TOKENS: tokens } });
    const res = await uploadTokenPost(ctx);
    expect(res.status).toBe(403);
  });
});
