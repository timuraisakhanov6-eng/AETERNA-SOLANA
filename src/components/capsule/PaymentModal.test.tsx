/**
 * AETERNA — PaymentModal Reown wallet integration tests
 *
 * Scope:
 * - verifies business-layer wallet boundary in PaymentModal.tsx
 * - does not test Reown internals directly
 */

import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

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

  it("blocks payment when wallet account changes after wallet verification", async () => {
    const wallet = createMockWallet({ connected: true, account: "MockAccount1111111111111111111111111111111111" })
    const issueChallengeMock = vi.fn().mockResolvedValue({
      challengeId: "challenge-1",
      message: "Sign this message",
      expiresAt: Date.now() + 60000,
    })
    const verifyProofMock = vi.fn().mockResolvedValue({ ok: true, creatorIdentityId: "identity-1", account: "MockAccount1111111111111111111111111111111111" })
    const signMessageMock = vi.fn().mockResolvedValue({ signature: new Uint8Array(64) })

    const updatedWallet = createMockWallet({
      connected: true,
      account: "DifferentAccount1111111111111111111111111111",
      signMessage: signMessageMock,
    })

    const Wrapper = () => {
      const [currentWallet, setCurrentWallet] = useState(wallet)
      return (
        <AETERNAWalletContext.Provider value={{ state: currentWallet, wallet: currentWallet }}>
          <PaymentModal
            open
            onClose={() => {}}
            protocolAccepted
            creatorIdentityId={null}
            unlockAt={null}
            onCreditReady={() => {}}
            onReserveReady={() => {}}
          />
          <button data-testid="update-wallet" onClick={() => setCurrentWallet({ ...updatedWallet, signMessage: signMessageMock })}>Update Wallet</button>
        </AETERNAWalletContext.Provider>
      )
    }

    render(<Wrapper />)

    const mockFetch = global.fetch as unknown as typeof vi.fn
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, paymentIntentId: "pi-1", expectedAmount: 1, currency: "USD", expiresAt: Date.now() + 60000 }),
      })
    )
    mockFetch.mockImplementationOnce((url: string) => {
      if (url.includes("issue-challenge")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, id: "challenge-1", challengeId: "challenge-1", challenge: "Sign this message", message: "Sign this message", expiresAt: Date.now() + 60000 }),
        })
      }
      if (url.includes("verify-proof")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, creatorIdentityId: "identity-1", account: "MockAccount1111111111111111111111111111111111" }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    const updateButton = await screen.findByTestId("update-wallet")
    updateButton.click()

    const verifyButton = await screen.findByText("Verify this wallet")
    verifyButton.click()

    await screen.findByText("Confirm $1.00 USDC")

    const confirmButton = screen.getByText("Confirm $1.00 USDC")
    confirmButton.click()

    expect(signMessageMock).not.toHaveBeenCalled()
    expect(updatedWallet.signAndSendTransaction).not.toHaveBeenCalled()
    expect(await screen.findByText("Wallet account changed after verification. Please verify again.")).toBeDefined()
  })

  it("shows Change Wallet when connected and verification present", async () => {
    const wallet = createMockWallet();
    renderPaymentModal(wallet, { creatorIdentityId: "creator-1" });
    expect(await screen.findByText("Change Wallet")).toBeDefined();
    expect(wallet.changeWallet).not.toHaveBeenCalled();
  });

  it("shows Change Wallet and Verify this wallet when connected but unverified", async () => {
    const wallet = createMockWallet({ connected: true, account: "MockAccount1111111111111111111111111111111111" })
    renderPaymentModal(wallet, { protocolAccepted: true, creatorIdentityId: null })
    expect(await screen.findByText("Change Wallet")).toBeDefined()
    expect(await screen.findByText("Verify this wallet")).toBeDefined()
    expect(wallet.changeWallet).not.toHaveBeenCalled()
  })

  it("uses walletRef.current.account for verification after wallet account updates", async () => {
    const wallet = createMockWallet({ connected: true, account: null })
    const issueChallengeMock = vi.fn().mockResolvedValue({
      challengeId: "challenge-1",
      message: "Sign this message",
      expiresAt: Date.now() + 60000,
    })
    const verifyProofMock = vi.fn().mockResolvedValue({ ok: true, creatorIdentityId: "identity-1", account: "MockAccount1111111111111111111111111111111111" })
    const signMessageMock = vi.fn().mockResolvedValue({ signature: new Uint8Array(64) })

    const updatedWallet = createMockWallet({
      connected: true,
      account: "MockAccount1111111111111111111111111111111111",
      signMessage: signMessageMock,
    })

    const Wrapper = () => {
      const [currentWallet, setCurrentWallet] = useState(wallet)
      return (
        <AETERNAWalletContext.Provider value={{ state: currentWallet, wallet: currentWallet }}>
          <PaymentModal
            open
            onClose={() => {}}
            protocolAccepted
            creatorIdentityId={null}
            unlockAt={null}
            onCreditReady={() => {}}
            onReserveReady={() => {}}
          />
          <button data-testid="update-wallet" onClick={() => setCurrentWallet({ ...updatedWallet, signMessage: signMessageMock })}>Update Wallet</button>
        </AETERNAWalletContext.Provider>
      )
    }

    render(<Wrapper />)

    const mockFetch = global.fetch as unknown as typeof vi.fn
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, paymentIntentId: "pi-1", expectedAmount: 1, currency: "USD", expiresAt: Date.now() + 60000 }),
      })
    )
    mockFetch.mockImplementationOnce((url: string) => {
      if (url.includes("issue-challenge")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, id: "challenge-1", challengeId: "challenge-1", challenge: "Sign this message", message: "Sign this message", expiresAt: Date.now() + 60000 }),
        })
      }
      if (url.includes("verify-proof")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, creatorIdentityId: "identity-1", account: "MockAccount1111111111111111111111111111111111" }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    const updateButton = await screen.findByTestId("update-wallet")
    updateButton.click()

    const verifyButton = await screen.findByText("Verify this wallet")
    verifyButton.click()

    expect(signMessageMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Wallet account is required for verification.")).toBeNull()
  })

  it("blocks payment when creatorIdentityId is present but verifiedCreatorAccount is missing", async () => {
    const wallet = createMockWallet({ connected: true, account: "MockAccount1111111111111111111111111111111111" })
    renderPaymentModal(wallet, { creatorIdentityId: "identity-1" })

    await screen.findByText("Confirm $1.00 USDC")
    const confirmButton = screen.getByText("Confirm $1.00 USDC")
    confirmButton.click()

    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled()
    expect(await screen.findByText("Wallet verification is required before payment.")).toBeDefined()
  })
});
