/**
 * AETERNA — PATCH-2K-C regression test (node environment).
 *
 * Wallet-driven create-flow events are edge-triggered (PATCH-2K-C):
 * a wallet-object re-emission while already disconnected emits nothing,
 * so a repeated DISCONNECTED can no longer reset discovering/
 * needs-payment to ready; ACCOUNT_CHANGED keeps its existing semantics.
 *
 * The production decision point is exported from CapsuleBuilder.tsx as
 * a pure function and pinned here:
 *
 * - walletFlowEvent (PATCH-2K-C): DISCONNECTED only on a real
 *   account→disconnected edge, ACCOUNT_CHANGED on a known→different
 *   known account, null otherwise;
 * - integration against the live create-flow reducer
 *   (capsuleCreateFlow): a null event leaves every state unchanged,
 *   DISCONNECTED/ACCOUNT_CHANGED reset busy and paid states to ready.
 *
 * The former PATCH-2G pure helper exports (shouldStartDiscovery /
 * discoveryNextState / createPrimaryDisabled /
 * shouldResetPaymentOnModalClose / hasRestorableEntitlement) were dead
 * test-only mirrors removed by PATCH-2K-D; the same gate invariants are
 * pinned on the live reducer by capsuleCreateFlow.test.ts.
 *
 * No DOM/network. No production calls.
 */

import { describe, expect, it } from "vitest";

import { walletFlowEvent } from "@/components/capsule/CapsuleBuilder";
import {
  reduceCreateFlow,
  type CreateFlowState,
} from "@/components/capsule/capsuleCreateFlow";

const ACCOUNT_A = "AccountAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACCOUNT_B = "AccountBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("PATCH-2K-C wallet flow events", () => {
  it("1: the initial disconnected run emits nothing", () => {
    expect(walletFlowEvent(undefined, false, null)).toBeNull();
  });

  it("2: a disconnected re-emission emits nothing (race fix)", () => {
    expect(walletFlowEvent(null, false, null)).toBeNull();
  });

  it("3: a connected account disconnecting emits DISCONNECTED", () => {
    expect(walletFlowEvent(ACCOUNT_A, false, null)).toBe("DISCONNECTED");
  });

  it("4: a different account while connected emits ACCOUNT_CHANGED", () => {
    expect(walletFlowEvent(ACCOUNT_A, true, ACCOUNT_B)).toBe("ACCOUNT_CHANGED");
  });

  it("5: the same account re-emitting emits nothing", () => {
    expect(walletFlowEvent(ACCOUNT_A, true, ACCOUNT_A)).toBeNull();
  });

  it("6: reconnecting after a disconnect emits no account switch", () => {
    expect(walletFlowEvent(null, true, ACCOUNT_A)).toBeNull();
  });
});

describe("PATCH-2K-C wallet events against the create-flow reducer", () => {
  // Mirrors the CapsuleBuilder wallet-sync effect: an event reaches the
  // reducer only when walletFlowEvent returns one (PATCH-2K-C).
  const applyWalletEvent = (
    state: CreateFlowState,
    previous: string | null | undefined,
    connected: boolean,
    account: string | null
  ): CreateFlowState => {
    const ev = walletFlowEvent(previous, connected, account);
    return ev ? reduceCreateFlow(state, ev) : state;
  };

  it("a null event leaves 'discovering' unchanged (no repeated DISCONNECTED reset)", () => {
    expect(applyWalletEvent("discovering", null, false, null)).toBe("discovering");
    expect(applyWalletEvent("needs-payment", null, false, null)).toBe("needs-payment");
    expect(applyWalletEvent("paid", null, false, null)).toBe("paid");
  });

  it("DISCONNECTED moves discovering -> ready", () => {
    expect(applyWalletEvent("discovering", ACCOUNT_A, false, null)).toBe("ready");
    expect(applyWalletEvent("needs-payment", ACCOUNT_A, false, null)).toBe("ready");
  });

  it("ACCOUNT_CHANGED resets the flow to ready per the existing reducer", () => {
    expect(applyWalletEvent("discovering", ACCOUNT_A, true, ACCOUNT_B)).toBe("ready");
    expect(applyWalletEvent("needs-payment", ACCOUNT_A, true, ACCOUNT_B)).toBe("ready");
    expect(applyWalletEvent("paid", ACCOUNT_A, true, ACCOUNT_B)).toBe("ready");
  });
});
