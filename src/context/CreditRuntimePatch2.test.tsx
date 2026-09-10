// @vitest-environment jsdom
/**
 * AETERNA — PATCH-2 runtime wiring invariants (client side).
 *
 * Covers:
 *  N. authenticated identity adoption into runtime
 *  O. AVAILABLE Credit discovery mirrors server answer
 *  R. successful in-session payment restores entitlement via the gate
 *  S. discovery only ever calls credit-status (never reserve/consume)
 *
 * All network access is mocked. No production calls.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CreatorIdentityProvider, CreatorCreditProvider, useCreatorIdentity, useCreatorCredit } from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider, useLandingPaymentGate } from "@/context/LandingPaymentGateContext";

vi.mock("@/components/capsule/PaymentModal", () => {
  let lastOnCreditReady: ((result: Record<string, unknown>) => void) | null = null;
  return {
    PaymentModal: (props: Record<string, unknown>) => {
      lastOnCreditReady = props["onCreditReady"] as (result: Record<string, unknown>) => void;
      return (
        <button
          data-testid="grant-btn"
          onClick={() =>
            lastOnCreditReady?.({
              status: "available",
              creatorIdentityId: "id-from-payment",
              creatorCreditId: "credit-from-payment",
              account: "acc-from-payment",
              paymentIntentId: "intent-from-payment",
            })
          }
        >
          grant
        </button>
      );
    },
  };
});

interface Harness {
  identity?: ReturnType<typeof useCreatorIdentity>;
  credit?: ReturnType<typeof useCreatorCredit>;
  gate?: ReturnType<typeof useLandingPaymentGate>;
  discover?: (network: string, account: string, signature: string, challengeId: string) => Promise<{
    status: "available" | "none";
    creatorCreditId: string | null;
    creatorIdentityId: string | null;
  }>;
}

function Probe({ harness }: { harness: Harness }) {
  const identity = useCreatorIdentity();
  const credit = useCreatorCredit();
  const gate = useLandingPaymentGate();
  harness.identity = identity;
  harness.credit = credit;
  harness.gate = gate;
  harness.discover = (network, account, signature, challengeId) =>
    credit.discoverAvailableCredit(network, account, signature, challengeId);
  return <div data-testid="probe" />;
}

function renderTree(harness: Harness) {
  return render(
    <CreatorIdentityProvider>
      <CreatorCreditProvider>
        <LandingPaymentGateProvider>
          <Probe harness={harness} />
        </LandingPaymentGateProvider>
      </CreatorCreditProvider>
    </CreatorIdentityProvider>
  );
}

describe("PATCH-2 runtime entitlement wiring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("N + O: adoption sets verified identity; discovery mirrors an AVAILABLE server answer", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        status: "available",
        creatorCreditId: "credit-1",
        creatorIdentityId: "identity-1",
        lifecycleId: null,
      }),
    });

    const harness: Harness = {};
    renderTree(harness);

    await act(async () => {
      harness.identity!.adoptIdentity("identity-adopted");
    });
    expect(harness.identity!.creatorIdentityId).toBe("identity-adopted");
    expect(harness.identity!.status).toBe("authenticated");

    let discovery: { status: string; creatorCreditId: string | null; creatorIdentityId: string | null } | undefined;
    await act(async () => {
      discovery = await harness.discover!("solana", "acc-1", "sig-1", "challenge-1");
    });

    expect(discovery).toEqual({
      status: "available",
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
    });
    expect(harness.credit!.creditStatus).toBe("available");
    expect(harness.credit!.creatorCreditId).toBe("credit-1");

    // S: discovery ONLY calls credit-status — never reserve/consume.
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls).toEqual(["/api/creator/credit-status"]);
  });

  it("E/Q: discovery 'none' leaves normal payment path available", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        status: "none",
        creatorCreditId: null,
        creatorIdentityId: "identity-1",
      }),
    });

    const harness: Harness = {};
    renderTree(harness);

    await act(async () => {
      harness.discover!("solana", "acc-1", "sig-1", "challenge-1");
    });

    expect(harness.credit!.creditStatus).toBe("idle");
    expect(harness.credit!.creatorCreditId).toBeNull();
  });

  it("R: successful in-session payment retains the FULL result in the gate and adopts the identity", async () => {
    const harness: Harness = {};
    renderTree(harness);

    const grantButton = screen.getByTestId("grant-btn");
    await act(async () => {
      fireEvent.click(grantButton);
    });

    expect(harness.gate!.entitlement).toEqual({
      creatorIdentityId: "id-from-payment",
      creatorCreditId: "credit-from-payment",
      account: "acc-from-payment",
      paymentIntentId: "intent-from-payment",
    });
    expect(harness.identity!.creatorIdentityId).toBe("id-from-payment");
    expect(harness.identity!.status).toBe("authenticated");
  });
});
