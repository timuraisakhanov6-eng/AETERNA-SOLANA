import { describe, expect, it } from "vitest";
import {
  onRequestPost,
  onRequestOptions,
} from "./../api/service-payment/create-quote";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

const validBody = {
  capsuleId: "a".repeat(64),
};

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
    body: overrides?.body ?? validBody,
  });

  return { context: makeEventContext({ request, env }), env };
}

describe("create-quote handler smoke coverage", () => {
  it("canonical service-payment create-quote returns immutable 1 USD quote", async () => {
    const { context } = buildContext();

    const response = await onRequestPost(context);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      expectedAmount: number;
      currency: string;
      expiresAt: number;
    };

    expect(payload.ok).toBe(true);
    expect(payload.expectedAmount).toBe(1);
    expect(payload.currency).toBe("USD");
  });

  it("returns 204 for allowed-origin OPTIONS preflight", async () => {
    const { context } = buildContext();

    const response = await onRequestOptions(context);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(204);
  });
});
