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
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
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

vi.mock("@/context/AETERNAWalletContext", () => {
  /**
   * A NEW value whenever the connected wallet actually changes — exactly what
   * the real context memoizes — and the SAME value otherwise. A wallet-moving
   * scenario (account switch / disconnect) therefore reaches every wallet
   * effect in the gate, while an ordinary re-render changes nothing.
   */
  let snapshot: typeof stableWallet | null = null;
  return {
    useAeternaWallet: () => {
      if (
        !snapshot ||
        snapshot.connected !== stableWallet.connected ||
        snapshot.account !== stableWallet.account ||
        snapshot.walletName !== stableWallet.walletName
      ) {
        snapshot = { ...stableWallet };
      }
      return snapshot;
    },
  };
});

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

/**
 * The request `init` of every fetch call to a matching endpoint: the body
 * carries the identity of the caller (the evidence id).
 */
const fetchInitsTo = (fragment: string) =>
  (
    fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit | undefined]
    >
  )
    .filter((call) => String(call[0]).includes(fragment))
    .map((call) => call[1]);

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

/**
 * Renders the in-memory admission the UI actually acts on (`none` while the
 * session holds no right). It makes "no admission was granted" directly
 * observable instead of inferring it from the absence of navigation.
 */
function AdmissionProbe() {
  const { admission } = useCreateAccess();
  return React.createElement(
    "div",
    { "data-testid": "admission" },
    admission ? `${admission.account}|${admission.creatorCreditId}` : "none"
  );
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
            React.createElement(AdmissionProbe),
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

/** The OTHER wallet account ("B") — never the owner of A's credit. */
const WALLET_ACCOUNT_B = "9YtRqBase58WalletAccountAccessGateB";

/**
 * Move the CONNECTED wallet (switch account, or disconnect) and re-render the
 * gate, so the whole component observes the new connection — exactly as the
 * real provider does when the wallet state changes.
 */
async function moveWallet(
  view: { rerender: (element: React.ReactElement) => void },
  next: { connected: boolean; account: string | null }
): Promise<void> {
  stableWallet.connected = next.connected;
  stableWallet.account = next.account;
  stableWallet.walletName = next.connected ? "Phantom" : null;
  await act(async () => {
    view.rerender(tree());
  });
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
    /**
     * The verifier does NOT confirm the transaction until the test allows
     * it. The AUTOMATIC same-attempt recovery (Stage B.1) therefore keeps
     * re-checking the SAME transaction WITHOUT completing anything, and a
     * new payment remains impossible.
     */
    let acceptVerification = false;
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      {
        match: "/api/service-payment/verify",
        respond: () => (acceptVerification ? VERIFY_VERIFIED() : VERIFY_FAILED()),
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
    const signaturesBeforeAutoCheck = signMessageMock.mock.calls.length;

    // Stage B.1: the SAME saved attempt is re-checked AUTOMATICALLY. It
    // re-verifies the recorded transaction without any wallet request, and
    // with an UNCONFIRMED verifier it signs nothing, grants nothing and
    // navigates nowhere.
    await waitFor(
      () => expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(2),
      { timeout: 5000 }
    );
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(signMessageMock.mock.calls.length).toBe(signaturesBeforeAutoCheck);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(screen.queryByTestId("create-route")).toBeNull();

    // The creator's EXPLICIT retry: the discovery answer is retained (no
    // second signature, no second discovery) and the SAME transaction is
    // re-verified.
    acceptVerification = true;
    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 5000 }
    );
    // Discovery answer retained: the second attempt does NOT re-run
    // discovery or ask for a second signature for it, and the retained
    // quote means no second purchase-guard proof either. Four signatures
    // total: discovery + two pre-payment re-checks + one guard proof (the
    // automatic recovery adds NO wallet request).
    expect(signMessageMock).toHaveBeenCalledTimes(4);
    expect(fetchCallsTo("/api/creator/credit-status")).toHaveLength(3);
    /**
     * SAME-INTENT RECOVERY: the retry RESUMES the transaction whose
     * signature is already known — it verifies it again instead of
     * sending a second transfer. Exactly ONE transfer is ever sent for
     * one purchase attempt, and the grant still happens exactly once.
     * Three verify calls: the explicit attempt, the AUTOMATIC read-only
     * re-check of that same attempt, and the resumed verification.
     */
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(3);
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
   * Stage B.1 — AUTOMATIC recovery of a saved payment attempt.
   *
   * A locally held payment attempt with a known transaction signature is
   * ALWAYS recovered automatically: the read-only check runs on its own (no
   * wallet request, no payment), a transient failure is retried a BOUNDED
   * number of times with backoff, and a payment the verifier CONFIRMS is
   * completed through the canonical idempotent grant so the normal flow
   * advances without a second click and without a second payment.
   */
  function seedStalePointerForGate(
    paymentIntentId = "intent-gate-recheck"
  ): void {
    const tx = "MockRecheckTransactionSignatureForGate".padEnd(64, "A");
    const seeded = writePendingPaymentAttempt({
      version: 2,
      paymentIntentId,
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

  /** Read-only RPC reads that KEEP the pointer (window not provably expired). */
  const SOLANA_RPC_ROUTES_KEPT = [
    {
      match: "/api/solana/rpc",
      respond: (init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          id?: unknown;
          method?: string;
        };
        if (body.method === "getBlockHeight") {
          // Still inside the recorded window (+margin): never releasable.
          return json({ jsonrpc: "2.0", id: body.id, result: 12345 });
        }
        return json({ jsonrpc: "2.0", id: body.id, result: null });
      },
    },
  ];

  /**
   * A `/api/service-payment/verify` responder keyed by the CALLER's evidence
   * id, so a scenario can distinguish the three independent callers:
   *   - `payment-recheck-…`            the recovery's read-only re-check;
   *   - `payment-attempt-recovery-…`   the recovery's canonical completion;
   *   - `payment-modal-…`              an explicit "Pay $1".
   */
  function verifyByCaller(outcomes: {
    recheck: () => ReturnType<typeof json>;
    completion: () => ReturnType<typeof json>;
    explicit: () => ReturnType<typeof json>;
  }): (init?: RequestInit) => ReturnType<typeof json> {
    return (init?: RequestInit) => {
      const evidenceId = String(
        JSON.parse(String(init?.body ?? "{}")).evidenceId ?? ""
      );
      if (evidenceId.startsWith("payment-recheck-")) return outcomes.recheck();
      if (evidenceId.startsWith("payment-attempt-recovery-")) {
        return outcomes.completion();
      }
      return outcomes.explicit();
    };
  }

  /** How many verify calls a given caller (evidence prefix) made. */
  function verifyCallsBy(prefix: string): number {
    return fetchInitsTo("/api/service-payment/verify").filter((init) =>
      String(init?.body ?? "").includes(`"evidenceId":"${prefix}`)
    ).length;
  }

  it("B1.1 — the manual 'Check again (no payment)' button is gone and the read-only check runs AUTOMATICALLY", async () => {
    connectWallet();
    setPhantom(true);
    seedStalePointerForGate();
    installFetchRoutes(SOLANA_RPC_ROUTES);

    render(tree());

    // No manual control exists anywhere in the interface.
    expect(
      screen.queryByRole("button", { name: "Check again (no payment)" })
    ).toBeNull();

    // With NO click at all, the check ran and the PROVEN release cleared the
    // saved pointer.
    await waitFor(() => {
      expect(readPendingPaymentAttempt()).toBeNull();
    });

    // The first page carries ONLY the permanent first-step hint — the
    // previous-attempt copy is never surfaced under CREATE CAPSULE.
    expect(screen.getByRole("status").textContent).toContain(
      "already have the right to create a capsule"
    );
    expect(screen.queryByText(/previous payment attempt/i)).toBeNull();
    expect(screen.queryByText(/window expired/i)).toBeNull();

    // Read-only reconciliation only: no wallet request of any kind.
    expect(fetchCallsTo("/api/solana/rpc").length).toBeGreaterThan(0);
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("B1.2 — a re-entry event during an in-flight check never starts a concurrent check", async () => {
    connectWallet();
    setPhantom(true);
    seedStalePointerForGate();

    // The reconciliation read hangs: the check stays in flight, so an
    // overlap is directly observable as a SECOND read.
    installFetchRoutes([
      {
        match: "/api/solana/rpc",
        respond: () => ({ ok: true, json: () => new Promise<never>(() => {}) }),
      },
    ]);

    render(tree());

    await waitFor(() => expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(1));

    // A natural re-entry event (network returned) must NOT open a second,
    // concurrent cycle while the first is still running.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(1);
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
  });

  it("B1.3 — a confirmed-on-chain attempt is preserved and needs no manual check and no second payment", async () => {
    connectWallet();
    setPhantom(true);
    seedStalePointerForGate();
    installFetchRoutes([
      ...SOLANA_RPC_ROUTES_KEPT,
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    // The automatic read-only re-check of the SAME transaction runs with no
    // click; the verifier CONFIRMS it, but the $1 step has not been entered
    // with the paying wallet yet, so nothing is completed from here.
    await waitFor(
      () => expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(1),
      { timeout: 5000 }
    );

    // The first page keeps the permanent first-step hint: the previous
    // payment is never announced under CREATE CAPSULE.
    expect(screen.getByRole("status").textContent).toContain(
      "already have the right to create a capsule"
    );
    expect(screen.queryByText(/previous payment/i)).toBeNull();

    // Nothing new was sent; the single saved attempt is preserved for the
    // automatic completion at the $1 step.
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(readPendingPaymentAttempt()?.transactionId).not.toBeNull();
  });

  it("B1.4 — a confirmed attempt at the $1 step is completed automatically with an idempotent grant and navigation", async () => {
    setPhantom(true);
    connectWallet();
    seedStalePointerForGate();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      ...SOLANA_RPC_ROUTES_KEPT,
      { match: "/api/service-payment/verify", respond: VERIFY_VERIFIED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    // The creator performs ONLY the normal first step (discovery).
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // No "Pay $1" click: the saved attempt is verified and granted
    // automatically, and the creator lands in creation.
    await waitFor(() => expect(screen.getByTestId("create-route")).toBeTruthy(), {
      timeout: 8000,
    });

    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    // The SAME transaction was granted exactly once (idempotent), and the
    // pointer is released only after the grant.
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("B1.5 — a transient failure triggers a BOUNDED automatic retry cycle with NO signature and keeps the attempt", async () => {
    connectWallet();
    setPhantom(true);
    seedStalePointerForGate();
    installFetchRoutes([
      {
        match: "/api/solana/rpc",
        // The read-only transport is temporarily unavailable.
        respond: () => ({ ok: false, json: async () => ({}) }),
      },
    ]);

    vi.useFakeTimers();
    try {
      render(tree());

      // The FIRST check runs on its own.
      await act(async () => {});
      expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(1);

      // A bounded number of automatic retries follow, then it STOPS.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      const bounded = fetchCallsTo("/api/solana/rpc").length;
      expect(bounded).toBeGreaterThan(1);
      expect(bounded).toBeLessThanOrEqual(4);

      // No endless polling.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(bounded);

      // No wallet request of any kind; the attempt is KEPT.
      expect(signMessageMock).not.toHaveBeenCalled();
      expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
      expect(readPendingPaymentAttempt()?.transactionId).toBe(
        "MockRecheckTransactionSignatureForGate".padEnd(64, "A")
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("B1.6 — an inherited controller error does NOT abort the automatic completion of a CONFIRMED attempt (paid + navigation, no click)", async () => {
    setPhantom(true);
    connectWallet();
    /**
     * The EXPLICIT $1 fails TRANSIENTLY, which leaves the controller in
     * `phase === "error"` while the attempt (with its transaction id) is
     * KEPT — exactly the state a confirmed previous attempt is recovered
     * from. The recovery's own COMPLETION is withheld so the $1 step it
     * opens is really COMMITTED while that stale error is still the
     * controller's phase.
     */
    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: () => VERIFY_VERIFIED(),
          completion: () => ({
            ok: true,
            json: () =>
              completionGate.then(() => ({ ok: true, status: "VERIFIED" })),
          }),
          explicit: () => VERIFY_FAILED(),
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    // 1) The normal first step, then ONE explicit $1 that FAILS.
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
          "Payment could not be verified"
        ),
      { timeout: 5000 }
    );
    expect(screen.queryByTestId("create-route")).toBeNull();
    const signaturesAfterFailure = signMessageMock.mock.calls.length;

    // 2) With NO further user interaction the AUTOMATIC recovery re-checks
    //    the SAME transaction, finds it confirmed and CONTINUES it: it
    //    enters the $1 step and awaits the canonical completion.
    await waitFor(
      // `Processing…` is ONLY reachable in `payment-in-progress`: it proves
      // the inherited `error` did NOT send the flow back to `needs-payment`.
      () => expect(screen.getByRole("status").textContent).toContain("Processing"),
      { timeout: 5000 }
    );
    expect(screen.queryByRole("button", { name: PAY_BUTTON })).toBeNull();

    // 3) The canonical completion succeeds (a VERIFIED verdict + an
    //    idempotent grant) and the flow must reach `paid` and NAVIGATE.
    await act(async () => {
      releaseCompletion();
    });

    await waitFor(() => expect(screen.getByTestId("create-route")).toBeTruthy(), {
      timeout: 8000,
    });

    // Exactly ONE transfer was ever signed and sent; the recovery minted no
    // new intent, asked for no signature and broadcast nothing.
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(1);
    // Two create-quote calls are the EXPLICIT payment's own (the quote and
    // the pre-signature re-read, as in test 7) — the recovery added none.
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(2);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
    expect(signMessageMock.mock.calls.length).toBe(signaturesAfterFailure);
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("B1.7 — a generation change during the pending completion still releases the $1 step (never stuck in Processing)", async () => {
    setPhantom(true);
    connectWallet();
    seedStalePointerForGate();

    /**
     * The recovery's COMPLETION is withheld, so the flow is genuinely
     * `payment-in-progress` when the generation changes; it then resolves as
     * a TRANSIENT failure.
     */
    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const gatedCompletionFailure = () => ({
      ok: true,
      json: () =>
        completionGate.then(() => ({
          ok: true,
          error: "PAYMENT_VERIFICATION_FAILED",
        })),
    });

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      ...SOLANA_RPC_ROUTES_KEPT,
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: VERIFY_VERIFIED,
          completion: gatedCompletionFailure,
          explicit: VERIFY_FAILED,
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // The recovery confirmed the read-only check and entered the $1 step;
    // the completion is blocked, so the UI is unmistakably mid-payment.
    await waitFor(
      () => expect(screen.getByRole("status").textContent).toContain("Processing"),
      { timeout: 5000 }
    );
    expect(screen.queryByRole("button", { name: PAY_BUTTON })).toBeNull();

    // A generation change while the completion is pending: account,
    // admission or a natural event. It must not abandon the $1 step.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    // The stale result lands as a transient failure. The step the recovery
    // ITSELF opened has to be released — never left simulating work.
    await act(async () => {
      releaseCompletion();
    });
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );

    // Nothing financial happened and no new attempt was opened.
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(readPendingPaymentAttempt()).not.toBeNull();
  });

  it("B1.8 — a re-arm signal during an in-flight check is honoured after it settles (never in parallel, never lost)", async () => {
    connectWallet();
    setPhantom(true);
    seedStalePointerForGate();

    // The FIRST read hangs: the check stays in flight, so a concurrent
    // check would be directly observable as a SECOND read.
    let releaseFirstRead: () => void = () => {};
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let rpcCalls = 0;
    installFetchRoutes([
      {
        match: "/api/solana/rpc",
        respond: () => {
          rpcCalls += 1;
          if (rpcCalls === 1) {
            return { ok: true, json: () => firstReadGate.then(() => ({})) };
          }
          // Every later read keeps the pointer (fail closed).
          return { ok: false, json: async () => ({}) };
        },
      },
      { match: "/api/service-payment/verify", respond: VERIFY_FAILED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());
    await waitFor(() => expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(1));

    // A natural re-entry event arrives WHILE the check is running: it must
    // not open a second, concurrent check...
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(1);

    // ...but it must not be LOST either: once the running check settles, the
    // pending signal re-arms one further bounded cycle.
    await act(async () => {
      releaseFirstRead();
    });
    await waitFor(
      () => expect(fetchCallsTo("/api/solana/rpc").length).toBeGreaterThan(1),
      { timeout: 5000 }
    );

    // One further signal, one further cycle — never an amplification.
    const settled = fetchCallsTo("/api/solana/rpc").length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(
      () => expect(fetchCallsTo("/api/solana/rpc")).toHaveLength(settled + 1),
      { timeout: 5000 }
    );

    // All of it stayed read-only: no wallet request, no payment, no grant,
    // and the single saved attempt is KEPT.
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(readPendingPaymentAttempt()).not.toBeNull();
  });

  it("B1.9 — the recovery's own unwind never swallows the NEXT genuine entry into the $1 step", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      ...SOLANA_RPC_ROUTES_KEPT,
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: VERIFY_VERIFIED,
          completion: VERIFY_FAILED,
          explicit: VERIFY_FAILED,
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());

    // The normal first step reaches the $1 step with NO saved attempt yet.
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(verifyCallsBy("payment-recheck-")).toBe(0);

    /**
     * Flush the $1 step's ARRIVAL re-arm signal while NO saved attempt exists
     * yet, so the recovery can only start from the natural signal below. (A
     * late flush would start a first cycle that the signal then supersedes —
     * the same, correct read-only check run twice, which is what a signal
     * arriving during a check is designed to do.)
     */
    await act(async () => {});

    /**
     * A saved attempt appears (carrying the intent the $1 step uses). The
     * next natural signal starts the recovery: it CONFIRMS the previous
     * transaction, its canonical completion fails TRANSIENTLY, and the
     * recovery unwinds its OWN $1 step back to `needs-payment`.
     */
    seedStalePointerForGate("payment-intent-access-gate");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(
      () => expect(verifyCallsBy("payment-attempt-recovery-")).toBe(1),
      { timeout: 5000 }
    );

    // The recovery's OWN unwind opened NO second, overlapping cycle: one
    // re-check produced that one completion.
    expect(verifyCallsBy("payment-recheck-")).toBe(1);
    expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy();

    /**
     * The NEXT entry into the $1 step is INDEPENDENT (an explicit "Pay $1"
     * that fails). The marker left by the recovery's own unwind must not
     * swallow it: the automatic recovery has to run again.
     */
    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));

    await waitFor(
      () => expect(verifyCallsBy("payment-recheck-")).toBe(2),
      { timeout: 5000 }
    );

    // The explicit retry RESUMED the recorded transaction: no second
    // transfer was signed or sent and nothing was granted.
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(readPendingPaymentAttempt()).not.toBeNull();
  });

  /**
   * ─── Stage B.1.4 — a settlement that belongs to ANOTHER connection ───
   *
   * The server side of a purchase is settled for ITS owner; whether that
   * result may be applied to THIS interface is a separate fact. These
   * scenarios move the connected wallet (switch / disconnect) while the
   * canonical completion — or an explicit payment's verification — is still
   * in flight, and then let it land SUCCESSFULLY for the original account.
   *
   * In every case the credit stays settled server-side for A (the grant
   * request is made, the pointer is released by that settlement), while the
   * current UI must receive nothing: no admission, no `paid`, no navigation
   * and no second purchase of any kind.
   */

  /** A verify answer that lands only when the test releases it. */
  function gatedVerified(release: Promise<void>) {
    return {
      ok: true,
      json: () => release.then(() => ({ ok: true, status: "VERIFIED" })),
    };
  }

  /**
   * A: the account is SWITCHED while A's canonical completion is pending.
   */
  it("B1.10 (A) — a pending completion that lands after an ACCOUNT SWITCH never admits the new account", async () => {
    setPhantom(true);
    connectWallet();
    seedStalePointerForGate("payment-intent-access-gate");

    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      ...SOLANA_RPC_ROUTES_KEPT,
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: VERIFY_VERIFIED,
          completion: () => gatedVerified(completionGate),
          explicit: VERIFY_FAILED,
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    const view = render(tree());
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    // Under A the recovery confirmed the recorded transaction and entered the
    // $1 step to continue THAT attempt: the completion is genuinely pending.
    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain("Processing"),
      { timeout: 5000 }
    );
    expect(verifyCallsBy("payment-attempt-recovery-")).toBe(1);

    // The identity proof of the initial discovery is the only wallet prompt
    // so far; nothing may be added by the settlement of ANOTHER connection.
    const promptsBeforeSwitch = signMessageMock.mock.calls.length;

    // The user switches to a DIFFERENT wallet while it is pending.
    await moveWallet(view, { connected: true, account: WALLET_ACCOUNT_B });

    // The flow left the state that belonged to A and nothing navigated.
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: GATE_BUTTON })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.queryByTestId("create-route")).toBeNull();
    // Nothing was admitted for A's settlement in B's session either.
    expect(screen.getByTestId("admission").textContent).toBe("none");

    // The recorded attempt is NOT dropped by the switch itself: it is the
    // only record of A's transaction.
    expect(readPendingPaymentAttempt()).not.toBeNull();

    // A's settlement lands: the server settles the credit for A ...
    await act(async () => {
      releaseCompletion();
    });
    await waitFor(
      () => expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1),
      { timeout: 5000 }
    );

    // ... and the UI REFUSES to apply it to B.
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(screen.queryByText(/Creation right confirmed/)).toBeNull();
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.getByRole("button", { name: GATE_BUTTON })).toBeTruthy();
    expect(screen.getByTestId("admission").textContent).toBe("none");

    // No second purchase of ANY kind was opened for B.
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(signMessageMock.mock.calls.length).toBe(promptsBeforeSwitch);
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(verifyCallsBy("payment-modal-")).toBe(0);

    // The settled attempt is released by the SERVER fact (never left as a
    // dangling pointer that could re-enter a payment).
    await waitFor(
      () => expect(readPendingPaymentAttempt()).toBeNull(),
      { timeout: 5000 }
    );
  });

  /**
   * B: the wallet is DISCONNECTED while A's canonical completion is pending.
   */
  it("B1.11 (B) — a pending completion that lands after a DISCONNECT is never applied", async () => {
    setPhantom(true);
    connectWallet();
    seedStalePointerForGate("payment-intent-access-gate");

    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      ...SOLANA_RPC_ROUTES_KEPT,
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: VERIFY_VERIFIED,
          completion: () => gatedVerified(completionGate),
          explicit: VERIFY_FAILED,
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    const view = render(tree());
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain("Processing"),
      { timeout: 5000 }
    );

    // The user disconnects while the completion is pending.
    await moveWallet(view, { connected: false, account: null });

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: GATE_BUTTON })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(screen.getByTestId("admission").textContent).toBe("none");

    // A's settlement still completes server-side ...
    await act(async () => {
      releaseCompletion();
    });
    await waitFor(
      () => expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1),
      { timeout: 5000 }
    );

    // ... and is NEVER applied to a disconnected wallet.
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(screen.queryByText(/Creation right confirmed/)).toBeNull();
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.getByTestId("admission").textContent).toBe("none");
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(verifyCallsBy("payment-modal-")).toBe(0);
  });

  /**
   * C: the SAME protection on the ordinary explicit-payment path
   * (`confirmAndVerify`), which settles through the same shared callback.
   */
  it("B1.12 (C) — an EXPLICIT payment's settlement is equally bound to the account that paid it", async () => {
    setPhantom(true);
    connectWallet();

    let releaseVerify: () => void = () => {};
    const verifyGate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      ...SOLANA_RPC_ROUTES_KEPT,
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: VERIFY_VERIFIED,
          completion: VERIFY_FAILED,
          explicit: () => gatedVerified(verifyGate),
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    const view = render(tree());
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: PAY_BUTTON })).toBeTruthy(),
      { timeout: 5000 }
    );

    // The one explicit $1 is signed and sent under A; its verification is
    // withheld, so the flow really is mid-payment (Processing…).
    fireEvent.click(screen.getByRole("button", { name: PAY_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain("Processing"),
      { timeout: 5000 }
    );
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(1);
    const quotesAtSwitch = fetchCallsTo("/api/service-payment/create-quote").length;
    const signaturesAtSwitch = signMessageMock.mock.calls.length;

    // The user switches to B while A's payment is still being verified.
    await moveWallet(view, { connected: true, account: WALLET_ACCOUNT_B });

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: GATE_BUTTON })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.getByTestId("admission").textContent).toBe("none");
    expect(readPendingPaymentAttempt()).not.toBeNull();

    // A's payment is verified and granted server-side ...
    await act(async () => {
      releaseVerify();
    });
    await waitFor(
      () => expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1),
      { timeout: 5000 }
    );

    // ... and is never applied to B, and nothing financial is repeated.
    expect(screen.queryByTestId("create-route")).toBeNull();
    expect(screen.queryByText(/Creation right confirmed/)).toBeNull();
    expect(screen.getByTestId("admission").textContent).toBe("none");
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(1);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(
      quotesAtSwitch
    );
    expect(signMessageMock.mock.calls.length).toBe(signaturesAtSwitch);
  });

  /**
   * D: after the switch, the ORIGINAL owner re-obtains the right it already
   * owns — through the ordinary discovery, with no second charge.
   */
  it("B1.13 (D) — the original owner comes back and finds its settled right (no second $1)", async () => {
    setPhantom(true);
    connectWallet();
    seedStalePointerForGate("payment-intent-access-gate");

    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });

    /**
     * The server's answer about A's right: absent before the settlement,
     * AVAILABLE once the settled credit exists.
     */
    let creditRightExists = false;
    const creditStatus = () =>
      creditRightExists ? AVAILABLE_DISCOVERY() : NO_CREDIT_DISCOVERY();

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: creditStatus },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      ...SOLANA_RPC_ROUTES_KEPT,
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: VERIFY_VERIFIED,
          completion: () => gatedVerified(completionGate),
          explicit: VERIFY_FAILED,
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    const view = render(tree());
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain("Processing"),
      { timeout: 5000 }
    );

    // B interrupts and gets NOTHING from A's settlement.
    await moveWallet(view, { connected: true, account: WALLET_ACCOUNT_B });
    await act(async () => {
      releaseCompletion();
    });
    await waitFor(
      () => expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1),
      { timeout: 5000 }
    );
    expect(screen.queryByTestId("create-route")).toBeNull();
    await waitFor(
      () => expect(readPendingPaymentAttempt()).toBeNull(),
      { timeout: 5000 }
    );

    // The right is now settled for A...
    creditRightExists = true;

    // ...so when A comes back, the ordinary check finds it: admission and
    // navigation without a second payment.
    await moveWallet(view, { connected: true, account: WALLET_ACCOUNT });
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: GATE_BUTTON })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));

    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 8000 }
    );

    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    // Exactly the ONE grant A's settled payment produced.
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
    // A's own right is what the session now holds.
    expect(screen.getByTestId("admission").textContent).toBe(
      `${WALLET_ACCOUNT}|${CREATOR_CREDIT_ID}`
    );
  });

  /**
   * E: the SAME account is still admitted by its own settlement — the guard
   * must not block the ordinary successful flow.
   */
  it("B1.14 (E) — the SAME account's settlement still reaches paid + navigation with no click", async () => {
    setPhantom(true);
    connectWallet();
    seedStalePointerForGate("payment-intent-access-gate");

    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });

    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      ...SOLANA_RPC_ROUTES_KEPT,
      {
        match: "/api/service-payment/verify",
        respond: verifyByCaller({
          recheck: VERIFY_VERIFIED,
          completion: () => gatedVerified(completionGate),
          explicit: VERIFY_FAILED,
        }),
      },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    render(tree());
    fireEvent.click(screen.getByRole("button", { name: GATE_BUTTON }));
    await waitFor(
      () =>
        expect(screen.getByRole("status").textContent).toContain("Processing"),
      { timeout: 5000 }
    );

    // The wallet never changes: the settlement belongs to the connection
    // that is live, so the flow advances by itself.
    await act(async () => {
      releaseCompletion();
    });

    await waitFor(
      () => expect(screen.getByTestId("create-route")).toBeTruthy(),
      { timeout: 8000 }
    );

    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(1);
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(readPendingPaymentAttempt()).toBeNull();
    expect(screen.getByTestId("admission").textContent).toBe(
      `${WALLET_ACCOUNT}|${CREATOR_CREDIT_ID}`
    );
  });

  /**
   * The FIRST page carries a PERMANENT explanation of the step the button
   * performs. It must never read as if a previous payment was started or is
   * awaiting confirmation — the automatic recovery's "previous attempt" copy
   * belongs to the $1 step, not to the pristine Home.
   */
  it("B1.15 — the pristine Home shows the permanent FIRST-STEP hint and never the previous-attempt copy", async () => {
    setPhantom(true);
    connectWallet();

    render(tree());

    expect(screen.getByRole("status").textContent).toBe(
      "First, we'll check whether you already have the right to create a capsule."
    );
    // No claim about a previous payment anywhere on the first page.
    expect(
      screen.queryByText(
        /previous payment attempt|previous payment is confirmed|window expired/i
      )
    ).toBeNull();

    // The hint promises a CHECK: nothing ran before the creator asks for it.
    expect(fetchCallsTo("/api/creator/credit-status")).toHaveLength(0);
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(signSolanaUSDCPaymentMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("create-route")).toBeNull();
    // The primary action itself is unchanged.
    expect(screen.getByRole("button", { name: GATE_BUTTON })).toBeTruthy();
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
        { match: "/api/service-payment/verify", respond: VERIFY_FAILED },
        { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
      ],
      /**
       * The endpoint refuses the transaction format BEFORE submitting it.
       * No classification field is present on purpose: an envelope the
       * client cannot vouch for must NOT be treated as a proven pre-send
       * refusal. The verifier stays UNCONFIRMED (see above), so the
       * automatic same-attempt recovery must keep the attempt without
       * completing anything.
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
    // Nothing beyond the single refused attempt was ever attempted: the
    // automatic same-attempt recovery may only re-check the recorded
    // transaction (read-only) — it never signs, sends, grants or navigates
    // while the verifier does not confirm.
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(1);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(screen.queryByTestId("create-route")).toBeNull();
  });

  it("17. a wallet-modified transaction is refused with a specific explanation — nothing was sent, nothing is held open", async () => {
    setPhantom(true);
    connectWallet();
    installFetchRoutes([
      { match: "/api/creator/issue-challenge", respond: CHALLENGE_RESPONSE },
      { match: "/api/creator/credit-status", respond: NO_CREDIT_DISCOVERY },
      { match: "/api/creator/verify-proof", respond: VERIFY_PROOF },
      { match: "/api/service-payment/create-quote", respond: CREATE_QUOTE },
      { match: "/api/service-payment/verify", respond: VERIFY_FAILED },
      { match: "/api/creator/grant-credit", respond: GRANT_CREDIT },
    ]);

    /**
     * The sign-only wallet step refuses the transaction the wallet
     * returned: a STRUCTURED code (the message deliberately does not
     * contain it), proven pre-send by the client itself. The broadcast
     * endpoint must never be reached — not even once.
     */
    signSolanaUSDCPaymentMock.mockRejectedValueOnce(
      Object.assign(
        new Error("the wallet returned a different transaction"),
        { code: "WALLET_MODIFIED_TRANSACTION" }
      )
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
          "did not match the one prepared here"
        ),
      { timeout: 5000 }
    );

    const statusText = screen.getByRole("status").textContent ?? "";
    // The specific refusal is surfaced, never the generic fallback…
    expect(statusText).not.toContain("Something went wrong");
    // …it makes no claim about funds…
    expect(statusText).not.toMatch(/not charged|nothing was charged|no money/i);
    // …and it never reads as sent, pending or awaiting confirmation.
    expect(statusText).not.toMatch(/awaiting|being checked|may still/i);
    // Nothing was sent and nothing new was attempted: no broadcast, no
    // verification, no grant, no automatic retry, no leftover pointer.
    expect(fetchCallsTo("/api/solana/broadcast")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(signSolanaUSDCPaymentMock).toHaveBeenCalledTimes(1);
    expect(readPendingPaymentAttempt()).toBeNull();
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