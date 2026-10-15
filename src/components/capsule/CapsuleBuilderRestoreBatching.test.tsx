// @vitest-environment jsdom
/**
 * AETERNA — PATCH-2M regression: service-payment result batch race.
 *
 * ORIGINAL DEFECT (PATCH-2M, pre-Home-gate architecture)
 * -----------------------------------------------------
 * The entitlement-restore effect's stale `if (createFlowState === "paid")
 * return;` guard swallowed the ONLY `setServicePaymentResult(...)` write,
 * so the flow committed `paid` with `servicePaymentResult = null` and
 * dead-ended `handleFinalCreateClick` silently — no preparation, no
 * /api/storage/quote, no Final Capsule Review. These tests FAILED on
 * pre-patch code and PASSED after the fix.
 *
 * ADAPTATION TO THE HOME GATE ARCHITECTURE
 * ----------------------------------------
 * The result no longer arrives from an inline controller on /create; it is
 * SEEDED from the Home gate's in-memory admission. The same class of race
 * therefore now lives in the admission-seeding effect, and the same
 * user-visible guarantee must hold:
 *
 *   admission seeded ⇒ `servicePaymentResult` set AND `createFlowState`
 *   = "paid" in ONE commit ⇒ the FIRST Create Capsule click on /create
 *   must reach preparePreparedCapsule + /api/capsule/prepared +
 *   /api/storage/quote + the Final Capsule Review dialog.
 *
 * A regression that seeds the state machine without the payment result
 * dead-ends exactly as before, and these tests fail.
 *
 * Idempotence is pinned on the live wiring: after paid, a rerender must not
 * re-seed, re-sign, re-quote or loop (a render loop would surface as
 * "Maximum update depth exceeded" or duplicated endpoint calls).
 *
 * jsdom component test. All network access is mocked. No production calls,
 * no real payment, no wallet transaction.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
  useCreatorIdentity,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import { CreateAccessProvider } from "@/context/CreateAccessContext";
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

const {
  WALLET_ACCOUNT,
  CREATOR_IDENTITY_ID,
  CREATOR_CREDIT_ID,
  stableWallet,
  signMessageMock,
  preparePreparedCapsuleMock,
} = vi.hoisted(() => {
  const WALLET_ACCOUNT = "7XkWqBase58WalletAccountFor2MTest";
  const CREATOR_IDENTITY_ID = "creator-identity-2m";
  const CREATOR_CREDIT_ID = "creator-credit-2m";

  const signMessageMock = vi.fn(async () => ({
    signature: new Uint8Array(64),
  }));

  // Stable identity across renders (see file header) — mirrors the
  // production useMemo'd wallet context value.
  const stableWallet = {
    connected: true,
    account: WALLET_ACCOUNT,
    walletName: "Test Wallet",
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: signMessageMock,
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    disconnect: vi.fn(async () => {}),
  };

  const preparePreparedCapsuleMock = vi.fn(async () => ({
    capsuleId: "capsule-2m-test",
    encryptedSizeBytes: 4096,
    vaultSha256: "a".repeat(64),
    saltBase: "b".repeat(43),
    encryptedVaultPointer: "vault-pointer-2m",
    chunkMetadata: [],
    creatorAuthority: "creator-authority-2m",
  }));

  return {
    WALLET_ACCOUNT,
    CREATOR_IDENTITY_ID,
    CREATOR_CREDIT_ID,
    stableWallet,
    signMessageMock,
    preparePreparedCapsuleMock,
  };
});

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    // Non-empty: canSeal requires items.length > 0 before Create Capsule
    // is enabled.
    items: [
      {
        id: "item-2m-1",
        type: "text",
        text: "PATCH-2M capsule body",
        createdAt: 1700000000000,
      },
    ],
    capsuleId: "capsule-2m-test",
    addTextItem: vi.fn(),
    addMediaItem: vi.fn(),
    description: "",
    setDescription: vi.fn(),
    unlockAt: 1798761600000,
    setUnlockAt: vi.fn(),
    getMediaFile: vi.fn(),
    resetCapsule: vi.fn(),
  }),
}));

vi.mock("@/components/capsule/ActionMenu", () => ({ default: () => null }));
vi.mock("@/components/capsule/MediaCapture", () => ({ default: () => null }));
vi.mock("@/components/capsule/CapsuleInput", () => ({ default: () => null }));
vi.mock("@/components/capsule/HorizontalCapsule", () => ({
  default: () => null,
}));
vi.mock("@/components/capsule/DateTimePicker", () => ({
  DateTimePicker: () => null,
  normalizeOpenAt: (value: unknown) => value,
}));

vi.mock("@/lib/capsule/preparePreparedCapsule", () => ({
  preparePreparedCapsule: preparePreparedCapsuleMock,
}));

vi.mock("@/lib/wallet/solanaWallet", () => ({
  sendSolanaUSDCPayment: vi.fn(async () => "tx-sig-2m-test"),
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  fundCreatorPaidStorage: vi.fn(),
  toCreatorIrysWallet: vi.fn(),
}));

/* ───────────────── harness ───────────────── */

const json = (body: unknown, ok = true) => ({
  ok,
  json: async () => body,
});

const PREPARED_PROJECTION = () =>
  json({ ok: true, preparedProjection: { preparedProjectionId: "projection-2m" } });

const STORAGE_QUOTE = () =>
  json({
    ok: true,
    storagePaymentId: "storage-payment-2m",
    expectedAmountAtomic: "1000000",
    displayAmountUSDC: "1.00",
    billableSizeBytes: 4096,
  });

let fetchMock: ReturnType<typeof vi.fn>;

function installFetchRoutes(
  routes: Array<{ match: string; respond: () => ReturnType<typeof json> }>
) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch in test: ${url}`);
    return route.respond();
  });
}

const fetchCallsTo = (fragment: string) =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes(fragment));

/** The exact admission shape the Home access gate grants. */
const ADMISSION = {
  creatorCreditId: CREATOR_CREDIT_ID,
  creatorIdentityId: CREATOR_IDENTITY_ID,
  account: WALLET_ACCOUNT,
};

/**
 * The Home gate also adopts the server-verified identity; the workspace's
 * wallet-match guard compares the seeded result against it, so the harness
 * must mirror that step.
 */
function SeedIdentity() {
  const { adoptIdentity } = useCreatorIdentity();
  React.useEffect(() => {
    adoptIdentity(CREATOR_IDENTITY_ID);
  }, [adoptIdentity]);
  return null;
}

const tree = () =>
  React.createElement(
    MemoryRouter,
    { initialEntries: ["/create"] },
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
            {
              initialAdmission: ADMISSION,
              children: React.createElement(
                React.Fragment,
                null,
                React.createElement(SeedIdentity),
                React.createElement(CapsuleBuilder)
              ),
            }
          )
        )
      )
    )
  );

async function acceptProtocol() {
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => {
    expect(
      (screen.getByRole("checkbox") as HTMLElement).dataset["state"]
    ).toBe("checked");
  });
}

describe("PATCH-2M service-payment result batch race (Home gate architecture)", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Model 01 wallet policy: Phantom only.
    (window as unknown as { phantom?: unknown }).phantom = { solana: {} };
    // jsdom's crypto lacks randomUUID on some Node 20 combinations.
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: () => "uuid-2m-test",
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { phantom?: unknown }).phantom;
    // clearAllMocks (NOT restoreAllMocks): call history must reset between
    // scenarios while the hoisted implementations survive.
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("SCENARIO A: the admission seed commits paid + result together, so the FIRST Create Capsule click reaches the storage quote", async () => {
    installFetchRoutes([
      { match: "/api/capsule/prepared", respond: PREPARED_PROJECTION },
      { match: "/api/storage/quote", respond: STORAGE_QUOTE },
    ]);

    const view = render(tree());
    await acceptProtocol();

    // The Home gate already established the entitlement server-side; the
    // workspace mirrors it as paid (no discovery, no signature).
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Creator access ready"
      );
    });

    // Seeding performs NO discovery and NO signature.
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/creator/credit-status")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/issue-challenge")).toHaveLength(0);
    expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(0);

    // servicePaymentResult is asserted indirectly through behavior: the
    // Create Capsule click must pass the `!servicePaymentResult` guard in
    // handleFinalCreateClick and reach the prepared projection + canonical
    // Irys quote + Final Capsule Review. A seed that commits paid WITHOUT
    // the result dead-ends here silently and this wait times out.
    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));

    await waitFor(
      () => expect(preparePreparedCapsuleMock).toHaveBeenCalledTimes(1),
      { timeout: 3000 }
    );
    await waitFor(() => {
      expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy(); // Final Capsule Review open
    });

    // Idempotence: rerendering while paid must not re-seed, re-sign,
    // re-prepare or re-quote, and must not loop the seeding effect.
    view.rerender(tree());
    expect(signMessageMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(1);
    expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    expect(preparePreparedCapsuleMock).toHaveBeenCalledTimes(1);
  });

  it("SCENARIO B: the seed performs no payment work — the $1 already happened on Home", async () => {
    installFetchRoutes([
      { match: "/api/capsule/prepared", respond: PREPARED_PROJECTION },
      { match: "/api/storage/quote", respond: STORAGE_QUOTE },
    ]);

    render(tree());
    await acceptProtocol();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Creator access ready");
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Capsule" }));
    await waitFor(() => {
      expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    });

    // /create never re-runs the service-payment pipeline.
    expect(fetchCallsTo("/api/service-payment/create-quote")).toHaveLength(0);
    expect(fetchCallsTo("/api/service-payment/verify")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/grant-credit")).toHaveLength(0);
    expect(fetchCallsTo("/api/creator/verify-proof")).toHaveLength(0);
  });
});
