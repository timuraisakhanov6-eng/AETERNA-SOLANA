import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createBusinessQuote } from "./../lib/business/businessQuoteStore";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";
import { onRequestPost as uploadTokenPost } from "./../api/upload-token";
import { onRequestPost as servicePaymentVerifyPost } from "./../api/service-payment/verify";

/* Targeted mock for Executor Hot.
 *
 * upload-token success path requires getExecutorAddress() and
 * assertExecutorHasBalance(). Both currently require secrets/network,
 * so we replace them with deterministic no-op implementations for this
 * test file only.
 */
vi.mock("./../lib/executorHot", () => ({
  assertExecutorHasBalance: vi.fn().mockResolvedValue(undefined),
  getExecutorAddress: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000000"),
  ExecutorUnavailableError: class extends Error {},
}));

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

async function seedBusinessQuote(
  kv: ReturnType<typeof createFakeKV>,
  capsuleId: string,
  expectedAmount = 1,
  currency = "USD"
) {
  await createBusinessQuote(kv, {
    capsuleId,
    billableSizeBytes: 1024,
    expectedAmount,
    currency,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
}

interface ServicePaymentEnv {
  BUSINESS_QUOTES: ReturnType<typeof createFakeKV> | undefined;
  CREATOR_IDENTITIES: ReturnType<typeof createFakeKV> | undefined;
  VERIFIED_PAYMENTS: ReturnType<typeof createFakeKV> | undefined;
  ALCHEMY_BASE_RPC_URL?: string;
  CHAINSTACK_BASE_RPC_URL?: string;
  CHAINSTACK_BASE_RPC_USERNAME?: string;
  CHAINSTACK_BASE_RPC_PASSWORD?: string;
}

function buildServicePaymentContext(overrides?: {
  body?: unknown;
  env?: Partial<ServicePaymentEnv>;
}) {
  const env: ServicePaymentEnv = {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_IDENTITIES: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    ALCHEMY_BASE_RPC_URL: "https://base-rpc.example.com",
    ...overrides?.env,
  };

  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body: overrides?.body,
  });

  return { context: makeEventContext({ request, env }), env };
}

function buildUploadTokenContext(overrides?: {
  body?: unknown;
  env?: Partial<ServicePaymentEnv>;
}) {
  const env: ServicePaymentEnv = {
    UPLOAD_TOKENS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    ...overrides?.env,
  };

  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body: overrides?.body,
  });

  return { context: makeEventContext({ request, env }), env };
}

describe("Payment authorization / replay protection invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("functions/api/upload-token.ts", () => {
    it("VERIFIED PAYMENT REQUIRED: rejects when verified payment missing", async () => {
      const { context } = buildUploadTokenContext({
        body: {
          capsuleId: "a".repeat(64),
          canonicalLifecycleId: "lifecycle-1",
          correlationTransactionId: "a".repeat(20),
        },
      });

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(403);
    });

    it("WRONG CAPSULE REJECTION: rejects when verified record capsuleId mismatches", async () => {
      const { env, context } = buildUploadTokenContext({
        body: {
          capsuleId: "a".repeat(64),
          canonicalLifecycleId: "lifecycle-1",
          correlationTransactionId: "a".repeat(20),
        },
      });

      await env.VERIFIED_PAYMENTS!.put(`capsule:${"a".repeat(64)}`, JSON.stringify({
        capsuleId: "b".repeat(64),
        ok: true,
        transactionId: "a".repeat(20),
        expiresAt: Date.now() + 60_000,
      }));

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(403);
    });

    it("EXPIRED AUTHORIZATION / PAYMENT STATE: rejects expired verified record", async () => {
      const { env, context } = buildUploadTokenContext({
        body: {
          capsuleId: "a".repeat(64),
          canonicalLifecycleId: "lifecycle-1",
          correlationTransactionId: "a".repeat(20),
        },
      });

      await env.VERIFIED_PAYMENTS!.put(`capsule:${"a".repeat(64)}`, JSON.stringify({
        capsuleId: "a".repeat(64),
        ok: true,
        transactionId: "a".repeat(20),
        expiresAt: Date.now() - 1000,
      }));

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(403);
    });

    it("PAYMENT VERIFICATION BINDING: rejects mismatched transactionId", async () => {
      const { env, context } = buildUploadTokenContext({
        body: {
          capsuleId: "a".repeat(64),
          canonicalLifecycleId: "lifecycle-1",
          correlationTransactionId: "a".repeat(20),
        },
      });

      await env.VERIFIED_PAYMENTS!.put(`capsule:${"a".repeat(64)}`, JSON.stringify({
        capsuleId: "a".repeat(64),
        ok: true,
        transactionId: "a".repeat(20),
        expiresAt: Date.now() + 60_000,
      }));

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(403);
    });

    it("INVALID PAYMENT: rejects non-ok verified record", async () => {
      const { env, context } = buildUploadTokenContext({
        body: {
          capsuleId: "a".repeat(64),
          canonicalLifecycleId: "lifecycle-1",
          correlationTransactionId: "a".repeat(20),
        },
      });

      await env.VERIFIED_PAYMENTS!.put(`capsule:${"a".repeat(64)}`, JSON.stringify({
        capsuleId: "a".repeat(64),
        ok: false,
        transactionId: "a".repeat(20),
        expiresAt: Date.now() + 60_000,
      }));

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(403);
    });

    it("FAIL-CLOSED: rejects malformed body missing required field", async () => {
      const { context } = buildUploadTokenContext({
        body: { capsuleId: "a".repeat(64) },
      });

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(400);
    });

    it("FAIL-CLOSED: rejects invalid transactionId format", async () => {
      const { context } = buildUploadTokenContext({
        body: {
          capsuleId: "a".repeat(64),
          transactionId: "!!!invalid!!!",
        },
      });

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(400);
    });

    it("FAIL-CLOSED: rejects when VERIFIED_PAYMENTS binding missing", async () => {
      const env = {
        UPLOAD_TOKENS: createFakeKV(),
        VERIFIED_PAYMENTS: undefined,
      };

      const request = createFakeRequest({
        headers: {
          origin: ALLOWED_ORIGIN,
          "content-type": "application/json",
        },
        body: {
          capsuleId: "a".repeat(64),
          canonicalLifecycleId: "lifecycle-1",
          correlationTransactionId: "a".repeat(20),
        },
      });

      const context = makeEventContext({ request, env });

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(503);
    });

    it("issues upload token for valid verified payment with mocked executor", async () => {
      const { env, context } = buildUploadTokenContext({
        body: {
          capsuleId: "a".repeat(64),
          canonicalLifecycleId: "lifecycle-1",
          correlationTransactionId: "a".repeat(20),
        },
      });

      await env.VERIFIED_PAYMENTS!.put(`capsule:${"a".repeat(64)}`, JSON.stringify({
        capsuleId: "a".repeat(64),
        ok: true,
        transactionId: "a".repeat(20),
        expiresAt: Date.now() + 60_000,
        creatorIdentityId: "a".repeat(32),
      }));

      const res = await uploadTokenPost(context);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.ok).toBe(true);
      expect(typeof payload.uploadToken).toBe("string");
    });
  });

  describe("functions/api/service-payment/verify.ts", () => {
    it("FAIL-CLOSED: rejects when BUSINESS_QUOTE is missing", async () => {
      const env = {
        BUSINESS_QUOTES: { get: async () => null },
        CREATOR_IDENTITIES: { get: async () => null },
        VERIFIED_PAYMENTS: { get: async () => null, put: async () => {} },
      };

      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: {
          capsuleId: "a".repeat(64),
          creatorIdentityId: "a".repeat(32),
          evidenceId: "ev-1",
        },
      });

      const context = makeEventContext({ request, env });
      const res = await servicePaymentVerifyPost(context);
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("BUSINESS_QUOTE_NOT_FOUND");
    });

    it("FAIL-CLOSED: rejects verification when quote is not exactly 1 USD", async () => {
      const env = {
        BUSINESS_QUOTES: {
          get: async () => JSON.stringify({
            capsuleId: "a".repeat(64),
            expectedAmount: 2,
            currency: "USD",
            expiresAt: Date.now() + 60_000,
          }),
        },
        CREATOR_IDENTITIES: {
          get: async () => JSON.stringify({ id: "a".repeat(32) }),
        },
        VERIFIED_PAYMENTS: { get: async () => null, put: async () => {} },
        ALCHEMY_BASE_RPC_URL: "https://base-rpc.example.com",
      };

      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: {
          capsuleId: "a".repeat(64),
          creatorIdentityId: "a".repeat(32),
          evidenceId: "ev-amount",
          txHash: "0x" + "a".repeat(64),
        },
      });

      const context = makeEventContext({ request, env });
      const res = await servicePaymentVerifyPost(context);
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("QUOTE_NOT_1_USD");
    });

    it("FAIL-CLOSED: rejects invalid txHash", async () => {
      const env = {
        BUSINESS_QUOTES: {
          get: async () => JSON.stringify({
            capsuleId: "a".repeat(64),
            expectedAmount: 1,
            currency: "USD",
            expiresAt: Date.now() + 60_000,
          }),
        },
        CREATOR_IDENTITIES: {
          get: async () => JSON.stringify({ id: "a".repeat(32) }),
        },
        VERIFIED_PAYMENTS: { get: async () => null, put: async () => {} },
      };

      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: {
          capsuleId: "a".repeat(64),
          creatorIdentityId: "a".repeat(32),
          evidenceId: "ev-tx",
          txHash: "not-a-txhash",
        },
      });

      const context = makeEventContext({ request, env });
      const res = await servicePaymentVerifyPost(context);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_TX_HASH");
    });

    it("FAIL-CLOSED: rejects when both providers are unavailable", async () => {
      const env = {
        BUSINESS_QUOTES: {
          get: async () => JSON.stringify({
            capsuleId: "a".repeat(64),
            expectedAmount: 1,
            currency: "USD",
            expiresAt: Date.now() + 60_000,
          }),
        },
        CREATOR_IDENTITIES: {
          get: async () => JSON.stringify({ id: "a".repeat(32) }),
        },
        VERIFIED_PAYMENTS: { get: async () => null, put: async () => {} },
      };

      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: {
          capsuleId: "a".repeat(64),
          creatorIdentityId: "a".repeat(32),
          evidenceId: "ev-provider",
          txHash: "0x" + "a".repeat(64),
        },
      });

      const context = makeEventContext({ request, env });
      const res = await servicePaymentVerifyPost(context);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("PROVIDERS_UNAVAILABLE");
    });

    it("FAIL-CLOSED: rejects when providers disagree on chain", async () => {
      const env = {
        BUSINESS_QUOTES: {
          get: async () => JSON.stringify({
            capsuleId: "a".repeat(64),
            expectedAmount: 1,
            currency: "USD",
            expiresAt: Date.now() + 60_000,
          }),
        },
        CREATOR_IDENTITIES: {
          get: async () => JSON.stringify({ id: "a".repeat(32) }),
        },
        VERIFIED_PAYMENTS: { get: async () => null, put: async () => {} },
        ALCHEMY_BASE_RPC_URL: "https://base-rpc.example.com",
        CHAINSTACK_BASE_RPC_URL: "https://chainstack.example.com",
        CHAINSTACK_BASE_RPC_USERNAME: "user",
        CHAINSTACK_BASE_RPC_PASSWORD: "pass",
      };

      const fakeFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "0x2105" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: { status: "0x1", blockNumber: "0x10", logs: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "0x1" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "0x1" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "0x2104" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "0x10" }),
        });

      vi.stubGlobal("fetch", fakeFetch);

      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: {
          capsuleId: "a".repeat(64),
          creatorIdentityId: "a".repeat(32),
          evidenceId: "ev-disagree",
          txHash: "0x" + "a".repeat(64),
        },
      });

      const context = makeEventContext({ request, env });
      const res = await servicePaymentVerifyPost(context);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("PROVIDER_DISAGREEMENT");

      vi.unstubAllGlobals();
    });

    it("IDEMPOTENT: returns existing verification without creating duplicate", async () => {
      const existing = JSON.stringify({
        ok: true,
        capsuleId: "a".repeat(64),
        quoteId: "a".repeat(64),
        creatorIdentityId: "a".repeat(32),
        evidenceId: "ev-3",
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });

      const env = {
        BUSINESS_QUOTES: {
          get: async () => JSON.stringify({
            capsuleId: "a".repeat(64),
            expectedAmount: 1,
            currency: "USD",
            expiresAt: Date.now() + 60_000,
          }),
        },
        CREATOR_IDENTITIES: {
          get: async () => JSON.stringify({ id: "a".repeat(32) }),
        },
        VERIFIED_PAYMENTS: { get: async (k: string) => k === `verified-payment:${"a".repeat(64)}:ev-3` ? existing : null, put: async () => {} },
      };

      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: {
          capsuleId: "a".repeat(64),
          creatorIdentityId: "a".repeat(32),
          evidenceId: "ev-3",
        },
      });

      const context = makeEventContext({ request, env });
      const res = await servicePaymentVerifyPost(context);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.status).toBe("VERIFIED");
    });

    it("FAIL-CLOSED: rejects already-consumed payment", async () => {
      const existing = JSON.stringify({
        ok: true,
        capsuleId: "a".repeat(64),
        quoteId: "a".repeat(64),
        creatorIdentityId: "a".repeat(32),
        evidenceId: "ev-consumed",
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        consumed: true,
      });

      const env = {
        BUSINESS_QUOTES: {
          get: async () => JSON.stringify({
            capsuleId: "a".repeat(64),
            expectedAmount: 1,
            currency: "USD",
            expiresAt: Date.now() + 60_000,
          }),
        },
        CREATOR_IDENTITIES: {
          get: async () => JSON.stringify({ id: "a".repeat(32) }),
        },
        VERIFIED_PAYMENTS: { get: async (k: string) => k === `verified-payment:${"a".repeat(64)}:ev-consumed` ? existing : null, put: async () => {} },
      };

      const request = createFakeRequest({
        headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: {
          capsuleId: "a".repeat(64),
          creatorIdentityId: "a".repeat(32),
          evidenceId: "ev-consumed",
          txHash: "0x" + "a".repeat(64),
        },
      });

      const context = makeEventContext({ request, env });
      const res = await servicePaymentVerifyPost(context);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("VERIFIED_PAYMENT_ALREADY_CONSUMED");
    });
  });
});
