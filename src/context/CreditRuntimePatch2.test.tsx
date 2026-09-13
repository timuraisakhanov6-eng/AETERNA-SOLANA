// @vitest-environment jsdom
/**
 * AETERNA — PATCH-2 runtime wiring invariants (client side).
 *
 * Covers:
 *  N. authenticated identity adoption into runtime
 *  R. successful in-session payment restores entitlement via the gate
 *
 * The former context members discoverAvailableCredit / reserveLifecycle /
 * accessStatus / setAccessStatus had zero production consumers (canonical
 * credit-status discovery lives in
 * servicePaymentController.discoverCreditStatus; lifecycle reservation in
 * CapsuleBuilder's local reserveLifecycle) and were removed by the
 * surface cleanup. The live discovery/entitlement discipline is pinned by
 * servicePaymentController.test.ts (PATCH-2J / PATCH-2K-A) and the gate
 * tests below.
 *
 * PATCH-2K-B: the app-root PaymentModal is removed — the gate is driven
 * directly through reportCreditReady / reportCreditDiscovery (the bodies
 * the modal callbacks used to fill). The modal vi.mock and its grant
 * button are gone; the modal API itself is asserted absent.
 *
 * All network access is mocked. No production calls.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { CreatorIdentityProvider, CreatorCreditProvider, useCreatorIdentity } from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider, useLandingPaymentGate } from "@/context/LandingPaymentGateContext";

interface Harness {
  identity?: ReturnType<typeof useCreatorIdentity>;
  gate?: ReturnType<typeof useLandingPaymentGate>;
}

function Probe({ harness }: { harness: Harness }) {
  const identity = useCreatorIdentity();
  const gate = useLandingPaymentGate();
  harness.identity = identity;
  harness.gate = gate;
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

  it("N: adoption sets verified identity into the runtime", async () => {
    const harness: Harness = {};
    renderTree(harness);

    await act(async () => {
      harness.identity!.adoptIdentity("identity-adopted");
    });
    expect(harness.identity!.creatorIdentityId).toBe("identity-adopted");
    expect(harness.identity!.status).toBe("authenticated");
  });

  it("R: successful in-session payment retains the FULL result in the gate and adopts the identity", async () => {
    const harness: Harness = {};
    renderTree(harness);

    // PATCH-2K-B: the gate is fed by the controller host (CapsuleBuilder)
    // via reportCreditReady — the server-verified grant result.
    await act(async () => {
      harness.gate!.reportCreditReady({
        status: "available",
        creatorIdentityId: "id-from-payment",
        creatorCreditId: "credit-from-payment",
        account: "acc-from-payment",
        paymentIntentId: "intent-from-payment",
      });
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

  it("PATCH-2K-B: reportCreditDiscovery AVAILABLE retains the entitlement and adopts the identity", async () => {
    const harness: Harness = {};
    renderTree(harness);

    await act(async () => {
      harness.gate!.reportCreditDiscovery({
        status: "available",
        creatorCreditId: "credit-9",
        creatorIdentityId: "identity-9",
        account: "acc-9",
      });
    });

    expect(harness.gate!.entitlement).toEqual({
      creatorCreditId: "credit-9",
      creatorIdentityId: "identity-9",
      account: "acc-9",
    });
    expect(harness.identity!.creatorIdentityId).toBe("identity-9");
    expect(harness.identity!.status).toBe("authenticated");
  });

  it("PATCH-2K-B: reportCreditDiscovery NONE clears a stale entitlement only for the SAME account", async () => {
    const harness: Harness = {};
    renderTree(harness);

    await act(async () => {
      harness.gate!.reportCreditDiscovery({
        status: "available",
        creatorCreditId: "credit-1",
        creatorIdentityId: "identity-1",
        account: "acc-1",
      });
    });
    expect(harness.gate!.entitlement).not.toBeNull();

    // Authoritative none for a DIFFERENT account must not touch the mirror.
    await act(async () => {
      harness.gate!.reportCreditDiscovery({
        status: "none",
        creatorCreditId: null,
        creatorIdentityId: "identity-1",
        account: "acc-OTHER",
      });
    });
    expect(harness.gate!.entitlement).toEqual({
      creatorCreditId: "credit-1",
      creatorIdentityId: "identity-1",
      account: "acc-1",
    });

    // Authoritative none for the SAME account clears the stale mirror.
    await act(async () => {
      harness.gate!.reportCreditDiscovery({
        status: "none",
        creatorCreditId: null,
        creatorIdentityId: "identity-1",
        account: "acc-1",
      });
    });
    expect(harness.gate!.entitlement).toBeNull();
  });

  it("PATCH-2K-B: the gate no longer exposes payment-modal API", () => {
    const harness: Harness = {};
    renderTree(harness);

    const gateRecord = harness.gate as unknown as Record<string, unknown>;
    expect(gateRecord["openLandingPaymentModal"]).toBeUndefined();
    expect(gateRecord["closeLandingPaymentModal"]).toBeUndefined();
    expect(gateRecord["isPaymentModalOpen"]).toBeUndefined();
  });
});
