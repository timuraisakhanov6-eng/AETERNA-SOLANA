// @vitest-environment jsdom
/**
 * AETERNA — Home Access Gate (CreateAccessGate) — scenario suite.
 *
 * The Home page is the admission gate for capsule creation: wallet connect
 * (Phantom only), server-authoritative entitlement discovery and the
 * one-time $1 creation-right payment live HERE, on the REAL wiring (real
 * headless servicePaymentController, real reduceCreateFlow reducer, real
 * LandingPaymentGateProvider mirror, real CreateAccessContext). Only the
 * wallet transport, the Solana payment transport and fetch are mocked.
 *
 * Scenarios pinned (from the controlled-implementation spec):
 *   1. desktop, no Phantom      -> install notice; NO connect/SIWS/quote/pay
 *   2. desktop install link     -> official URL, no referral parameters
 *   3. mobile, no injected      -> "Open in Phantom" panel + return copy
 *   4. mobile deeplink          -> public utility invoked; still nothing paid
 *   5. mobile + injected        -> Phantom's own browser keeps the headless
 *                                  flow (no redirect loop, no deeplink)
 *   6. discovery AVAILABLE      -> auto-navigate /create, NO $1 (also covers
 *                                  the previously-paid / closed-browser case:
 *                                  admission is never persisted, the server
 *                                  still owns the unused right)
 *   7. discovery NONE -> $1     -> single charge -> auto-navigate, no second
 *                                  click; no editor before admission
 *   8. verify failure           -> stays on Home, bounded retry (the second
 *                                  charge happens ONLY after an explicit
 *                                  click — never automatically)
 *   9. grant without credit id  -> no admission, no navigation, support copy
 *  10. identity failure         -> error state, retry re-runs discovery
 *  11. already admitted         -> immediate navigate, zero fetch/signature
 *  12. recovery hint            -> offered, NEVER automatic (no endpoint call
 *                                  until the user taps)
 *  13. recovery restored        -> hint dropped, canonical flow re-runs
 *  14. recovery blocked         -> hint KEPT, no navigation, support copy
 *  15. busy state               -> primary button disabled during discovery
 *
 * jsdom component test — same convention as the former
 * CapsuleBuilderPhantomGate / CapsuleBuilderRestoreBatching suites.
 * All network access is mocked. No production calls. No real payment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import { CreateAccessProvider, useCreateAccess } from "@/context/CreateAccessContext";
import CreateAccessGate from "@/components/access/CreateAccessGate";
import {
  clearPendingPaymentAttempt,
  readPendingPaymentAttempt,
  writePendingPaymentAttempt,
} from "@/lib/payment/pendingPaymentAttempt";
import {
  PHANTOM_EXPLORER_ID,
  PHANTOM_INSTALL_URL,
  PHANTOM_MOBILE_OPEN_LABEL,
  PHANTOM_MOBILE_TITLE,
} from "@/lib/wallet/phantomProvider";

/**
 * Mock the PUBLIC AppKit boundary only (`CoreHelperUtil.isMobile` and
 * `MobileWalletUtil.handleMobileDeeplinkRedirect`) — the real AETERNA gate
 * logic (including openAeternaInPhantomMobile) runs underneath.
 */
const { isMobileMock, mobileDeeplinkMock } = vi.hoisted(() => ({
  isMobileMock: vi.fn(() => false),
  mobileDeeplinkMock: vi.fn(),
}));

vi.mock("@reown/appkit-controllers", () => ({
  CoreHelperUtil: { isMobile: isMobileMock },
  MobileWalletUtil: { handleMobileDeeplinkRedirect: mobileDeeplinkMock },
}));

const {
  WALLET_ACCOUNT,
  CREATOR_IDENTITY_ID,
  CREATOR_CREDIT_ID,
  stableWallet,
  signMessageMock,
  signSolanaUSDCPaymentMock,
  fetchMock,
} = vi.hoisted(() => {
  const WALLET_ACCOUNT = "7XkWqBase58WalletAccountAccessGate";
  const CREATOR_IDENTITY_ID = "creator-identity-access-gate";
  const CREATOR_CREDIT_ID = "creator-credit-access-gate";

  const signMessageMock = vi.fn(async () => ({
    signature: new Uint8Array(64),
  }));
  const signSolanaUSDCPaymentMock = vi.fn(async () => ({
    signature: "tx-sig-access-gate",
    signedTransactionBase64: "bW9jay1zaWduZWQ=",
    blockhash: "mock-blockhash",
    lastValidBlockHeight: 12345,
  }));
  const fetchMock = vi.fn(async (_input?: unknown) => ({
    ok: true,
    json: async () => ({ ok: true }),
  }));

  // Mutable per test (connected/disconnected) — same object identity, as
  // production AETERNAWalletContext memoizes its value.
  const stableWallet = {
    connected: false,
    account: null as string | null,
    walletName: null as string | null,
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: signMessageMock,
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    signTransaction: vi.fn(async (tx: unknown) => tx),
    disconnect: vi.fn(async () => {}),
  };

  return {
    WALLET_ACCOUNT,
    CREATOR_IDENTITY_ID,
    CREATOR_CREDIT_ID,
    stableWallet,
    signMessageMock,
    signSolanaUSDCPaymentMock,
    fetchMock,
  };
});

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/lib/wallet/solanaWallet", () => ({
  signSolanaUSDCPayment: signSolanaUSDCPaymentMock,
}));

/* ───────────────── fetch routing ───────────────── */

const json = (body: unknown, ok = true) => ({
  ok,
  json: async () => body,
});

const CHALLENGE_RESPONSE = () =>
  json({
    ok: true,
    id: "challenge-access-gate",
    challengeId: "challenge-access-gate",
    challenge: "abc",
    message: "AETERNA identity challenge",
    expiresAt: Date.now() + 600_000,
  });

const AVAILABLE_DISCOVERY = () =>
  json({
    ok: true,
    status: "available",
    creatorCreditId: CREATOR_CREDIT_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    account: WALLET_ACCOUNT,
    summary: {
      availableCount: 1,
      consumingCount: 0,
      consumedCount: 0,
      total: 1,
      enumerationComplete: true,
    },
    unfinishedLifecycles: [],
  });

/** A CONFIRMED absence: complete enumeration, zero active rights. */
const NO_CREDIT_DISCOVERY_BODY = {
  ok: true,
  status: "none",
  creatorCreditId: null,
  creatorIdentityId: null,
  account: WALLET_ACCOUNT,
  summary: {
    availableCount: 0,
    consumingCount: 0,
    consumedCount: 0,
    total: 0,
    enumerationComplete: true,
  },
  unfinishedLifecycles: [],
};

const NO_CREDIT_DISCOVERY = () => json(NO_CREDIT_DISCOVERY_BODY);

/** An UNCONFIRMED absence: the enumeration could not be vouched for. */
const UNCONFIRMED_NONE_DISCOVERY = () =>
  json({
    ok: true,
    status: "none",
    creatorCreditId: null,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    account: WALLET_ACCOUNT,
    summary: {
      availableCount: 0,
      consumingCount: 0,
      consumedCount: 1,
      total: 1,
      enumerationComplete: false,
    },
    unfinishedLifecycles: [],
  });

/** An authoritative CONSUMING answer (no localStorage hint involved). */
const CONSUMING_DISCOVERY = (
  lifecycles: Array<{
    creatorCreditId: string;
    lifecycleId: string;
    capsuleId: string;
  }>
) =>
  json({
    ok: true,
    status: "consuming",
    creatorCreditId: null,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    account: WALLET_ACCOUNT,
    summary: {
      availableCount: 0,
      consumingCount: lifecycles.length,
      consumedCount: 0,
      total: lifecycles.length,
      enumerationComplete: true,
    },
    unfinishedLifecycles: lifecycles,
  });

const VERIFY_PROOF = () =>
  json({
    ok: true,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    account: WALLET_ACCOUNT,
  });

/**
 * The same successful verification, plus the short-lived creator session the
 * server now mints. With a live session the following credit-status
 * re-check and create-quote calls need NO new wallet signature.
 */
const VERIFY_PROOF_WITH_SESSION = () =>
  json({
    ok: true,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    account: WALLET_ACCOUNT,
    sessionToken: `aets.${CREATOR_IDENTITY_ID}.c2VjcmV0LXNlc3Npb24tc2VjcmV0`,
    sessionExpiresAt: Date.now() + 8 * 60 * 1000,
  });

const CREATE_QUOTE = () =>
  json({
    ok: true,
    paymentIntentId: "payment-intent-access-gate",
    expectedAmount: 1,
    currency: "USDC",
    expiresAt: Date.now() + 600_000,
  });

/**
 * The purchase was already settled by ANOTHER tab/device: the server
 * reports the credit as granted.
 */
const CREATE_QUOTE_GRANTED = () =>
  json({
    ok: true,
    paymentState: "granted",
    paymentIntentId: "payment-intent-access-gate",
    expectedAmount: 1,
    currency: "USDC",
    expiresAt: Date.now() + 600_000,
  });

const VERIFY_VERIFIED = () => json({ ok: true, status: "VERIFIED" });

const VERIFY_FAILED = () =>
  json({ ok: true, error: "PAYMENT_VERIFICATION_FAILED" });

const GRANT_CREDIT = () =>
  json({ ok: true, status: "AVAILABLE", creatorCreditId: CREATOR_CREDIT_ID });

const GRANT_CREDIT_WITHOUT_ID = () =>
  json({ ok: true, status: "AVAILABLE" });

function installFetchRoutes(
  routes: Array<{
    match: string;
    respond: (init?: RequestInit) => ReturnType<typeof json>;
  }>,
  /**
   * Optional override for the validated broadcast endpoint. Defaults to the
   * canonical success echo; a scenario that must exercise a REFUSAL passes
   * its own response here instead of adding a magic route.
   */
  broadcastRespond: (init?: RequestInit) => ReturnType<typeof json> = () =>
    json({ ok: true, signature: "tx-sig-access-gate" })
) {
  // Cast through the hoisted mock's own signature: per-test routes replace
  // the implementation, so the exact response shape varies by scenario.
  (fetchMock as unknown as {
    mockImplementation: (
      fn: (input?: unknown, init?: RequestInit) => Promise<unknown>
    ) => void;
  }).mockImplementation(async (input?: unknown, init?: RequestInit) => {
    const url = String(input);
    /**
     * The validated broadcast endpoint is always available: the payment
     * signs locally, persists, then binds + broadcasts through it. By
     * default it echoes the signature the mocked signing produced.
     */
    if (url.includes("/api/solana/broadcast")) {
      return broadcastRespond(init);
    }
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch in test: ${url}`);
    return route.respond(init);
  });
}

const fetchCallsTo = (fragment: string) =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes(fragment));

/* ───────────────── harness ───────────────── */

/** The /create destination the gate navigates to on admission. */
function CreateProbe() {
  return React.createElement("div", { "data-testid": "create-route" });
}

/** Grants the in-memory admission before the gate's first paint. */
function SeedAdmission() {
  const { grantAccess } = useCreateAccess();
  React.useEffect(() => {
    grantAccess({
      creatorCreditId: CREATOR_CREDIT_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      account: WALLET_ACCOUNT,
    });
  }, [grantAccess]);
  return null;
}

const tree = (options?: { seedAdmission?: boolean }) =>
  React.createElement(
    MemoryRouter,
    null,
    React.createElement(
      CreatorIdentityProvider,
      null,
      React.createElement(
        CreatorCreditProvider,
        null,
        React.createElement(
          LandingPaymentGateProvider,
          null,
          React.createElement(
            CreateAccessProvider,
            null,
            options?.seedAdmission
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(SeedAdmission),
                  React.createElement(
                    Routes,
                    null,
                    React.createElement(Route, {
                      path: "/",
                      element: React.createElement(CreateAccessGate),
                    }),
                    React.createElement(Route, {
                      path: "/create",
                      element: React.createElement(CreateProbe),
                    })
                  )
                )
              : React.createElement(
                  Routes,
                  null,
                  React.createElement(Route, {
                    path: "/",
                    element: React.createElement(CreateAccessGate),
                  }),
                  React.createElement(Route, {
                    path: "/create",
                    element: React.createElement(CreateProbe),
                  })
                )
          )
        )
      )
    )
  );

const GATE_BUTTON = "CREATE CAPSULE";
const PAY_BUTTON = "Pay $1 — Unlock Creation";

function setPhantom(present: boolean): void {
  const w = window as unknown as { phantom?: unknown };
  if (present) {
    w.phantom = { solana: {} };
  } else {
    delete w.phantom;
  }
}

function connectWallet(): void {
  stableWallet.connected = true;
  stableWallet.account = WALLET_ACCOUNT;
  stableWallet.walletName = "Phantom";
}

/* ==== SCENARIOS ==== */

describe("Home Access Gate", () => {
  beforeEach(() => {
    // The suite routes all traffic through fetchMock (installed as the
    // global fetch); per-test routes are added with installFetchRoutes.
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    signMessageMock.mockClear();
    signSolanaUSDCPaymentMock.mockClear();
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(false);
    mobileDeeplinkMock.mockReset();
    stableWallet.connected = false;
    stableWallet.account = null;
    stableWallet.walletName = null;
    setPhantom(false);
    try {
      localStorage.clear();
    } catch {
      /* jsdom always provides localStorage */
    }
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: () => "00000000-0000-4000-8000-000000000000",
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // The pending-payment pointer is browser state shared by every test
    // in this jsdom environment: clear it so one scenario's submitted
    // transaction can never leak into the next.
    clearPendingPaymentAttempt();
    setPhantom(false);
  });

  it("1. desktop without Phantom shows the install notice and performs NO connect, NO SIWS, NO quote, NO payment", async () => {
    setPhantom(false);
    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Phantom Wallet Required"
      );
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("create-route")).toBeNull();
  });

  it("2. the install link is the official Phantom URL with no referral parameter", async () => {
    setPhantom(false);
    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    const link = await screen.findByRole("link", { name: "Install Phantom" });
    expect(PHANTOM_INSTALL_URL).toBe("https://phantom.com/download");
    expect(link.getAttribute("href")).toBe(PHANTOM_INSTALL_URL);
    expect(link.getAttribute("href")).not.toMatch(/ref=|referral|affiliate|utm_/i);
    expect(mobileDeeplinkMock).not.toHaveBeenCalled();
  });

  it("3. mobile without an injected Phantom offers 'Open in Phantom', the install link and the return instruction", async () => {
    isMobileMock.mockReturnValue(true);
    setPhantom(false);
    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(PHANTOM_MOBILE_TITLE);
    expect(alert.textContent).not.toContain("Phantom Wallet Required");
    // Clear fallback for a Phantom newcomer: the deep-link action, the
    // official install link and the "come back" instruction.
    expect(
      screen.getByRole("button", { name: PHANTOM_MOBILE_OPEN_LABEL })
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Install Phantom" })).toBeTruthy();
    expect(alert.textContent).toContain(
      "come back and tap Create Capsule again"
    );

    // Nothing happens before the user reaches Phantom — no redirect loop
    // inside Phantom's browser either (no navigation happened at all).
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mobileDeeplinkMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("create-route")).toBeNull();
  });

  it("4. mobile: 'Open in Phantom' invokes the installed public deeplink utility and still never connects, quotes or pays", async () => {
    isMobileMock.mockReturnValue(true);
    setPhantom(false);
    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    const openButton = await screen.findByRole("button", {
      name: PHANTOM_MOBILE_OPEN_LABEL,
    });

    fireEvent.click(openButton);

    expect(mobileDeeplinkMock).toHaveBeenCalledTimes(1);
    expect(mobileDeeplinkMock).toHaveBeenCalledWith(PHANTOM_EXPLORER_ID, "solana");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("5. mobile + injected Phantom (inside Phantom's own browser) keeps the normal headless flow — no deeplink, no redirect", async () => {
    isMobileMock.mockReturnValue(true);
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: AVAILABLE_DISCOVERY },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(() => {
      expect(
        fetchCallsTo("/api/creator/issue-challenge").length
      ).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mobileDeeplinkMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("6. discovery AVAILABLE (previously paid — including a closed browser) auto-navigates with NO payment", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: AVAILABLE_DISCOVERY },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // No editor, no $1: the unused right is discovered and admission is
    // granted in the same commit that moves the flow to paid.
    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 5000 }
    );

    // AVAILABLE discovery: exactly one signature and NO payment flow at
    // all (no pre-payment re-check is ever reached).
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/credit-status")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/verify-proof")).toHaveLength(0);
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(0);
  });

  it("7. discovery NONE -> one explicit $1 confirm -> single charge -> auto-navigate without a second click", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // Authoritative NO-CREDIT answer: stay on Home, $1 offered.
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: PAY_BUTTON })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.getByRole("status").textContent).toContain(
      "One-time setup — $1 USDC"
    );
    // Pre-payment state: exactly ONE signature (the discovery proof). The
    // pre-payment re-check has not run yet.
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/verify-proof")).toHaveLength(1);
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("create-route")).toBeNull();

    // The single explicit payment trigger.
    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    // Admission lands and the gate navigates by itself — no second click.
    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 5000 }
    );

    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
    // One $1 = one capsule: one charge, one verification, one grant.
    // The authoritative PRE-SIGNATURE RE-READ adds a second create-quote
    // CALL, but it reuses the retained challenge (no extra wallet prompt)
    // and the server continues the SAME attempt — this stub answers with
    // ONE intent, so there is still exactly one quote and one grant.
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(2);
    // One payment attempt signs exactly three proofs: the discovery
    // proof, one pre-payment re-check, and the purchase-guard proof
    // taken when the quote is requested. The authoritative re-read adds
    // NO fourth prompt (it reuses the retained challenge).
    expect(signMessageMock).toHaveBeenCalledTimes(3);
  });

  it("7b. with a live session a fresh $1 needs only ONE identity signature (re-check + quote reuse it)", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF_WITH_SESSION },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );
    // Verification alone: exactly one signature so far.
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("create-route")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 5000 }
    );

    // ONE identity signature for the WHOLE fresh purchase: the pre-payment
    // re-check and the purchase-guard proof both reused the session. The
    // financial transaction is still a single $1 (one transfer, one
    // verification, one grant).
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
  });

  it("8. a failed verification stays on Home and only an EXPLICIT retry can charge again (never automatic)", async () => {
    setPhantom(true);
    connectWallet();
    let verifyAttempt = 0;
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      {
        match: "/api/service-payment/verify",
        respond: () => {
          verifyAttempt += 1;
          return verifyAttempt === 1 ? VERIFY_FAILED() : VERIFY_VERIFIED();
        },
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );

    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    // Failure keeps the creator on Home with a clear retry state.
    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "Payment could not be verified"
        ),
      { timeout: 5000 }
    );
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    // No automatic retry: exactly one failure, one verify call, one
    // payment attempt.
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(1);
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);

    // Explicit retry: the discovery answer is retained (no second
    // signature, no second discovery) and the payment is re-attempted.
    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 5000 }
    );
    // Discovery answer retained: the second attempt does NOT re-run
    // discovery or ask for a second signature for it, and the retained
    // quote means no second purchase-guard proof either. Four signatures
    // total: discovery + two pre-payment re-checks + one guard proof.
    expect(signMessageMock).toHaveBeenCalledTimes(4);
    expect(fetchCallsTo("/api/creator/credit-status")).toHaveLength(3);
    /**
     * SAME-INTENT RECOVERY: the retry RESUMES the transaction whose
     * signature is already known — it verifies it again instead of
     * sending a second transfer. Exactly ONE transfer is ever sent for
     * one purchase attempt, and the grant still happens exactly once.
     */
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(2);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
  });

  it("9. a verified grant WITHOUT creatorCreditId admits nobody: no navigation, no retry, support copy", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT_WITHOUT_ID },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "could not be activated"
        ),
      { timeout: 5000 }
    );

    // The payment happened exactly once; nothing was admitted, nothing
    // navigated, and the dead-end button cannot trigger a second charge.
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("create-route")).toBeNull();
    const deadEnd = screen.getByRole("button", { name: GATE_BUTTON });
    expect(deadEnd).toBeTruthy();
    fireEvent.click(deadEnd);
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "could not be activated"
    );
  });

  it("10. an identity failure surfaces the retry state and an explicit retry re-runs discovery", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      {
        match: "/api/creator/issue-challenge",
        respond: () => json({ ok: false, error: "CHALLENGE_ISSUANCE_FAILED" }, false),
      },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "Wallet verification was not completed"
        ),
      { timeout: 5000 }
    );
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();

    // Explicit retry re-enters discovery (the retained proof makes this a
    // second attempt, not a second $1).
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(2),
      { timeout: 5000 }
    );
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("11. an already-admitted session navigates immediately — no re-check, no fetch, no signature", async () => {
    setPhantom(true);
    connectWallet();

    render(tree({ seedAdmission: true }));

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("12. an authoritative CONSUMING answer OFFERS recovery but never acts on it automatically", async () => {
    setPhantom(true);
    connectWallet();
    // No localStorage hint at all: the attempt is discovered from the
    // server's own enumeration.
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () =>
          CONSUMING_DISCOVERY([
            {
              creatorCreditId: CREATOR_CREDIT_ID,
              lifecycleId: "lifecycle-authoritative",
              capsuleId: "c".repeat(64),
            },
          ]),
      },
      {
        match: "/api/creator/recover-lifecycle",
        respond: () =>
          json({ ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE" }),
      },
    ]);

    render(tree());

    // The access gate only discovers the entitlement on an explicit click —
    // exactly like the real Home page.
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // The affordance exists (authoritative, not hint-driven)...
    const recoverButton = await screen.findByRole("button", {
      name: "Restore creation right",
    });
    expect(recoverButton).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain(
      "unfinished capsule attempt"
    );

    // …but nothing was called: no unmount, tab-close or visit hook.
    expect(fetchCallsTo("/api/creator/recover-lifecycle")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: PAY_BUTTON })).toBeNull();
  });

  it("13. recovery 'restored' re-runs the canonical access flow without a second $1", async () => {
    setPhantom(true);
    connectWallet();
    let discoveryCalls = 0;
    // No localStorage hint: the recovery identifiers come from the server.
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () => {
          discoveryCalls += 1;
          // Before the restore the right is CONSUMING; after it the server
          // reports the restored AVAILABLE credit (no second $1).
          return discoveryCalls === 1
            ? CONSUMING_DISCOVERY([
                {
                  creatorCreditId: CREATOR_CREDIT_ID,
                  lifecycleId: "lifecycle-access-gate",
                  capsuleId: "c".repeat(64),
                },
              ])
            : AVAILABLE_DISCOVERY();
        },
      },
      {
        match: "/api/creator/recover-lifecycle",
        respond: () => json({ ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE" }),
      },
    ]);

    render(tree());

    // The access gate only discovers the entitlement on an explicit click —
    // exactly like the real Home page.
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore creation right" })
    );

    // The DO restored the right: discovery re-runs and the restored credit
    // is discovered WITHOUT a new $1.
    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 8000 }
    );
    expect(fetchCallsTo("/api/creator/recover-lifecycle")).toHaveLength(1);
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    // Discovery ran twice: once before the recovery, once after it.
    expect(fetchCallsTo("/api/creator/credit-status").length).toBeGreaterThanOrEqual(2);

    // D3: the request carried a SIGNED owner proof, not just identifiers.
    const recoverCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("recover-lifecycle")
    );
    const sentBody = JSON.parse(
      String(
        (recoverCall as unknown as [unknown, RequestInit?] | undefined)?.[1]
          ?.body ?? "{}"
      )
    ) as Record<string, unknown>;
    expect(sentBody["challengeId"]).toBeTruthy();
    expect(sentBody["signature"]).toBeTruthy();
    expect(sentBody["network"]).toBe("solana");
    expect(sentBody["account"]).toBe(WALLET_ACCOUNT);
    // …and the identifiers came from the AUTHORITATIVE enumeration.
    expect(sentBody["lifecycleId"]).toBe("lifecycle-access-gate");
    expect(sentBody["capsuleId"]).toBe("c".repeat(64));
  });

  it("13b. SCENARIO 9: a recovery attempt without an owner proof is refused and restores nothing", async () => {
    setPhantom(true);
    connectWallet();
    // The wallet can still DISCOVER the attempt, but the challenge for the
    // recovery owner proof is refused by the server (expired): no valid
    // proof ⇒ no restore, whatever the identifiers are.
    let challengeCalls = 0;
    installFetchRoutes([
      {
        match: "/api/creator/issue-challenge",
        respond: () => {
          challengeCalls += 1;
          return challengeCalls === 1
            ? CHALLENGE_RESPONSE()
            : json({ ok: false, error: "CHALLENGE_EXPIRED" }, false);
        },
      },
      {
        match: "/api/creator/credit-status",
        respond: () =>
          CONSUMING_DISCOVERY([
            {
              creatorCreditId: CREATOR_CREDIT_ID,
              lifecycleId: "lifecycle-access-gate",
              capsuleId: "c".repeat(64),
            },
          ]),
      },
      {
        match: "/api/creator/recover-lifecycle",
        respond: () => json({ ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE" }),
      },
    ]);

    render(tree());

    // The access gate only discovers the entitlement on an explicit click —
    // exactly like the real Home page.
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore creation right" })
    );

    await waitFor(
      () =>
        expect(screen.getByRole("note").textContent).toContain(
          "Connect the wallet that paid"
        ),
      { timeout: 8000 }
    );

    // Nothing was restored, nothing navigated, nothing was charged.
    expect(fetchCallsTo("/api/creator/recover-lifecycle")).toHaveLength(0);
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("14. recovery 'blocked' keeps the attempt recoverable, navigates nowhere and shows support copy", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () =>
          CONSUMING_DISCOVERY([
            {
              creatorCreditId: CREATOR_CREDIT_ID,
              lifecycleId: "lifecycle-access-gate",
              capsuleId: "c".repeat(64),
            },
          ]),
      },
      {
        match: "/api/creator/recover-lifecycle",
        respond: () =>
          json({ ok: true, outcome: "SEAL_VERIFIED_AWAITING_FINALIZATION" }),
      },
    ]);

    render(tree());

    // The access gate only discovers the entitlement on an explicit click —
    // exactly like the real Home page.
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore creation right" })
    );

    await waitFor(
      () =>
        expect(screen.getByRole("note").textContent).toContain(
          "cannot be undone"
        ),
      { timeout: 8000 }
    );

    expect(screen.queryByTestId("create-route")).toBeNull();
    // The attempt is still recoverable in the UI (the server refused the
    // restore, it did not resolve the right).
    expect(
      screen.getByRole("button", { name: "Restore creation right" })
    ).toBeTruthy();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("15. the primary button is disabled while discovery is in flight", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: AVAILABLE_DISCOVERY },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // The click commits synchronously (CREATE_CLICKED → discovering), so
    // the busy disable is observable BEFORE the async verification chain
    // resolves — together with an in-flight status line.
    expect(
      (screen.getByRole("button") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(
      /Connecting wallet|Verifying wallet|Checking/
    );

    // The flow then completes and navigates; no $1 was ever requested.
    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("16. SCENARIO 3: authoritative CONSUMING (no localStorage hint) offers recovery and NEVER a second $1", async () => {
    setPhantom(true);
    connectWallet();
    // localStorage deliberately EMPTY - the attempt is found by the server.
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () =>
          CONSUMING_DISCOVERY([
            {
              creatorCreditId: CREATOR_CREDIT_ID,
              lifecycleId: "lifecycle-authoritative",
              capsuleId: "c".repeat(64),
            },
          ]),
      },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "already have a creation right"
        ),
      { timeout: 8000 }
    );

    // NO invitation to pay, NO editor, NO navigation, NO payment.
    expect(screen.queryByRole("button", { name: PAY_BUTTON })).toBeNull();
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    // The primary action in this state is a re-check, never a payment.
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    // The safe way out is offered instead of a payment.
    expect(
      screen.getByRole("button", { name: "Restore creation right" })
    ).toBeTruthy();
  });

  it("17. SCENARIO 4: an unreadable discovery answer fails closed - no $1 is offered", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () => json({ ok: true, status: "something-unexpected" }),
      },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "Something went wrong"
        ),
      { timeout: 8000 }
    );

    expect(screen.queryByRole("button", { name: PAY_BUTTON })).toBeNull();
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("18. SCENARIO 4b: a server error during discovery fails closed - no $1 is offered", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () =>
          json({ ok: false, error: "DISCOVERY_UNAVAILABLE" }, false),
      },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () => expect(screen.getByRole("status").textContent).not.toBe(""),
      { timeout: 8000 }
    );

    expect(screen.queryByRole("button", { name: PAY_BUTTON })).toBeNull();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("19. SCENARIO 5/6: several authoritative unfinished attempts are offered independently", async () => {
    setPhantom(true);
    connectWallet();
    // No localStorage hints: both attempts come from the server.
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () =>
          CONSUMING_DISCOVERY([
            {
              creatorCreditId: "creator-credit-alpha",
              lifecycleId: "lifecycle-alpha",
              capsuleId: "a".repeat(64),
            },
            {
              creatorCreditId: "creator-credit-beta",
              lifecycleId: "lifecycle-beta",
              capsuleId: "b".repeat(64),
            },
          ]),
      },
    ]);

    render(tree());

    // The access gate only discovers the entitlement on an explicit click —
    // exactly like the real Home page.
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // Two independent affordances, one per authoritative attempt.
    const buttons = await screen.findAllByRole("button", {
      name: /Restore right /,
    });
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("note").textContent).toContain("2 unfinished");
    // No payment offer in this state.
    expect(screen.queryByRole("button", { name: PAY_BUTTON })).toBeNull();
  });

  it("20. SCENARIO 10/11: the pre-payment re-check finds an AVAILABLE right and the new payment is cancelled", async () => {
    setPhantom(true);
    connectWallet();
    // The first discovery says "no rights"; by the time the user actually
    // presses Pay, the KV record has become visible (KV eventual
    // consistency) - the fresh re-check must catch it BEFORE any money
    // moves.
    let discoveryCalls = 0;
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () => {
          discoveryCalls += 1;
          return discoveryCalls === 1
            ? NO_CREDIT_DISCOVERY()
            : AVAILABLE_DISCOVERY();
        },
      },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: PAY_BUTTON })
        ).toBeTruthy(),
      { timeout: 8000 }
    );

    // Explicit pay: the re-check runs first and finds the right.
    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 8000 }
    );

    // NOTHING was charged: no quote, no transfer, no grant.
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(0);
  });

  it("21. SCENARIO 12: an UNCONFIRMED absence never authorises payment - the check is repeated first", async () => {
    setPhantom(true);
    connectWallet();
    let discoveryCalls = 0;
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () => {
          discoveryCalls += 1;
          // discovery, then one UNCONFIRMED re-check answer, then confirmed.
          return discoveryCalls === 2
            ? UNCONFIRMED_NONE_DISCOVERY()
            : NO_CREDIT_DISCOVERY();
        },
      },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 8000 }
    );

    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    // The creator is told why the payment has not started.
    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "Checking your creation right"
        ),
      { timeout: 8000 }
    );

    // Only after the CONFIRMED absence does the payment proceed - exactly
    // one charge, as before.
    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 20000 }
    );
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
  });

  it("22. SCENARIO 12b: a failing re-check refuses the payment instead of charging", async () => {
    setPhantom(true);
    connectWallet();
    let discoveryCalls = 0;
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () => {
          discoveryCalls += 1;
          // The discovery answers fine; every re-check fails.
          return discoveryCalls === 1
            ? NO_CREDIT_DISCOVERY()
            : json(
                { ok: false, error: "ENTITLEMENT_ENUMERATION_INCOMPLETE" },
                false
              );
        },
      },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 8000 }
    );

    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "could not confirm"
        ),
      { timeout: 8000 }
    );

    // Nothing was charged, and the $1 button stays available for a retry.
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy();
  });

  it("23. a CONSUMED-only right is reported as used, and a new $1 remains possible", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () =>
          json({
            ok: true,
            status: "none",
            creatorCreditId: null,
            creatorIdentityId: CREATOR_IDENTITY_ID,
            account: WALLET_ACCOUNT,
            summary: {
              availableCount: 0,
              consumingCount: 0,
              consumedCount: 1,
              total: 1,
              enumerationComplete: true,
            },
            unfinishedLifecycles: [],
          }),
      },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain("was used"),
      { timeout: 8000 }
    );
    // The $1 offer is still available for the next capsule.
    expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy();
  });

  it("16. a stale quote whose purchase is ALREADY GRANTED continues the access flow — no charge", async () => {
    setPhantom(true);
    connectWallet();
    let discoveryCalls = 0;
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        // First discovery: no right yet, so the $1 is offered. The
        // re-discovery that follows the GRANTED answer finds the credit
        // that another tab/device has already produced.
        respond: () =>
          (discoveryCalls += 1) === 1
            ? NO_CREDIT_DISCOVERY()
            : AVAILABLE_DISCOVERY(),
      },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      {
        match: "/api/service-payment/create-quote",
        respond: CREATE_QUOTE_GRANTED,
      },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: PAY_BUTTON })
        ).toBeTruthy(),
      { timeout: 5000 }
    );

    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    // The gate continues the EXISTING access flow: the authoritative
    // discovery admits the creator on the credit that already exists.
    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 8000 }
    );

    // NOTHING was charged, verified or granted a second time.
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
  });

  /**
   * READ-ONLY "Check again" (Stage B).
   *
   * A locally held payment attempt may be re-checked without ANY wallet
   * request: the reconciliation reads the chain directly and the
   * verification of the SAME transaction is signature-free.
   */
  function seedStalePointerForGate(): void {
    const tx = "MockRecheckTransactionSignatureForGate".padEnd(64, "A");
    const seeded = writePendingPaymentAttempt({
      version: 2,
      paymentIntentId: "intent-gate-recheck",
      creatorIdentityId: CREATOR_IDENTITY_ID,
      network: "solana",
      account: WALLET_ACCOUNT,
      transactionId: tx,
      signedTransaction: "bW9jay1zaWduZWQ=",
      blockhash: "mock-blockhash",
      lastValidBlockHeight: 12345,
      outcome: "submitted",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(seeded).toBe(true);
  }

  const SOLANA_RPC_ROUTES = [
    {
      match: "/api/solana/rpc",
      respond: (init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          id?: unknown;
          method?: string;
        };
        if (body.method === "getBlockHeight") {
          return json({ jsonrpc: "2.0", id: body.id, result: 999999999 });
        }
        if (body.method === "getSignatureStatuses") {
          return json({
            jsonrpc: "2.0",
            id: body.id,
            result: { context: { slot: 1 }, value: [null] },
          });
        }
        return json({ jsonrpc: "2.0", id: body.id, result: null });
      },
    },
  ];

  it("offers a read-only Check again that opens NO wallet window and sends NO payment", async () => {
    connectWallet();
    setPhantom(true);
    seedStalePointerForGate();
    installFetchRoutes(SOLANA_RPC_ROUTES);

    render(tree());

    const checkAgain = await screen.findByRole("button", {
      name: "Check again (no payment)",
    });
    fireEvent.click(checkAgain);

    await waitFor(() => {
      expect(screen.getByText(/provably absent on Solana/i)).toBeTruthy();
    });

    // Read-only: no identity signature, no transaction signature, no
    // broadcast, no new quote/intent.
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    // The provably stale pointer was released.
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("a repeated click never starts a concurrent check", async () => {
    connectWallet();
    setPhantom(true);
    seedStalePointerForGate();
    installFetchRoutes(SOLANA_RPC_ROUTES);

    render(tree());

    const checkAgain = await screen.findByRole("button", {
      name: "Check again (no payment)",
    });
    // Two clicks in the SAME tick, before the first check settles.
    fireEvent.click(checkAgain);
    fireEvent.click(checkAgain);

    await waitFor(() => {
      expect(screen.getByText(/provably absent on Solana/i)).toBeTruthy();
    });

    // ONE reconciliation = exactly three read-only RPC calls; a second
    // concurrent check would have doubled them.
    expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(3);
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });
});

/**
 * PRODUCTION REGRESSIONS (INVALID_INSTRUCTION_COUNT + repeated signatures)
 *
 * The server refused a signed transaction and the gate showed the generic
 * "Something went wrong. Please try again." copy, inviting an immediate
 * retry. Two invariants are pinned here:
 *
 *  - a KNOWN server-side transaction-format refusal gets its own
 *    explanation and never the generic fallback;
 *  - while a wallet request is in flight, an extra click opens NO second
 *    signature window.
 */
describe("Home Access Gate — server refusal and in-flight protection", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    signMessageMock.mockClear();
    signSolanaUSDCPaymentMock.mockClear();
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(false);
    mobileDeeplinkMock.mockReset();
    stableWallet.connected = false;
    stableWallet.account = null;
    stableWallet.walletName = null;
    setPhantom(false);
    try {
      localStorage.clear();
    } catch {
      /* jsdom always provides localStorage */
    }
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: () => "00000000-0000-4000-8000-000000000000",
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearPendingPaymentAttempt();
    setPhantom(false);
  });

  it("16. a server-side transaction-format refusal shows a specific explanation, never the generic failure", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes(
      [
        { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
        { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
        { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
        { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
        { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
        { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
      ],
      /**
       * The endpoint refuses the transaction format BEFORE submitting it.
       * No classification field is present on purpose: an envelope the
       * client cannot vouch for must NOT be treated as a proven pre-send
       * refusal.
       */
      () => json({ ok: false, error: "INVALID_INSTRUCTION_COUNT" }, false)
    );

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () => expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );

    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain(
          "rejected by our server"
        ),
      { timeout: 5000 }
    );

    const statusText = screen.getByRole("status").textContent ?? "";
    // The specific reason is surfaced, never the generic fallback...
    expect(statusText).not.toContain("Something went wrong");
    // ...and it makes no claim about the user's funds.
    expect(statusText).not.toMatch(/not charged|nothing was charged|no money/i);
    // Nothing beyond the single refused attempt was ever attempted.
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(screen.queryByTestId("create-route")).toBeNull();
  });
});

/**
 * IN-FLIGHT CLICK PROTECTION
 *
 * A second click while a wallet request is running must not start a second
 * flow — that is what used to open a second Phantom signature window.
 */
describe("Home Access Gate — in-flight click protection", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    signMessageMock.mockClear();
    signSolanaUSDCPaymentMock.mockClear();
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(false);
    mobileDeeplinkMock.mockReset();
    stableWallet.connected = false;
    stableWallet.account = null;
    stableWallet.walletName = null;
    setPhantom(false);
    try {
      localStorage.clear();
    } catch {
      /* jsdom always provides localStorage */
    }
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: () => "00000000-0000-4000-8000-000000000000",
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearPendingPaymentAttempt();
    setPhantom(false);
  });

  it("17. an extra click while a wallet request is in flight opens NO second signature window", async () => {
    setPhantom(true);
    connectWallet();

    // The discovery answer is withheld until this test releases it, so the
    // gate is genuinely MID-FLIGHT when the extra click happens.
    // (Initialised to a no-op: the resolver is assigned inside the promise
    // executor, which the compiler cannot observe.)
    let releaseDiscovery: () => void = () => {};
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      {
        match: "/api/creator/credit-status",
        respond: () => ({
          ok: true,
          json: async () => {
            await discoveryGate;
            return NO_CREDIT_DISCOVERY_BODY;
          },
        }),
      },
    ]);

    render(tree());

    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // The signature window is open: exactly one challenge, one signature.
    await waitFor(() => expect(signMessageMock).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
    expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(1);

    // The primary action is blocked for the whole in-flight window...
    const primary = screen.getByRole("button") as HTMLButtonElement;
    await waitFor(() => expect(primary.disabled).toBe(true));

    // ...so repeated clicks start nothing new.
    fireEvent.click(primary);
    fireEvent.click(primary);

    expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(1);
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();

    releaseDiscovery();

    // The withheld answer lands and the flow continues normally, still with
    // exactly ONE identity signature for the whole discovery.
    await waitFor(
      () => expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(1);
  });
});