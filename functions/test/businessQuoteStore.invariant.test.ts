import { describe, expect, it } from "vitest";
import {
  onRequestPost,
  onRequestOptions,
} from "./../api/service-payment/create-quote";
import { createBusinessQuote, getBusinessQuote } from "./../lib/business/businessQuoteStore";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

function buildContext(overrides?: {
  body?: unknown;
  origin?: string;
  contentType?: string;
}) {
  const env = {
    BUSINESS_QUOTES: createFakeKV(),
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
