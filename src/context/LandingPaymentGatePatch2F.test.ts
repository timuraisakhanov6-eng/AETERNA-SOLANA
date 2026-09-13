/**
 * AETERNA — PATCH-2F regression test (node environment).
 *
 * Canonical requirement: an existing AVAILABLE Creator Credit must let
 * the creator continue without a second $1 — and must not leave a
 * payment step mounted over the workspace.
 *
 * Pinned here: the payment gate is programmatically drivable —
 * CapsuleBuilder feeds server-verified outcomes via reportCreditDiscovery
 * / reportCreditReady (PATCH-2K-B — the app-root modal and its
 * open/close API are removed). Mounted via react-dom/server like the
 * other PATCH-2 node tests; no DOM needed.
 *
 * The former exported predicate hasRestorableEntitlement was a dead
 * test-only mirror removed by PATCH-2K-D; the live entitlement-restore
 * decision runs in CapsuleBuilder's entitlement effect and its reducer
 * invariant is pinned by capsuleCreateFlow.test.ts.
 *
 * All network access is mocked (none is performed). No production calls.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AETERNAWalletContext,
  type AeternaWallet,
} from "@/context/AETERNAWalletContext";
import { CreatorIdentityProvider } from "@/context/CreatorRuntimeContext";
import {
  LandingPaymentGateProvider,
  useLandingPaymentGate,
} from "@/context/LandingPaymentGateContext";

function GateProbe({
  harness,
}: {
  harness: { gate?: ReturnType<typeof useLandingPaymentGate> };
}) {
  harness.gate = useLandingPaymentGate();
  return null;
}

function renderGateProvider(harness: {
  gate?: ReturnType<typeof useLandingPaymentGate>;
}) {
  const disconnectedWallet = {
    walletId: null,
    walletName: null,
    account: null,
    connected: false,
    ready: false,
    error: null,
  } as unknown as AeternaWallet;

  renderToStaticMarkup(
    React.createElement(
      AETERNAWalletContext.Provider,
      { value: { state: disconnectedWallet, wallet: disconnectedWallet } },
      React.createElement(
        CreatorIdentityProvider,
        null,
        React.createElement(
          LandingPaymentGateProvider,
          null,
          React.createElement(GateProbe, { harness })
        )
      )
    )
  );
}

describe("PATCH-2F payment gate is programmatically drivable (PATCH-2K-B API)", () => {
  it("context API exposes entitlement reporting; the modal API is removed", () => {
    const harness: { gate?: ReturnType<typeof useLandingPaymentGate> } = {};
    renderGateProvider(harness);

    expect(harness.gate).toBeDefined();
    expect(typeof harness.gate!.reportCreditDiscovery).toBe("function");
    expect(typeof harness.gate!.reportCreditReady).toBe("function");
    expect(harness.gate!.entitlement).toBeNull();

    // PATCH-2K-B: no payment-modal API remains on the gate.
    const gateRecord = harness.gate as unknown as Record<string, unknown>;
    expect(gateRecord["openLandingPaymentModal"]).toBeUndefined();
    expect(gateRecord["closeLandingPaymentModal"]).toBeUndefined();
    expect(gateRecord["isPaymentModalOpen"]).toBeUndefined();
  });

  it("reportCreditDiscovery / reportCreditReady are callable and do not throw", () => {
    const harness: { gate?: ReturnType<typeof useLandingPaymentGate> } = {};
    renderGateProvider(harness);

    expect(() =>
      harness.gate!.reportCreditDiscovery({
        status: "none",
        creatorCreditId: null,
        creatorIdentityId: null,
        account: "account-a",
      })
    ).not.toThrow();
    expect(() =>
      harness.gate!.reportCreditReady({
        status: "available",
        creatorCreditId: "credit-1",
        creatorIdentityId: "identity-1",
        account: "account-a",
      })
    ).not.toThrow();
  });
});
