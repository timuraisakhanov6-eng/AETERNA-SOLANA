// @vitest-environment jsdom
/**
 * AETERNA — R9-A77.1 regression: a null `unlockAt` must never enter the
 * capsule creation pipeline.
 *
 * DEFECT (identified by the R9-A77 read-only TypeScript audit)
 * -----------------------------------------------------------
 * `unlockAt` is `number | null` (CapsuleContext). The Create Capsule
 * handler reads it directly as `openAt`, and `openAt` is a vault-key
 * derivation input ("the vault key derives from (recipientSecret,
 * saltBase, openAt, capsuleId)" — see CapsuleBuilder's own
 * buildPreparationFingerprint documentation).
 *
 * The only thing standing between a null and that pipeline was
 * `disabled={isCreateDisabled}` on the submit button, i.e. a rendered
 * attribute rather than a guard inside the operation. These tests FAIL
 * on the pre-fix code and PASS once the handler validates its own
 * input, exactly like the PATCH-2M suite this harness is adapted from.
 *
 * HOW THE HANDLER IS REACHED
 * --------------------------
 * The button is disabled while `unlockAt` is null, so a synthetic click
 * is (correctly) ignored by React. That is asserted first, as the
 * usability safeguard it is. The handler is then invoked through the
 * component's own React `onClick` prop, bypassing the disabled
 * attribute — which models every invocation path that does not depend
 * on a DOM attribute: a keyboard submit, a programmatic call, a future
 * refactor that hoists the handler, or a test harness. No production
 * API is added or exposed for this; the handler invoked is the real one.
 *
 * jsdom component test. All network access is mocked. No production
 * calls, no real payment, no wallet transaction, no real crypto.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  CreatorCreditProvider,
  CreatorIdentityProvider,
  useCreatorIdentity,
} from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import { CreateAccessProvider } from "@/context/CreateAccessContext";
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

/** Canonical fixture timestamp: 2026-12-31T12:00:00.000Z. */
const OPEN_AT = 1798761600000;

const {
  WALLET_ACCOUNT,
  CREATOR_IDENTITY_ID,
  CREATOR_CREDIT_ID,
  stableWallet,
  capsuleState,
  preparePreparedCapsuleMock,
} = vi.hoisted(() => {
  const WALLET_ACCOUNT = "7XkWqBase58WalletAccountForUnlockAtTest";
  const CREATOR_IDENTITY_ID = "creator-identity-unlockat";
  const CREATOR_CREDIT_ID = "creator-credit-unlockat";

  // Mutable: each test decides whether an unlock time was chosen.
  const capsuleState: { unlockAt: number | null } = { unlockAt: null };

  const stableWallet = {
    connected: true,
    account: WALLET_ACCOUNT,
    walletName: "Test Wallet",
    openWalletPicker: vi.fn(async () => {}),
    changeWallet: vi.fn(async () => {}),
    signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })),
    signAndSendTransaction: vi.fn(async () => ({ signature: "unused" })),
    disconnect: vi.fn(async () => {}),
  };

  // The single prepared-capsule entry point: vault preparation, vault-key
  // generation, key derivation, media chunk preparation and vault
  // encryption all live behind it. Never calling it is therefore proof
  // that none of them started.
  const preparePreparedCapsuleMock = vi.fn(
    async (_input: { capsuleId: string; openAt: number }) => ({
      capsuleId: "capsule-unlockat-test",
      encryptedSizeBytes: 4096,
      vaultSha256: "a".repeat(64),
      saltBase: "b".repeat(43),
      encryptedVaultPointer: "vault-pointer-unlockat",
      chunkMetadata: [],
      creatorAuthority: "creator-authority-unlockat",
      recipientSecret: "c".repeat(43),
    })
  );

  return {
    WALLET_ACCOUNT,
    CREATOR_IDENTITY_ID,
    CREATOR_CREDIT_ID,
    stableWallet,
    capsuleState,
    preparePreparedCapsuleMock,
  };
});

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => stableWallet,
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    // Non-empty: canSeal requires items.length > 0.
    items: [
      {
        id: "item-unlockat-1",
        type: "text",
        text: "R9-A77.1 null unlockAt capsule body",
        createdAt: 1700000000000,
      },
    ],
    capsuleId: "capsule-unlockat-test",
    addTextItem: vi.fn(),
    addMediaItem: vi.fn(),
    description: "",
    setDescription: vi.fn(),
    unlockAt: capsuleState.unlockAt,
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
  sendSolanaUSDCPayment: vi.fn(async () => "tx-sig-unlockat-test"),
}));
vi.mock("@/lib/storage/creatorIrys", () => ({
  fundCreatorPaidStorage: vi.fn(),
  toCreatorIrysWallet: vi.fn(),
}));

/* ───────────────── harness ───────────────── */

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

const PREPARED_PROJECTION = () =>
  json({ ok: true, preparedProjection: { preparedProjectionId: "projection-unlockat" } });

const STORAGE_QUOTE = () =>
  json({
    ok: true,
    storagePaymentId: "storage-payment-unlockat",
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

const ADMISSION = {
  creatorCreditId: CREATOR_CREDIT_ID,
  creatorIdentityId: CREATOR_IDENTITY_ID,
  account: WALLET_ACCOUNT,
};

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

/**
 * The component's OWN onClick for the Create Capsule button.
 *
 * Read from the React props attached to the rendered element, so the
 * function returned is the production handler bound to live component
 * state — not a copy, not a stub. Reading it also lets the test bypass
 * the `disabled` attribute, which is the whole point: the handler must
 * refuse on its own.
 */
function createButtonHandler(): () => unknown {
  const button = screen.getByRole("button", { name: "Create Capsule" });
  const key = Object.keys(button).find((candidate) =>
    candidate.startsWith("__reactProps$")
  );
  if (!key) {
    throw new Error("React props are not attached to the Create Capsule button");
  }
  const props = (button as unknown as Record<string, { onClick?: unknown }>)[key];
  const onClick = props?.onClick;
  if (typeof onClick !== "function") {
    throw new Error("Create Capsule button has no onClick handler");
  }
  return onClick as () => unknown;
}

async function invokeCreateHandler(): Promise<void> {
  const handler = createButtonHandler();
  await act(async () => {
    await handler();
  });
}

async function renderPaidWorkspace() {
  const view = render(tree());
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toBe("Creator access ready");
  });
  return view;
}

describe("R9-A77.1 null unlockAt is rejected at the creation boundary", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Model 01 wallet policy: Phantom only.
    (window as unknown as { phantom?: unknown }).phantom = { solana: {} };
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: () => "uuid-unlockat-test",
        configurable: true,
      });
    }
    capsuleState.unlockAt = null;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { phantom?: unknown }).phantom;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("NULL: the handler refuses before vault preparation, key derivation, encryption, quote, publication or sealing", async () => {
    // Routes are installed on purpose: if a null leaked through, the
    // handler would happily reach the prepared projection and the quote.
    installFetchRoutes([
      { match: "/api/capsule/prepared", respond: PREPARED_PROJECTION },
      { match: "/api/storage/quote", respond: STORAGE_QUOTE },
    ]);

    await renderPaidWorkspace();

    const button = screen.getByRole("button", {
      name: "Create Capsule",
    }) as HTMLButtonElement;

    // 1. The UI safeguard exists ...
    expect(button.disabled).toBe(true);

    // 2. ... and a normal click is refused by it (usability only).
    fireEvent.click(button);
    expect(preparePreparedCapsuleMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // 3. Bypass the attribute: the handler itself is now under test.
    await invokeCreateHandler();

    // No vault preparation / key generation / derivation / encryption:
    // all of it lives behind preparePreparedCapsule.
    expect(preparePreparedCapsuleMock).not.toHaveBeenCalled();
    // No prepared projection, no canonical Irys quote, no reserve, no
    // publication, no sealing.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(0);
    expect(fetchCallsTo("/api/storage/quote")).toHaveLength(0);
    // The review dialog must not open, and nothing is navigating away.
    expect(screen.queryByRole("dialog")).toBeNull();

    // The existing error surface is used.
    expect(
      screen.getByText("Set an unlock date before creating the capsule.")
    ).toBeTruthy();

    // No processing/loading state is left active.
    expect(screen.queryByText("PREPARING VAULT...")).toBeNull();
    expect(button.disabled).toBe(true);
  });

  it("VALID: a numeric unlockAt still prepares the capsule with that exact openAt", async () => {
    capsuleState.unlockAt = OPEN_AT;

    installFetchRoutes([
      { match: "/api/capsule/prepared", respond: PREPARED_PROJECTION },
      { match: "/api/storage/quote", respond: STORAGE_QUOTE },
    ]);

    await renderPaidWorkspace();

    const button = screen.getByRole("button", {
      name: "Create Capsule",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(
      () => expect(preparePreparedCapsuleMock).toHaveBeenCalledTimes(1),
      { timeout: 3000 }
    );

    // The validated value is passed through unchanged: no rounding, no
    // clamping, no Date.now() fallback, no string coercion.
    const firstCall = preparePreparedCapsuleMock.mock.calls[0];
    expect(firstCall?.[0].openAt).toBe(OPEN_AT);

    // Existing successful behaviour is intact, end to end.
    await waitFor(() => {
      expect(fetchCallsTo("/api/capsule/prepared")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fetchCallsTo("/api/storage/quote")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
  });
});
