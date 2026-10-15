// @vitest-environment jsdom
/**
 * AETERNA — same-intent payment recovery (client side)
 *
 * These invariants pin the CLIENT half of the recovery contract:
 *
 *  1. a payment is NEVER sent against an expired quote;
 *  2. a transaction whose signature is known is RESUMED (verified), never
 *     re-sent;
 *  3. an UNKNOWN send outcome blocks any further transfer;
 *  4. a wallet rejection (provably pre-send) is its own state and leaves
 *     no "unknown outcome" marker, so the same intent may be retried;
 *  5. a transport failure AFTER the signature does not lose it — the
 *     stored signature is what a later attempt resumes.
 *
 * All wallet/RPC/network calls are mocked. No real transaction, no real
 * payment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createServicePaymentController,
  type ServicePaymentController,
  type ServicePaymentWalletApi,
} from "./servicePaymentController";
import { signSolanaUSDCPayment } from "@/lib/wallet/solanaWallet";
import {
  clearPendingPaymentAttempt,
  readPendingPaymentAttempt,
  writePendingPaymentAttempt,
} from "./pendingPaymentAttempt";

vi.mock("@/lib/wallet/solanaWallet", () => ({
  signSolanaUSDCPayment: vi.fn(async () => ({
    signature: "mock-tx-signature",
    signedTransactionBase64: "bW9jay1zaWduZWQ=",
    blockhash: "mock-blockhash",
    lastValidBlockHeight: 12345,
  })),
}));

const ACCOUNT = "7XkWqBase58WalletAccountRecovery";
const TX = "MockTransactionSignatureRecovery1111111111111111111";

const ISSUE_BODY = {
  ok: true,
  id: "challenge-recovery",
  challengeId: "challenge-recovery",
  challenge: "recovery",
  message: "AETERNA identity challenge:recovery",
  expiresAt: 0,
};

const PROOF_BODY = {
  ok: true,
  status: "available",
  creatorIdentityId: "identity-1",
  creatorCreditId: "credit-1",
  account: ACCOUNT,
};

const NO_CREDIT_DISCOVERY = {
  ok: true,
  status: "none",
  creatorCreditId: null,
  creatorIdentityId: "identity-1",
  account: ACCOUNT,
  summary: {
    availableCount: 0,
    consumingCount: 0,
    consumedCount: 0,
    total: 0,
    enumerationComplete: true,
  },
  unfinishedLifecycles: [],
};

function createWalletStub(overrides: Partial<ServicePaymentWalletApi> = {}): ServicePaymentWalletApi {
  return {
    connected: true,
    account: ACCOUNT,
    walletName: "Test Wallet",
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })),
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    signTransaction: vi.fn(async (tx: unknown) => tx),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  } as ServicePaymentWalletApi;
}

interface Stub {
  fetchImpl: typeof fetch;
  quoteCalls: number;
  verifyCalls: () => { transactionId?: string | undefined }[];
  broadcastCalls: () => unknown[];
  grantCalls: () => unknown[];
}

/**
 * Sequenced fetch stub for the payment flow. `expiresAt` controls the
 * quote window; `verifyBehaviour` decides what /verify answers.
 */
function createStub(options: {
  expiresAt?: number;
  verifyBehaviour?: "verified" | "transport-error" | "not-found";
  broadcastFails?: boolean;
  /**
   * The signature create-quote reports as ALREADY bound to this attempt
   * (the server-side discovery of a lost local pointer).
   */
  resumeTransactionId?: string;
  /**
   * What the AUTHORITATIVE PRE-SIGNATURE RE-READ — the 2nd and every
   * later create-quote call — answers. This models a second tab or
   * device acting between THIS tab's quote and its payment.
   */
  onRecheck?: {
    resumeTransactionId?: string;
    paymentState?: "ready_to_pay" | "verified_pending_grant" | "granted";
    /** The re-read itself is unreadable (server unavailable). */
    fail?: boolean;
  };
} = {}): Stub {
  let quoteCalls = 0;
  /**
   * The intent the stub has issued. The REAL server CONTINUES an
   * existing active attempt: the first create-quote mints the intent and
   * every later call returns the SAME one. The stub must model that,
   * otherwise the authoritative pre-signature re-read would observe a
   * different intent and fail closed.
   */
  let issuedIntentId: string | null = null;
  const verifyBodies: { transactionId?: string | undefined }[] = [];
  const broadcastBodies: unknown[] = [];
  const grantBodies: unknown[] = [];

  const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.includes("issue-challenge")) {
      return { ok: true, json: async () => ISSUE_BODY } as Response;
    }
    if (url.includes("credit-status")) {
      return { ok: true, json: async () => NO_CREDIT_DISCOVERY } as Response;
    }
    if (url.includes("verify-proof")) {
      return { ok: true, json: async () => PROOF_BODY } as Response;
    }
    // The validated broadcast endpoint must echo the signature that the
    // (mocked) signing produced, otherwise the controller fails closed.
    if (url.includes("/api/solana/broadcast")) {
      broadcastBodies.push(body);
      if (options.broadcastFails) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ ok: false, error: "RPC_ERROR" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ ok: true, signature: TX }),
      } as Response;
    }
    if (url.includes("create-quote")) {
      quoteCalls += 1;
      const isRecheck = quoteCalls > 1;
      if (isRecheck && options.onRecheck?.fail) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ ok: false, error: "ENTITLEMENT_STATE_UNKNOWN" }),
        } as unknown as Response;
      }
      issuedIntentId =
        issuedIntentId ??
        (typeof body["paymentIntentId"] === "string"
          ? body["paymentIntentId"]
          : "intent-recovery");
      return {
        ok: true,
        json: async () => ({
          ok: true,
          paymentState:
            (isRecheck ? options.onRecheck?.paymentState : undefined) ??
            "ready_to_pay",
          paymentIntentId: issuedIntentId,
          expectedAmount: 1,
          currency: "USDC",
          expiresAt: options.expiresAt ?? Date.now() + 30 * 60 * 1000,
          resumeTransactionId: isRecheck
            ? options.onRecheck?.resumeTransactionId ??
              options.resumeTransactionId ??
              null
            : options.resumeTransactionId ?? null,
        }),
      } as Response;
    }
    if (url.includes("service-payment/verify")) {
      verifyBodies.push({ transactionId: body["transactionId"] as string | undefined });
      const behaviour = options.verifyBehaviour ?? "verified";
      if (behaviour === "transport-error") {
        throw new Error("network down");
      }
      if (behaviour === "not-found") {
        return {
          ok: false,
          status: 402,
          json: async () => ({ ok: false, error: "TX_NOT_FOUND" }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ ok: true, status: "VERIFIED" }) } as Response;
    }
    if (url.includes("grant-credit")) {
      grantBodies.push(body);
      return {
        ok: true,
        json: async () => ({ ok: true, creatorCreditId: "credit-1", status: "AVAILABLE" }),
      } as Response;
    }
    throw new Error(`UNMOCKED_FETCH: ${url}`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    get quoteCalls() {
      return quoteCalls;
    },
    verifyCalls: () => verifyBodies,
    grantCalls: () => grantBodies,
    broadcastCalls: () => broadcastBodies,
  };
}

/** Drive the controller to the point where a payment may be confirmed. */
async function driveToPayable(stub: Stub): Promise<ServicePaymentController> {
  const controller = createServicePaymentController({ fetchImpl: stub.fetchImpl });
  controller.setParams({
    creatorIdentityId: null,
    protocolAccepted: true,
    stopAfterCredit: true,
  });
  controller.syncWallet(createWalletStub());
  await controller.requestQuote();
  await controller.connectWallet();
  return controller;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingPaymentAttempt();
  vi.mocked(signSolanaUSDCPayment).mockImplementation(async () => ({
    signature: TX,
    signedTransactionBase64: "bW9jay1zaWduZWQ=",
    blockhash: "mock-blockhash",
    lastValidBlockHeight: 12345,
  }));
});

afterEach(() => {
  clearPendingPaymentAttempt();
  vi.useRealTimers();
});

describe("client payment recovery", () => {
  it("2/3: the signature is persisted BEFORE the broadcast, and a failed persist blocks it", async () => {
    /**
     * Part 1 — order of operations.
     *
     * The broadcast is made to FAIL. If the signature had been persisted
     * only AFTER a successful broadcast, the record would be missing;
     * because it is persisted first, a record survives a failed (or
     * lost) broadcast, and a retry resumes the SAME signature.
     */
    const failingStub = createStub({ broadcastFails: true });
    const failing = createServicePaymentController({
      fetchImpl: failingStub.fetchImpl,
    });
    failing.setParams({
      creatorIdentityId: null,
      protocolAccepted: true,
      stopAfterCredit: true,
    });
    failing.syncWallet(createWalletStub());
    await failing.requestQuote();
    await failing.connectWallet();
    await failing.confirmAndVerify();

    expect(failingStub.broadcastCalls()).toHaveLength(1);
    // The record exists even though the network call failed.
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
    expect(readPendingPaymentAttempt()?.outcome).toBe("submitted");
    expect(failing.getState().error).toBe("RPC_ERROR");
    clearPendingPaymentAttempt();

    /**
     * Part 2 — a record that cannot be written blocks the broadcast.
     */
    const stub = createStub();
    // Simulate a browser with no usable storage at all (private mode /
    // storage disabled): the pending attempt then cannot be persisted,
    // and the payment must NOT be broadcast.
    const originalStorage = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      value: undefined,
      configurable: true,
    });
    let blocked: ServicePaymentController;
    try {
      blocked = createServicePaymentController({ fetchImpl: stub.fetchImpl });
      blocked.setParams({
        creatorIdentityId: null,
        protocolAccepted: true,
        stopAfterCredit: true,
      });
      blocked.syncWallet(createWalletStub());
      await blocked.requestQuote();
      await blocked.connectWallet();
      await blocked.confirmAndVerify();
    } finally {
      Object.defineProperty(window, "localStorage", {
        value: originalStorage,
        configurable: true,
      });
    }

    expect(blocked.getState().error).toBe("PAYMENT_ATTEMPT_NOT_PERSISTED");
    expect(stub.broadcastCalls()).toHaveLength(0);
  });

  it("1: an EXPIRED quote is never used to send a payment", async () => {
    const stub = createStub({ expiresAt: Date.now() - 1000 });
    const controller = await driveToPayable(stub);

    await controller.confirmAndVerify();

    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().error).toBe("QUOTE_EXPIRED_REFRESH_REQUIRED");
    expect(stub.verifyCalls()).toHaveLength(0);
  });

  it("5: a KNOWN signature is resumed for verification — never re-sent", async () => {
    const stub = createStub();
    const controller = await driveToPayable(stub);
    const quote = controller.getState().quote!;
    writePendingPaymentAttempt({
      version: 2,
      paymentIntentId: quote.paymentIntentId,
      creatorIdentityId: "identity-1",
      network: "solana",
      account: ACCOUNT,
      transactionId: TX,
      signedTransaction: "bW9jay1zaWduZWQ=",
      blockhash: "mock-blockhash",
      lastValidBlockHeight: 12345,
      outcome: "submitted",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await controller.confirmAndVerify();

    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(stub.verifyCalls()).toEqual([{ transactionId: TX }]);
    // The settled payment releases the local pointer.
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("6: an UNKNOWN send outcome blocks any further transfer", async () => {
    const stub = createStub();
    const controller = await driveToPayable(stub);
    const quote = controller.getState().quote!;
    writePendingPaymentAttempt({
      version: 2,
      paymentIntentId: quote.paymentIntentId,
      creatorIdentityId: "identity-1",
      network: "solana",
      account: ACCOUNT,
      transactionId: null,
      signedTransaction: null,
      blockhash: null,
      lastValidBlockHeight: null,
      outcome: "unknown",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await controller.confirmAndVerify();

    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(controller.getState().error).toBe("PAYMENT_OUTCOME_UNKNOWN");
    expect(stub.verifyCalls()).toHaveLength(0);
    // The blocking marker survives: the state stays unknown until it is
    // resolved by a confirmed outcome.
    expect(readPendingPaymentAttempt()?.outcome).toBe("unknown");
  });

  it("4: a wallet rejection is a distinct state and the same intent may be retried", async () => {
    const stub = createStub();
    const controller = await driveToPayable(stub);
    vi.mocked(signSolanaUSDCPayment).mockRejectedValueOnce(
      new Error("User rejected the request.")
    );

    await controller.confirmAndVerify();

    expect(controller.getState().error).toBe("PAYMENT_REJECTED_BY_WALLET");
    expect(readPendingPaymentAttempt()).toBeNull();
    expect(stub.verifyCalls()).toHaveLength(0);

    // Safe retry on the SAME intent: a transfer is sent again.
    await controller.confirmAndVerify();
    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledTimes(2);
    expect(stub.grantCalls()).toHaveLength(1);
  });

  it("7: a transport failure AFTER the signature does not lose it", async () => {
    vi.useFakeTimers();
    const stub = createStub({ verifyBehaviour: "transport-error" });
    const controller = createServicePaymentController({ fetchImpl: stub.fetchImpl });
    controller.setParams({
      creatorIdentityId: null,
      protocolAccepted: true,
      stopAfterCredit: true,
    });
    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();

    const pending = controller.confirmAndVerify();
    // Flush the polling loop: several bounded windows of fake time, so the
    // chained retry timers are drained as they are scheduled.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await pending;

    // The signature was persisted BEFORE verification, so it survives.
    const record = readPendingPaymentAttempt();
    expect(record?.transactionId).toBe(TX);
    expect(record?.outcome).toBe("submitted");
    expect(controller.getState().phase).toBe("error");

    // A retry resumes THAT transaction instead of sending a new one.
    const verifyBefore = stub.verifyCalls().length;
    const retry = controller.confirmAndVerify();
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await retry;
    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledTimes(1);
    expect(stub.verifyCalls().length).toBeGreaterThan(verifyBefore);
  });

  it("a non-rejection SIGNING failure is definite: no transaction exists, and the state is recorded", async () => {
    const stub = createStub();
    const controller = await driveToPayable(stub);
    vi.mocked(signSolanaUSDCPayment).mockRejectedValueOnce(
      new Error("Adapter disconnected unexpectedly")
    );

    await controller.confirmAndVerify();

    /**
     * With the two-phase flow a signing failure happens BEFORE any
     * network call, so no transaction can exist. It is reported as
     * PAYMENT_SIGNING_FAILED, and the attempt is still recorded as
     * "unknown" so nothing is silently retried without an explicit user
     * action.
     */
    expect(controller.getState().error).toBe("PAYMENT_SIGNING_FAILED");
    expect(readPendingPaymentAttempt()?.outcome).toBe("unknown");
    expect(stub.verifyCalls()).toHaveLength(0);

    // Nothing was broadcast.
    expect(stub.broadcastCalls()).toHaveLength(0);
  });

  it("8: a SERVER-discovered bound signature is resumed after the local record is lost", async () => {
    const SERVER_TX = "ServerBoundTransactionSignatureRecovery2222222222";
    const stub = createStub({ resumeTransactionId: SERVER_TX });
    const controller = await driveToPayable(stub);

    // The local pointer is GONE (cleared storage / another browser
    // profile): the ONLY knowledge of this attempt's transaction is the
    // one the server discovered for the proven identity.
    expect(readPendingPaymentAttempt()).toBeNull();

    await controller.confirmAndVerify();

    // The DISCOVERED transaction is verified — nothing new is signed and
    // nothing new is broadcast — and the existing verify/grant chain
    // completes.
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(stub.verifyCalls()).toEqual([{ transactionId: SERVER_TX }]);
    expect(stub.grantCalls()).toHaveLength(1);
  });

  it("9: a server-discovered signature that is NOT observable fails closed — no new payment", async () => {
    vi.useFakeTimers();
    const SERVER_TX = "ServerBoundTransactionSignatureRecovery3333333333";
    const stub = createStub({
      resumeTransactionId: SERVER_TX,
      verifyBehaviour: "not-found",
    });
    const controller = createServicePaymentController({ fetchImpl: stub.fetchImpl });
    controller.setParams({
      creatorIdentityId: null,
      protocolAccepted: true,
      stopAfterCredit: true,
    });
    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();

    const pending = controller.confirmAndVerify();
    // Drain the bounded verification window (TX_NOT_FOUND is pending, not
    // a verdict) so the polling loop runs to exhaustion.
    for (let i = 0; i < 30; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await pending;

    /**
     * A single RPC sample that cannot see the transaction is NOT proof
     * that it was never sent. The client therefore signs NOTHING, sends
     * NOTHING, and reports an unresolved state instead of offering a new
     * payment.
     */
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(stub.grantCalls()).toHaveLength(0);
    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().error).toContain(
      "PAYMENT_NOT_OBSERVED_ON_CHAIN"
    );
  });

  it("10: two tabs — tab B resumes the signature bound by tab A (no new signature, no broadcast)", async () => {
    const TAB_A_TX = "TabABoundTransactionSignatureRecovery444444444";
    // Tab B's OWN quote (call 1) knows nothing; by the time it pays, tab A
    // has bound a signature, which the authoritative re-read (call 2)
    // reports. Both tabs share ONE payment intent.
    const stub = createStub({ onRecheck: { resumeTransactionId: TAB_A_TX } });
    const controller = await driveToPayable(stub);

    // Stale in-memory state: neither the local pointer nor the quote knows
    // anything about tab A's signature.
    expect(readPendingPaymentAttempt()).toBeNull();
    expect(controller.getState().quote?.resumeTransactionId ?? null).toBeNull();

    await controller.confirmAndVerify();

    // Tab B signs NOTHING and broadcasts NOTHING: it verifies tab A's
    // transaction and completes the existing verify/grant chain.
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(stub.verifyCalls()).toEqual([{ transactionId: TAB_A_TX }]);
    expect(stub.grantCalls()).toHaveLength(1);
  });

  it("11: a stale quote whose purchase is ALREADY GRANTED signs nothing", async () => {
    const stub = createStub({ onRecheck: { paymentState: "granted" } });
    const controller = await driveToPayable(stub);

    await controller.confirmAndVerify();

    // The purchase already produced a Creator Credit: no signature, no
    // transaction, no verification — the caller continues the EXISTING
    // access flow (re-discovery) instead.
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(stub.verifyCalls()).toHaveLength(0);
    expect(controller.getState().error).toBe(
      "PAYMENT_ALREADY_GRANTED_REFRESH_REQUIRED"
    );
  });

  it("12: a stale quote whose payment is already RECORDED fails closed", async () => {
    const stub = createStub({
      onRecheck: { paymentState: "verified_pending_grant" },
    });
    const controller = await driveToPayable(stub);

    await controller.confirmAndVerify();

    // A verified payment is already recorded and its grant is unfinished:
    // nothing new is signed and nothing new is sent.
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(controller.getState().error).toBe(
      "PAYMENT_ALREADY_RECORDED_CHECK_REQUIRED"
    );
  });

  it("13: an UNREADABLE authoritative state blocks the new signature", async () => {
    const stub = createStub({ onRecheck: { fail: true } });
    const controller = await driveToPayable(stub);

    await controller.confirmAndVerify();

    // Unknown / unreadable state is NOT permission to sign.
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(controller.getState().error).toBe("PAYMENT_STATE_UNVERIFIED");
  });

  it("14: a confirmed reserved intent with NO bound signature still pays normally", async () => {
    const stub = createStub();
    const controller = await driveToPayable(stub);

    await controller.confirmAndVerify();

    // The guard confirmed `reserved` with no bound signature — the ONLY
    // state in which a new transaction may be signed.
    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledTimes(1);
    expect(stub.broadcastCalls()).toHaveLength(1);
    expect(stub.grantCalls()).toHaveLength(1);
  });
});
