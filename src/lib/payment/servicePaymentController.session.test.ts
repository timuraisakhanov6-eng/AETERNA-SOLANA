// @vitest-environment jsdom
/**
 * AETERNA — creator session: client wiring
 *
 * The server-side session invariants live in
 * `functions/test/creatorSession.invariant.test.ts`. THIS suite proves the
 * CLIENT half of the contract:
 *
 *  - a successful verify-proof hands back a session that is kept ONLY in
 *    memory and used for the following credit-status / create-quote calls;
 *  - a fresh purchase therefore performs exactly ONE identity signature
 *    (the verify-proof proof) when the session is live;
 *  - a retry within the TTL adds NO identity signature;
 *  - a PROVEN invalidation (SESSION_INVALID / SESSION_EXPIRED) causes AT
 *    MOST ONE controlled transition to the legacy challenge/proof path —
 *    never a loop of signatures and never an automatic second payment;
 *  - a TRANSIENT SESSION_UNAVAILABLE (HTTP 503) is NOT a session verdict:
 *    the token is kept, no challenge/signature is requested and the failure
 *    propagates as the existing retryable error, so the creator retries
 *    later with the SAME session;
 *  - the session is not written to localStorage/sessionStorage/IndexedDB
 *    and does not survive a reset.
 *
 * All network access is injected. No production calls, no real wallets.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";

import { createServicePaymentController } from "@/lib/payment/servicePaymentController";
import { clearPendingPaymentAttempt } from "./pendingPaymentAttempt";
import type {
  ServicePaymentController,
  ServicePaymentControllerDeps,
  ServicePaymentWalletApi,
} from "@/lib/payment/servicePaymentController";
import { signSolanaUSDCPayment } from "@/lib/wallet/solanaWallet";

vi.mock("@/lib/wallet/solanaWallet", () => ({
  signSolanaUSDCPayment: vi.fn(async () => ({
    signature: "mock-tx-signature",
    signedTransactionBase64: "bW9jay1zaWduZWQ=",
    blockhash: "mock-blockhash",
    lastValidBlockHeight: 12345,
  })),
}));

const ACCOUNT = "MockAccount1111111111111111111111111111111111";
const IDENTITY = "identity-1";
const SESSION_TOKEN = "aets.identity-1.c2VjcmV0LXNlc3Npb24tc2VjcmV0";

type Call = { url: string; body: Record<string, unknown> | undefined };

interface StubOptions {
  /**
   * When set, the matching endpoint rejects any request carrying a
   * `sessionToken` with 401 SESSION_INVALID (models an expired/revoked
   * session).
   */
  rejectSessionFor?: Array<"credit-status" | "create-quote">;
  /**
   * Refuse a session-bearing request to the given endpoint with an EXACT
   * error code + HTTP status. Used to model 401 SESSION_EXPIRED, 503
   * SESSION_UNAVAILABLE and to prove that classification compares the code
   * by EQUALITY (never a substring of the message).
   */
  sessionErrorFor?: Array<{
    endpoint: "credit-status" | "create-quote";
    code: string;
    status?: number;
    /**
     * Number of session-bearing requests to this endpoint that SUCCEED
     * before the error starts. Default 0 = fail from the very first request.
     */
    after?: number;
  }>;
  /** Issue a session from verify-proof (default true). */
  issueSession?: boolean;
  /** verify-proof response expiresAt offset from now (default +8 min). */
  sessionTtlMs?: number;
}

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 401): Response {
  return { ok, status, json: async () => payload } as Response;
}

function createSessionFetchStub(options: StubOptions = {}) {
  const calls: Call[] = [];
  const sessionAttempts = new Map<string, number>();
  const sessionRejectionFor = (
    url: string,
    body: Record<string, unknown> | undefined
  ): { code: string; status: number } | null => {
    if (!body?.["sessionToken"]) return null;
    const endpoint: "credit-status" | "create-quote" | null = url.includes("credit-status")
      ? "credit-status"
      : url.includes("create-quote")
      ? "create-quote"
      : null;
    if (!endpoint) return null;
    const exact = options.sessionErrorFor?.find((entry) => entry.endpoint === endpoint);
    if (exact) {
      const seen = sessionAttempts.get(endpoint) ?? 0;
      sessionAttempts.set(endpoint, seen + 1);
      if (seen < (exact.after ?? 0)) return null;
      return { code: exact.code, status: exact.status ?? 503 };
    }
    if ((options.rejectSessionFor ?? []).includes(endpoint)) {
      return { code: "SESSION_INVALID", status: 401 };
    }
    return null;
  };

  const fetchStub = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    let body: Record<string, unknown> | undefined;
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, body });

    if (url.includes("/api/creator/issue-challenge")) {
      return jsonResponse({
        ok: true,
        id: "challenge-1",
        challengeId: "challenge-1",
        challenge: "challenge-payload",
        message: "AETERNA identity challenge",
        expiresAt: Date.now() + 600_000,
      });
    }

    if (url.includes("/api/creator/credit-status")) {
      const rejection = sessionRejectionFor(url, body);
      if (rejection) {
        return jsonResponse({ ok: false, error: rejection.code }, false, rejection.status);
      }
      return jsonResponse({
        ok: true,
        status: "none",
        creatorCreditId: null,
        creatorIdentityId: IDENTITY,
        summary: {
          availableCount: 0,
          consumingCount: 0,
          consumedCount: 0,
          total: 0,
          enumerationComplete: true,
        },
      });
    }

    if (url.includes("/api/creator/verify-proof")) {
      const payload: Record<string, unknown> = {
        ok: true,
        creatorIdentityId: IDENTITY,
        account: ACCOUNT,
      };
      if (options.issueSession !== false) {
        payload["sessionToken"] = SESSION_TOKEN;
        payload["sessionExpiresAt"] = Date.now() + (options.sessionTtlMs ?? 480_000);
      }
      return jsonResponse(payload);
    }

    if (url.includes("/api/service-payment/create-quote")) {
      const rejection = sessionRejectionFor(url, body);
      if (rejection) {
        return jsonResponse({ ok: false, error: rejection.code }, false, rejection.status);
      }
      return jsonResponse({
        ok: true,
        paymentIntentId: "pi-1",
        expectedAmount: 1,
        currency: "USDC",
        expiresAt: Date.now() + 30 * 60 * 1000,
        paymentState: "ready_to_pay",
        resumeTransactionId: null,
      });
    }

    if (url.includes("/api/service-payment/verify")) {
      return jsonResponse({ ok: true, status: "VERIFIED" });
    }
    if (url.includes("/api/creator/grant-credit")) {
      return jsonResponse({ ok: true, creatorCreditId: "credit-1", status: "AVAILABLE" });
    }
    if (url.includes("/api/solana/broadcast")) {
      return jsonResponse({ ok: true, signature: "mock-tx-signature" });
    }

    throw new Error("UNMOCKED_FETCH: " + url);
  }) as unknown as typeof fetch;

  return { fetchStub, calls };
}

function dumpStorage(storage: Storage): string {
  const parts: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) parts.push(`${key}=${storage.getItem(key) ?? ""}`);
  }
  return parts.join("|");
}

function createWalletStub(
  overrides: Partial<ServicePaymentWalletApi> = {}
): ServicePaymentWalletApi {
  return {
    connected: true,
    account: ACCOUNT,
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })),
    signAndSendTransaction: vi.fn(async () => ({ signature: "mock-wallet-tx" })),
    signTransaction: vi.fn(async (tx: Transaction | VersionedTransaction) => tx),
    ...overrides,
  };
}

function setup(options: StubOptions = {}) {
  const { fetchStub, calls } = createSessionFetchStub(options);
  const deps: ServicePaymentControllerDeps = { fetchImpl: fetchStub };
  const controller: ServicePaymentController = createServicePaymentController(deps);
  return { controller, calls };
}

/** connectWallet → verify identity (the ONE identity signature). */
async function connectAndVerify(controller: ServicePaymentController, wallet: ServicePaymentWalletApi) {
  controller.syncWallet(wallet);
  controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });
  await controller.connectWallet();
}

/** The explicit "Pay" sequence the gate performs. */
async function paySequence(controller: ServicePaymentController) {
  await controller.recheckEntitlement();
  await controller.requestQuote();
  await controller.confirmAndVerify();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingPaymentAttempt();
  localStorage.clear();
  sessionStorage.clear();
});

describe("creator session — client flow", () => {
  it("uses the session for credit-status and create-quote (no extra signMessage)", async () => {
    const { controller, calls } = setup();
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);

    await controller.recheckEntitlement();
    await controller.requestQuote();

    // The session, not a fresh proof, authorized both follow-ups.
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);

    const creditStatusWithSession = calls.filter(
      (c) => c.url.includes("credit-status") && typeof c.body?.["sessionToken"] === "string"
    );
    const quoteWithSession = calls.filter(
      (c) => c.url.includes("create-quote") && typeof c.body?.["sessionToken"] === "string"
    );
    expect(creditStatusWithSession.length).toBeGreaterThanOrEqual(1);
    expect(quoteWithSession.length).toBeGreaterThanOrEqual(1);
  });

  it("performs exactly ONE identity signature for a fresh payment when the session is live", async () => {
    const { controller } = setup();
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    await paySequence(controller);

    expect(controller.getState().phase).toBe("available");
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(signSolanaUSDCPayment).toHaveBeenCalledTimes(1);
  });

  it("adds NO identity signature on a retry within the session TTL", async () => {
    const { controller } = setup();
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    await controller.recheckEntitlement();
    await controller.requestQuote();
    await controller.confirmAndVerify();

    // Explicit retry of the re-check + quote within the TTL: the session is
    // still live, so neither stage asks for a new signature.
    await controller.recheckEntitlement();
    await controller.requestQuote();

    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
  });

  it("makes AT MOST ONE legacy transition per request when the session is rejected — never a loop", async () => {
    const { controller, calls } = setup({ rejectSessionFor: ["credit-status", "create-quote"] });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);

    await paySequence(controller);

    // One verify-proof signature + one fallback for the re-check + one
    // fallback for the quote = 3. Bounded, deterministic, no loop.
    expect(wallet.signMessage).toHaveBeenCalledTimes(3);
    expect(signSolanaUSDCPayment).toHaveBeenCalledTimes(1);

    // The fallback requests carry no session token (the dead one was dropped).
    const quoteCalls = calls.filter((c) => c.url.includes("create-quote"));
    const nonSessionQuoteCalls = quoteCalls.filter(
      (c) => typeof c.body?.["sessionToken"] !== "string"
    );
    expect(nonSessionQuoteCalls.length).toBeGreaterThanOrEqual(1);
    expect(nonSessionQuoteCalls[0]?.body?.["challengeId"]).toBeTruthy();

    // No unbounded number of wallet prompts.
    expect(vi.mocked(wallet.signMessage).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("falls back to the legacy proof path when no session is issued (backward compatible)", async () => {
    const { controller } = setup({ issueSession: false });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    await controller.recheckEntitlement();
    await controller.requestQuote();

    // No session + no retained purchase proof yet: the retry-style stages
    // sign once each. Exactly the pre-session behavior.
    expect(wallet.signMessage).toHaveBeenCalledTimes(3);
  });

  it("never persists the session token in browser storage", async () => {
    const { controller } = setup();
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    await controller.recheckEntitlement();
    await controller.requestQuote();

    const dump = [
      dumpStorage(localStorage),
      dumpStorage(sessionStorage),
    ].join("|");
    expect(dump).not.toContain(SESSION_TOKEN);
    expect(dump).not.toContain("aets.");
  });

  it("drops the session on account change (the old token is never reused)", async () => {
    const { controller, calls } = setup();
    const wallet = createWalletStub();
    await connectAndVerify(controller, wallet);

    // Account switch clears the verification context AND the session.
    controller.syncWallet(
      createWalletStub({ account: "OtherAccount1111111111111111111111111111111" })
    );
    calls.length = 0;

    await controller.recheckEntitlement();
    await controller.requestQuote();

    // No request after the switch reuses the old session.
    const reused = calls.filter((c) => typeof c.body?.["sessionToken"] === "string");
    expect(reused).toHaveLength(0);
  });

  it("clears the session on reset()", async () => {
    const { controller, calls } = setup();
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    controller.reset();
    calls.length = 0;

    await controller.requestQuote();

    const quoteWithSession = calls.filter(
      (c) => c.url.includes("create-quote") && typeof c.body?.["sessionToken"] === "string"
    );
    expect(quoteWithSession).toHaveLength(0);
  });

  /* ── Stage A.2 — a TRANSIENT 503 is never a session verdict ── */

  it("keeps a valid session on SESSION_UNAVAILABLE and requests no signature", async () => {
    const { controller, calls } = setup({
      sessionErrorFor: [{ endpoint: "credit-status", code: "SESSION_UNAVAILABLE", status: 503 }],
    });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);

    // Isolate the re-check: the initial verification flow has already
    // issued its own challenge + proof-backed discovery.
    calls.length = 0;

    // Transient unavailability must PROPAGATE as the existing retryable
    // error — never be swallowed into a legacy fallback.
    await expect(controller.recheckEntitlement()).rejects.toThrow("SESSION_UNAVAILABLE");

    // No legacy transition: no challenge, no signature.
    expect(calls.some((c) => c.url.includes("issue-challenge"))).toBe(false);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);

    // The session SURVIVED: the later retry still carries the SAME token.
    calls.length = 0;
    await expect(controller.recheckEntitlement()).rejects.toThrow("SESSION_UNAVAILABLE");
    const retriedWithSession = calls.filter(
      (c) => c.url.includes("credit-status") && c.body?.["sessionToken"] === SESSION_TOKEN
    );
    expect(retriedWithSession).toHaveLength(1);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the session and sends nothing when create-quote is temporarily unavailable", async () => {
    const { controller, calls } = setup({
      sessionErrorFor: [{ endpoint: "create-quote", code: "SESSION_UNAVAILABLE", status: 503 }],
    });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    calls.length = 0;
    await controller.requestQuote();

    // Fail closed: no quote, no fallback signature, no payment.
    expect(controller.getState().quote).toBeNull();
    expect(controller.getState().error).toBe("SESSION_UNAVAILABLE");
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(signSolanaUSDCPayment).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes("issue-challenge"))).toBe(false);

    // The retry reuses the SAME session token (not a proof).
    calls.length = 0;
    await controller.requestQuote();
    const retried = calls.filter(
      (c) => c.url.includes("create-quote") && c.body?.["sessionToken"] === SESSION_TOKEN
    );
    expect(retried).toHaveLength(1);
  });

  it("a temporary session error starts no payment, verification, grant or broadcast", async () => {
    const { controller, calls } = setup({
      sessionErrorFor: [
        { endpoint: "credit-status", code: "SESSION_UNAVAILABLE", status: 503 },
        { endpoint: "create-quote", code: "SESSION_UNAVAILABLE", status: 503 },
      ],
    });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    // The gate's pay path stops at the re-check (it rejects → retry surface).
    await expect(controller.recheckEntitlement()).rejects.toThrow("SESSION_UNAVAILABLE");

    expect(signSolanaUSDCPayment).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes("/api/service-payment/verify"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/api/creator/grant-credit"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/api/solana/broadcast"))).toBe(false);
    // Identity verification is intact — only the read-only re-check failed.
    expect(controller.getState().verifiedCreatorIdentityId).toBe(IDENTITY);
  });

  it("never signs a payment when the PRE-SIGNATURE re-read hits a temporary session error", async () => {
    const { controller } = setup({
      sessionErrorFor: [
        // The FIRST session create-quote (the initial quote) succeeds; the
        // SECOND (the pre-signature authoritative re-read) reports a
        // transient 503.
        { endpoint: "create-quote", code: "SESSION_UNAVAILABLE", status: 503, after: 1 },
      ],
    });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    await controller.recheckEntitlement();
    await controller.requestQuote();
    expect(controller.getState().quote).toBeTruthy();

    await controller.confirmAndVerify();

    // Fail closed: the unreadable attempt state is NOT permission to sign.
    expect(controller.getState().error).toBe("PAYMENT_STATE_UNVERIFIED");
    expect(signSolanaUSDCPayment).not.toHaveBeenCalled();
    // No legacy fallback signature either: the session was kept.
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
  });

  /* ── Stage A.2 — a PROVEN invalidation still yields ONE fallback ── */

  it("drops the session and makes exactly ONE legacy fallback on SESSION_EXPIRED", async () => {
    const { controller, calls } = setup({
      sessionErrorFor: [{ endpoint: "credit-status", code: "SESSION_EXPIRED", status: 401 }],
    });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    calls.length = 0;

    await controller.recheckEntitlement();

    // 1 verify-proof signature + 1 fallback signature: the dead token was
    // dropped and the fallback used a REAL proof.
    expect(wallet.signMessage).toHaveBeenCalledTimes(2);
    const creditCalls = calls.filter((c) => c.url.includes("credit-status"));
    expect(creditCalls).toHaveLength(2);
    expect(typeof creditCalls[0]?.body?.["sessionToken"]).toBe("string");
    expect(creditCalls[1]?.body?.["sessionToken"]).toBeUndefined();
    expect(creditCalls[1]?.body?.["challengeId"]).toBeTruthy();
  });

  it("drops the session and makes exactly ONE legacy fallback on SESSION_INVALID", async () => {
    const { controller, calls } = setup({ rejectSessionFor: ["credit-status"] });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    calls.length = 0;
    await controller.recheckEntitlement();

    expect(wallet.signMessage).toHaveBeenCalledTimes(2);
    const creditCalls = calls.filter((c) => c.url.includes("credit-status"));
    expect(creditCalls).toHaveLength(2);
    expect(typeof creditCalls[0]?.body?.["sessionToken"]).toBe("string");
    expect(creditCalls[1]?.body?.["sessionToken"]).toBeUndefined();
    expect(creditCalls[1]?.body?.["challengeId"]).toBeTruthy();
  });

  /* ── Stage A.2 — classification is EXACT, never substring ── */

  it("does not classify unrelated text CONTAINING SESSION_INVALID as a session code", async () => {
    const { controller, calls } = setup({
      sessionErrorFor: [
        { endpoint: "create-quote", code: "NOT_A_SESSION_INVALID_MARKER", status: 409 },
      ],
    });
    const wallet = createWalletStub();

    await connectAndVerify(controller, wallet);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);

    await controller.requestQuote();

    // "NOT_A_SESSION_INVALID_MARKER".includes("SESSION_INVALID") === true,
    // yet it must NOT be treated as a session verdict: no fallback
    // signature, and the session is NOT dropped.
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(controller.getState().error).toBe("NOT_A_SESSION_INVALID_MARKER");

    calls.length = 0;
    await controller.requestQuote();
    const retriedWithSession = calls.filter(
      (c) => c.url.includes("create-quote") && c.body?.["sessionToken"] === SESSION_TOKEN
    );
    expect(retriedWithSession).toHaveLength(1);
  });
});
