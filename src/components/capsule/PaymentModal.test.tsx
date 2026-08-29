/**
 * AETERNA — PaymentModal Reown wallet integration tests
 *
 * Scope:
 * - verifies business-layer wallet boundary in PaymentModal.tsx
 * - does not test Reown internals directly
 */

import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentModal } from "@/components/capsule/PaymentModal";
import { AETERNAWalletContext } from "@/context/AETERNAWalletContext";
import type { AeternaWallet } from "@/context/AETERNAWalletContext";

function createMockWallet(overrides: Partial<AeternaWallet> = {}): AeternaWallet {
  return {
    walletId: "mock-wallet-id",
    walletName: "Mock Wallet",
    account: "MockAccount1111111111111111111111111111111111",
    connected: true,
    ready: true,
    error: null,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    changeWallet: vi.fn().mockResolvedValue(undefined),
    openWalletPicker: vi.fn().mockResolvedValue(undefined),
    signMessage: vi.fn().mockResolvedValue({ signature: new Uint8Array(64) }),
    signAndSendTransaction: vi.fn().mockResolvedValue({ signature: "mock-signature" }),
    ...overrides,
  };
}

type RenderPaymentModalOptions = {
  protocolAccepted?: boolean;
  creatorIdentityId?: string | null;
  unlockAt?: number | null;
};

function renderPaymentModal(wallet: AeternaWallet, options: RenderPaymentModalOptions = {}) {
  const { protocolAccepted = true, creatorIdentityId = null, unlockAt = null } = options;
  return render(
    <AETERNAWalletContext.Provider value={{ state: wallet, wallet }}>
      <PaymentModal
        open
        onClose={() => {}}
        protocolAccepted={protocolAccepted}
        creatorIdentityId={creatorIdentityId}
        unlockAt={unlockAt}
      />
    </AETERNAWalletContext.Provider>
  );
}

describe("PaymentModal Reown wallet integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, paymentIntentId: "pi-1", expectedAmount: 1, currency: "USD", expiresAt: Date.now() + 60000 }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders wallet connect action when disconnected", async () => {
    const wallet = createMockWallet({ connected: false, account: null });
    renderPaymentModal(wallet);
    expect(await screen.findByText("Connect Wallet")).toBeDefined();
  });

  it("blocks payment continuation when wallet.account mismatches bound creator identity account", async () => {
    const wallet = createMockWallet({ account: "DifferentAccount1111111111111111111111111111" });
    renderPaymentModal(wallet);
    await screen.findByText("Confirm $1.00 USDC");
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("shows Change Wallet when connected and verification present", async () => {
    const wallet = createMockWallet();
    renderPaymentModal(wallet, { creatorIdentityId: "creator-1" });
    expect(await screen.findByText("Change Wallet")).toBeDefined();
    expect(wallet.changeWallet).not.toHaveBeenCalled();
  });

  it("shows Change Wallet and Verify this wallet when connected but unverified", async () => {
    const wallet = createMockWallet({ connected: true, account: "MockAccount1111111111111111111111111111111111" });
    renderPaymentModal(wallet, { protocolAccepted: true, creatorIdentityId: null });
    expect(await screen.findByText("Change Wallet")).toBeDefined();
    expect(await screen.findByText("Verify this wallet")).toBeDefined();
    expect(wallet.changeWallet).not.toHaveBeenCalled();
  });
});
