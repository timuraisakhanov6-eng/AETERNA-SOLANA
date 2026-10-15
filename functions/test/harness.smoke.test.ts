import { describe, expect, it } from "vitest";
import {
  onRequestPost,
  onRequestOptions,
} from "./../api/service-payment/create-quote";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
} from "./harness";

/* Real EIP-191 fixture (shared with the credit-status invariants): the
 * signature is valid for `AETERNA identity challenge:challenge-valid`.
 * create-quote requires a cryptographically proven creator identity and
 * an atomic purchase reservation before it mints a payment intent. */
const OWNER_ACCOUNT = "0xd5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
const OWNER_SIGNATURE =
  "0x57cf9db5baf4181da98d503ef389e277ac810d417c93ba45d2f380092b67a18a3f8c194f8ea5dd75530914a77c89d0e55afee9161805f2f7116c659750c5c75e1c";
const CHALLENGE_ID = "challenge-valid";
const CREATOR_IDENTITY_ID = "creator-1";

const PROOF = {
  challengeId: CHALLENGE_ID,
  network: "eip155:8453",
  account: OWNER_ACCOUNT,
  signature: OWNER_SIGNATURE,
};

function createFakeCreatorIdentities() {
  const store = new Map<string, string>();
  store.set(
    `creator:challenge:${CHALLENGE_ID}`,
    JSON.stringify({
      challenge: CHALLENGE_ID,
      network: "eip155:8453",
      expiresAt: Date.now() + 600_000,
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


const ALLOWED_ORIGIN = "https://aeternacapsule.com";

const validBody = {
  capsuleId: "a".repeat(64),
  ...PROOF,
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
    body: overrides?.body ?? validBody,
  });

  return { context: makeEventContext({ request, env }), env };
}

describe("create-quote handler smoke coverage", () => {
  it("canonical service-payment create-quote returns immutable 1 USDC quote", async () => {
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
    expect(payload.currency).toBe("USDC");
  });

  it("returns 204 for allowed-origin OPTIONS preflight", async () => {
    const { context } = buildContext();

    const response = await onRequestOptions(context);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(204);
  });
});
