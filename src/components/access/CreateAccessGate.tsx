/**
 * AETERNA — Home Access Gate (wallet → entitlement → $1 creation right)
 *
 * The Home page is the admission gate for capsule creation. This component
 * owns the ENTIRE pre-/create flow and reuses the canonical machinery
 * unchanged:
 *
 *   - the headless servicePaymentController (PATCH-2H): ONE identity
 *     signature per verification flow (issue-challenge → signMessage →
 *     credit-status discovery → verify-proof), the fixed $1 USDC quote,
 *     the on-chain payment, server verification polling and grant-credit;
 *   - the reduceCreateFlow state machine (PATCH-2K-A): payment is
 *     reachable ONLY after an authoritative NO-CREDIT discovery answer;
 *   - LandingPaymentGateContext (reportCreditDiscovery / reportCreditReady)
 *     so the verified creatorIdentityId is adopted exactly as before.
 *
 * Outcomes:
 *   - AVAILABLE discovery (previously paid, unused right — including after
 *     a closed browser): grant admission → navigate /create. NO payment.
 *   - NO-CREDIT discovery: stay on Home with "Pay $1 — Unlock Creation".
 *     After the verified payment + grant: grant admission → navigate
 *     /create automatically (no second click).
 *   - Wallet/verification/payment failure or user cancellation: stay on
 *     Home with a clear retry state. No editor, no automatic retry, no
 *     double payment (the controller's tx-uniqueness claim and replay
 *     idempotency remain the server-side guards).
 *
 * Mobile: Phantom does not inject into mobile Safari/Chrome. Mobile
 * without an injected Phantom is offered the official "Open in Phantom"
 * action (the installed AppKit MobileWalletUtil deeplink — no hand-built
 * URL) plus the official install link and a return instruction. Inside
 * Phantom's own browser the provider IS injected, so the normal headless
 * flow runs and NO deeplink/redirect happens (no redirect loop).
 *
 * Nothing here is authority: the Creator Credit record, the challenge
 * proof and every creation operation remain server-side. Admission is a
 * non-persisted in-memory token (CreateAccessContext) — a URL, router
 * state or React flag can never prove payment.
 *
 * Bounded CONSUMING recovery: when this browser previously reserved a
 * lifecycle that was never published or sealed, the gate OFFERS a
 * user-triggered POST /api/creator/recover-lifecycle. It is NEVER called
 * automatically (no unmount / tab-close / visit hook). The Durable Object
 * decides authoritatively and restores AVAILABLE only when the
 * publication AND seal are both unverified and no publication claim is in
 * flight (see src/lib/access/unfinishedLifecycle.ts).
 */

import { useCallback, useEffect, useRef, useState, useReducer, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAeternaWallet } from "@/context/AETERNAWalletContext";
import { useCreateAccess } from "@/context/CreateAccessContext";
import { useLandingPaymentGate } from "@/context/LandingPaymentGateContext";
import {
  createServicePaymentController,
} from "@/lib/payment/servicePaymentController";
import type {
  ServicePaymentController,
  ServicePaymentUnfinishedLifecycle,
} from "@/lib/payment/servicePaymentController";
import { readPendingPaymentAttempt } from "@/lib/payment/pendingPaymentAttempt";
import {
  INITIAL_CREATE_FLOW_STATE,
  reduceCreateFlow,
} from "@/components/capsule/capsuleCreateFlow";
import {
  PHANTOM_INSTALL_URL,
  PHANTOM_MOBILE_BODY,
  PHANTOM_MOBILE_OPEN_LABEL,
  PHANTOM_MOBILE_TITLE,
  PHANTOM_REQUIRED_BODY,
  PHANTOM_REQUIRED_TITLE,
  isMobileBrowser,
  isPhantomAvailable,
  openAeternaInPhantomMobile,
} from "@/lib/wallet/phantomProvider";
import {
  describeRecoveryResponse,
  readUnfinishedLifecycles,
  removeUnfinishedLifecycle,
  type RecoveryOutcome,
  type UnfinishedLifecycleRecord,
} from "@/lib/access/unfinishedLifecycle";

/* ================= SHARED GATE COPY ================= */

// Short, non-technical error text for the inline status line. The raw
// controller error code stays in state (support/debug) and is never
// rendered. Same contract the inline /create gate used (PATCH-2K-B).
function describeGateError(raw: string | null): string {
  if (!raw) return "Something went wrong. Please try again.";
  const code = raw.toUpperCase();
  if (code.includes("CREATOR_ALREADY_HAS_LIVE_RIGHT")) {
    return "You already have a creation right — checking it now.";
  }
  if (code.includes("QUOTE_EXPIRED_REFRESH_REQUIRED")) {
    return "Your payment window expired. Tap Pay again for a fresh window on the same purchase — nothing was charged.";
  }
  if (code.includes("PAYMENT_OUTCOME_UNKNOWN")) {
    return "We are checking your previous payment attempt. Nothing new has been sent.";
  }
  if (code.includes("PAYMENT_REJECTED_BY_WALLET")) {
    return "You cancelled in your wallet. Nothing was sent — you can try again.";
  }
  if (
    code.includes("ENTITLEMENT_STATE_UNKNOWN") ||
    code.includes("ENUMERATION_INCOMPLETE") ||
    code.includes("ENUMERATION_UNAVAILABLE") ||
    code.includes("ENTITLEMENT_STATE_UNREADABLE")
  ) {
    return "We could not confirm your creation right right now. Nothing was charged — please check again.";
  }
  if (code.includes("PAYMENT_ATTEMPT_ACTIVE")) {
    return "An earlier purchase attempt is still open. Resuming it instead of starting a new one.";
  }
  /**
   * SERVER-SIDE TRANSACTION-FORMAT REFUSAL.
   *
   * `INVALID_INSTRUCTION_COUNT` (the strict parser) and
   * `UNEXPECTED_INSTRUCTION_COUNT` (the canonical-shape validator) mean
   * the server refused the SIGNED TRANSACTION before it submitted
   * anything — not that the wallet or the verification failed. This must
   * never fall through to the generic "Something went wrong" copy, and it
   * must not invite an immediate retry while a previous payment attempt
   * may still be under verification: the copy states the server-side fact
   * and nothing about the user's funds.
   */
  if (
    code.includes("INVALID_INSTRUCTION_COUNT") ||
    code.includes("UNEXPECTED_INSTRUCTION_COUNT")
  ) {
    return "Your wallet's transaction was rejected by our server before it was submitted — the transaction format did not match what this payment expects. If a payment is still being checked, wait for that result before paying again.";
  }
  if (code.includes("SIGNATURE") || code.includes("CHALLENGE")) {
    return "Wallet verification was not completed. Please try again.";
  }
  if (code.includes("QUOTE")) {
    return "Payment setup failed. Please try again.";
  }
  if (code.includes("PAYMENT") || code.includes("VERIF") || code.includes("GRANT")) {
    return "Payment could not be verified. No entitlement was granted. Please try again.";
  }
  if (code.includes("WALLET") || code.includes("ACCOUNT")) {
    return "Wallet connection issue. Please try again.";
  }
  return "Something went wrong. Please try again.";
}

/**
 * Wallet-driven gate events (PATCH-2K-C semantics, shared with the
 * builder-side wallet guard exported from CapsuleBuilder): a disconnect
 * only counts when a real account was previously connected; an account
 * switch is a known account replaced by a different known account.
 */
function walletFlowEvent(
  previous: string | null | undefined,
  connected: boolean,
  account: string | null
): "DISCONNECTED" | "ACCOUNT_CHANGED" | null {
  if (!connected) {
    return previous !== null && previous !== undefined
      ? "DISCONNECTED"
      : null;
  }

  if (previous !== account) {
    if (previous !== null && account !== null) {
      return "ACCOUNT_CHANGED";
    }
  }

  return null;
}

/* ================= COMPONENT ================= */

/**
 * Owner proof for POST /api/creator/recover-lifecycle (D3).
 *
 * Reuses the EXISTING identity scheme — the same SIWS challenge + wallet
 * signature the payment flow already performs. No new password, secret or
 * ownership model is introduced, and no seed phrase / private key is ever
 * read. The signature binds the recovery request to the creator account;
 * the server resolves the creator identity from it and requires that
 * identity to be the credit's owner.
 *
 * Returns null when the wallet cannot produce a proof (not connected, no
 * account, challenge refused) — the caller then refuses to recover.
 */
async function buildRecoveryOwnerProof(
  wallet: { connected: boolean; account: string | null; signMessage: (m: string | Uint8Array) => Promise<{ signature: Uint8Array }> }
): Promise<{
  challengeId: string;
  network: string;
  account: string;
  signature: string;
} | null> {
  const account = wallet.account;
  if (!wallet.connected || !account) return null;

  try {
    const res = await fetch("/api/creator/issue-challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network: "solana", publicKey: account }),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      id?: unknown;
      challengeId?: unknown;
      message?: unknown;
    } | null;

    const challengeId =
      typeof data?.id === "string"
        ? data.id
        : typeof data?.challengeId === "string"
        ? data.challengeId
        : "";
    if (!res.ok || !data?.ok || !challengeId || typeof data.message !== "string") {
      return null;
    }

    const { signature } = await wallet.signMessage(
      new TextEncoder().encode(data.message)
    );
    const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)));

    return { challengeId, network: "solana", account, signature: encoded };
  } catch {
    // Wallet rejected / transport failure: no proof, no recovery.
    return null;
  }
}

export default function CreateAccessGate() {
  const navigate = useNavigate();
  const { admission, grantAccess, clearAccess } = useCreateAccess();
  const { reportCreditDiscovery, reportCreditReady } = useLandingPaymentGate();
  const wallet = useAeternaWallet();

  /* ---------- headless service payment controller (canonical flow) ---------- */

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const servicePaymentRef = useRef<ServicePaymentController | null>(null);
  if (!servicePaymentRef.current) {
    servicePaymentRef.current = createServicePaymentController({
      isCancelled: () => !mountedRef.current,
    });
  }
  const servicePayment = servicePaymentRef.current;

  const servicePaymentRuntime = useSyncExternalStore(
    servicePayment.subscribe,
    servicePayment.getState,
    servicePayment.getState
  );

  const [createFlowState, dispatchCreateFlow] = useReducer(
    reduceCreateFlow,
    INITIAL_CREATE_FLOW_STATE
  );

  /* ---------- UX-only gate surfaces ---------- */

  const [phantomRequired, setPhantomRequired] = useState(false);
  const [phantomMobileRequired, setPhantomMobileRequired] = useState(false);
  // A verified payment whose grant response carried no creatorCreditId is a
  // server-contract anomaly: the entitlement cannot be activated. No retry
  // is offered (a retry could double-charge); the user is told to contact
  // support instead.
  const [grantIncomplete, setGrantIncomplete] = useState(false);

  /* ---------- bounded CONSUMING recovery (user-triggered only) ---------- */

  // D2: local pointers to unfinished attempts started in THIS browser. They
  // are auxiliary only: the authoritative list comes from the server's
  // enumeration (servicePaymentRuntime.discovery.unfinishedLifecycles), so a
  // cleared localStorage or a different device can no longer hide a right.
  const [localHints, setLocalHints] = useState<UnfinishedLifecycleRecord[]>(
    () => readUnfinishedLifecycles()
  );
  const [recovering, setRecovering] = useState(false);
  const [recoveryOutcome, setRecoveryOutcome] = useState<RecoveryOutcome | null>(
    null
  );
  // Set when the pre-payment entitlement re-check could not CONFIRM the
  // absence of an active right. Payment is refused in that case.
  const [recheckError, setRecheckError] = useState(false);

  /**
   * Set when the SAME purchase attempt is already recorded as verified
   * server-side but this browser holds no transaction signature to
   * resume: nothing may be sent, and the creator is told why.
   */
  const [paymentHold, setPaymentHold] = useState<string | null>(null);
  // True while the pre-payment entitlement re-check is running.
  const [rechecking, setRechecking] = useState(false);

  /* ---------- controller wiring (same order the inline gate used) ---------- */

  useEffect(() => {
    servicePayment.setParams({
      creatorIdentityId: null,
      protocolAccepted: true,
      stopAfterCredit: true,
    });
  }, [servicePayment]);

  /**
   * The AUTHORITATIVE unfinished lifecycles reported by the server. Every
   * entry is read from the server's own CreditRecord — the client never
   * supplies these identifiers.
   */
  const unfinishedLifecycles =
    servicePaymentRuntime.discovery?.unfinishedLifecycles ?? [];

  /**
   * The server-derived creator identity of the last verified discovery.
   * Used only as the CLAIM in the recovery request — the endpoint resolves
   * the identity from the signed proof and requires the two to match.
   */
  const creatorIdentityIdForRecovery =
    servicePaymentRuntime.discovery?.creatorIdentityId ?? "";

  /** Authoritative summary of the creator's rights (null when unknown). */
  const discoverySummary = servicePaymentRuntime.discovery?.summary ?? null;

  /**
   * Grant the in-memory admission from an authoritative AVAILABLE answer.
   * A partially-identified result grants nothing (fail-closed).
   */
  const grantAdmissionFromDiscovery = useCallback(
    (result: {
      creatorCreditId: string | null;
      creatorIdentityId: string | null;
      account: string | null;
    }) => {
      if (
        result.creatorCreditId &&
        result.creatorIdentityId &&
        result.account
      ) {
        grantAccess({
          creatorCreditId: result.creatorCreditId,
          creatorIdentityId: result.creatorIdentityId,
          account: result.account,
        });
      } else {
        setGrantIncomplete(true);
      }
    },
    [grantAccess]
  );

  // Server-verified facts enter as reducer events; entitlement facts go to
  // the gate mirror (adoptIdentity) AND to the in-memory admission. All
  // three updates land in ONE React commit, so the navigation effect below
  // always observes the committed admission — a paid flow can never
  // navigate into /create without it.
  useEffect(() => {
    servicePayment.setCallbacks({
      onCreditDiscovered: (result) => {
        reportCreditDiscovery(result);
        // D1: three distinct authoritative answers. CONSUMING is NEVER
        // folded into "none" — it parks the flow in needs-recovery, which
        // cannot reach a payment.
        dispatchCreateFlow(
          result.status === "available"
            ? "DISCOVERY_AVAILABLE"
            : result.status === "consuming"
            ? "DISCOVERY_CONSUMING"
            : "DISCOVERY_NONE"
        );
        if (result.status === "available") {
          grantAdmissionFromDiscovery(result);
        }
      },
      onCreditReady: (result) => {
        reportCreditReady(result);
        dispatchCreateFlow("PAYMENT_CONFIRMED");
        if (result.creatorCreditId) {
          grantAccess({
            creatorCreditId: result.creatorCreditId,
            creatorIdentityId: result.creatorIdentityId ?? "",
            account: result.account ?? "",
            ...(result.paymentIntentId !== undefined
              ? { paymentIntentId: result.paymentIntentId }
              : {}),
          });
        } else {
          setGrantIncomplete(true);
        }
      },
    });
  }, [servicePayment, reportCreditDiscovery, reportCreditReady, grantAccess, grantAdmissionFromDiscovery]);

  useEffect(() => {
    servicePayment.syncWallet(wallet);
  }, [servicePayment, wallet]);

  // Account switch / disconnect void the (account-bound) admission: the
  // creator must re-run the gate with the identity that owns the credit.
  const previousWalletAccountRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = previousWalletAccountRef.current;
    if (previous !== undefined) {
      const ev = walletFlowEvent(previous, wallet.connected, wallet.account);
      if (ev) {
        clearAccess();
      }
    }
    previousWalletAccountRef.current = wallet.connected ? wallet.account : null;
  }, [wallet, clearAccess]);

  // Controller error → reducer (same semantics as the inline gate: a
  // payment-phase failure returns to $1 confirm with the discovery answer
  // preserved; identity-phase failures surface the retry state).
  useEffect(() => {
    if (servicePaymentRuntime.phase !== "error") return;
    const paymentError = servicePaymentRuntime.error ?? "";
    /**
     * These two are NOT generic failures: the controller's pre-signature
     * authoritative re-read found this purchase already settled by
     * another tab/device. `confirmPayment` continues the EXISTING access
     * flow for them, so the generic abort must not race that decision.
     */
    if (
      paymentError.includes("PAYMENT_ALREADY_GRANTED_REFRESH_REQUIRED") ||
      paymentError.includes("PAYMENT_ALREADY_RECORDED_CHECK_REQUIRED")
    ) {
      return;
    }
    dispatchCreateFlow(
      createFlowState === "payment-in-progress"
        ? "PAYMENT_ABORTED"
        : "ERROR"
    );
  }, [servicePaymentRuntime.phase, createFlowState, servicePaymentRuntime.error]);

  // The ONLY navigation into /create: admitted AND the state machine is
  // paid. Never fired from an event handler — always after the commit
  // that established admission.
  useEffect(() => {
    if (createFlowState === "paid" && admission) {
      navigate("/create");
    }
  }, [createFlowState, admission, navigate]);

  /* ---------- actions ---------- */

  // Canonical discovery run: identity verification + credit discovery.
  // Never a quote, never a payment (payment is reachable only after an
  // authoritative NO-CREDIT discovery). Kept free of any state guard so
  // the post-recovery restart can invoke it directly.
  const beginDiscovery = () => {
    dispatchCreateFlow("CREATE_CLICKED");

    const runtime = servicePayment.getState();
    if (
      runtime.discovery?.status === "none" &&
      runtime.verifiedCreatorIdentityId
    ) {
      // Retry after a payment-phase error: identity and the NO-CREDIT
      // discovery answer are already established — return straight to the
      // $1 confirm step without re-running discovery or asking for a
      // second signature.
      dispatchCreateFlow("DISCOVERY_NONE");
      return;
    }

    void servicePayment.connectWallet();
  };

  // First explicit Create Capsule action: identity verification + credit
  // discovery. Never a quote, never a payment.
  const start = () => {
    if (admission) {
      // Already admitted in this session: no re-check, no re-payment.
      navigate("/create");
      return;
    }

    if (
      createFlowState !== "ready" &&
      createFlowState !== "error" &&
      createFlowState !== "needs-recovery"
    ) {
      return;
    }

    setGrantIncomplete(false);
    setRecoveryOutcome(null);

    // Model 01 wallet policy: Phantom only
    // (docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1).
    // Stop BEFORE connect, SIWS, quote, the $1 payment or any Irys action
    // when Phantom is not available. UX gate only — the server remains the
    // sole identity/payment authority.
    if (!isPhantomAvailable()) {
      // Model 01 mobile: Phantom connects through its own in-app browser,
      // so offer the official deeplink instead of the desktop install
      // notice. Nothing is connected, quoted or paid here.
      if (isMobileBrowser()) {
        setPhantomMobileRequired(true);
        setPhantomRequired(false);
        return;
      }

      setPhantomMobileRequired(false);
      setPhantomRequired(true);
      return;
    }

    setPhantomMobileRequired(false);
    setPhantomRequired(false);
    beginDiscovery();
  };

  // THE single production payment trigger: an explicit confirm click while
  // the flow is in needs-payment.
  //
  // Before ANY money moves, a FRESH authoritative entitlement re-check runs
  // (KV eventual consistency means a single earlier answer is not authority
  // for a new $1). It creates no quote, no payment and no entitlement; the
  // existing payment flow continues only after the check CONFIRMS that no
  // AVAILABLE and no CONSUMING right exists.
  const confirmPayment = async () => {
    if (createFlowState !== "needs-payment") return;

    // An in-session admission means this creator already holds a right —
    // never re-check-and-pay in the same flow.
    if (admission) {
      navigate("/create");
      return;
    }

    setRecheckError(false);
    setPaymentHold(null);
    setRechecking(true);
    try {
      let rechecked;
      try {
        rechecked = await servicePayment.recheckEntitlement();
      } catch {
        // Transport / signature / unreadable answer / cancelled: a check
        // that did not complete is NOT authority to pay.
        setRecheckError(true);
        return;
      }


      if (rechecked.status === "available") {
        // A right exists after all (KV lag, or a payment in another tab):
        // grant admission and NEVER start a second payment. The reducer
        // event moves the flow to paid, which is what triggers navigation.
        grantAdmissionFromDiscovery(rechecked);
        dispatchCreateFlow("DISCOVERY_AVAILABLE");
        return;
      }

      if (rechecked.status === "consuming") {
        // A right is bound to an unfinished lifecycle: offer recovery.
        dispatchCreateFlow("DISCOVERY_CONSUMING");
        return;
      }

      if (rechecked.summary?.enumerationComplete !== true) {
        // "none" from an enumeration that could not be confirmed complete —
        // refuse to pay on an unconfirmed absence.
        setRecheckError(true);
        return;
      }
    } finally {
      setRechecking(false);
    }

    dispatchCreateFlow("PAYMENT_STARTED");

    if (servicePayment.getState().quote === null) {
      await servicePayment.requestQuote();
      const requested = servicePayment.getState().quote;
      if (requested && requested.paymentState === "granted") {
        // The purchase already produced a Creator Credit: re-run the
        // AUTHORITATIVE discovery, which admits the creator on the right
        // that already exists. (`beginDiscovery` would short-circuit on
        // the earlier NO-CREDIT answer and loop back to the $1 step.)
        dispatchCreateFlow("RESET");
        await servicePayment.verifyIdentity();
        return;
      }
      if (requested && requested.paymentState === "verified_pending_grant") {
        /**
         * A payment is already recorded for this attempt. It may only be
         * resumed by verifying THAT transaction — which requires its
         * signature. Without it, nothing is sent and the creator is told
         * the previous attempt is being checked.
         */
        const pending = readPendingPaymentAttempt();
        if (
          !pending ||
          !pending.transactionId ||
          pending.paymentIntentId !== requested.paymentIntentId
        ) {
          dispatchCreateFlow("RESET");
          setPaymentHold(
            "A previous payment attempt for this purchase is being checked. Nothing new will be sent — tap Check again shortly."
          );
          return;
        }
      }
      if (servicePayment.getState().quote === null) {
        /**
         * The server-side purchase guard refused to mint a payment
         * intent because a live right already exists (or an earlier
         * purchase attempt is still open). That is NOT an error state
         * for the creator: re-run the authoritative discovery, which
         * routes to creation when a right is available and offers
         * recovery when one is bound to an unfinished lifecycle.
         */
        const quoteError = servicePayment.getState().error ?? "";
        if (
          quoteError.includes("CREATOR_ALREADY_HAS_LIVE_RIGHT") ||
          quoteError.includes("PAYMENT_ATTEMPT_ACTIVE")
        ) {
          dispatchCreateFlow("RESET");
          beginDiscovery();
          return;
        }
        // Quote failed for another reason: the controller is in the error
        // phase; the error effect above moves the flow to the retry state.
        return;
      }
    }

    await servicePayment.confirmAndVerify();

    /**
     * The controller's AUTHORITATIVE PRE-SIGNATURE RE-READ can discover
     * that this purchase was already settled by ANOTHER tab or device
     * while THIS tab held a stale quote. Nothing was signed or sent —
     * continue the EXISTING access flow instead of charging again.
     */
    const postPaymentError = servicePayment.getState().error ?? "";
    if (postPaymentError.includes("PAYMENT_ALREADY_GRANTED_REFRESH_REQUIRED")) {
      // The credit already exists: re-run the authoritative discovery,
      // which admits the creator on the right that is already theirs.
      dispatchCreateFlow("RESET");
      setPaymentHold(null);
      await servicePayment.verifyIdentity();
      return;
    }
    if (postPaymentError.includes("PAYMENT_ALREADY_RECORDED_CHECK_REQUIRED")) {
      // A verified payment is already recorded and its grant is
      // unfinished: fail closed — nothing new is sent.
      dispatchCreateFlow("RESET");
      setPaymentHold(
        "A previous payment attempt for this purchase is being checked. Nothing new will be sent — tap Check again shortly."
      );
      return;
    }
  };

  // Bounded, EXPLICIT user-triggered recovery of ONE unfinished lifecycle.
  // Never called automatically. The identifiers come from the AUTHORITATIVE
  // enumeration (the server's own CreditRecord), the request carries a
  // signed OWNER PROOF (D3), and the Durable Object remains the sole
  // decision authority.
  const handleRecover = async (
    record: ServicePaymentUnfinishedLifecycle
  ) => {
    if (recovering) return;
    if (!record.creatorCreditId || !record.lifecycleId || !record.capsuleId) {
      // An incomplete server record cannot be recovered safely.
      setRecoveryOutcome({
        kind: "unknown",
        message:
          "This unfinished attempt is missing its identifiers. Please contact support.",
      });
      return;
    }

    setRecovering(true);
    setRecoveryOutcome(null);
    try {
      // D3: without a valid owner proof the request is refused locally and
      // nothing is restored. Knowledge of the identifiers alone is not
      // sufficient authority.
      const proof = await buildRecoveryOwnerProof(wallet);
      if (!proof) {
        setRecoveryOutcome({
          kind: "unauthorized",
          message:
            "Connect the wallet that paid for this creation right, then try again.",
        });
        return;
      }

      const res = await fetch("/api/creator/recover-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorIdentityId: creatorIdentityIdForRecovery,
          lifecycleId: record.lifecycleId,
          capsuleId: record.capsuleId,
          ...proof,
        }),
      });
      const payload = await res.json().catch(() => null);
      const outcome = describeRecoveryResponse(res.status, payload);

      if (outcome.kind === "restored") {
        // The server restored the unused creation right: drop THIS local
        // pointer only (D2 — the others are untouched) and re-run the
        // canonical discovery, which now finds the AVAILABLE credit.
        // No second $1.
        removeUnfinishedLifecycle(record.lifecycleId);
        setLocalHints(readUnfinishedLifecycles());
        setRecoveryOutcome(null);
        dispatchCreateFlow("RESET");
        beginDiscovery();
        return;
      }

      if (outcome.kind === "resolved") {
        // Nothing left to recover (consumed / resolved / record not found):
        // drop only this stale pointer.
        removeUnfinishedLifecycle(record.lifecycleId);
        setLocalHints(readUnfinishedLifecycles());
      }

      // "blocked" / "unauthorized" / "unknown" keep the pointer: the right
      // may still be recoverable.
      setRecoveryOutcome(outcome);
    } catch {
      setRecoveryOutcome({
        kind: "unknown",
        message: "We could not check the unfinished attempt. Please try again.",
      });
    } finally {
      setRecovering(false);
    }
  };

  /* ---------- derived UI ---------- */

  const busy =
    createFlowState === "discovering" ||
    createFlowState === "payment-in-progress" ||
    rechecking ||
    /**
     * Controller phases in which a WALLET REQUEST IS IN FLIGHT (connect /
     * identity verification / transaction confirmation). The reducer alone
     * is not enough: a phase-driven re-render can put the flow back into
     * "ready" while the controller is still working, which is exactly how
     * a second click used to open a second signature window. Disabling the
     * primary action for the whole in-flight phase closes that hole; the
     * controller's own in-flight guards remain the authoritative
     * protection.
     */
    servicePaymentRuntime.phase === "connecting_wallet" ||
    servicePaymentRuntime.phase === "verifying_identity" ||
    servicePaymentRuntime.phase === "confirming";

  const primaryLabel =
    createFlowState === "needs-payment"
      ? "Pay $1 — Unlock Creation"
      : createFlowState === "needs-recovery"
      ? "Check again"
      : "CREATE CAPSULE";

  const gateStatus = (() => {
    if (paymentHold) {
      return paymentHold;
    }
    if (grantIncomplete) {
      return "Payment was verified, but the creation right could not be activated. Please contact support.";
    }
    if (rechecking) {
      // The creator must see WHY the $1 has not started yet.
      return "Checking your creation right…";
    }
    if (recheckError) {
      // A re-check that did not CONFIRM the absence of an active right:
      // no payment is started on an unconfirmed absence.
      return "We could not confirm that you have no active creation right. Nothing was charged — please try again in a moment.";
    }
    switch (createFlowState) {
      case "discovering":
        return servicePaymentRuntime.phase === "connecting_wallet"
          ? "Connecting wallet…"
          : servicePaymentRuntime.phase === "verifying_identity"
          ? "Verifying wallet…"
          : "Checking your creation right…";
      case "needs-recovery":
        // D1: an authoritative CONSUMING answer. There is NO $1 here — the
        // creator already owns a right; it is bound to an unfinished
        // attempt that must be restored instead.
        return "You already have a creation right bound to an unfinished capsule. Restore it below — do not pay again.";
      case "needs-payment":
        // A payment-phase failure returns here (PAYMENT_ABORTED keeps
        // the discovery answer so the $1 step can be retried without a
        // second discovery): surface the reason next to the retry
        // affordance so the state is unmistakably a retry.
        if (servicePaymentRuntime.error) {
          return describeGateError(servicePaymentRuntime.error);
        }
        // A CONSUMED right is an authoritative, complete answer: the
        // creator has already used a right, and a new capsule needs a new $1.
        if (discoverySummary?.consumedCount) {
          return "Your previous creation right was used. A new capsule needs a new $1 creation right.";
        }
        return "One-time setup — $1 USDC. One capsule per payment.";
      case "payment-in-progress":
        return "Processing…";
      case "paid":
        return "Creation right confirmed — opening creation…";
      case "error":
        return describeGateError(
          servicePaymentRuntime.error ?? servicePaymentRuntime.verificationError
        );
      default:
        return null; // ready — plain Create Capsule
    }
  })();

  return (
    <div className="w-full space-y-4">
      <Button
        type="button"
        disabled={busy || recovering}
        onClick={
          createFlowState === "needs-payment" ? confirmPayment : start
        }
        className="
          w-full
          h-11
          sm:h-12
          xl:h-12
          bg-[hsl(220,35%,9%)]
          text-amber-300
          border
          border-amber-400/50
          text-[11px]
          sm:text-[12px]
          xl:text-[13px]
          font-medium
          tracking-[0.18em]
          shadow-[0_0_18px_rgba(255,180,90,0.25),inset_0_0_12px_rgba(255,180,90,0.06)]
          transition-all
          duration-300
          ease-out
          hover:bg-[hsl(220,35%,11%)]
          hover:text-amber-200
          hover:border-amber-300/70
          hover:scale-x-[1.04]
          hover:shadow-[0_0_32px_rgba(255,180,90,0.45),inset_0_0_16px_rgba(255,180,90,0.1)]
          disabled:opacity-60
          disabled:cursor-not-allowed
          disabled:hover:scale-x-100
          whitespace-normal
        "
      >
        {primaryLabel}
      </Button>

      {gateStatus && (
        <p
          className="text-[11px] md:text-[12px] xl:text-[13px] text-amber-100/60 leading-relaxed tracking-wide text-center"
          role="status"
        >
          {gateStatus}
        </p>
      )}

      {/* Unfinished-attempt recovery: offered ONLY from the AUTHORITATIVE
          enumeration (never from localStorage alone), never automatically,
          and each attempt is restored independently (D2). */}
      {unfinishedLifecycles.length > 0 && !admission && (
        <div
          className="rounded-lg border border-amber-400/30 bg-amber-500/5 p-3 space-y-2 text-center"
          role="note"
        >
          <p className="text-[11px] md:text-[12px] text-amber-100/70 leading-relaxed">
            {unfinishedLifecycles.length === 1
              ? "This wallet has an unfinished capsule attempt. If nothing was published for it, its creation right can be restored."
              : `This wallet has ${unfinishedLifecycles.length} unfinished capsule attempts. Each creation right can be restored separately.`}
          </p>
          {unfinishedLifecycles.map((record) => (
            <div key={record.creatorCreditId} className="space-y-1">
              <Button
                type="button"
                disabled={recovering || busy}
                onClick={() => {
                  void handleRecover(record);
                }}
                className="h-9 px-4 text-[11px] bg-transparent text-amber-300 border border-amber-400/50 hover:bg-amber-400/10"
              >
                {recovering
                  ? "Checking…"
                  : unfinishedLifecycles.length === 1
                  ? "Restore creation right"
                  : `Restore right ${(record.lifecycleId ?? record.creatorCreditId).slice(0, 8)}`}
              </Button>
              {/* Auxiliary local pointer only — it is NOT what made the
                  attempt discoverable. */}
              {localHints.some(
                (hint) => hint.lifecycleId === record.lifecycleId
              ) && (
                <p className="text-[10px] text-amber-100/40 leading-relaxed">
                  Started in this browser
                </p>
              )}
            </div>
          ))}
          {recoveryOutcome && (
            <p className="text-[11px] text-amber-100/60 leading-relaxed">
              {recoveryOutcome.message}
            </p>
          )}
        </div>
      )}

      {phantomMobileRequired && (
        <div
          role="alert"
          className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-500 space-y-2 text-left"
        >
          <p className="font-medium">{PHANTOM_MOBILE_TITLE}</p>
          <p>{PHANTOM_MOBILE_BODY}</p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              type="button"
              onClick={openAeternaInPhantomMobile}
              className="h-9 px-4 text-xs"
            >
              {PHANTOM_MOBILE_OPEN_LABEL}
            </Button>
            <a
              href={PHANTOM_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Install Phantom
            </a>
          </div>
          <p className="text-amber-500/80">
            After Phantom opens AETERNA, come back and tap Create Capsule again.
          </p>
        </div>
      )}

      {phantomRequired && (
        <div
          role="alert"
          className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-500 space-y-1 text-left"
        >
          <p className="font-medium">{PHANTOM_REQUIRED_TITLE}</p>
          <p>{PHANTOM_REQUIRED_BODY}</p>
          <a
            href={PHANTOM_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Install Phantom
          </a>
        </div>
      )}
    </div>
  );
}
