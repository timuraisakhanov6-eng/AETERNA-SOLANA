/**
 * AETERNA — PATCH-2K-A create-flow reducer invariants (node environment).
 *
 * Pins the pure /create service-payment gate state machine before the
 * PaymentModal removal wires it into CapsuleBuilder:
 *
 * - payment is reachable ONLY through DISCOVERY_NONE (discovery-gated);
 * - DISCOVERY_AVAILABLE never leads to payment (PATCH-2F);
 * - a repeated CREATE_CLICKED never starts a second flow (PATCH-2G);
 * - PAYMENT_ABORTED preserves the discovery answer and never erases paid;
 * - account change / disconnect reset the flow (PATCH-2J account-bound
 *   proof semantics);
 * - the reducer is pure and deterministic (no time, no randomness, no
 *   I/O — result depends only on the (state, event) input pair).
 *
 * No DOM, no network, no production calls.
 */

import { describe, expect, it } from "vitest";

import {
  INITIAL_CREATE_FLOW_STATE,
  reduceCreateFlow,
  type CreateFlowEvent,
  type CreateFlowState,
} from "@/components/capsule/capsuleCreateFlow";

const STATES: CreateFlowState[] = [
  "ready",
  "discovering",
  "needs-payment",
  "payment-in-progress",
  "paid",
  "error",
];

const EVENTS: CreateFlowEvent[] = [
  "CREATE_CLICKED",
  "DISCOVERY_AVAILABLE",
  "DISCOVERY_NONE",
  "PAYMENT_STARTED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_ABORTED",
  "ERROR",
  "ACCOUNT_CHANGED",
  "DISCONNECTED",
  "RESET",
];

describe("PATCH-2K-A create-flow transitions", () => {
  it("A: ready → discovering on CREATE_CLICKED", () => {
    expect(INITIAL_CREATE_FLOW_STATE).toBe("ready");
    expect(reduceCreateFlow("ready", "CREATE_CLICKED")).toBe("discovering");
  });

  it("B: discovering → paid on DISCOVERY_AVAILABLE", () => {
    expect(reduceCreateFlow("discovering", "DISCOVERY_AVAILABLE")).toBe("paid");
  });

  it("C: discovering → needs-payment on DISCOVERY_NONE", () => {
    expect(reduceCreateFlow("discovering", "DISCOVERY_NONE")).toBe(
      "needs-payment"
    );
  });

  it("D: needs-payment → payment-in-progress on PAYMENT_STARTED", () => {
    expect(reduceCreateFlow("needs-payment", "PAYMENT_STARTED")).toBe(
      "payment-in-progress"
    );
  });

  it("E: payment-in-progress → paid on PAYMENT_CONFIRMED", () => {
    expect(reduceCreateFlow("payment-in-progress", "PAYMENT_CONFIRMED")).toBe(
      "paid"
    );
  });

  it("F: payment-in-progress → needs-payment on PAYMENT_ABORTED (discovery answer kept)", () => {
    expect(reduceCreateFlow("payment-in-progress", "PAYMENT_ABORTED")).toBe(
      "needs-payment"
    );
  });
});

describe("PATCH-2K-A create-flow invariants", () => {
  it("G: a repeated CREATE_CLICKED never starts a second flow", () => {
    expect(reduceCreateFlow("discovering", "CREATE_CLICKED")).toBe(
      "discovering"
    );
    expect(reduceCreateFlow("needs-payment", "CREATE_CLICKED")).toBe(
      "needs-payment"
    );
    expect(reduceCreateFlow("payment-in-progress", "CREATE_CLICKED")).toBe(
      "payment-in-progress"
    );
    expect(reduceCreateFlow("paid", "CREATE_CLICKED")).toBe("paid");
  });

  it("H: PAYMENT_STARTED is accepted only from needs-payment — payment cannot start before discovery", () => {
    for (const state of STATES) {
      expect(reduceCreateFlow(state, "PAYMENT_STARTED")).toBe(
        state === "needs-payment" ? "payment-in-progress" : state
      );
    }
    // needs-payment itself is reachable only via DISCOVERY_NONE from
    // discovering — together the two tables prove every payment path
    // passes through a NO-CREDIT discovery answer.
    for (const state of STATES) {
      expect(reduceCreateFlow(state, "DISCOVERY_NONE")).toBe(
        state === "discovering" ? "needs-payment" : state
      );
    }
  });

  it("I: an AVAILABLE discovery never reaches payment", () => {
    for (const state of STATES) {
      const paid = reduceCreateFlow(state, "DISCOVERY_AVAILABLE");
      expect(paid).toBe("paid");
      expect(reduceCreateFlow(paid, "PAYMENT_STARTED")).toBe("paid");
      // A late/stale DISCOVERY_NONE must not un-do the restored credit.
      expect(reduceCreateFlow(paid, "DISCOVERY_NONE")).toBe("paid");
    }
  });

  it("J: error recovery — busy states may error; ready/paid/needs-payment are never clobbered; retry re-enters discovering", () => {
    expect(reduceCreateFlow("discovering", "ERROR")).toBe("error");
    expect(reduceCreateFlow("payment-in-progress", "ERROR")).toBe("error");
    expect(reduceCreateFlow("ready", "ERROR")).toBe("ready");
    expect(reduceCreateFlow("paid", "ERROR")).toBe("paid");
    expect(reduceCreateFlow("needs-payment", "ERROR")).toBe("needs-payment");

    // Recovery: explicit retry re-enters discovering (the controller
    // reuses the retained proof — no second signature), or RESET.
    expect(reduceCreateFlow("error", "CREATE_CLICKED")).toBe("discovering");
    expect(reduceCreateFlow("error", "RESET")).toBe("ready");
  });

  it("K: ACCOUNT_CHANGED resets every state to ready", () => {
    for (const state of STATES) {
      expect(reduceCreateFlow(state, "ACCOUNT_CHANGED")).toBe("ready");
    }
  });

  it("L: DISCONNECTED resets every state to ready", () => {
    for (const state of STATES) {
      expect(reduceCreateFlow(state, "DISCONNECTED")).toBe("ready");
    }
  });

  it("M: the reducer is pure and deterministic — result depends only on (state, event)", () => {
    const table = () =>
      STATES.flatMap((state) =>
        EVENTS.map((event) => ({
          state,
          event,
          next: reduceCreateFlow(state, event),
        }))
      );

    expect(table()).toEqual(table());

    // Every outcome is one of the six states (no out-of-table values).
    for (const state of STATES) {
      for (const event of EVENTS) {
        expect(STATES).toContain(reduceCreateFlow(state, event));
      }
    }
  });
});

describe("PATCH-2K-A create-flow scenarios", () => {
  it("flow B: connected, no credit — one discovery, cancellable $1, retry, then paid", () => {
    let state = INITIAL_CREATE_FLOW_STATE;
    state = reduceCreateFlow(state, "CREATE_CLICKED");
    expect(state).toBe("discovering");
    state = reduceCreateFlow(state, "DISCOVERY_NONE");
    expect(state).toBe("needs-payment");
    state = reduceCreateFlow(state, "PAYMENT_STARTED");
    expect(state).toBe("payment-in-progress");
    state = reduceCreateFlow(state, "PAYMENT_ABORTED");
    expect(state).toBe("needs-payment");
    // Retry without a second discovery, then pay.
    state = reduceCreateFlow(state, "PAYMENT_STARTED");
    expect(state).toBe("payment-in-progress");
    state = reduceCreateFlow(state, "PAYMENT_CONFIRMED");
    expect(state).toBe("paid");
  });

  it("flow C: available credit — discovery alone reaches paid, payment never starts", () => {
    let state = INITIAL_CREATE_FLOW_STATE;
    state = reduceCreateFlow(state, "CREATE_CLICKED");
    state = reduceCreateFlow(state, "DISCOVERY_AVAILABLE");
    expect(state).toBe("paid");
    expect(reduceCreateFlow(state, "PAYMENT_STARTED")).toBe("paid");
    expect(reduceCreateFlow(state, "PAYMENT_ABORTED")).toBe("paid");
    expect(reduceCreateFlow(state, "CREATE_CLICKED")).toBe("paid");
  });

  it("flow A: disconnected — wallet events reset safely and an explicit click restarts the only flow", () => {
    let state = INITIAL_CREATE_FLOW_STATE;
    state = reduceCreateFlow(state, "CREATE_CLICKED");
    state = reduceCreateFlow(state, "DISCONNECTED");
    expect(state).toBe("ready");
    state = reduceCreateFlow(state, "CREATE_CLICKED");
    state = reduceCreateFlow(state, "ACCOUNT_CHANGED");
    expect(state).toBe("ready");
    expect(reduceCreateFlow(state, "CREATE_CLICKED")).toBe("discovering");
  });

  it("paid survives stray late events; only explicit account/reset transitions leave it", () => {
    expect(reduceCreateFlow("paid", "PAYMENT_ABORTED")).toBe("paid");
    expect(reduceCreateFlow("paid", "ERROR")).toBe("paid");
    expect(reduceCreateFlow("paid", "DISCOVERY_NONE")).toBe("paid");
    expect(reduceCreateFlow("paid", "ACCOUNT_CHANGED")).toBe("ready");
    expect(reduceCreateFlow("paid", "DISCONNECTED")).toBe("ready");
    expect(reduceCreateFlow("paid", "RESET")).toBe("ready");
  });
});

describe("D1 — CONSUMING never becomes an invitation to pay", () => {
  it("discovering → needs-recovery on DISCOVERY_CONSUMING", () => {
    expect(reduceCreateFlow("discovering", "DISCOVERY_CONSUMING")).toBe(
      "needs-recovery"
    );
  });

  it("SCENARIO 3: needs-recovery has NO path to payment", () => {
    // The payment trigger is rejected from needs-recovery...
    expect(reduceCreateFlow("needs-recovery", "PAYMENT_STARTED")).toBe(
      "needs-recovery"
    );
    // ...and no other event can move it into needs-payment either.
    expect(reduceCreateFlow("needs-recovery", "DISCOVERY_NONE")).toBe(
      "needs-recovery"
    );
    expect(reduceCreateFlow("needs-recovery", "PAYMENT_CONFIRMED")).toBe(
      "needs-recovery"
    );
    expect(reduceCreateFlow("needs-recovery", "PAYMENT_ABORTED")).toBe(
      "needs-recovery"
    );
    // It can only leave via an explicit re-check or a successful recovery.
    expect(reduceCreateFlow("needs-recovery", "CREATE_CLICKED")).toBe(
      "discovering"
    );
    expect(reduceCreateFlow("needs-recovery", "RESET")).toBe("ready");
  });

  it("DISCOVERY_CONSUMING is accepted only from discovering (no state clobbering)", () => {
    expect(reduceCreateFlow("ready", "DISCOVERY_CONSUMING")).toBe("ready");
    expect(reduceCreateFlow("needs-payment", "DISCOVERY_CONSUMING")).toBe(
      "needs-payment"
    );
    expect(reduceCreateFlow("paid", "DISCOVERY_CONSUMING")).toBe("paid");
  });

  it("payment is still reachable ONLY through DISCOVERY_NONE", () => {
    // A full walk from every non-none branch must never reach payment.
    for (const state of ["ready", "discovering", "needs-recovery", "error", "paid"] as const) {
      expect(reduceCreateFlow(state, "PAYMENT_STARTED")).not.toBe(
        "payment-in-progress"
      );
    }
    // The canonical path still works.
    let state = INITIAL_CREATE_FLOW_STATE;
    state = reduceCreateFlow(state, "CREATE_CLICKED");
    state = reduceCreateFlow(state, "DISCOVERY_NONE");
    state = reduceCreateFlow(state, "PAYMENT_STARTED");
    expect(state).toBe("payment-in-progress");
  });

  it("a CONSUMING answer never yields paid (no entitlement from a bound right)", () => {
    expect(reduceCreateFlow("discovering", "DISCOVERY_CONSUMING")).not.toBe("paid");
  });
});
