/**
 * AETERNA — service-payment verify: TRANSPORT vs VERDICT.
 *
 * The verifier must never blur two different facts:
 *
 *   1. "the chain was successfully asked and did not report the
 *      transaction yet"  -> 402 `TX_NOT_FOUND` (pending; retryable);
 *   2. "the chain could not be asked at all (transport / RPC failure)"
 *      -> its OWN status (503 when temporary, 502 otherwise), NEVER
 *      402 `TX_NOT_FOUND`.
 *
 * Conflating (2) into (1) would let an RPC outage read as "the payment is
 * absent", which is exactly the class of bug this stage removes. The
 * endpoint must also fail closed: no verified payment is written and no
 * transaction-uniqueness claim is made on a transport failure.
 *
 * Mocks only: the Solana lookup is stubbed, everything else is the real
 * handler over fake KV. No network, no real RPC.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { createBusinessQuote } from "./../lib/business/businessQuoteStore";
import { onRequestPost as servicePaymentVerifyPost } from "./../api/service-payment/verify";
import * as solanaRpc from "./../lib/solana/rpc";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";
const CREATOR_IDENTITY_ID = "creator-1";
const CREATOR_IDENTITY_ACCOUNT = "123456789ABCDEF";
const PAYMENT_INTENT_ID = "intent-transient-1";
const EVIDENCE_ID = "evidence-transient-1";
const SOLANA_TX =
  "Base58SignatureForSolanaTransaction1234567890ABCDEF1234567890ABCDEF";

function createFakeCreatorIdentityKV() {
  const store = new Map<string, string>();
  store.set(
    `creator:identity:id:${CREATOR_IDENTITY_ID}`,
    `solana:${CREATOR_IDENTITY_ACCOUNT}`
  );
  store.set(
    `creator:identity:solana:${CREATOR_IDENTITY_ACCOUNT}`,
    JSON.stringify({
      id: CREATOR_IDENTITY_ID,
      network: "solana",
      account: CREATOR_IDENTITY_ACCOUNT,
    })
  );
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async () => {},
    delete: async () => {},
  };
}

function buildEnv() {
  return {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_IDENTITIES: createFakeCreatorIdentityKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
  };
}
type Env = ReturnType<typeof buildEnv>;

function context(env: Env, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });
  return makeEventContext({ request, env: env as never });
}

const originalGetSolanaTransaction = Object.getOwnPropertyDescriptor(
  solanaRpc,
  "getSolanaTransaction"
)!.value;

function mockSolanaLookup(impl: () => unknown) {
  Object.defineProperty(solanaRpc, "getSolanaTransaction", {
    value: vi.fn(impl),
    writable: true,
    configurable: true,
  });
}

async function runVerify(env: Env): Promise<Response> {
  await createBusinessQuote(
    { BUSINESS_QUOTES: env.BUSINESS_QUOTES },
    {
      paymentIntentId: PAYMENT_INTENT_ID,
      expectedAmount: 1,
      currency: "USDC",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
  );

  return servicePaymentVerifyPost(
    context(env, {
      paymentIntentId: PAYMENT_INTENT_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      evidenceId: EVIDENCE_ID,
      transactionId: SOLANA_TX,
    }) as never
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(solanaRpc, "getSolanaTransaction", {
    value: originalGetSolanaTransaction,
    writable: true,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("service-payment verify — transport failure is not a verdict", () => {
  it("maps a TEMPORARY RPC failure to 503 VERIFICATION_UNAVAILABLE (never TX_NOT_FOUND)", async () => {
    mockSolanaLookup(() => {
      throw new Error("RPC_TIMEOUT");
    });

    const env = buildEnv();
    const res = await runVerify(env);
    const body = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe("VERIFICATION_UNAVAILABLE");
    // Fail closed: no verified payment was written.
    expect(env.VERIFIED_PAYMENTS.data.size).toBe(0);
  });

  it("maps a provider HTTP 429 to 503 VERIFICATION_UNAVAILABLE", async () => {
    mockSolanaLookup(() => {
      throw new Error("RPC_HTTP_ERROR_429");
    });

    const res = await runVerify(buildEnv());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "VERIFICATION_UNAVAILABLE"
    );
  });

  it("maps a NON-transient failure to 502 VERIFICATION_FAILED", async () => {
    mockSolanaLookup(() => {
      throw new Error("RPC_MISSING_RESULT");
    });

    const env = buildEnv();
    const res = await runVerify(env);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "VERIFICATION_FAILED"
    );
    expect(env.VERIFIED_PAYMENTS.data.size).toBe(0);
  });

  it("keeps the SUCCESSFUL `null` lookup as 402 TX_NOT_FOUND (the distinction survives)", async () => {
    // A completed lookup that reports "not observed yet" — NOT an error.
    mockSolanaLookup(() => Promise.resolve(null));

    const res = await runVerify(buildEnv());

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "TX_NOT_FOUND"
    );
  });

  it("logs only the failure CLASS — never a payload, signature or secret", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSolanaLookup(() => {
      throw new Error("RPC_TIMEOUT");
    });

    await runVerify(buildEnv());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, detail] = errorSpy.mock.calls[0]!;
    expect(String(message)).toContain("solana verification unavailable");
    const serialized = JSON.stringify(detail);
    expect(serialized).toContain("transient");
    // No transaction payload, signature, URL or credential is logged.
    expect(serialized).not.toContain(SOLANA_TX);
    expect(serialized).not.toContain("http");
    expect(serialized.toLowerCase()).not.toContain("signature");
  });
});
