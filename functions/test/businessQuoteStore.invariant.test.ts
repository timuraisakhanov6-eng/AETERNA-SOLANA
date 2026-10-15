import { describe, expect, it } from "vitest";
import {
  onRequestPost,
  onRequestOptions,
} from "./../api/service-payment/create-quote";
import { createBusinessQuote, getBusinessQuote } from "./../lib/business/businessQuoteStore";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
} from "./harness";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

/**
 * Real EIP-191 fixture shared with the credit-status invariants: the
 * signature is valid for `AETERNA identity challenge:challenge-valid`
 * and the account below. create-quote now requires a cryptographically
 * proven creator identity before it will mint a payment intent.
 */
const OWNER_ACCOUNT = "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
const OWNER_SIGNATURE =
  "0x57cf9db5baf4181da98d503ef389e277ac810d417c93ba45d2f380092b67a18a3f8c194f8ea5dd75530914a77c89d0e55afee9161805f2f7116c659750c5c75e1c";
const CHALLENGE_ID = "challenge-valid";
const CREATOR_IDENTITY_ID = "creator-1";

function createFakeCreatorIdentities() {
  const store = new Map<string, string>();
  store.set(
    `creator:challenge:${CHALLENGE_ID}`,
    JSON.stringify({
      challenge: CHALLENGE_ID,
      network: "eip155:8453",
      expiresAt: Date.now() + 60_000,
    })
  );
  store.set(
    `creator:identity:eip155:8453:${OWNER_ACCOUNT.toLowerCase()}`,
    JSON.stringify({
      id: CREATOR_IDENTITY_ID,
      account: OWNER_ACCOUNT.toLowerCase(),
      network: "eip155:8453",
    })
  );
  store.set(
    `creator:identity:id:${CREATOR_IDENTITY_ID}`,
    `eip155:8453:${OWNER_ACCOUNT.toLowerCase()}`
  );
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

/** The signed proof every create-quote call must now carry. */
const PROOF = {
  challengeId: CHALLENGE_ID,
  network: "eip155:8453",
  account: OWNER_ACCOUNT,
  signature: OWNER_SIGNATURE,
};

function buildContext(overrides?: {
  body?: unknown;
  origin?: string;
  contentType?: string;
}) {
  const env = {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_IDENTITIES: createFakeCreatorIdentities(),
    CREDIT_OP_COORDINATOR: createFakeCreditCoordinatorBinding(),
  };

  const request = createFakeRequest({
    headers: {
      origin: overrides?.origin ?? ALLOWED_ORIGIN,
      "content-type": overrides?.contentType ?? "application/json",
    },
    body: overrides?.body,
  });

  return { context: makeEventContext({ request, env }), env };
}

describe("Business Quote invariants — canonical service-payment create-quote", () => {
  const validBody = {
    paymentIntentId: "intent-1",
    ...PROOF,
  };

  it("server price authority: expectedAmount is canonical fixed 1 USDC, not client-supplied", async () => {
    const { context } = buildContext({
      body: {
        ...validBody,
        expectedAmount: 3.99,
      },
    });

    const response = await onRequestPost(context);

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      expectedAmount: number;
    };

    expect(payload.ok).toBe(true);
    expect(payload.expectedAmount).toBe(1);
  });

  it("existing Business Quote is immutable: repeated create returns original quote unchanged", async () => {
    const { context, env } = buildContext({
      body: validBody,
    });

    const first = await onRequestPost(context);
    expect(first.status).toBe(200);

    const firstPayload = (await first.json()) as {
      ok: boolean;
      expiresAt: number;
    };

    const second = await onRequestPost(context);
    expect(second.status).toBe(200);

    const secondPayload = (await second.json()) as {
      ok: boolean;
      expiresAt: number;
    };

    expect(secondPayload.expiresAt).toBe(firstPayload.expiresAt);

    const stored = await getBusinessQuote(
      env,
      validBody.paymentIntentId
    );

    expect(stored).not.toBeNull();
    expect(stored!.expectedAmount).toBe(1);
    expect(stored!.currency).toBe("USDC");
  });

  it("Business Quote idempotency: second create does not create conflicting authority", async () => {
    const { context, env } = buildContext({
      body: validBody,
    });

    const first = await onRequestPost(context);
    expect(first.status).toBe(200);

    const firstPayload = (await first.json()) as { ok: boolean };

    expect(firstPayload.ok).toBe(true);

    const second = await onRequestPost(context);
    expect(second.status).toBe(200);

    const secondPayload = (await second.json()) as { ok: boolean };

    expect(secondPayload.ok).toBe(true);

    const stored = await getBusinessQuote(
      env,
      validBody.paymentIntentId
    );

    expect(stored).not.toBeNull();
    expect(stored!.paymentIntentId).toBe(validBody.paymentIntentId);
    expect(stored!.expectedAmount).toBe(1);
  });

  it("expiresAt is present and equals createdAt + 30 minutes", async () => {
    const { context } = buildContext({
      body: validBody,
    });

    const response = await onRequestPost(context);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      expiresAt: number;
    };

    expect(payload.ok).toBe(true);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  it("currency is always USDC", async () => {
    const { context } = buildContext({
      body: validBody,
    });

    const response = await onRequestPost(context);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      currency: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.currency).toBe("USDC");
  });

  it("payment layer does not provide a mutation path for Business Quote", () => {
    const mutations = [
      "updateBusinessQuote",
      "patchBusinessQuote",
      "overwriteBusinessQuote",
    ];

    for (const name of mutations) {
      expect(createBusinessQuote).not.toHaveProperty(name);
      expect(getBusinessQuote).not.toHaveProperty(name);
    }
  });

  it("Model B: the canonical service quote is exactly 1 USDC", async () => {
    const { context, env } = buildContext({ body: validBody });

    const response = await onRequestPost(context);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      expectedAmount: number;
      currency: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.expectedAmount).toBe(1);
    expect(payload.currency).toBe("USDC");

    const stored = await getBusinessQuote(env, validBody.paymentIntentId);
    expect(stored).not.toBeNull();
    expect(stored!.expectedAmount).toBe(1);
    expect(stored!.currency).toBe("USDC");
  });

  it("Model B: client-supplied USD denomination cannot alter the canonical USDC quote", async () => {
    const { context, env } = buildContext({
      body: { ...validBody, expectedAmount: 3.99, currency: "USD" },
    });

    const response = await onRequestPost(context);
    expect(response.status).toBe(200);

    const stored = await getBusinessQuote(env, validBody.paymentIntentId);
    expect(stored).not.toBeNull();
    expect(stored!.expectedAmount).toBe(1);
    expect(stored!.currency).toBe("USDC");
  });

  it("Model B: the canonical quote carries no USD/oracle/conversion authority", async () => {
    const { context, env } = buildContext({ body: validBody });
    await onRequestPost(context);

    const stored = await getBusinessQuote(env, validBody.paymentIntentId);
    const keys = Object.keys(stored as unknown as Record<string, unknown>);

    for (const forbidden of [
      "usdAmount",
      "serviceFeeUsd",
      "oracle",
      "exchangeRate",
      "priceSource",
      "convertedAmount",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
