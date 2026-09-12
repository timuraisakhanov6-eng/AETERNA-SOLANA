/**
 * AETERNA — PATCH-2H Phase 1 headless service payment controller tests
 * (node environment, no DOM / no .tsx).
 *
 * Proves the orchestration extracted from PaymentModal keeps its exact
 * contract: initial idle state, wallet-picker / identity wiring, grant
 * status normalization (PATCH-2E), the successful grant path with
 * onCreditReady / onReserveReady, error mapping and the reset paths.
 *
 * All network access is injected/mocked. No production calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createServicePaymentController,
  normalizeGrantCreditStatus,
} from "@/lib/payment/servicePaymentController";
import type {
  ServicePaymentController,
  ServicePaymentControllerDeps,
  ServicePaymentCreditResult,
  ServicePaymentReserveResult,
  ServicePaymentWalletApi,
} from "@/lib/payment/servicePaymentController";
import { sendSolanaUSDCPayment } from "@/lib/wallet/solanaWallet";

vi.mock("@/lib/wallet/solanaWallet", () => ({
  sendSolanaUSDCPayment: vi.fn(async () => "mock-tx-signature"),
}));

const ACCOUNT = "MockAccount1111111111111111111111111111111111";
const DESTINATION = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";

const QUOTE_BODY = {
  ok: true,
  paymentIntentId: "pi-1",
  expectedAmount: 1,
  currency: "USD",
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
    ...overrides,
  };
}

function setup(options: {
  routes?: Route[];
  onCreditReady?: (result: ServicePaymentCreditResult) => void;
  onReserveReady?: (result: ServicePaymentReserveResult) => void;
} = {}): {
  controller: ServicePaymentController;
  calls: { url: string; body?: unknown }[];
} {
  const { fetchStub, calls } = createFetchStub(options.routes ?? []);
  const deps: ServicePaymentControllerDeps = {
    fetchImpl: fetchStub,
    onCreditReady: options.onCreditReady,
    onReserveReady: options.onReserveReady,
  };
  return { controller: createServicePaymentController(deps), calls };
}

/** quote -> connect -> verify identity, the shared prefix of all payment tests. */
async function driveToWalletVerified(controller: ServicePaymentController) {
  await controller.requestQuote();
  controller.syncWallet(createWalletStub());
  await controller.connectWallet();
}

const SUCCESS_ROUTES: Route[] = [
  { match: (u) => u.includes("create-quote"), body: QUOTE_BODY },
  { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
  { match: (u) => u.includes("verify-proof"), body: PROOF_BODY },
  { match: (u) => u.includes("service-payment/verify"), body: { ok: true, status: "VERIFIED" } },
  { match: (u) => u.includes("grant-credit"), body: { ok: true, creatorCreditId: "credit-1", status: "AVAILABLE" } },
];

beforeEach(() => {
  vi.clearAllMocks();
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
    });
  });

  it("(b) opens the wallet picker when disconnected, then verifies identity", async () => {
    const { controller } = setup({
      routes: [
        { match: (u) => u.includes("issue-challenge"), body: ISSUE_BODY },
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
    expect(vi.mocked(sendSolanaUSDCPayment)).toHaveBeenCalledWith(
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
    });
  });

  it("(f) disconnecting the wallet resets verification state", async () => {
    const { controller } = setup({ routes: SUCCESS_ROUTES });

    await driveToWalletVerified(controller);
    expect(controller.getState().phase).toBe("wallet_verified");

    controller.syncWallet(createWalletStub({ connected: false, account: null }));

    expect(controller.getState().phase).toBe("quote_ready");
    expect(controller.getState().verifiedCreatorIdentityId).toBeNull();
    expect(controller.getState().verifiedCreatorAccount).toBeNull();
  });

  it("(f) a wallet account change resets verification state", async () => {
    const { controller } = setup({ routes: SUCCESS_ROUTES });

    await driveToWalletVerified(controller);
    expect(controller.getState().phase).toBe("wallet_verified");

    controller.syncWallet(createWalletStub({ account: "DifferentAccount11111111111111111111111111" }));

    expect(controller.getState().verifiedCreatorIdentityId).toBeNull();
    expect(controller.getState().verifiedCreatorAccount).toBeNull();
  });
});
