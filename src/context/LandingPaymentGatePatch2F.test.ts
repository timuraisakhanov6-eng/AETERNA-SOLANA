/**
 * AETERNA — PATCH-2F regression test (node environment).
 *
 * Canonical requirement: an existing AVAILABLE Creator Credit must let
 * the creator continue without a second $1 — and must not leave a
 * payment step mounted over the workspace.
 *
 * Two production behaviors are pinned here:
 *
 * 1. The payment gate is programmatically drivable: CapsuleBuilder feeds
 *    server-verified outcomes via reportCreditDiscovery /
 *    reportCreditReady (PATCH-2K-B — the app-root modal and its
 *    open/close API are removed). Mounted via react-dom/server like the
 *    other PATCH-2 node tests; no DOM needed.
 *
 * 2. CapsuleBuilder's entitlement-restore decision (exported pure
 *    predicate hasRestorableEntitlement): discovery "available" with a
 *    credit id restores the paid workspace; any other outcome ("none",
 *    or "available" without a credit id) leaves the payment state
 *    untouched.
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
import {
  hasRestorableEntitlement,
  type DiscoveryOutcome,
} from "@/components/capsule/CapsuleBuilder";

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

describe("PATCH-2F entitlement restore decision", () => {
  it("available discovery with a credit id restores entitlement (paid + gate close)", () => {
    const discovery: DiscoveryOutcome = {
      status: "available",
      creatorCreditId: "74a61dd1473459166d2f72c0d0bc6a9e",
    };
    // Production credit-status evidence for the discovered credit.
    expect(hasRestorableEntitlement(discovery)).toBe(true);
  });

  it("no credit (status none) does not restore entitlement nor close the gate", () => {
    const discovery: DiscoveryOutcome = {
      status: "none",
      creatorCreditId: null,
    };
    expect(hasRestorableEntitlement(discovery)).toBe(false);
  });

  it("available without a credit id does not restore entitlement nor close the gate", () => {
    const discovery: DiscoveryOutcome = {
      status: "available",
      creatorCreditId: null,
    };
    expect(hasRestorableEntitlement(discovery)).toBe(false);
  });

  it("empty-string credit id is treated as no entitlement", () => {
    const discovery: DiscoveryOutcome = {
      status: "available",
      creatorCreditId: "",
    };
    expect(hasRestorableEntitlement(discovery)).toBe(false);
  });
});
