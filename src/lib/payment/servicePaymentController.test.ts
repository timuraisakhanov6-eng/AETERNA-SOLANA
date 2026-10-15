// @vitest-environment jsdom
/**
 * AETERNA — PATCH-2H Phase 1 headless service payment controller tests.
 *
 * jsdom (not node): the two-phase payment persists the signed attempt
 * BEFORE broadcasting and fails closed when that record cannot be
 * written, so the suite needs a real browser-storage surface.
 *
 * Proves the orchestration extracted from PaymentModal keeps its exact
 * contract: initial idle state, wallet-picker / identity wiring, grant
 * status normalization (PATCH-2E), the successful grant path with
 * onCreditReady / onReserveReady, error mapping and the reset paths.
 *
 * All network access is injected/mocked. No production calls.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";

import {
  createServicePaymentController,
  normalizeGrantCreditStatus,
} from "@/lib/payment/servicePaymentController";
import {
  readPendingPaymentAttempt,
  clearPendingPaymentAttempt,
} from "./pendingPaymentAttempt";
import type {
  ServicePaymentController,
  ServicePaymentControllerDeps,
  ServicePaymentCreditResult,
  ServicePaymentReserveResult,
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
const DESTINATION = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";

const QUOTE_BODY = {
  ok: true,
  paymentIntentId: "pi-1",
  expectedAmount: 1,
  currency: "USDC",
  expiresAt: 1893456000000,
};
const ISSUE_BODY = {
  ok: true,
  id: "challenge-1",
  challenge: "challenge-payload",
  message: "AETERNA identity challenge",
  expiresAt: 1893456000000,
};
const PROOF_BODY = { ok: true, creatorIdentityId: "identity-1", account: ACCOUNT };

/**
 * PATCH-2J: credit-status runs with the SAME proof BEFORE verify-proof
 * (verify-proof consumes the challenge). Default fixture: an existing
 * identity with no AVAILABLE credit.
 */
const CREDIT_STATUS_NONE_BODY = {
  ok: true,
  status: "none",
  creatorCreditId: null,
  creatorIdentityId: "identity-1",
};
const CREDIT_STATUS_ROUTE: Route = {
  match: (u) => u.includes("credit-status"),
  body: CREDIT_STATUS_NONE_BODY,
};

type Route = {
  match: (url: string) => boolean;
  ok?: boolean;
  body: unknown;
};

function createFetchStub(routes: Route[]) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchStub = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, body });
    const route = routes.find((r) => r.match(url));
    if (!route) {
      /**
       * requestQuote now obtains its OWN fresh challenge to prove the
       * creator identity to the purchase guard. Tests that exercise the
       * payment flow get a deterministic challenge here; a test that
       * wants a specific challenge still overrides it with a route.
       */
      /**
       * The validated broadcast endpoint: the controller signs, persists,
       * binds and broadcasts through it. The mock returns the SAME
       * signature the mocked signing produced.
       */
      if (url.includes("/api/solana/broadcast")) {
        return {
          ok: true,
          json: async () => ({ ok: true, signature: "mock-tx-signature" }),
        } as Response;
      }
      if (url.includes("/api/creator/issue-challenge")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            id: "purchase-challenge",
            challengeId: "purchase-challenge",
            challenge: "purchase",
            message: "AETERNA identity challenge:purchase",
            expiresAt: Date.now() + 600_000,
          }),
        } as Response;
      }
      throw new Error("UNMOCKED_FETCH: " + url);
    }
    return {
      ok: route.ok ?? true,
      json: async () => route.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchStub, calls };
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
    // Two-phase payment: the wallet SIGNS WITHOUT SENDING. The stub
    // returns the transaction it was given, marked as signed.
    signTransaction: vi.fn(
      async (tx: Transaction | VersionedTransaction) => tx
    ),
    ...overrides,
  };
}

function setup(options: {
  routes?: Route[];
  onCreditReady?: (result: ServicePaymentCreditResult) => void;
  onReserveReady?: (result: ServicePaymentReserveResult) => void;
  onCreditDiscovered?: (result: unknown) => void;
} = {}): {
  controller: ServicePaymentController;
  calls: { url: string; body?: unknown }[];
} {
  const { fetchStub, calls } = createFetchStub(options.routes ?? []);
  const deps: ServicePaymentControllerDeps = {
    fetchImpl: fetchStub,
    onCreditReady: options.onCreditReady,
    onReserveReady: options.onReserveReady,
    onCreditDiscovered: options.onCreditDiscovered as ServicePaymentControllerDeps["onCreditDiscovered"],
  };
  return { controller: createServicePaymentController(deps), calls };
}

/**
 * quote -> connect -> verify identity, the shared prefix of all payment
 * tests. The wallet is synced FIRST because the quote endpoint now
 * requires a cryptographically proven creator identity (the purchase
 * guard) — exactly as the production flow does.
 */
async function driveToWalletVerified(controller: ServicePaymentController) {
  controller.syncWallet(createWalletStub());
  await controller.requestQuote();
  await controller.connectWallet();
}

const SUCCESS_ROUTES: Route[] = [
  { match: (u) => u.includes("create-quote"), body: QUOTE_BODY },
  { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
  CREDIT_STATUS_ROUTE,
  { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
  { match: (u) => u.includes("service-payment/verify"), body: { ok: true, status: "VERIFIED" } },
  { match: (u) => u.includes("grant-credit"), body: { ok: true, creatorCreditId: "credit-1", status: "AVAILABLE" } },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The pending-attempt pointer is browser state; every test starts clean.
  clearPendingPaymentAttempt();
});

describe("PATCH-2H service payment controller", () => {
  it("(a) starts in the initial idle state", () => {
    const { controller } = setup();
    expect(controller.getState()).toEqual({
      phase: "idle",
      quote: null,
      error: null,
      isProcessing: false,
      verifiedCreatorIdentityId: null,
      verifiedCreatorAccount: null,
      verificationError: null,
      identityProof: null,
      discovery: null,
    });
  });

  it("(b) opens the wallet picker when disconnected, then verifies identity", async () => {
    const { controller } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
      ],
    });
    const disconnected = createWalletStub({ connected: false, account: null });
    const pickerWallet = createWalletStub();
    (disconnected.openWalletPicker as unknown as { mockImplementation: (f: () => Promise<void>) => void })
      .mockImplementation(async () => {
        // The UI pushes the newly connected wallet in via syncWallet.
        controller.syncWallet(pickerWallet);
      });
    controller.syncWallet(disconnected);

    await controller.connectWallet();

    expect(disconnected.openWalletPicker).toHaveBeenCalledTimes(1);
    expect(pickerWallet.signMessage).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe("wallet_verified");
    expect(controller.getState().verifiedCreatorIdentityId).toBe("identity-1");
    expect(controller.getState().verifiedCreatorAccount).toBe(ACCOUNT);
  });

  it("(b) skips the picker when already connected and verifies identity", async () => {
    const { controller } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
      ],
    });
    const wallet = createWalletStub();
    controller.syncWallet(wallet);

    await controller.connectWallet();

    expect(wallet.openWalletPicker).not.toHaveBeenCalled();
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe("wallet_verified");
  });

  it("(b) skips identity verification when creatorIdentityId is provided", async () => {
    const { controller } = setup();
    controller.setParams({ creatorIdentityId: "identity-1", protocolAccepted: true });
    const wallet = createWalletStub();
    controller.syncWallet(wallet);

    await controller.connectWallet();

    expect(wallet.signMessage).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe("quote_ready");
  });

  it("(c) normalizes grant-credit statuses (PATCH-2E)", () => {
    expect(normalizeGrantCreditStatus("AVAILABLE")).toBe("available");
    expect(normalizeGrantCreditStatus("Consuming")).toBe("consuming");
    expect(normalizeGrantCreditStatus("consumed")).toBe("consumed");
    expect(normalizeGrantCreditStatus(undefined)).toBe("available");
    expect(normalizeGrantCreditStatus(7)).toBe("available");
  });

  it("(d) completes quote -> pay -> grant and emits onCreditReady (stopAfterCredit)", async () => {
    const onCreditReady = vi.fn<[ServicePaymentCreditResult], void>();
    const onReserveReady = vi.fn<[ServicePaymentReserveResult], void>();
    const { controller, calls } = setup({
      routes: SUCCESS_ROUTES,
      onCreditReady,
      onReserveReady,
    });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });

    await driveToWalletVerified(controller);
    expect(controller.getState().phase).toBe("wallet_verified");

    await controller.confirmAndVerify();

    expect(controller.getState().phase).toBe("available");
    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: DESTINATION,
        amountAtomic: "1000000",
        publicKey: ACCOUNT,
      })
    );
    expect(onCreditReady).toHaveBeenCalledTimes(1);
    expect(onCreditReady).toHaveBeenCalledWith({
      status: "available",
      creatorIdentityId: "identity-1",
      creatorCreditId: "credit-1",
      account: ACCOUNT,
      paymentIntentId: "pi-1",
    });
    expect(onReserveReady).not.toHaveBeenCalled();

    const grantCall = calls.find((c) => c.url.includes("grant-credit"));
    expect(grantCall?.body).toMatchObject({
      paymentIntentId: "pi-1",
      creatorIdentityId: "identity-1",
      transactionId: "mock-tx-signature",
    });
    expect(String((grantCall?.body as { verifiedPaymentId?: string })?.verifiedPaymentId)).toContain(
      "payment-modal-pi-1-"
    );
  });

  it("(d) continues to reserve-lifecycle when stopAfterCredit is false", async () => {
    const onCreditReady = vi.fn<[ServicePaymentCreditResult], void>();
    const onReserveReady = vi.fn<[ServicePaymentReserveResult], void>();
    const { controller } = setup({
      routes: [
        ...SUCCESS_ROUTES,
        { match: (u) => u.includes("reserve-lifecycle"), body: { ok: true, lifecycleId: "lc-1" } },
      ],
      onCreditReady,
      onReserveReady,
    });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: false });

    await driveToWalletVerified(controller);
    await controller.confirmAndVerify();

    expect(onCreditReady).toHaveBeenCalledTimes(1);
    expect(onReserveReady).toHaveBeenCalledTimes(1);
    expect(onReserveReady).toHaveBeenCalledWith({
      creatorCreditId: "credit-1",
      lifecycleId: "lc-1",
      paymentIntentId: "pi-1",
    });
    expect(controller.getState().phase).toBe("reserving");
  });

  it("(e) maps a failed quote to the error phase", async () => {
    const { controller } = setup({
      routes: [{ match: (u) => u.includes("create-quote"), ok: false, body: { ok: false, error: "QUOTE_DENIED" } }],
    });

    // The guarded quote requires a proven creator identity: the wallet is
    // synced first, exactly like the production flow.
    controller.syncWallet(createWalletStub());
    await controller.requestQuote();

    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().error).toBe("QUOTE_DENIED");
  });

  it("(e) maps a non-VERIFIED payment to the error phase without granting", async () => {
    const onCreditReady = vi.fn<[ServicePaymentCreditResult], void>();
    const { controller } = setup({
      routes: [
        { match: (u) => u.includes("create-quote"), body: QUOTE_BODY },
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
        { match: (u) => u.includes("service-payment/verify"), body: { ok: true, status: "PENDING" } },
      ],
      onCreditReady,
    });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });

    await driveToWalletVerified(controller);
    await controller.confirmAndVerify();

    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().error).toBe("PAYMENT_NOT_VERIFIED");
    expect(onCreditReady).not.toHaveBeenCalled();
  });

  it("(e) maps an identity verification failure to verificationError", async () => {
    const { controller } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), ok: false, body: { ok: false, error: "INVALID_SIGNATURE" } },
      ],
    });
    controller.syncWallet(createWalletStub());

    await controller.connectWallet();

    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().verificationError).toBe("INVALID_SIGNATURE");
    expect(controller.getState().error).toBe("INVALID_SIGNATURE");
  });

  it("(f) reset returns the controller to the idle state", async () => {
    const { controller } = setup({ routes: [{ match: (u) => u.includes("create-quote"), body: QUOTE_BODY }] });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    expect(controller.getState().phase).toBe("quote_ready");
    expect(controller.getState().quote).not.toBeNull();

    controller.reset();

    expect(controller.getState()).toEqual({
      phase: "idle",
      quote: null,
      error: null,
      isProcessing: false,
      verifiedCreatorIdentityId: null,
      verifiedCreatorAccount: null,
      verificationError: null,
      identityProof: null,
      discovery: null,
    });
  });

  it("(f) disconnecting the wallet resets verification state", async () => {
    const { controller } = setup({ routes: SUCCESS_ROUTES });

    await driveToWalletVerified(controller);
    expect(controller.getState().phase).toBe("wallet_verified");
    // PATCH-2J: verify-proof consumed the challenge — nothing retained.
    expect(controller.getState().identityProof).toBeNull();

    controller.syncWallet(createWalletStub({ connected: false, account: null }));

    expect(controller.getState().phase).toBe("quote_ready");
    expect(controller.getState().verifiedCreatorIdentityId).toBeNull();
    expect(controller.getState().verifiedCreatorAccount).toBeNull();
    expect(controller.getState().identityProof).toBeNull();
  });

  it("(f) a wallet account change resets verification state", async () => {
    const { controller } = setup({ routes: SUCCESS_ROUTES });

    await driveToWalletVerified(controller);
    expect(controller.getState().phase).toBe("wallet_verified");

    controller.syncWallet(createWalletStub({ account: "DifferentAccount11111111111111111111111111" }));

    expect(controller.getState().verifiedCreatorIdentityId).toBeNull();
    expect(controller.getState().verifiedCreatorAccount).toBeNull();
    expect(controller.getState().identityProof).toBeNull();
    expect(controller.getState().discovery).toBeNull();
  });
});

/**
 * PATCH-2J — single-sign identity + credit discovery.
 *
 * One identity challenge per verification flow; the SAME
 * challengeId/network/account/signature drives credit-status discovery
 * FIRST (read-only, does not consume the challenge) and verify-proof
 * SECOND (consumes the challenge) only when discovery answered
 * "none". An AVAILABLE answer restores the entitlement with no
 * verify-proof, no payment, no grant, no reserve.
 */
describe("PATCH-2J single-sign identity + credit discovery", () => {
  const countCalls = (calls: { url: string }[], fragment: string) =>
    calls.filter((c) => c.url.includes(fragment)).length;

  it("A/H: one issue-challenge and ONE signMessage per flow (no-credit path)", async () => {
    const onCreditDiscovered = vi.fn();
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
      ],
      onCreditDiscovered,
    });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();

    expect(controller.getState().phase).toBe("wallet_verified");
    /**
     * Exactly TWO challenges/signatures for the whole flow, one per
     * PROOF — never a redundant third:
     *   1. the discovery proof (reused unchanged by verify-proof), and
     *   2. the purchase-guard proof taken when the quote is requested.
     */
    expect(countCalls(calls, "issue-challenge")).toBe(2);
    expect(countCalls(calls, "credit-status")).toBe(1);
    expect(countCalls(calls, "verify-proof")).toBe(1);
    expect(onCreditDiscovered).toHaveBeenCalledTimes(1);
    expect(onCreditDiscovered).toHaveBeenCalledWith({
      status: "none",
      creatorCreditId: null,
      creatorIdentityId: "identity-1",
      account: ACCOUNT,
      summary: null,
      unfinishedLifecycles: null,
    });
  });

  it("B: AVAILABLE credit → verify-proof NOT called, payment NOT called", async () => {
    const onCreditDiscovered = vi.fn();
    const onCreditReady = vi.fn<[ServicePaymentCreditResult], void>();
    const wallet = createWalletStub();
    const { controller, calls } = setup({
      // No verify-proof route on purpose: a call would throw
      // UNMOCKED_FETCH and fail the test (fail-closed).
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        {
          match: (u) => u.includes("credit-status"),
          body: { ok: true, status: "available", creatorCreditId: "credit-9", creatorIdentityId: "identity-9" },
        },
      ],
      onCreditDiscovered,
      onCreditReady,
    });

    await controller.requestQuote();
    controller.syncWallet(wallet);
    await controller.connectWallet();

    expect(controller.getState().phase).toBe("available");
    expect(controller.getState().identityProof).toBeNull();
    expect(controller.getState().discovery).toEqual({
      status: "available",
      creatorCreditId: "credit-9",
      creatorIdentityId: "identity-9",
      account: ACCOUNT,
      summary: null,
      unfinishedLifecycles: null,
    });
    expect(countCalls(calls, "verify-proof")).toBe(0);
    expect(onCreditDiscovered).toHaveBeenCalledWith({
      status: "available",
      creatorCreditId: "credit-9",
      creatorIdentityId: "identity-9",
      account: ACCOUNT,
      summary: null,
      unfinishedLifecycles: null,
    });

    // Payment must stay forbidden after a restored credit.
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });
    await controller.confirmAndVerify();
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(onCreditReady).not.toHaveBeenCalled();
  });

  it("C: NO CREDIT → verify-proof reuses the SAME challengeId/signature, payment allowed", async () => {
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("create-quote"), body: QUOTE_BODY },
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
        { match: (u) => u.includes("service-payment/verify"), body: { ok: true, status: "VERIFIED" } },
        { match: (u) => u.includes("grant-credit"), body: { ok: true, creatorCreditId: "credit-1", status: "AVAILABLE" } },
      ],
    });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();
    await controller.confirmAndVerify();

    const discoveryCall = calls.find((c) => c.url.includes("credit-status"));
    const proofCall = calls.find((c) => c.url.includes("verify-proof"));
    expect(discoveryCall?.body).toMatchObject({ challengeId: "challenge-1", network: "solana", account: ACCOUNT });
    expect(proofCall?.body).toMatchObject({ challengeId: "challenge-1", network: "solana", account: ACCOUNT });
    expect((proofCall?.body as { signature?: string }).signature).toBe(
      (discoveryCall?.body as { signature?: string }).signature
    );
    expect(countCalls(calls, "verify-proof")).toBe(1);
    expect(controller.getState().phase).toBe("available");
    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledTimes(1);
  });

  it("D: credit-status strictly precedes verify-proof (challenge-consumption ordering)", async () => {
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
      ],
    });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();

    const discoveryIndex = calls.findIndex((c) => c.url.includes("credit-status"));
    const proofIndex = calls.findIndex((c) => c.url.includes("verify-proof"));
    expect(discoveryIndex).toBeGreaterThanOrEqual(0);
    expect(proofIndex).toBeGreaterThan(discoveryIndex);
  });

  it("E: account switch clears the retained proof; the new flow signs again", async () => {
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        // Discovery fails → the proof stays retained for a retry.
        { match: (u) => u.includes("credit-status"), ok: false, body: { ok: false, error: "CREDIT_STATUS_DOWN" } },
      ],
    });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();
    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().identityProof).not.toBeNull();

    controller.syncWallet(createWalletStub({ account: "DifferentAccount11111111111111111111111111" }));
    expect(controller.getState().identityProof).toBeNull();
    expect(controller.getState().discovery).toBeNull();

    // A new flow under the new account binding may issue a NEW challenge
    // and signature — the old proof must never be reused.
    const wallet2 = createWalletStub({ account: "DifferentAccount11111111111111111111111111" });
    controller.syncWallet(wallet2);
    await controller.connectWallet();

    /**
     * Three challenges in total: the purchase-guard proof taken by the
     * first requestQuote, the discovery proof of the first flow, and the
     * discovery proof of the new account's flow. Each is signed EXACTLY
     * once, and the old account's proof is never reused.
     */
    expect(countCalls(calls, "issue-challenge")).toBe(3);
    expect(wallet2.signMessage).toHaveBeenCalledTimes(1);
  });

  it("F: wallet disconnect clears the retained proof", async () => {
    const { controller } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        { match: (u) => u.includes("credit-status"), ok: false, body: { ok: false, error: "CREDIT_STATUS_DOWN" } },
      ],
    });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();
    expect(controller.getState().identityProof).not.toBeNull();

    controller.syncWallet(createWalletStub({ connected: false, account: null }));

    expect(controller.getState().identityProof).toBeNull();
    expect(controller.getState().discovery).toBeNull();
  });

  it("G: failed identity proof blocks the payment path", async () => {
    const { controller } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        CREDIT_STATUS_ROUTE,
        { match: (u) => u.includes("verify-proof"), ok: false, body: { ok: false, error: "INVALID_SIGNATURE" } },
      ],
    });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();

    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().verificationError).toBe("INVALID_SIGNATURE");

    await controller.confirmAndVerify();
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
  });

  it("H: a transient discovery failure retries with the SAME proof — no second challenge/signature", async () => {
    let creditStatusCalls = 0;
    const wallet = createWalletStub();
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        {
          match: (u) => u.includes("credit-status"),
          get body() {
            creditStatusCalls += 1;
            return creditStatusCalls === 1
              ? { ok: false, error: "CREDIT_STATUS_DOWN" }
              : CREDIT_STATUS_NONE_BODY;
          },
        },
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
      ],
    });

    await controller.requestQuote();
    controller.syncWallet(wallet);
    await controller.connectWallet();
    expect(controller.getState().phase).toBe("error");

    // Explicit retry: the retained proof is still valid — no new
    // challenge, no second signature.
    await controller.verifyIdentity();

    expect(controller.getState().phase).toBe("wallet_verified");
    expect(countCalls(calls, "issue-challenge")).toBe(1);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(countCalls(calls, "credit-status")).toBe(2);
    const discoveryBodies = calls
      .filter((c) => c.url.includes("credit-status"))
      .map((c) => (c.body as { challengeId?: string; signature?: string }));
    expect(discoveryBodies[0]?.challengeId).toBe(discoveryBodies[1]?.challengeId);
    expect(discoveryBodies[0]?.signature).toBe(discoveryBodies[1]?.signature);
  });

  it("H: an expired retained proof forces a fresh challenge on retry", async () => {
    const wallet = createWalletStub();
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), get body() { return { ...ISSUE_BODY, expiresAt: Date.now() - 1000 }; } },
        { match: (u) => u.includes("credit-status"), ok: false, body: { ok: false, error: "CHALLENGE_EXPIRED" } },
      ],
    });

    await controller.requestQuote();
    controller.syncWallet(wallet);
    await controller.connectWallet();
    expect(controller.getState().phase).toBe("error");

    // The retained proof is expired — the retry MUST issue a new
    // challenge and request a new signature (server-enforced freshness).
    await controller.verifyIdentity();

    expect(countCalls(calls, "issue-challenge")).toBe(2);
    expect(wallet.signMessage).toHaveBeenCalledTimes(2);
    expect(controller.getState().phase).toBe("error");
  });

  it("H: CREATOR_IDENTITY_NOT_FOUND is a deterministic none — proof proceeds to verify-proof", async () => {
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        {
          match: (u) => u.includes("credit-status"),
          ok: false,
          body: { ok: false, error: "CREATOR_IDENTITY_NOT_FOUND" },
        },
        { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
      ],
    });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();

    expect(controller.getState().phase).toBe("wallet_verified");
    expect(controller.getState().discovery).toEqual({
      status: "none",
      creatorCreditId: null,
      creatorIdentityId: null,
      account: ACCOUNT,
      summary: null,
      unfinishedLifecycles: null,
    });
    expect(countCalls(calls, "verify-proof")).toBe(1);
  });
});

/**
 * PATCH-2K-A — payment-after-discovery guard (defense-in-depth).
 *
 * confirmAndVerify must be unreachable without a completed credit-status
 * discovery that answered NO CREDIT: no quote creation, no USDC
 * transport, no /api/service-payment/verify, no grant-credit. An
 * AVAILABLE discovery must block payment without clobbering the restored
 * credit state; discovery reset (account switch / disconnect / failure)
 * must re-block it.
 */
describe("PATCH-2K-A payment-after-discovery guard", () => {
  const countCalls = (calls: { url: string }[], fragment: string) =>
    calls.filter((c) => c.url.includes(fragment)).length;

  it("blocks confirmAndVerify before any discovery — controlled error, zero transport", async () => {
    const onCreditReady = vi.fn<[ServicePaymentCreditResult], void>();
    const { controller, calls } = setup({ routes: [], onCreditReady });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });
    controller.syncWallet(createWalletStub());

    await controller.confirmAndVerify();

    const state = controller.getState();
    expect(state.phase).toBe("error");
    expect(state.error).toBe("CREDIT_DISCOVERY_REQUIRED");
    expect(state.discovery).toBeNull();
    expect(onCreditReady).not.toHaveBeenCalled();
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    // No quote creation, no verify, no grant — in fact no network call at all.
    expect(countCalls(calls, "create-quote")).toBe(0);
    expect(countCalls(calls, "service-payment/verify")).toBe(0);
    expect(countCalls(calls, "grant-credit")).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("blocks payment after an AVAILABLE discovery and preserves the restored credit state", async () => {
    const onCreditReady = vi.fn<[ServicePaymentCreditResult], void>();
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("create-quote"), body: QUOTE_BODY },
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        {
          match: (u) => u.includes("credit-status"),
          body: { ok: true, status: "available", creatorCreditId: "credit-9", creatorIdentityId: "identity-9" },
        },
      ],
      onCreditReady,
    });

    // The legacy modal flow held a quote before discovery; the guard must
    // block payment even with quote + identity + wallet all present.
    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();
    expect(controller.getState().phase).toBe("available");

    controller.setParams({ creatorIdentityId: "identity-9", protocolAccepted: true, stopAfterCredit: true });
    await controller.confirmAndVerify();

    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(onCreditReady).not.toHaveBeenCalled();
    // The restored-credit state is preserved untouched (no error clobber).
    expect(controller.getState().phase).toBe("available");
    expect(controller.getState().error).toBeNull();
    expect(countCalls(calls, "service-payment/verify")).toBe(0);
    expect(countCalls(calls, "grant-credit")).toBe(0);
  });

  it("blocks payment when discovery failed (no credit-status answer)", async () => {
    const { controller, calls } = setup({
      routes: [
        { match: (u) => u.includes("create-quote"), body: QUOTE_BODY },
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
        { match: (u) => u.includes("credit-status"), ok: false, body: { ok: false, error: "CREDIT_STATUS_DOWN" } },
      ],
    });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();
    expect(controller.getState().phase).toBe("error");

    await controller.confirmAndVerify();

    expect(controller.getState().error).toBe("CREDIT_DISCOVERY_REQUIRED");
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(countCalls(calls, "service-payment/verify")).toBe(0);
    expect(countCalls(calls, "grant-credit")).toBe(0);
  });

  it("account switch and disconnect invalidate discovery — payment stays blocked", async () => {
    const { controller, calls } = setup({ routes: SUCCESS_ROUTES });
    controller.setParams({ creatorIdentityId: null, protocolAccepted: true, stopAfterCredit: true });

    controller.syncWallet(createWalletStub());
    await controller.requestQuote();
    await controller.connectWallet();
    expect(controller.getState().phase).toBe("wallet_verified");

    // Account switch: discovery is account-bound (PATCH-2J) — the reset
    // forbids payment for the new account until it re-discovers.
    controller.syncWallet(createWalletStub({ account: "DifferentAccount11111111111111111111111111" }));
    await controller.confirmAndVerify();
    expect(controller.getState().discovery).toBeNull();
    expect(controller.getState().error).toBe("CREDIT_DISCOVERY_REQUIRED");
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();

    // Disconnect: same reset semantics.
    controller.syncWallet(createWalletStub({ connected: false, account: null }));
    await controller.confirmAndVerify();
    expect(controller.getState().discovery).toBeNull();
    expect(controller.getState().error).toBe("CREDIT_DISCOVERY_REQUIRED");
    expect(vi.mocked(signSolanaUSDCPayment)).not.toHaveBeenCalled();
    expect(countCalls(calls, "service-payment/verify")).toBe(0);
    expect(countCalls(calls, "grant-credit")).toBe(0);
  });
});

/* ─────────── PAYMENT RELIABILITY: bounded verification polling ─────────── */

/**
 * D2/D3/D4 — a wallet returning a signature is NOT proof the transaction
 * landed. Verification must poll the SAME signature within a bounded window
 * and must never turn a non-landed transaction into a payment.
 *
 * The verify route is sequenced so a test can model "not observable yet, then
 * observable" (propagation) and "never observable" (never landed).
 */
function createSequencedFetchStub(
  verifyResponses: Array<{ httpOk?: boolean; status?: number; body: unknown }>
) {
  let verifyIndex = 0;
  const calls: { url: string; body?: unknown }[] = [];

  const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, body });

    // The validated broadcast endpoint (sign → persist → bind → broadcast).
    if (url.includes("/api/solana/broadcast")) {
      return {
        ok: true,
        json: async () => ({ ok: true, signature: "mock-tx-signature" }),
      } as Response;
    }

    if (url.includes("service-payment/verify")) {
      const index = Math.min(verifyIndex, verifyResponses.length - 1);
      verifyIndex += 1;
      const route = verifyResponses[index]!;
      return {
        ok: route.httpOk ?? true,
        status: route.status ?? 200,
        json: async () => route.body,
      } as Response;
    }

    const ok = (payload: unknown) =>
      ({ ok: true, status: 200, json: async () => payload }) as Response;

    if (url.includes("create-quote")) return ok(QUOTE_BODY);
    if (url.includes("issue-challenge")) return ok(ISSUE_BODY);
    if (url.includes("credit-status")) return ok(CREDIT_STATUS_NONE_BODY);
    if (url.includes("verify-proof")) return ok(PROOF_BODY);
    if (url.includes("grant-credit"))
      return ok({ ok: true, creatorCreditId: "credit-1", status: "AVAILABLE" });
    if (url.includes("reserve-lifecycle"))
      return ok({ ok: true, lifecycleId: "lifecycle-1" });

    throw new Error("UNMOCKED_FETCH: " + url);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    verifyCalls: () => calls.filter((c) => c.url.includes("service-payment/verify")),
    grantCalls: () => calls.filter((c) => c.url.includes("grant-credit")),
  };
}

type SequencedStub = ReturnType<typeof createSequencedFetchStub>;

const TX_NOT_FOUND_RESPONSE = {
  httpOk: false,
  status: 402,
  body: { ok: false, error: "TX_NOT_FOUND" },
};
const VERIFIED_RESPONSE = {
  httpOk: true,
  status: 200,
  body: { ok: true, status: "VERIFIED" },
};

async function driveToVerifiedPayment(
  stub: SequencedStub
): Promise<ServicePaymentController> {
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

describe("payment reliability — bounded verification polling (D2/D3/D4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(signSolanaUSDCPayment).mockResolvedValue({ signature: "mock-tx-signature", signedTransactionBase64: "bW9jay1zaWduZWQ=", blockhash: "mock-blockhash", lastValidBlockHeight: 12345 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(signSolanaUSDCPayment).mockReset();
    vi.mocked(signSolanaUSDCPayment).mockResolvedValue({ signature: "mock-tx-signature", signedTransactionBase64: "bW9jay1zaWduZWQ=", blockhash: "mock-blockhash", lastValidBlockHeight: 12345 });
  });

  it("2/5: TX_NOT_FOUND is retried, then a VERIFIED response grants exactly once", async () => {
    const stub = createSequencedFetchStub([TX_NOT_FOUND_RESPONSE, VERIFIED_RESPONSE]);
    const controller = await driveToVerifiedPayment(stub);

    const pending = controller.confirmAndVerify();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(controller.getState().phase).not.toBe("error");
    // Pending first, then a single successful verification.
    expect(stub.verifyCalls()).toHaveLength(2);
    expect(stub.grantCalls()).toHaveLength(1);
    // No second blockchain transaction was ever requested.
    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledTimes(1);
  });

  it("3/7: a transaction that is never observable ends in a recoverable error, never as paid", async () => {
    const stub = createSequencedFetchStub([TX_NOT_FOUND_RESPONSE]);
    const controller = await driveToVerifiedPayment(stub);

    const pending = controller.confirmAndVerify();
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;

    const state = controller.getState();
    expect(state.phase).toBe("error");
    expect(state.error).toContain("PAYMENT_NOT_OBSERVED_ON_CHAIN");
    // Never treated as paid, no credit granted.
    expect(stub.grantCalls()).toHaveLength(0);
    // Bounded: it retried, but a finite number of times.
    expect(stub.verifyCalls().length).toBeGreaterThan(1);
    expect(stub.verifyCalls().length).toBeLessThanOrEqual(23);
    // Still exactly one blockchain transaction attempt.
    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledTimes(1);
  });

  it("a definitive verdict (TX_FAILED) is NOT retried", async () => {
    const stub = createSequencedFetchStub([
      { httpOk: false, status: 402, body: { ok: false, error: "TX_FAILED" } },
    ]);
    const controller = await driveToVerifiedPayment(stub);

    const pending = controller.confirmAndVerify();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().error).toBe("TX_FAILED");
    expect(stub.verifyCalls()).toHaveLength(1);
    expect(stub.grantCalls()).toHaveLength(0);
  });

  it("6: a wallet rejection remains a rejection — no verification, no payment", async () => {
    vi.mocked(signSolanaUSDCPayment).mockRejectedValueOnce(
      new Error("User rejected the request.")
    );
    const stub = createSequencedFetchStub([VERIFIED_RESPONSE]);
    const controller = await driveToVerifiedPayment(stub);

    const pending = controller.confirmAndVerify();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    const state = controller.getState();
    expect(state.phase).toBe("error");
    /**
     * A wallet rejection is the ONE failure that provably happens BEFORE
     * anything is sent, so it is reported as its own state
     * (PAYMENT_REJECTED_BY_WALLET) and leaves NO "unknown outcome"
     * marker: the same purchase intent may safely be retried.
     */
    expect(state.error).toBe("PAYMENT_REJECTED_BY_WALLET");
    // A cancellation never reaches verification or credit.
    expect(stub.verifyCalls()).toHaveLength(0);
    expect(stub.grantCalls()).toHaveLength(0);
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("8: canonical destination, amount and payer are unchanged", async () => {
    const stub = createSequencedFetchStub([VERIFIED_RESPONSE]);
    const controller = await driveToVerifiedPayment(stub);

    const pending = controller.confirmAndVerify();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(vi.mocked(signSolanaUSDCPayment)).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: DESTINATION,
        amountAtomic: "1000000",
        publicKey: ACCOUNT,
        signTransaction: expect.any(Function),
      })
    );
  });
});

/* ================= PRE-PAYMENT ENTITLEMENT RE-CHECK (KV lag) =================
 *
 * A single "no rights" answer is NOT authority for a new $1: KV is
 * eventually consistent, so a right granted seconds ago can be invisible.
 * `recheckEntitlement()` therefore repeats the READ-ONLY enumeration with
 * the same signed proof until either an active right appears or the
 * enumeration is vouched complete. It must never create a quote, a
 * payment or an entitlement, and it must throw (never answer "none") on
 * an unreadable/unknown/failed response.
 */

describe("pre-payment entitlement re-check", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const walletStub = () => {
    const signMessage = vi.fn(async () => ({ signature: new Uint8Array(64) }));
    return {
      wallet: {
        connected: true,
        account: ACCOUNT,
        walletName: "Test Wallet",
        openWalletPicker: vi.fn(async () => {}),
        changeWallet: vi.fn(async () => {}),
        signMessage,
        signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
        signTransaction: vi.fn(
          async (tx: Transaction | VersionedTransaction) => tx
        ),
        disconnect: vi.fn(async () => {}),
      },
      signMessage,
    };
  };

  const creditStatusRoute = (body: unknown) => ({
    match: (u: string) => u.includes("credit-status"),
    body,
  });

  const issueChallengeRoute = {
    match: (u: string) => u.includes("issue-challenge"),
    body: ISSUE_BODY,
  };

  const COMPLETE_NONE = {
    ok: true,
    status: "none",
    creatorCreditId: null,
    creatorIdentityId: "identity-1",
    summary: {
      availableCount: 0,
      consumingCount: 0,
      consumedCount: 0,
      total: 0,
      enumerationComplete: true,
    },
    unfinishedLifecycles: [],
  };

  const UNCONFIRMED_NONE = {
    ...COMPLETE_NONE,
    summary: { ...COMPLETE_NONE.summary, enumerationComplete: false },
  };

  const AVAILABLE = {
    ok: true,
    status: "available",
    creatorCreditId: "credit-9",
    creatorIdentityId: "identity-9",
    summary: {
      availableCount: 1,
      consumingCount: 0,
      consumedCount: 0,
      total: 1,
      enumerationComplete: true,
    },
    unfinishedLifecycles: [],
  };

  const CONSUMING = {
    ok: true,
    status: "consuming",
    creatorCreditId: null,
    creatorIdentityId: "identity-9",
    summary: {
      availableCount: 0,
      consumingCount: 1,
      consumedCount: 0,
      total: 1,
      enumerationComplete: true,
    },
    unfinishedLifecycles: [
      { creatorCreditId: "credit-9", lifecycleId: "lifecycle-9", capsuleId: "capsule-9" },
    ],
  };

  it("a CONFIRMED absence ends the re-check immediately (no quote, no payment)", async () => {
    const { controller, calls } = setup({
      routes: [issueChallengeRoute, creditStatusRoute(COMPLETE_NONE)],
    });
    const { wallet } = walletStub();
    controller.syncWallet(wallet);

    const result = await controller.recheckEntitlement();

    expect(result.status).toBe("none");
    expect(result.summary?.enumerationComplete).toBe(true);
    // Read-only: no payment endpoints were touched at all.
    expect(calls.filter((c) => c.url.includes("create-quote"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("service-payment/verify"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("grant-credit"))).toHaveLength(0);
    // Exactly one signature for the whole check.
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
  });

  it("an ACTIVE right short-circuits the window — no retry, no payment", async () => {
    for (const body of [AVAILABLE, CONSUMING]) {
      const { controller, calls } = setup({
        routes: [issueChallengeRoute, creditStatusRoute(body)],
      });
      const { wallet } = walletStub();
      controller.syncWallet(wallet);

      const result = await controller.recheckEntitlement();

      expect(result.status).toBe(body.status);
      // One read only: the window is abandoned as soon as a right appears.
      expect(calls.filter((c) => c.url.includes("credit-status"))).toHaveLength(1);
      expect(calls.filter((c) => c.url.includes("create-quote"))).toHaveLength(0);
      expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    }
  });

  it("an UNCONFIRMED absence is retried on a bounded schedule and returns without completeness", async () => {
    const { controller, calls } = setup({
      routes: [issueChallengeRoute, creditStatusRoute(UNCONFIRMED_NONE)],
    });
    const { wallet } = walletStub();
    controller.syncWallet(wallet);

    const promise = controller.recheckEntitlement();

    // Drive the bounded window forward: the schedule sums to 60s.
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const result = await promise;

    expect(result.status).toBe("none");
    // NOT a confirmed absence — a caller must refuse to pay on it.
    expect(result.summary?.enumerationComplete).toBe(false);
    // The window was actually used (several reads), and it stayed READ-ONLY.
    expect(calls.filter((c) => c.url.includes("credit-status")).length).toBeGreaterThan(1);
    expect(calls.filter((c) => c.url.includes("create-quote"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("grant-credit"))).toHaveLength(0);
    // Still a single signature for the whole window.
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
  });

  it("an unreadable/unknown answer THROWS instead of returning 'none'", async () => {
    for (const body of [
      { ok: true },                                  // status missing
      { ok: true, status: "weird" },                 // unknown status
      { ok: false, error: "ENTITLEMENT_STATE_UNREADABLE" },
    ]) {
      const { controller } = setup({
        routes: [issueChallengeRoute, { match: (u: string) => u.includes("credit-status"), body, ok: false }],
      });
      const { wallet } = walletStub();
      controller.syncWallet(wallet);

      await expect(controller.recheckEntitlement()).rejects.toThrow();
    }
  });

  it("an unconfirmed absence that later becomes CONFIRMED ends the window early", async () => {
    const calls: { url: string }[] = [];
    let responses = 0;
    // self-contained stub: the first two reads are unconfirmed, the third
    // confirms the absence, so the window must end there.
    const fetchStub = (async (input: unknown) => {
      const url = String(input);
      calls.push({ url });
      if (url.includes("issue-challenge")) {
        return { ok: true, json: async () => ISSUE_BODY } as Response;
      }
      responses += 1;
      const body = responses >= 3 ? COMPLETE_NONE : UNCONFIRMED_NONE;
      return { ok: true, json: async () => body } as Response;
    }) as unknown as typeof fetch;

    const controller = createServicePaymentController({ fetchImpl: fetchStub });
    const { wallet } = walletStub();
    controller.syncWallet(wallet);

    const promise = controller.recheckEntitlement();
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
    const result = await promise;

    expect(result.summary?.enumerationComplete).toBe(true);
    expect(calls.filter((c) => c.url.includes("credit-status")).length).toBe(3);
  });

  it("it refuses to run without a connected wallet account", async () => {
    const { controller } = setup({
      routes: [issueChallengeRoute, creditStatusRoute(COMPLETE_NONE)],
    });
    controller.syncWallet({
      ...walletStub().wallet,
      connected: false,
      account: null,
    });

    await expect(controller.recheckEntitlement()).rejects.toThrow();
  });
});
