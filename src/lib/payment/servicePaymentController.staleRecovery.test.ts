// @vitest-environment jsdom
/**
 * AETERNA — stale pending-attempt reconciliation THROUGH the payment
 * controller.
 *
 * Pins the controller-side contract:
 *  1. a stale pointer (proven expired + absent) is released during an
 *     explicit confirm, the AUTHORITATIVE intent/quote state is
 *     re-obtained, and NO payment, signature or broadcast is started in
 *     that same call — the creator starts the next step explicitly;
 *  2. the refreshed server answer is respected: a server-bound
 *     signature is surfaced for resume verification instead of any new
 *     sign/broadcast; existing grant states surface their existing
 *     tokens;
 *  3. when reconciliation CANNOT prove either thing, the previous
 *     protective behaviour is exactly unchanged — the SAME recorded
 *     transaction is resumed and verified (never re-sent);
 *  4. the three identity-proof stages stay separate and a synchronous
 *     duplicate confirm still coalesces — no second challenge / wallet
 *     window is introduced by reconciliation.
 *
 * The reconciliation transport is mocked (no network, no real RPC); the
 * wallet signing and everything else flow through the standard stubs of
 * the existing suites.
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

/**
 * Reconciliation is fully controlled per-test — the controller only
 * forwards its `fetchImpl`.
 */
const reconcileMock = vi.hoisted(() =>
  vi.fn<() => Promise<unknown>>()
);
vi.mock("@/lib/payment/pendingAttemptRecovery", () => ({
  PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS: 32,
  reconcileStalePendingPaymentAttempt: (...args: unknown[]) =>
    reconcileMock(...args),
}));

const ACCOUNT = "7XkWqStaleRecoAccount";
const TX = "MockStaleRecoveryTransactionSignature11111111111";
const INTENT = "intent-stale-1";

const ISSUE_BODY = {
  ok: true,
  id: "challenge-stale",
  challengeId: "challenge-stale",
  challenge: "stale",
  message: "AETERNA identity challenge:stale",
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

interface StaleStub {
  fetchImpl: typeof fetch;
  quoteCalls: () => number;
  verifyCalls: () => { transactionId?: string | undefined }[];
  broadcastCalls: () => unknown[];
}
/**
 * Sequenced fetch stub for the stale-recovery controller path. The
 * first create-quote issues `intent-stale-1`; every later call re-reads
 * with the configurable attempt state.
 */
function createStaleStub(options: {
  expiresAt?: number;
  /** create-quote answers on the SECOND and every later call. */
  onRecheck?: {
    paymentIntentId?: string;
    paymentState?: "ready_to_pay" | "verified_pending_grant" | "granted";
    resumeTransactionId?: string | null;
  };
  /** What /api/service-payment/verify answers. */
  verifyBehaviour?: "verified" | "not-found";
} = {}): StaleStub {
  let quoteCalls = 0;
  const verifyBodies: { transactionId?: string | undefined }[] = [];
  const broadcastBodies: unknown[] = [];

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
    if (url.includes("create-quote")) {
      quoteCalls += 1;
      const isRecheck = quoteCalls > 1;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          paymentState:
            (isRecheck ? options.onRecheck?.paymentState : undefined) ??
            "ready_to_pay",
          paymentIntentId:
            (isRecheck ? options.onRecheck?.paymentIntentId : undefined) ??
            INTENT,
          expectedAmount: 1,
          currency: "USDC",
          expiresAt:
            options.expiresAt ?? Date.now() + 30 * 60 * 1000,
          resumeTransactionId: isRecheck
            ? options.onRecheck?.resumeTransactionId ?? null
            : null,
        }),
      } as Response;
    }
    if (url.includes("service-payment/verify")) {
      verifyBodies.push({ transactionId: body["transactionId"] as string | undefined });
      if (options.verifyBehaviour === "not-found") {
        return {
          ok: false,
          status: 402,
          json: async () => ({ ok: false, error: "TX_NOT_FOUND" }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ ok: true, status: "VERIFIED" }) } as Response;
    }
    if (url.includes("/api/solana/broadcast")) {
      broadcastBodies.push(body);
      return { ok: true, json: async () => ({ ok: true, signature: TX }) } as Response;
    }
    if (url.includes("grant-credit")) {
      return {
        ok: true,
        json: async () => ({ ok: true, creatorCreditId: "credit-1", status: "AVAILABLE" }),
      } as Response;
    }
    throw new Error(`UNMOCKED_FETCH: ${url}`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    quoteCalls: () => quoteCalls,
    verifyCalls: () => verifyBodies,
    broadcastCalls: () => broadcastBodies,
  };
}

/** How many NEW payment transactions were signed (through the mock). */
function newPaymentSignings(): number {
  return vi.mocked(signSolanaUSDCPayment).mock.calls.length;
}

/** Exceeds VERIFY_PENDING_MAX_WINDOW_MS (45s) so the bound loop drains. */
const VERIFY_WINDOW_DRIVE_MS = 60_000;

/** A pending pointer for the CURRENT intent whose transaction is stale. */
function seedStalePointer(): void {
  writePendingPaymentAttempt({
    version: 2,
    paymentIntentId: INTENT,
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
}

/** Wires the controller to the payable state (quote + wallet verified). */
async function driveToPayable(stub: StaleStub): Promise<ServicePaymentController> {
  const controller = createServicePaymentController({
    fetchImpl: stub.fetchImpl,
  });
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
  vi.mocked(signSolanaUSDCPayment).mockImplementation(async () => ({
    signature: TX,
    signedTransactionBase64: "bW9jay1zaWduZWQ=",
    blockhash: "mock-blockhash",
    lastValidBlockHeight: 12345,
  }));
  reconcileMock.mockReset();
  clearPendingPaymentAttempt();
});

afterEach(() => {
  clearPendingPaymentAttempt();
  vi.useRealTimers();
});

describe("controller — stale pending-attempt reconciliation", () => {
  /**
   * The reconciliation module owns the clearing; the controller reacts
   * to the outcome. The mock reproduces BOTH halves so the controller
   * runs against the real post-release state.
   */
  function mockReleased(): void {
    reconcileMock.mockImplementation(async () => {
      clearPendingPaymentAttempt();
      return { status: "released", releaseReason: "EXPIRED_AND_ABSENT" };
    });
  }

  it("releases a PROVEN stale pointer, re-obtains the authoritative quote, and starts NO payment in that call", async () => {
    const stub = createStaleStub();
    const controller = await driveToPayable(stub);
    seedStalePointer();

    // Proven: expired and gone.
    mockReleased();

    await controller.confirmAndVerify();

    const state = controller.getState();
    // No verify, no broadcast, no new signing happened in this call.
    expect(stub.verifyCalls()).toHaveLength(0);
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(newPaymentSignings()).toBe(0);
    // The authoritative intent/quote state was re-obtained.
    expect(stub.quoteCalls()).toBeGreaterThanOrEqual(2);
    expect(state.quote?.paymentIntentId).toBe(INTENT);
    expect(state.error).toContain("PAYMENT_STALE_ATTEMPT_RELEASED");
    expect(state.phase).toBe("error");
    // The pointer is gone.
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("does NOT re-send or re-sign when the refreshed quote carries a server-bound signature", async () => {
    const stub = createStaleStub({
      onRecheck: { resumeTransactionId: "server-bound-signature" },
    });
    const controller = await driveToPayable(stub);
    seedStalePointer();

    mockReleased();
    await controller.confirmAndVerify();

    const state = controller.getState();
    expect(newPaymentSignings()).toBe(0);
    expect(stub.broadcastCalls()).toHaveLength(0);
    // No verification of ANOTHER transaction was started either:
    // verification resumes ONLY through the creator's next explicit step.
    expect(stub.verifyCalls()).toHaveLength(0);
    expect(state.error).toContain("PAYMENT_SERVER_SIGNATURE_BOUND");
  });

  it("surfaces the existing tokens when the refreshed attempt is already granted/verified", async () => {
    const grantedStub = createStaleStub({ onRecheck: { paymentState: "granted" } });
    const granted = await driveToPayable(grantedStub);
    seedStalePointer();
    mockReleased();
    await granted.confirmAndVerify();
    expect(granted.getState().error).toContain("PAYMENT_ALREADY_GRANTED_REFRESH_REQUIRED");

    const pendingStub = createStaleStub({
      onRecheck: { paymentState: "verified_pending_grant" },
    });
    const pending = await driveToPayable(pendingStub);
    seedStalePointer();
    mockReleased();
    await pending.confirmAndVerify();
    expect(pending.getState().error).toContain("PAYMENT_ALREADY_RECORDED_CHECK_REQUIRED");
  });

  it("keeps the previous protective resume behaviour when reconciliation does NOT prove release", async () => {
    // The verifier keeps saying the transaction is not observable yet
    // (the very stale loop this stage fixes): the pointer must survive.
    const stub = createStaleStub({ verifyBehaviour: "not-found" });
    const controller = await driveToPayable(stub);
    seedStalePointer();

    // Uncertain: reconciliation keeps the pointer (any reason).
    reconcileMock.mockResolvedValue({
      status: "kept",
      reason: "BLOCKHASH_WINDOW_NOT_PROVABLY_EXPIRED",
    });

    // The bounded verification window uses real delays; drive it with
    // fake timers and await the pending bound loop quickly.
    vi.useFakeTimers();
    const confirmPromise = controller.confirmAndVerify();
    await vi.advanceTimersByTimeAsync(VERIFY_WINDOW_DRIVE_MS);
    await confirmPromise;

    const state = controller.getState();
    // The SAME recorded transaction was resumed and polled (no NEW
    // transaction, no broadcast).
    const verifyCalls = stub.verifyCalls();
    expect(verifyCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of verifyCalls) {
      expect(call.transactionId).toBe(TX);
    }
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(state.error).toContain("PAYMENT_NOT_OBSERVED_ON_CHAIN");
    // The pointer survives a kept reconciliation — the basis of the
    // fail-closed contract.
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("never signs a new transaction when reconciliation is kept", async () => {
    const stub = createStaleStub();
    const controller = await driveToPayable(stub);
    seedStalePointer();

    reconcileMock.mockResolvedValue({
      status: "kept",
      reason: "TRANSACTION_STATUS_KNOWN",
    });

    await controller.confirmAndVerify();

    expect(newPaymentSignings()).toBe(0);
    expect(stub.broadcastCalls()).toHaveLength(0);
  });

  it("repeated explicit confirms keep single-stage semantics: one proof, one resume, no second signing", async () => {
    const stub = createStaleStub({
      onRecheck: { paymentState: "granted" },
    });
    const controller = await driveToPayable(stub);
    seedStalePointer();
    reconcileMock.mockResolvedValue({
      status: "kept",
      reason: "BLOCKHASH_WINDOW_NOT_PROVABLY_EXPIRED",
    });

    // First confirm: the pointer is resumed and its verification settles
    // the purchase (verified -> grant). The purchase-proof stage keeps
    // the challenge it retained (no extra prompt).
    await controller.confirmAndVerify();
    // Second confirm: the authoritative re-read answers GRANTED — the
    // creator already owns the credit, so nothing new is signed.
    await controller.confirmAndVerify();

    // Exactly ONE verification of the RESUMED transaction; the settled
    // intent never re-pays.
    expect(stub.verifyCalls()).toEqual([{ transactionId: TX }]);
    expect(stub.broadcastCalls()).toHaveLength(0);
    expect(newPaymentSignings()).toBe(0);
    expect(controller.getState().error).toContain(
      "PAYMENT_ALREADY_GRANTED_REFRESH_REQUIRED"
    );
    // Quote reads: initial + the authoritative re-read of the second
    // confirm. The purchase proof was reused between the two.
    expect(stub.quoteCalls()).toBe(2);
  });
});

