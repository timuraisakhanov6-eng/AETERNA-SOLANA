/**
 * AETERNA — Capsule create-flow state machine (PATCH-2K-A)
 *
 * Pure, host-side reducer for the /create service-payment gate. It is the
 * single source of truth for WHICH step of the create flow the user is
 * in. It deliberately knows nothing about wallets, HTTP, KV, prices, or
 * the blockchain: discovery and payment facts arrive as events dispatched
 * by the host (CapsuleBuilder) from the headless service payment
 * controller.
 *
 * Invariants (pinned by capsuleCreateFlow.test.ts):
 * - payment is reachable only through DISCOVERY_NONE
 *   (ready → discovering → needs-payment → payment-in-progress);
 * - DISCOVERY_AVAILABLE never leads to payment (PATCH-2F: an available
 *   Creator Credit always restores paid, idempotently, and wins from
 *   payment-in-progress);
 * - a repeated CREATE_CLICKED during discovering / needs-payment /
 *   payment-in-progress / paid never starts a second flow;
 * - PAYMENT_ABORTED keeps the discovery answer (needs-payment) so the $1
 *   step can be retried without a second discovery, and never erases
 *   paid — an authoritative Creator Credit leaves the machine only via
 *   an explicit ACCOUNT_CHANGED / DISCONNECTED / RESET;
 * - ACCOUNT_CHANGED / DISCONNECTED reset the flow to ready: the identity
 *   proof and the discovery answer are account-bound (PATCH-2J), so a new
 *   account must re-discover before any payment. The server-side Creator
 *   Credit and the app-root entitlement mirror live OUTSIDE this reducer
 *   and are not erased by it.
 *
 * Error recovery: ERROR is accepted only from the busy states
 * (discovering / payment-in-progress) — a stray error must not clobber
 * ready, needs-payment, or paid. From error, CREATE_CLICKED re-enters
 * discovering (the controller reuses the retained identity proof without
 * a second signature) and RESET returns to ready.
 */

export type CreateFlowState =
  | "ready"
  | "discovering"
  | "needs-payment"
  | "payment-in-progress"
  | "paid"
  | "error"

export type CreateFlowEvent =
  | "CREATE_CLICKED"
  | "DISCOVERY_AVAILABLE"
  | "DISCOVERY_NONE"
  | "PAYMENT_STARTED"
  | "PAYMENT_CONFIRMED"
  | "PAYMENT_ABORTED"
  | "ERROR"
  | "ACCOUNT_CHANGED"
  | "DISCONNECTED"
  | "RESET"

export const INITIAL_CREATE_FLOW_STATE: CreateFlowState = "ready"

/**
 * Transition table. Unhandled (state, event) pairs are no-ops: the
 * reducer returns the current state unchanged, so a late or stale event
 * can never overwrite a stronger state (paid is never clobbered by a
 * stale DISCOVERY_NONE, a busy state is never restarted by a second
 * click).
 */
export function reduceCreateFlow(
  state: CreateFlowState,
  event: CreateFlowEvent
): CreateFlowState {
  switch (event) {
    case "CREATE_CLICKED":
      return state === "ready" || state === "error" ? "discovering" : state
    case "DISCOVERY_AVAILABLE":
      // PATCH-2G semantics: available always restores paid (idempotent)
      // and wins from payment-in-progress.
      return state === "paid" ? state : "paid"
    case "DISCOVERY_NONE":
      return state === "discovering" ? "needs-payment" : state
    case "PAYMENT_STARTED":
      return state === "needs-payment" ? "payment-in-progress" : state
    case "PAYMENT_CONFIRMED":
      return state === "payment-in-progress" ? "paid" : state
    case "PAYMENT_ABORTED":
      // Discovery answer preserved — the $1 step can be retried.
      return state === "payment-in-progress" ? "needs-payment" : state
    case "ERROR":
      return state === "discovering" || state === "payment-in-progress"
        ? "error"
        : state
    case "ACCOUNT_CHANGED":
    case "DISCONNECTED":
    case "RESET":
      return "ready"
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}
