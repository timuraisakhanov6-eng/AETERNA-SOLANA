/**
 * AETERNA — PATCH-2G regression test (node environment).
 *
 * Closes the race where a creator with an existing AVAILABLE Creator
 * Credit could click "Pay $1 & Create Capsule" while entitlement
 * discovery was still in flight (and, after a no-credit/error outcome,
 * discovery would loop back into repeated signMessage requests for the
 * same wallet).
 *
 * The production state machine is exported from CapsuleBuilder.tsx as
 * pure functions and pinned here:
 *
 * - shouldStartDiscovery: one attempt per wallet account per component
 *   session (attempted-ref semantics), never from paid, never while a
 *   previous attempt is still in flight, never without a wallet.
 * - discoveryNextState: ready→discovering→(paid | ready), with
 *   "available" preserving PATCH-2F (always restores paid) and
 *   no-credit/error only un-doing the discovering phase — never
 *   clobbering paid/payment_in_progress.
 * - createPrimaryDisabled: "discovering" disables the create button;
 *   every pre-existing state's disable behavior is unchanged.
 * - walletFlowEvent (PATCH-2K-C): wallet-driven flow events are
 *   edge-triggered — a wallet-object re-emission while already
 *   disconnected emits nothing, so a repeated DISCONNECTED can no longer
 *   reset discovering/needs-payment to ready; ACCOUNT_CHANGED keeps its
 *   existing semantics.
 *
 * No DOM/network. No production calls.
 */

import { describe, expect, it } from "vitest";

import {
  createPrimaryDisabled,
  discoveryNextState,
  shouldResetPaymentOnModalClose,
  shouldStartDiscovery,
  walletFlowEvent,
  type DiscoveryOutcomeKind,
  type ServicePaymentState,
} from "@/components/capsule/CapsuleBuilder";
import {
  reduceCreateFlow,
  type CreateFlowState,
} from "@/components/capsule/capsuleCreateFlow";

const ACCOUNT_A = "AccountAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACCOUNT_B = "AccountBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("PATCH-2G discovery start guard", () => {
  it("A: 'ready' starts the discovering phase", () => {
    expect(discoveryNextState("ready", "start")).toBe("discovering");
  });

  it("E: the same wallet account cannot start discovery twice", () => {
    // First attempt: nothing recorded yet for ACCOUNT_A.
    expect(shouldStartDiscovery(true, ACCOUNT_A, "ready", null, false)).toBe(true);
    // While that attempt is in flight.
    expect(
      shouldStartDiscovery(true, ACCOUNT_A, "discovering", ACCOUNT_A, true)
    ).toBe(false);
    // After it ended with no credit (state back to "ready"): the
    // attempted-ref still blocks a second discovery for ACCOUNT_A.
    expect(
      shouldStartDiscovery(true, ACCOUNT_A, "ready", ACCOUNT_A, false)
    ).toBe(false);
  });

  it("F: a different wallet account may start a new discovery", () => {
    expect(
      shouldStartDiscovery(true, ACCOUNT_B, "ready", ACCOUNT_A, false)
    ).toBe(true);
  });

  it("start never fires from paid/payment_in_progress or without a wallet", () => {
    expect(discoveryNextState("paid", "start")).toBeNull();
    expect(discoveryNextState("payment_in_progress", "start")).toBeNull();
    expect(shouldStartDiscovery(true, ACCOUNT_A, "paid", null, false)).toBe(false);
    expect(shouldStartDiscovery(false, null, "ready", null, false)).toBe(false);
    expect(shouldStartDiscovery(true, ACCOUNT_A, "ready", null, true)).toBe(false);
  });
});

describe("PATCH-2G discovery outcome transitions", () => {
  it("B: available restores paid (PATCH-2F semantics preserved)", () => {
    expect(discoveryNextState("discovering", "available")).toBe("paid");
  });

  it("C: no credit returns to ready (un-blocks the canonical $1 path, no loop)", () => {
    expect(discoveryNextState("discovering", "no-credit")).toBe("ready");
  });

  it("D: error returns to ready", () => {
    expect(discoveryNextState("discovering", "error")).toBe("ready");
  });

  it("no-credit/error never clobber paid/payment_in_progress", () => {
    expect(discoveryNextState("paid", "no-credit")).toBeNull();
    expect(discoveryNextState("paid", "error")).toBeNull();
    expect(discoveryNextState("payment_in_progress", "no-credit")).toBeNull();
    expect(discoveryNextState("payment_in_progress", "error")).toBeNull();
  });

  it("available is idempotent on paid and wins from payment_in_progress", () => {
    expect(discoveryNextState("paid", "available")).toBeNull();
    expect(discoveryNextState("payment_in_progress", "available")).toBe("paid");
  });
});

describe("PATCH-2G create button guard", () => {
  const outcomes: DiscoveryOutcomeKind[] = ["start", "available", "no-credit", "error"];

  it("G: discovering disables the button even with a complete capsule", () => {
    expect(createPrimaryDisabled(false, "discovering", true, true)).toBe(true);
  });

  it("G: the discovering phase is reachable only from ready", () => {
    const from: ServicePaymentState[] = ["ready", "payment_in_progress", "paid", "discovering"];
    expect(from.map((s) => discoveryNextState(s, "start"))).toEqual([
      "discovering",
      null,
      null,
      null,
    ]);
    expect(outcomes.length).toBe(4);
  });

  it("H: paid behavior unchanged", () => {
    expect(createPrimaryDisabled(false, "paid", true, true)).toBe(false);
    expect(createPrimaryDisabled(false, "paid", false, true)).toBe(true);
    expect(createPrimaryDisabled(false, "paid", true, false)).toBe(true);
  });

  it("H: payment_in_progress/ready/storage-review behavior unchanged", () => {
    expect(createPrimaryDisabled(false, "payment_in_progress", true, true)).toBe(true);
    expect(createPrimaryDisabled(false, "ready", true, true)).toBe(false);
    expect(createPrimaryDisabled(false, "ready", false, true)).toBe(true);
    expect(createPrimaryDisabled(true, "paid", true, true)).toBe(false);
    expect(createPrimaryDisabled(true, "paid", true, false)).toBe(true);
  });
});

describe("PATCH-2G abandoned payment-modal close reset", () => {
  it("I: a close without a granted credit returns payment_in_progress to ready", () => {
    expect(shouldResetPaymentOnModalClose(false, false, "payment_in_progress")).toBe(true);
  });

  it("I: an open modal never resets", () => {
    expect(shouldResetPaymentOnModalClose(true, false, "payment_in_progress")).toBe(false);
  });

  it("I: a close that accompanies a granted credit never resets", () => {
    expect(shouldResetPaymentOnModalClose(false, true, "payment_in_progress")).toBe(false);
  });

  it("I: only payment_in_progress is resettable", () => {
    const states: ServicePaymentState[] = [
      "ready",
      "paid",
      "discovering",
    ];
    expect(
      states.map((s) => shouldResetPaymentOnModalClose(false, false, s))
    ).toEqual([false, false, false]);
  });
});

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
