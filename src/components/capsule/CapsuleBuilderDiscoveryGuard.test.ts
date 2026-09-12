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
 *
 * No DOM/network. No production calls.
 */

import { describe, expect, it } from "vitest";

import {
  createPrimaryDisabled,
  discoveryNextState,
  shouldStartDiscovery,
  type DiscoveryOutcomeKind,
  type ServicePaymentState,
} from "@/components/capsule/CapsuleBuilder";

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
