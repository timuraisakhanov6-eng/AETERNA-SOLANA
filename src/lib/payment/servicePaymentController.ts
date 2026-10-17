/**
 * AETERNA — Headless Service Payment Controller (PATCH-2H Phase 1)
 *
 * Orchestration extracted verbatim from PaymentModal.tsx.
 * The modal remains the UI shell; this controller owns the canonical
 * service-payment flow:
 *
 *   paymentIntentId -> immutable quote -> Solana USDC payment
 *   -> server verification -> Creator Credit -> grant-credit
 *
 * When stopAfterCredit=true, the controller stops after grant-credit
 * and returns control to the caller without reserving lifecycle.
 *
 * This controller MUST NOT:
 * - calculate authoritative price
 * - declare payment success locally
 * - write Credit state
 * - treat frontend state as authority
 *
 * It is framework-agnostic: no JSX, no Dialog, no DOM. The UI subscribes
 * via subscribe()/getState() (useSyncExternalStore-compatible) and drives
 * the actions; wallet state is pushed in via syncWallet(); immutable
 * parameters via setParams(); result callbacks via setCallbacks().
 */

import type { Transaction, VersionedTransaction } from "@solana/web3.js"

import { signSolanaUSDCPayment } from "@/lib/wallet/solanaWallet"
import {
  clearPendingPaymentAttempt,
  readPendingPaymentAttempt,
  writePendingPaymentAttempt,
} from "@/lib/payment/pendingPaymentAttempt"

/* ───────────────── TYPES ───────────────── */

export type ServicePaymentPhase =
  | "idle"
  | "quoting"
  | "quote_ready"
  | "connecting_wallet"
  | "verifying_identity"
  | "wallet_verified"
  | "confirming"
  | "verifying"
  | "available"
  | "reserving"
  | "error"

export interface ServicePaymentQuote {
  paymentIntentId: string
  /**
   * Authoritative state of the purchase attempt this quote belongs to
   * (from the identity coordinator, via create-quote):
   *  - "ready_to_pay"            — a transfer may be sent for this intent
   *  - "verified_pending_grant"  — a payment is already recorded; resume
   *                                its verification/grant, never re-send
   *  - "granted"                 — the credit exists; go to creation
   */
  paymentState?: "ready_to_pay" | "verified_pending_grant" | "granted"
  expectedAmount: number
  currency: string
  expiresAt: number
  /**
   * DISCOVERY: the transaction signature ALREADY bound to this payment
   * intent, when the server has one (read-only read-through of the
   * identity coordinator's attempt record, returned only to the
   * identity that proved ownership of the attempt).
   *
   * A non-null value means the client must VERIFY THIS transaction and
   * must NOT sign a new one — it is what lets a browser that lost its
   * local pending record resume the SAME payment instead of sending a
   * second transfer.
   */
  resumeTransactionId?: string | null
}

/**
 * PATCH-2J: memory-only record of the ONE identity proof of the current
 * verification flow (challenge id, network, account binding, base64
 * signature, server expiry). Lives only in the controller's in-memory
 * state — never persisted, never exposed to React context or the UI —
 * and is invalidated on reset, wallet disconnect, or account switch.
 */
export interface ServicePaymentIdentityProof {
  challengeId: string
  network: string
  account: string
  signature: string
  expiresAt: number
}

/**
 * One unfinished lifecycle reported by the AUTHORITATIVE enumeration
 * (server-side `unfinishedLifecycles`). The identifiers come from the
 * server's own CreditRecord — the client never has to supply them, and a
 * lost localStorage hint can no longer hide an existing right.
 */
export interface ServicePaymentUnfinishedLifecycle {
  creatorCreditId: string;
  lifecycleId: string | null;
  capsuleId: string | null;
}

/**
 * PATCH-2J: server answer of the credit-status discovery performed with
 * the SAME proof that (may) later consume verify-proof. Carries only the
 * entitlement facts — never the raw signature/proof.
 *
 * D1 remediation: the authoritative server states are NO LONGER collapsed
 * into one bucket. `"consuming"` means the creator already owns a right
 * that is bound to an unfinished lifecycle — it must NEVER be treated as
 * "no right" (that is what invited a duplicate $1). `summary` /
 * `unfinishedLifecycles` are the authoritative enumeration result; an
 * unreadable/unknown server answer is NOT represented here at all —
 * `discoverCreditStatus` throws, so the caller fails closed rather than
 * paying.
 */
export interface ServicePaymentDiscoveryResult {
  status: "available" | "consuming" | "none"
  creatorCreditId: string | null
  creatorIdentityId: string | null
  account: string | null
  /**
   * Authoritative summary of every right owned by the verified identity.
   * Optional/additive: a binding that does not report one (an
   * owner-scoped lookup) leaves it absent.
   */
  summary?: {
    availableCount: number;
    consumingCount: number;
    consumedCount: number;
    total: number;
    /** True only when the server could vouch for a COMPLETE enumeration. */
    enumerationComplete: boolean;
  } | null
  /**
   * Authoritative unfinished lifecycles (empty array when there are none,
   * absent when the binding does not report one). Optional/additive.
   */
  unfinishedLifecycles?: ReadonlyArray<ServicePaymentUnfinishedLifecycle> | null
}

export interface ServicePaymentState {
  phase: ServicePaymentPhase
  quote: ServicePaymentQuote | null
  error: string | null
  isProcessing: boolean
  verifiedCreatorIdentityId: string | null
  verifiedCreatorAccount: string | null
  verificationError: string | null
  identityProof: ServicePaymentIdentityProof | null
  discovery: ServicePaymentDiscoveryResult | null
}

/**
 * Structural wallet surface the controller needs. Satisfied by
 * AeternaWallet (AETERNAWalletContext) without coupling this module
 * to the wallet context itself.
 */
export interface ServicePaymentWalletApi {
  connected: boolean
  account: string | null
  openWalletPicker: () => Promise<void>
  changeWallet: () => Promise<void>
  signMessage: (message: string | Uint8Array) => Promise<{ signature: Uint8Array }>
  signAndSendTransaction: (
    transaction: Transaction | VersionedTransaction
  ) => Promise<{ signature: string }>
  /**
   * Signs WITHOUT sending. Required for the two-phase payment: the
   * signature must exist before the network does.
   */
  signTransaction?: (
    transaction: Transaction | VersionedTransaction
  ) => Promise<Transaction | VersionedTransaction>
}

export interface ServicePaymentCreditResult {
  status: string
  creatorIdentityId?: string
  creatorCreditId?: string
  account?: string
  paymentIntentId?: string
}

export interface ServicePaymentReserveResult {
  creatorCreditId: string
  lifecycleId: string
  paymentIntentId: string
}

export interface ServicePaymentParams {
  creatorIdentityId?: string | null | undefined
  protocolAccepted: boolean
  stopAfterCredit?: boolean
}

export interface ServicePaymentCallbacks {
  onCreditReady?: ((result: ServicePaymentCreditResult) => void) | undefined
  onReserveReady?: ((result: ServicePaymentReserveResult) => void) | undefined
  /**
   * PATCH-2J: emitted once per verification flow with the credit-status
   * discovery answer (status / creatorCreditId / creatorIdentityId /
   * account). Entitlement facts only — the raw proof never leaves the
   * controller.
   */
  onCreditDiscovered?: ((result: ServicePaymentDiscoveryResult) => void) | undefined
}

export interface ServicePaymentControllerDeps extends ServicePaymentCallbacks {
  /**
   * Cancellation probe (UI unmount / modal closed). In PaymentModal this
   * replaces the mountedRef check inside the wallet-connection wait loop.
   */
  isCancelled?: (() => boolean) | undefined
  /** Test seam only — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch | undefined
  /**
   * Test seam ONLY — the wallet's SIGN-WITHOUT-SENDING capability.
   *
   * The local pending-payment record may only be released automatically
   * after a proven pre-broadcast refusal when the payment path never
   * handed the transaction to a sending wallet primitive. Production
   * always uses the canonical path (`signTransaction` only, see
   * `confirmAndVerify`), which is what makes the release safe; a caller
   * that could NOT prove it (no sign-only capability, or the deprecated
   * send-and-sign path) must leave the record untouched so a possibly
   * submitted transaction is still resumed by verification.
   *
   * Defaults to `signTransaction` (the production capability).
   */
  safePreBroadcastRelease?: (() => boolean) | undefined
}

export interface ServicePaymentController {
  subscribe: (listener: () => void) => () => void
  getState: () => ServicePaymentState
  setParams: (params: ServicePaymentParams) => void
  setCallbacks: (callbacks: ServicePaymentCallbacks) => void
  /**
   * Push the current wallet API into the controller. Also applies the
   * wallet-sync reset semantics previously owned by the modal's
   * connected/account effect: disconnect or an account change resets
   * verification state.
   */
  syncWallet: (wallet: ServicePaymentWalletApi) => void
  requestQuote: () => Promise<void>
  connectWallet: () => Promise<void>
  verifyIdentity: () => Promise<void>
  confirmAndVerify: () => Promise<void>
  /**
   * Fresh authoritative entitlement re-check for the pre-payment decision
   * (D1/KV lag). Re-signs ONE challenge, then repeats the READ-ONLY
   * enumeration on a bounded schedule. Creates no quote, no payment and no
   * entitlement; throws on any unreadable/unknown answer so the caller
   * fails closed instead of paying.
   */
  recheckEntitlement: () => Promise<ServicePaymentDiscoveryResult>
  /** Full reset — mirrors the modal's close effect. */
  reset: () => void
}

/* ───────────────── PATCH-2E ───────────────── */

/**
 * /api/creator/grant-credit returns the raw Creator Credit store enum
 * ("AVAILABLE"), while /api/creator/credit-status maps the same enum to
 * lowercase ("available"). The phase comparison in confirmAndVerify is
 * case-sensitive; normalize here so an uppercase grant status cannot
 * strand the flow in "verifying" after a successful grant.
 *
 * Re-exported by PaymentModal for the node-env regression test — the
 * canonical implementation lives here by design (PATCH-2H Phase 1).
 */
export function normalizeGrantCreditStatus(raw: unknown): string {
  return typeof raw === "string" ? raw.toLowerCase() : "available"
}

/* ───────────────── HELPERS ───────────────── */

/**
 * SAME-SHAPE CALL SERIALIZATION (in-flight guard).
 *
 * WHY THIS EXISTS
 *
 * Each identity-proof stage writes its result into controller state only
 * AFTER the wallet answers (`state.identityProof` in `verifyIdentity`,
 * `retainedPurchaseProof` in `buildPurchaseProof`, the proof local in
 * `recheckEntitlement`). Two OVERLAPPING calls of the SAME stage
 * therefore both observe "no proof yet", both request a challenge and
 * both open a wallet signature window — the repeated Phantom prompt seen
 * in production. `isProcessing` does NOT prevent this, because the guard
 * it feeds is reset by a re-render of an outer phase.
 *
 * This guard coalesces only calls of the SAME stage: the second caller
 * JOINS the first operation instead of starting a second one, so one
 * stage = at most one challenge and at most one signature window.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * The O(1) replay of the last result is NOT reuse across stages: it
 * happens while `active` is still non-null, i.e. only for an overlapping
 * caller of the same stage, and the wrapped function replaces the record
 * before it ever settles (every stage writes its record before its final
 * await resolves). Stages whose server semantics differ are therefore
 * never served by another stage's record — in particular the consumed
 * `verify-proof` proof is never replayed into the purchase guard, and the
 * purchase-guard proof is never replayed into the discovery stage.
 *
 * `markActive` / `markIdle` / `isActive` are provided so the visible
 * phase is already up to date BEFORE the wrapper hands the caller back
 * its replayed result — a joining caller must never observe a stale
 * "ready" phase while this stage is still open.
 *
 * FAILURE SEMANTICS: a rejection clears the in-flight slot and every
 * joined caller sees the same failure; nothing is cached across
 * operations, so a retry always re-opens the stage normally.
 */
function createSameShapeCallGuard(): {
  isActive: () => boolean
  run: <T>(markActive: () => void, markIdle: () => void, operation: () => Promise<T>) => Promise<T>
} {
  let active: { promise: Promise<unknown> } | null = null

  return {
    isActive: () => active !== null,
    run<T>(
      markActive: () => void,
      markIdle: () => void,
      operation: () => Promise<T>
    ): Promise<T> {
      if (active) {
        // A caller of the SAME stage is already running: adopt the phase
        // this stage sets, then await the SAME operation — never a second
        // one. It receives exactly the same result (or the same failure).
        markActive()
        return active.promise as Promise<T>
      }

      const record: { promise: Promise<unknown> } = { promise: Promise.resolve() }
      const pending = operation()
      record.promise = pending
      active = record

      /**
       * Release the slot when the operation settles. The derived promise
       * deliberately does NOT rethrow: the ORIGINAL promise is what the
       * callers receive, so a failure still reaches them and can never
       * surface as an unhandled rejection through this cleanup chain.
       */
      pending.then(
        () => {
          if (active === record) {
            active = null
            // The stage may have ended by parking the flow in a transient
            // state (e.g. `verifying`) that is only final once nothing is
            // in flight; normalise it for the callers being released.
            markIdle()
          }
        },
        () => {
          if (active === record) active = null
        }
      )

      return pending
    },
  }
}

async function issueChallenge(
  publicKey: string,
  fetchImpl: typeof fetch
) {
  const res = await fetchImpl("/api/creator/issue-challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ network: "solana", publicKey }),
  })

  const data = (await res.json()) as { ok: boolean; id?: string; challengeId?: string; challenge?: string; message?: string; expiresAt?: number; error?: string }
  if (!res.ok || !data?.ok || !data.id || !data.challenge || !data.message) {
    throw new Error(data?.error || "IDENTITY_CHALLENGE_FAILED")
  }

  const challengeId = data.id ?? data.challengeId

  return {
    challengeId,
    challenge: data.challenge,
    message: data.message,
    expiresAt: Number(data.expiresAt),
  }
}

async function verifyProof(
  input: { challengeId: string; network: string; account: string; signature: string },
  fetchImpl: typeof fetch
) {
  const res = await fetchImpl("/api/creator/verify-proof", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })

  const data = await res.json() as { ok: boolean; creatorIdentityId?: string; account?: string; error?: string }
  if (!res.ok || !data?.ok || !data.creatorIdentityId) {
    throw new Error(data?.error || "IDENTITY_VERIFICATION_FAILED")
  }

  return {
    creatorIdentityId: data.creatorIdentityId,
    account: data.account ?? input.account,
  }
}

/**
 * PATCH-2J: authenticated credit-status discovery with an ALREADY-SIGNED
 * proof (same challengeId/network/account/signature that verify-proof
 * will consume afterwards). The endpoint is read-only and does not
 * consume the challenge, so the proof stays alive for verify-proof.
 *
 * A brand-new creator has no server-side identity yet
 * (CREATOR_IDENTITY_NOT_FOUND): because Creator Credits are bound to a
 * server-side identity, no credit can exist for this account — the
 * answer is a deterministic "none" and the unconsumed proof proceeds to
 * verify-proof.
 *
 * D1 remediation — STRICT status mapping:
 *  - "available"  → available (an unused right exists)
 *  - "none"       → none (the server authoritatively reports no usable
 *                   right; CONSUMED is deliberately reported as "none" by
 *                   the endpoint and means the same thing here: nothing
 *                   usable remains)
 *  - "consuming"  → consuming (a right bound to an unfinished lifecycle —
 *                   NEVER an invitation to pay again)
 *  - anything else (missing/unknown status, malformed body) → THROW. An
 *    unreadable answer must never be interpreted as "no right", because
 *    that is exactly what would enable a duplicate $1.
 */
/**
 * PATCH-2J: authenticated credit-status discovery with an ALREADY-SIGNED
 * proof (same challengeId/network/account/signature that verify-proof
 * will consume afterwards). The endpoint is read-only and does not
 * consume the challenge, so the proof stays alive for verify-proof AND
 * for the bounded pre-payment re-check.
 *
 * The endpoint performs an AUTHORITATIVE enumeration of every right owned
 * by the server-verified creator identity (no client-supplied credit id or
 * lifecycle id is needed or trusted), so AVAILABLE and CONSUMING are
 * detected even with an empty localStorage or a different device.
 *
 * A brand-new creator has no server-side identity yet
 * (CREATOR_IDENTITY_NOT_FOUND): because Creator Credits are bound to a
 * server-side identity, no credit can exist for this account — the
 * answer is a deterministic "none" and the unconsumed proof proceeds to
 * verify-proof.
 *
 * D1 remediation — STRICT status mapping:
 *  - "available"  → available (an unused right exists)
 *  - "none"       → none (the server authoritatively reports no usable
 *                   right; CONSUMED is deliberately reported as "none" by
 *                   the endpoint and means the same thing here: nothing
 *                   usable remains)
 *  - "consuming"  → consuming (a right bound to an unfinished lifecycle —
 *                   NEVER an invitation to pay again)
 *  - anything else (missing/unknown status, malformed body) → THROW. An
 *    unreadable answer must never be interpreted as "no right", because
 *    that is exactly what would enable a duplicate $1.
 */
async function discoverCreditStatus(
  proof: ServicePaymentIdentityProof,
  fetchImpl: typeof fetch
): Promise<ServicePaymentDiscoveryResult> {
  const res = await fetchImpl("/api/creator/credit-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: proof.challengeId,
      network: proof.network,
      account: proof.account,
      signature: proof.signature,
    }),
  })

  const data = await res.json().catch(() => null) as {
    ok?: boolean
    status?: unknown
    creatorCreditId?: unknown
    creatorIdentityId?: unknown
    summary?: unknown
    unfinishedLifecycles?: unknown
    error?: string
  } | null

  if (!res.ok || !data?.ok) {
    if (data?.error === "CREATOR_IDENTITY_NOT_FOUND") {
      return {
        status: "none",
        creatorCreditId: null,
        creatorIdentityId: null,
        account: proof.account,
        summary: null,
        unfinishedLifecycles: null,
      }
    }
    throw new Error(data?.error || "CREDIT_DISCOVERY_FAILED")
  }

  const rawStatus = typeof data.status === "string" ? data.status : ""

  // Authoritative enumeration result (null when the binding does not report
  // one, e.g. an owner-scoped lookup).
  const summary =
    data.summary && typeof data.summary === "object"
      ? (data.summary as Record<string, unknown>)
      : null
  const normalizedSummary =
    summary &&
    typeof summary["availableCount"] === "number" &&
    typeof summary["consumingCount"] === "number" &&
    typeof summary["consumedCount"] === "number" &&
    typeof summary["total"] === "number"
      ? {
          availableCount: summary["availableCount"] as number,
          consumingCount: summary["consumingCount"] as number,
          consumedCount: summary["consumedCount"] as number,
          total: summary["total"] as number,
          enumerationComplete: summary["enumerationComplete"] === true,
        }
      : null

  const rawUnfinished = Array.isArray(data.unfinishedLifecycles)
    ? data.unfinishedLifecycles
    : null
  const unfinishedLifecycles = rawUnfinished
    ? rawUnfinished
        .map((entry): ServicePaymentUnfinishedLifecycle | null => {
          if (!entry || typeof entry !== "object") return null
          const record = entry as Record<string, unknown>
          if (typeof record["creatorCreditId"] !== "string") return null
          const lifecycleId = record["lifecycleId"]
          const capsuleId = record["capsuleId"]
          return {
            creatorCreditId: record["creatorCreditId"] as string,
            lifecycleId: typeof lifecycleId === "string" ? lifecycleId : null,
            capsuleId: typeof capsuleId === "string" ? capsuleId : null,
          }
        })
        .filter(
          (entry): entry is ServicePaymentUnfinishedLifecycle => entry !== null
        )
    : null

  if (rawStatus === "consuming") {
    return {
      status: "consuming",
      creatorCreditId:
        typeof data.creatorCreditId === "string" ? data.creatorCreditId : null,
      creatorIdentityId:
        typeof data.creatorIdentityId === "string" ? data.creatorIdentityId : null,
      account: proof.account,
      summary: normalizedSummary,
      unfinishedLifecycles,
    }
  }

  if (rawStatus === "none") {
    return {
      status: "none",
      creatorCreditId: null,
      creatorIdentityId:
        typeof data.creatorIdentityId === "string" ? data.creatorIdentityId : null,
      account: proof.account,
      summary: normalizedSummary,
      unfinishedLifecycles,
    }
  }

  if (rawStatus === "available" && typeof data.creatorCreditId === "string") {
    return {
      status: "available",
      creatorCreditId: data.creatorCreditId,
      creatorIdentityId:
        typeof data.creatorIdentityId === "string" ? data.creatorIdentityId : null,
      account: proof.account,
      summary: normalizedSummary,
      unfinishedLifecycles,
    }
  }

  // Fail closed: an answer this controller cannot interpret must never be
  // downgraded to "no right" (that would enable a duplicate $1).
  throw new Error("CREDIT_DISCOVERY_UNREADABLE_STATUS")
}

/* ───────────────── PRE-PAYMENT ENTITLEMENT RE-CHECK ───────────────── */

/**
 * Bounded re-check of the creator's entitlement BEFORE any money moves.
 *
 * WHY: KV is eventually consistent (documented audit hazard). A right that
 * was granted seconds ago can be invisible to a single enumeration, and a
 * single "no rights" answer is NOT sufficient authority for a new $1.
 *
 * HOW: read-only repeats of the SAME authoritative enumeration with the
 * same already-signed proof (credit-status never consumes the challenge,
 * so one signature covers the whole window). NO quote, NO payment, NO
 * grant, NO entitlement is created here — those happen only after this
 * check finishes.
 *
 * LIMIT (explicit): this narrows, and does not eliminate, the window. A
 * KV lag longer than the window, or a listing that never converges, can
 * still yield an unconfirmed absence — which the caller must NOT treat as
 * authority to pay.
 */
const RECHECK_WINDOW_MS = 60_000;
const RECHECK_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 12_000, 15_000, 15_000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function recheckEntitlementWithProof(
  proof: ServicePaymentIdentityProof,
  fetchImpl: typeof fetch,
  isCancelled?: (() => boolean) | undefined
): Promise<ServicePaymentDiscoveryResult> {
  const deadline = Date.now() + RECHECK_WINDOW_MS;
  let attempt = 0;

  for (;;) {
    // Throws on any unreadable / unknown / failed answer — a caller can
    // never mistake an error for "no rights".
    const result = await discoverCreditStatus(proof, fetchImpl);

    if (result.status !== "none") return result; // available | consuming

    // A COMPLETE enumeration with zero available and zero consuming rights
    // is the only answer that authorises continuing to payment.
    if (result.summary?.enumerationComplete === true) return result;

    if (Date.now() >= deadline) {
      // Unconfirmed absence after the bounded window: report it as "none"
      // WITHOUT completeness, so the caller refuses to pay.
      return result;
    }

    const delay = RECHECK_DELAYS_MS[Math.min(attempt, RECHECK_DELAYS_MS.length - 1)];
    attempt += 1;
    if (!delay || delay <= 0) return result;

    await sleep(delay);
    if (isCancelled?.()) {
      throw new Error("ENTITLEMENT_RECHECK_CANCELLED");
    }
  }
}

/* ───────────────── VERIFICATION POLLING (D2/D3/D4) ───────────────── */

const VERIFY_PENDING_RETRY_DELAY_MS = 2_000
const VERIFY_PENDING_MAX_WINDOW_MS = 45_000
const VERIFY_PENDING_MAX_ATTEMPTS = 23

interface ServicePaymentVerificationPollBody {
  readonly paymentIntentId: string
  readonly creatorIdentityId: string
  readonly evidenceId: string
  readonly transactionId: string
}

type ServicePaymentVerificationPollResult =
  | { readonly ok: true; readonly status: string }
  | { readonly ok: false; readonly error: string; readonly pending: boolean }

/**
 * Bounded polling of the payment verifier.
 *
 * The wallet returns a signature as soon as it signs and submits — that is NOT
 * proof the transaction landed (a blockhash can expire during the approval
 * window, or the submission can be dropped). Verification therefore polls the
 * SAME signature until the verifier can observe it on-chain.
 *
 * Only `TX_NOT_FOUND` is treated as pending: it means the verifier could not
 * observe the transaction yet. Every other outcome is a definitive verdict and
 * is returned immediately — a failed, misdirected or underpaid transaction is
 * never retried into a success.
 *
 * This re-sends the SAME `transactionId` over the existing verify endpoint. It
 * never signs, sends or constructs a transaction, so it cannot create a
 * duplicate payment.
 *
 * The window is finite: expiry yields a recoverable error, never a payment.
 */
/**
 * Classifies a wallet failure as a DEFINITE pre-send rejection.
 *
 * `signAndSendTransaction` both signs AND sends, so in general a thrown
 * error does not prove that no transaction was submitted. A user
 * rejection, however, is the wallet refusing to sign at all — the one
 * failure the client can safely treat as "nothing was sent" and retry.
 * Every OTHER failure is treated as an UNKNOWN OUTCOME: a transaction
 * may exist on-chain, so the client must not send another one.
 */
function isDefiniteWalletRejection(err: unknown): boolean {
  if (!err) return false
  const code = (err as { code?: unknown }).code
  if (code === 4001) return true
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : ""
  return /user rejected|rejected by user|user denied|declined by user|user cancelled|user canceled|request rejected/i.test(
    message
  )
}

/**
 * Binds + broadcasts a signed payment through the validated endpoint.
 *
 * Never throws. On a failure it reports the SERVER's own structured
 * classification (`broadcastAttempted`) alongside the error code, so the
 * caller can tell a proven pre-send refusal apart from an unknown
 * on-chain outcome. The flag is never derived from the error text.
 *
 * `safePreBroadcastRelease` decides whether the local pending record may
 * be released for a pre-send refusal. It is REQUIRED to be true for the
 * release to happen, because `broadcastAttempted: false` describes only
 * what THIS endpoint did — it is not proof that no on-chain operation
 * happened anywhere else. The production payment path proves the
 * stronger precondition statically: it signs WITHOUT sending
 * (`signTransaction`), and NO production code path calls the
 * send-and-sign wallet primitive (`signAndSendTransaction`) — verified by
 * the whole-repository audit recorded in this file's tests (the only
 * production callers of `sendSolanaUSDCPayment`, the send-and-sign
 * helper, are the tests themselves).
 */
async function broadcastSignedPayment(
  fetchImpl: typeof fetch,
  input: {
    paymentIntentId: string
    creatorIdentityId: string
    signedTransaction: string
  },
  safePreBroadcastRelease: boolean
): Promise<
  | { ok: true; signature: string }
  | { ok: false; error: string; broadcastAttempted?: boolean }
> {
  try {
    const res = await fetchImpl("/api/solana/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      signature?: string
      error?: string
      broadcastAttempted?: unknown
    } | null
    if (!res.ok || !data?.ok || typeof data.signature !== "string") {
      /**
       * Only an EXPLICIT `broadcastAttempted: false` is a proven pre-send
       * refusal. An absent / non-boolean field (older endpoint, proxy,
       * truncated body) is UNKNOWN and therefore keeps the protective
       * behaviour of resuming the possibly-sent transaction.
       */
      const preSendRefusal = data?.broadcastAttempted === false
      if (preSendRefusal && safePreBroadcastRelease) {
        /**
         * Proven pre-send refusal AND the transaction was only ever
         * signed: no transaction of ours can exist for this attempt, so
         * the local pointer must be released. Otherwise the next explicit
         * retry would resume-verify a transaction that was never
         * submitted and the creator would be stuck in a verification
         * loop for a payment that cannot be observed.
         *
         * Scoped to THIS intent on purpose: every other pending attempt is
         * left untouched.
         */
        const current = readPendingPaymentAttempt()
        if (current && current.paymentIntentId === input.paymentIntentId) {
          clearPendingPaymentAttempt()
        }
      }
      const failure: { ok: false; error: string; broadcastAttempted?: boolean } = {
        ok: false,
        error:
          typeof data?.error === "string" && data.error
            ? data.error
            : "PAYMENT_BROADCAST_FAILED",
      }
      // Omitted entirely when the server did not classify the refusal.
      if (typeof data?.broadcastAttempted === "boolean") {
        failure.broadcastAttempted = data.broadcastAttempted
      }
      return failure
    }
    return { ok: true, signature: data.signature }
  } catch {
    return { ok: false, error: "PAYMENT_BROADCAST_FAILED" }
  }
}

async function pollServicePaymentVerification(
  fetchImpl: typeof fetch,
  body: ServicePaymentVerificationPollBody
): Promise<ServicePaymentVerificationPollResult> {
  const deadline = Date.now() + VERIFY_PENDING_MAX_WINDOW_MS
  let lastError = "PAYMENT_VERIFICATION_FAILED"

  for (let attempt = 0; attempt < VERIFY_PENDING_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(VERIFY_PENDING_RETRY_DELAY_MS, remaining))
      )
    }

    let res: Response
    try {
      res = await fetchImpl("/api/service-payment/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (err) {
      // Transport failure — no verdict yet, keep polling within the window.
      lastError =
        err instanceof Error ? err.message : "PAYMENT_VERIFICATION_FAILED"
      continue
    }

    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      status?: unknown
      error?: string
    } | null

    if (res.ok && data?.ok) {
      return {
        ok: true,
        status: typeof data.status === "string" ? data.status : "",
      }
    }

    const error =
      typeof data?.error === "string" ? data.error : "PAYMENT_VERIFICATION_FAILED"
    lastError = error

    // Only "not observable yet" is pending; anything else is definitive.
    if (res.status !== 402 || error !== "TX_NOT_FOUND") {
      return { ok: false, error, pending: false }
    }
  }

  return { ok: false, error: lastError, pending: true }
}

/* ───────────────── FACTORY ───────────────── */

export function createServicePaymentController(
  deps: ServicePaymentControllerDeps = {}
): ServicePaymentController {
  const fetchImpl = deps.fetchImpl ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init))

  /**
   * In-flight guards: at most ONE operation per identity-proof stage, so
   * an overlapping caller joins the running operation instead of opening
   * a second challenge / a second wallet signature window.
   *
   * The stages stay SEPARATE on purpose — they are different protocol
   * steps with different server semantics (verify-proof CONSUMES the
   * challenge, credit-status and create-quote only read it), so one
   * stage's proof must never be substituted for another's.
   */
  const identityVerificationGuard = createSameShapeCallGuard()
  const purchaseProofGuard = createSameShapeCallGuard()
  const entitlementRecheckGuard = createSameShapeCallGuard()

  /**
   * May a proven pre-broadcast refusal release the local pending record?
   *
   * Defaults to the production capability — the wallet API exposes the
   * SIGN-WITHOUT-SENDING primitive, which the payment path uses
   * exclusively. A caller that cannot vouch for it (test seam) keeps the
   * protective "resume the possibly-sent transaction" behaviour.
   */
  const isSafePreBroadcastRelease = () => {
    if (deps.safePreBroadcastRelease) return deps.safePreBroadcastRelease()
    return typeof wallet?.signTransaction === "function"
  }

  let state: ServicePaymentState = {
    phase: "idle",
    quote: null,
    error: null,
    isProcessing: false,
    verifiedCreatorIdentityId: null,
    verifiedCreatorAccount: null,
    verificationError: null,
    identityProof: null,
    discovery: null,
  }

  const listeners = new Set<() => void>()

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const getState = () => state

  /** Shallow change-guard: identical state patches must not notify. */
  const patch = (next: Partial<ServicePaymentState>) => {
    let changed = false
    for (const key of Object.keys(next) as (keyof ServicePaymentState)[]) {
      if (state[key] !== next[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  let wallet: ServicePaymentWalletApi | null = null
  let previousAccount: string | null = null

  let params: ServicePaymentParams = {
    creatorIdentityId: null,
    protocolAccepted: false,
    stopAfterCredit: false,
  }

  let callbacks: ServicePaymentCallbacks = {
    onCreditReady: deps.onCreditReady,
    onReserveReady: deps.onReserveReady,
    onCreditDiscovered: deps.onCreditDiscovered,
  }

  const setParams = (next: ServicePaymentParams) => {
    params = next
  }

  const setCallbacks = (next: ServicePaymentCallbacks) => {
    callbacks = next
  }

  const resetVerificationState = () => {
    // The purchase-guard proof is account-bound too: a disconnect or an
    // account switch must not leave it reusable.
    retainedPurchaseProof = null
    patch({
      verifiedCreatorIdentityId: null,
      verifiedCreatorAccount: null,
      verificationError: null,
      error: null,
      isProcessing: false,
      phase: "quote_ready",
      // PATCH-2J: a proof is bound to its account — a wallet disconnect or
      // account switch invalidates it immediately.
      identityProof: null,
      discovery: null,
    })
  }

  const reset = () => {
    retainedPurchaseProof = null
    patch({
      phase: "idle",
      quote: null,
      error: null,
      isProcessing: false,
      verifiedCreatorIdentityId: null,
      verifiedCreatorAccount: null,
      verificationError: null,
      identityProof: null,
      discovery: null,
    })
  }

  /**
   * Fresh, AUTHORITATIVE entitlement re-check (D1 / KV lag).
   *
   * Signs exactly ONE new challenge and then repeats the read-only
   * enumeration with the same proof — one wallet prompt per explicit pay
   * attempt, never one per retry. Creates no quote, no payment and no
   * entitlement.
   */
  const recheckEntitlement = async (): Promise<ServicePaymentDiscoveryResult> => {
    /**
     * One overlapping re-check JOINS the running one: the entitlement
     * question is the same and the answer is already being computed, so a
     * second challenge + signature window would add nothing but a prompt.
     * The guard covers the WHOLE operation (challenge → signature →
     * bounded re-read), so it can never release mid-flight.
     */
    const runRecheck = async (): Promise<ServicePaymentDiscoveryResult> => {
      const currentWallet = wallet;
      const account = currentWallet?.account ?? null;
      if (!currentWallet?.connected || !account) {
        throw new Error("WALLET_ACCOUNT_UNAVAILABLE");
      }

      const challenge = await issueChallenge(account, fetchImpl);
      const encoded =
        typeof challenge.message === "string"
          ? new TextEncoder().encode(challenge.message)
          : challenge.message;

      const { signature } = await currentWallet.signMessage(encoded);
      const proof: ServicePaymentIdentityProof = {
        challengeId: challenge.challengeId,
        network: "solana",
        account,
        signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
        expiresAt: challenge.expiresAt,
      };

      return recheckEntitlementWithProof(proof, fetchImpl, deps.isCancelled);
    };

    return entitlementRecheckGuard.run(
      () => patch({ phase: "verifying_identity", error: null, isProcessing: true }),
      () => patch({ isProcessing: false }),
      runRecheck
    );
  };

  const syncWallet = (next: ServicePaymentWalletApi) => {
    wallet = next

    if (!next.connected) {
      resetVerificationState()
      previousAccount = null
      return
    }

    const previous = previousAccount
    if (previous && next.account && previous !== next.account) {
      resetVerificationState()
    }
    previousAccount = next.account
  }

  /* ───────────────── CANONICAL FLOW ───────────────── */

  /**
   * The identity proof the purchase guard is currently using.
   *
   * RETAINED in a closure (deliberately NOT in `state`) so an
   * authoritative re-read before a payment can reuse it: `create-quote`
   * VERIFIES the challenge but does not consume it (only verify-proof
   * consumes), so re-asking costs the creator NO extra wallet prompt
   * while the challenge is alive. Dropped on disconnect / account
   * switch, exactly like `state.identityProof`.
   */
  let retainedPurchaseProof: ServicePaymentIdentityProof | null = null

  /**
   * A LIVE identity proof for the purchase guard.
   *
   * Deliberately NOT reused from `state.identityProof`: verify-proof
   * consumes (deletes) the server-side challenge, so that retained proof
   * may already be dead. The purchase guard keeps its OWN challenge,
   * which create-quote never consumes — so the pre-payment authoritative
   * re-read can reuse it without a second wallet prompt.
   */
  const buildPurchaseProof = async (): Promise<{
    challengeId: string
    network: string
    account: string
    signature: string
  }> => {
    /**
     * The proof itself is built in a non-guarded helper: it CREATES the
     * challenge + signature once and RETAINS it. Two overlapping callers
     * must not each create one, so the guard below serialises them.
     */
    const runPurchaseProof = async (): Promise<{
      challengeId: string
      network: string
      account: string
      signature: string
    }> => {
      const currentAccount = wallet?.account ?? null
      if (!currentAccount) {
        throw new Error("WALLET_ACCOUNT_UNAVAILABLE")
      }

      const retained = retainedPurchaseProof
      if (
        retained &&
        retained.account === currentAccount &&
        retained.expiresAt > Date.now()
      ) {
        return {
          challengeId: retained.challengeId,
          network: retained.network,
          account: retained.account,
          signature: retained.signature,
        }
      }

      const { challengeId, message, expiresAt } = await issueChallenge(currentAccount, fetchImpl)
      const encoded =
        typeof message === "string" ? new TextEncoder().encode(message) : message
      if (!wallet?.account) {
        throw new Error("WALLET_ACCOUNT_UNAVAILABLE")
      }
      const { signature } = await wallet.signMessage(encoded)
      if (!wallet?.account) {
        throw new Error("WALLET_ACCOUNT_UNAVAILABLE")
      }

      const proof: ServicePaymentIdentityProof = {
        challengeId,
        network: "solana",
        account: currentAccount,
        signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 600_000,
      }
      retainedPurchaseProof = proof

      // The wire shape is unchanged: the extra expiresAt stays local.
      return {
        challengeId: proof.challengeId,
        network: proof.network,
        account: proof.account,
        signature: proof.signature,
      }
    }

    /**
     * The purchase guard does NOT own a visible phase of its own, so the
     * phase markers are no-ops here — only the in-flight coalescing
     * matters. Overlapping callers share the SAME retained challenge, so
     * at most one signature window is opened for this stage.
     */
    return purchaseProofGuard.run(
      () => {},
      () => {},
      runPurchaseProof
    )
  }

  /**
   * Calls the purchase-guard endpoint with a proof and parses its
   * AUTHORITATIVE answer. Throws on refusal and patches NO state, so the
   * same call serves both the initial quote and the pre-payment re-read.
   *
   * `continued: true` means the server resumed an EXISTING purchase
   * attempt (this creator already had one in flight) and returned THAT
   * intent's quote — a second, independent purchase intent is never
   * created.
   */
  const fetchQuoteState = async (proof: {
    challengeId: string
    network: string
    account: string
    signature: string
  }): Promise<ServicePaymentQuote> => {
    const paymentIntentId = crypto.randomUUID()

    /**
     * The quote endpoint requires a cryptographically proven creator
     * identity AND atomically reserves the purchase attempt against the
     * identity-scoped Durable Object before minting any payment intent.
     * A live right or an unfinished purchase makes it answer with the
     * existing state instead of a new quote.
     */
    const res = await fetchImpl("/api/service-payment/create-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentIntentId, ...proof }),
    })

    const data = await res.json()
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "QUOTE_REQUEST_FAILED")
    }

    return {
      paymentIntentId: typeof data.paymentIntentId === "string" ? data.paymentIntentId : paymentIntentId,
      expectedAmount: Number(data.expectedAmount ?? 1),
      currency: typeof data.currency === "string" ? data.currency : "",
      expiresAt: Number(data.expiresAt),
      paymentState:
        data.paymentState === "granted" ||
        data.paymentState === "verified_pending_grant"
          ? data.paymentState
          : "ready_to_pay",
      // Server-side discovery of an already-bound signature for this
      // SAME intent (read-only; only ever the caller's own attempt).
      resumeTransactionId:
        typeof data.resumeTransactionId === "string" && data.resumeTransactionId
          ? data.resumeTransactionId
          : null,
    }
  }

  const requestQuote = async () => {
    patch({ phase: "quoting", error: null, isProcessing: true })

    try {
      const proof = await buildPurchaseProof()
      const q = await fetchQuoteState(proof)
      patch({ quote: q, phase: "quote_ready", isProcessing: false })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "QUOTE_REQUEST_FAILED"
      patch({ error: message, phase: "error", isProcessing: false })
    }
  }

  /**
   * AUTHORITATIVE RE-READ of this creator identity's purchase attempt,
   * performed BEFORE any new transaction signature.
   *
   * The in-memory quote is only a SNAPSHOT and must never be treated as
   * proof that no signature exists — another tab or device can have
   * bound one (or completed the purchase) since it was fetched. This
   * re-asks the EXISTING proof-backed purchase-guard endpoint, which
   * resolves the identity server-side and returns the CURRENT attempt
   * state plus any already-bound transaction signature.
   *
   * Never throws: an unreadable / refused answer is `ok: false`, so the
   * caller fails closed instead of signing.
   */
  const recheckAttemptState = async (): Promise<
    { ok: true; quote: ServicePaymentQuote } | { ok: false }
  > => {
    try {
      const proof = await buildPurchaseProof()
      const quote = await fetchQuoteState(proof)
      return { ok: true, quote }
    } catch {
      return { ok: false }
    }
  }

  const verifyIdentity = async () => {
    const currentAccount = wallet?.account ?? null
    if (!currentAccount) {
      patch({ error: "Wallet account is required for verification.", phase: "error" })
      return
    }

    patch({ phase: "verifying_identity", error: null, verificationError: null, isProcessing: true })

    /**
     * The VERIFICATION OPERATION itself: challenge (unless a live proof is
     * retained) → wallet signature → authoritative credit-status discovery
     * → verify-proof consumption. Wrapped by the in-flight guard below so
     * an overlapping caller joins THIS operation instead of opening a
     * second wallet signature window.
     */
    const runIdentityVerification = async (): Promise<void> => {
      try {
      // PATCH-2J: ONE identity challenge per verification flow. A retained
      // proof still bound to the current account and unexpired is reused
      // as-is — an explicit retry after a transient failure must not ask
      // the wallet for a second signature.
      let proof = state.identityProof
      if (!proof || proof.account !== currentAccount || proof.expiresAt <= Date.now()) {
        const { challengeId, message, expiresAt } = await issueChallenge(currentAccount, fetchImpl)

        const encoded =
          typeof message === "string" ? new TextEncoder().encode(message) : message

        if (!wallet?.account) {
          throw new Error("Wallet account changed during verification.")
        }

        const { signature } = await wallet.signMessage(encoded)

        if (!wallet?.account) {
          throw new Error("Wallet account changed after signing.")
        }

        proof = {
          challengeId,
          network: "solana",
          account: currentAccount,
          signature: btoa(
            String.fromCharCode(...new Uint8Array(signature))
          ),
          expiresAt,
        }
        patch({ identityProof: proof })
      }

      // PATCH-2J: credit-status discovery runs BEFORE verify-proof —
      // verify-proof consumes (deletes) the server-side challenge, so
      // discovery can only reuse the same proof while it is alive.
      //
      // The endpoint performs an AUTHORITATIVE enumeration of every right
      // the verified creator identity owns, so CONSUMING is detected from
      // server data alone — no localStorage hint, no client-supplied
      // lifecycle id, same-device assumption.
      const discovery = await discoverCreditStatus(proof, fetchImpl)

      patch({ discovery })
      callbacks.onCreditDiscovered?.(discovery)

      if (discovery.status === "available") {
        // PATCH-2F: a discovered AVAILABLE Creator Credit restores the
        // paid workspace with NO verify-proof, NO payment, NO grant and
        // NO reserve. The flow is complete — the proof is dropped.
        patch({ phase: "available", isProcessing: false, identityProof: null })
        return
      }

      if (discovery.status === "consuming") {
        // A right already exists and is bound to an unfinished lifecycle:
        // STOP here. No verify-proof consumption, no quote, no payment —
        // the gate offers recovery instead.
        patch({ phase: "quote_ready", isProcessing: false, identityProof: null })
        return
      }

      // PATCH-2J NO CREDIT: consume the SAME proof via verify-proof; the
      // canonical $1 payment path then proceeds unchanged.
      const { creatorIdentityId, account } = await verifyProof(
        {
          challengeId: proof.challengeId,
          network: proof.network,
          account: currentAccount,
          signature: proof.signature,
        },
        fetchImpl
      )

      patch({
        verifiedCreatorIdentityId: creatorIdentityId,
        verifiedCreatorAccount: account,
        phase: "wallet_verified",
        // The challenge was consumed server-side on success — nothing to
        // reuse.
        identityProof: null,
      })
    } catch (err) {
        const message =
          err instanceof Error ? err.message : "WALLET_VERIFICATION_FAILED"
        // A retained proof (if any) survives the failure so an explicit
        // retry reuses it without a second signature; syncWallet (account
        // switch / disconnect) and reset() invalidate it.
        patch({ verificationError: message, error: message, phase: "error" })
      } finally {
        patch({ isProcessing: false })
      }
    }

    /**
     * Phase markers for a JOINING caller and for the moment this stage
     * releases its in-flight slot.
     *
     * `verifying` and `available` are states of COMPLETED work and are
     * deliberately left alone. Only a still-transient `verifying_identity`
     * is normalised once nothing is in flight: the gate must be able to
     * act on a settled phase (identity + discovery are either established
     * or reported through `error`), so it can never be left spinning
     * forever on a dead in-flight flag.
     */
    const markStageActive = () =>
      patch({ error: null, isProcessing: true })

    const markStageIdle = () => {
      const transient = state.phase === "verifying_identity"
      patch({
        ...(transient
          ? {
              phase:
                state.discovery && state.verifiedCreatorIdentityId
                  ? "wallet_verified"
                  : "quote_ready",
            }
          : {}),
        isProcessing: false,
      })
    }

    return identityVerificationGuard.run(
      markStageActive,
      markStageIdle,
      runIdentityVerification
    )
  }

  const connectWallet = async () => {
    if (wallet && wallet.connected && wallet.account) {
      if (!params.creatorIdentityId && !state.verifiedCreatorIdentityId) {
        await verifyIdentity()
      } else {
        patch({ phase: "quote_ready" })
      }
      return
    }

    patch({ phase: "connecting_wallet", error: null, verificationError: null })

    try {
      if (!wallet) {
        throw new Error("WALLET_CONNECT_FAILED")
      }

      await wallet.openWalletPicker()

      if (!wallet.account) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup()
            reject(new Error("Wallet account is not available."))
          }, 30000)

          const interval = setInterval(() => {
            if (deps.isCancelled?.()) {
              cleanup()
              reject(new Error("Modal closed during wallet connection."))
              return
            }
            if (wallet?.account) {
              cleanup()
              resolve()
            }
          }, 50)

          const cleanup = () => {
            clearTimeout(timeout)
            clearInterval(interval)
          }
        })
      }

      const currentAccount = wallet?.account ?? null
      if (!currentAccount) {
        throw new Error("Wallet account is not available.")
      }

      if (!params.creatorIdentityId && !state.verifiedCreatorIdentityId) {
        await verifyIdentity()
      } else {
        patch({ phase: "quote_ready" })
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "WALLET_CONNECT_FAILED"
      patch({ error: message, phase: "error", isProcessing: false })
    }
  }

  const confirmAndVerify = async () => {
    // PATCH-2K-A: the $1 payment is reachable only through a completed
    // credit-status discovery that answered NO CREDIT (PATCH-2J ordering).
    // A flow that never discovered must not reach the transport —
    // controlled error, no quote, no USDC, no verify, no grant. A flow
    // that discovered an AVAILABLE Creator Credit must never pay a second
    // $1 — the restored-credit state is preserved untouched.
    if (!state.discovery) {
      patch({
        error: "CREDIT_DISCOVERY_REQUIRED",
        phase: "error",
        isProcessing: false,
      })
      return
    }
    if (state.discovery.status !== "none") {
      return
    }

    const effectiveCreatorIdentityId =
      params.creatorIdentityId || state.verifiedCreatorIdentityId
    if (!params.protocolAccepted || !effectiveCreatorIdentityId || !state.quote) {
      patch({
        error:
          !effectiveCreatorIdentityId
            ? "Creator identity is required."
            : "Protocol acceptance is required.",
        phase: "error",
        isProcessing: false,
      })
      return
    }

    const currentAccount = wallet?.account ?? null
    if (!currentAccount) {
      patch({
        error: "Wallet account is required for payment.",
        phase: "error",
        isProcessing: false,
      })
      return
    }

    if (effectiveCreatorIdentityId && !state.verifiedCreatorAccount) {
      resetVerificationState()
      patch({ error: "Wallet verification is required before payment.", phase: "error" })
      return
    }

    if (
      state.verifiedCreatorIdentityId &&
      state.verifiedCreatorAccount &&
      currentAccount !== state.verifiedCreatorAccount
    ) {
      resetVerificationState()
      patch({ error: "Wallet account changed after verification. Please verify again.", phase: "error" })
      return
    }

    const quote = state.quote

    /**
     * QUOTE EXPIRY GUARD (client side).
     *
     * A payment must never be sent against an expired quote: the server
     * rejects an expired quote at verification time, so such a transfer
     * could be spent and never credited. The caller re-requests the
     * SAME payment intent (renewed window) instead.
     */
    if (quote.expiresAt <= Date.now()) {
      patch({
        error: "QUOTE_EXPIRED_REFRESH_REQUIRED",
        phase: "error",
        isProcessing: false,
      })
      return
    }

    /**
     * PENDING-ATTEMPT RESOLUTION.
     *
     * If THIS intent already produced a transaction signature, that SAME
     * transaction is verified — a second transfer is never sent. If the
     * outcome of the previous send is UNKNOWN (no signature, and the
     * failure did not provably happen before sending), no transfer is
     * sent at all: a transaction may exist on-chain.
     */
    const pending = readPendingPaymentAttempt()
    const pendingForThisIntent =
      pending && pending.paymentIntentId === quote.paymentIntentId ? pending : null
    let resumableTransactionId: string | null = null
    if (pendingForThisIntent) {
      if (pendingForThisIntent.transactionId) {
        resumableTransactionId = pendingForThisIntent.transactionId
      } else if (pendingForThisIntent.outcome === "unknown") {
        patch({
          error: "PAYMENT_OUTCOME_UNKNOWN",
          phase: "error",
          isProcessing: false,
        })
        return
      }
    } else if (quote.resumeTransactionId) {
      /**
       * LOCAL POINTER LOST, SERVER SIGNATURE KNOWN.
       *
       * The local pending record for this intent is gone (cleared
       * storage, a different profile), but the server — which resolved
       * the attempt from the cryptographic identity proof and its OWN
       * record, never from anything the client claimed — already has a
       * signature bound to it. That signature is all verification
       * needs, so THIS transaction is resumed and no new transaction is
       * ever signed.
       */
      resumableTransactionId = quote.resumeTransactionId
    }

    /**
     * AUTHORITATIVE RE-READ BEFORE ANY NEW SIGNATURE.
     *
     * Everything above reads the in-memory quote and the local pointer —
     * both are SNAPSHOTS. A second tab or device can have bound a
     * signature (or completed the purchase) since they were taken, so
     * before a new transaction is signed the CURRENT attempt state is
     * re-read from the existing proof-backed endpoint. A signature bound
     * in another tab is then resumed instead of signing a doomed
     * transaction; an already-recorded payment continues the existing
     * grant/access flow; anything unreadable fails closed.
     */
    if (!resumableTransactionId) {
      patch({ isProcessing: true })
      const authoritative = await recheckAttemptState()
      if (!authoritative.ok) {
        // Unknown / unreadable state is NOT permission to sign.
        patch({
          error: "PAYMENT_STATE_UNVERIFIED",
          phase: "error",
          isProcessing: false,
        })
        return
      }
      const current = authoritative.quote
      if (current.paymentIntentId !== quote.paymentIntentId) {
        // The server no longer associates this purchase with the intent
        // this client holds: never sign against a mismatched attempt.
        patch({
          error: "PAYMENT_INTENT_CHANGED",
          phase: "error",
          isProcessing: false,
        })
        return
      }
      if (current.resumeTransactionId) {
        // Bound by another tab/device: verify THAT transaction, never
        // sign a new one.
        resumableTransactionId = current.resumeTransactionId
      } else if (current.paymentState === "granted") {
        // The purchase already produced a Creator Credit: continue the
        // existing access flow (re-discovery), no signature, no transfer.
        patch({
          error: "PAYMENT_ALREADY_GRANTED_REFRESH_REQUIRED",
          phase: "error",
          isProcessing: false,
        })
        return
      } else if (current.paymentState === "verified_pending_grant") {
        // A verified payment is already recorded and its grant is
        // unfinished: fail closed — nothing new is signed or sent.
        patch({
          error: "PAYMENT_ALREADY_RECORDED_CHECK_REQUIRED",
          phase: "error",
          isProcessing: false,
        })
        return
      }
      // Otherwise the server confirmed `ready_to_pay` with NO bound
      // signature — the only state in which a new signature is allowed.
    }

    patch({ phase: "verifying", error: null, isProcessing: true })

    try {
      const paymentWallet = wallet
      if (!paymentWallet?.account) {
        throw new Error("Wallet account is required for payment.")
      }

      let txHash: string
      if (resumableTransactionId) {
        // Resume the EXISTING transaction: verify it, never sign or send
        // a new one.
        txHash = resumableTransactionId
      } else {
        /**
         * TWO-PHASE PAYMENT: sign locally → persist → bind + broadcast.
         *
         * The wallet SIGNS WITHOUT SENDING, so the transaction signature
         * is known BEFORE the network can see the transaction. It is
         * persisted first, then bound atomically to this payment intent
         * by the validated broadcast endpoint. A lost response can
         * therefore only ever resume the SAME transaction.
         */
        const signTransaction = paymentWallet.signTransaction
        if (typeof signTransaction !== "function") {
          patch({
            error: "WALLET_SIGN_TRANSACTION_UNAVAILABLE",
            phase: "error",
            isProcessing: false,
          })
          return
        }

        let signed: {
          signature: string
          signedTransactionBase64: string
          blockhash: string
          lastValidBlockHeight: number | null
        }
        try {
          signed = await signSolanaUSDCPayment({
            destination: "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu",
            amountAtomic: "1000000",
            publicKey: paymentWallet.account,
            signTransaction,
          })
        } catch (signErr) {
          if (isDefiniteWalletRejection(signErr)) {
            // The wallet refused to sign: nothing was signed, nothing was
            // sent, so the same intent may safely be retried.
            clearPendingPaymentAttempt()
            patch({
              error: "PAYMENT_REJECTED_BY_WALLET",
              phase: "error",
              isProcessing: false,
            })
            return
          }
          // The signing step failed in a way that is not a user
          // rejection: no transaction exists (signing happens before any
          // network call), but the state is still recorded so nothing is
          // silently retried.
          writePendingPaymentAttempt({
            version: 2,
            paymentIntentId: quote.paymentIntentId,
            creatorIdentityId: effectiveCreatorIdentityId,
            network: "solana",
            account: currentAccount,
            transactionId: null,
            signedTransaction: null,
            blockhash: null,
            lastValidBlockHeight: null,
            outcome: "unknown",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          patch({
            error: "PAYMENT_SIGNING_FAILED",
            phase: "error",
            isProcessing: false,
          })
          return
        }

        /**
         * Persist BEFORE any network call. If the record cannot be
         * written, the payment must NOT be broadcast: a lost response
         * would then be unrecoverable.
         */
        const persisted = writePendingPaymentAttempt({
          version: 2,
          paymentIntentId: quote.paymentIntentId,
          creatorIdentityId: effectiveCreatorIdentityId,
          network: "solana",
          account: currentAccount,
          transactionId: signed.signature,
          signedTransaction: signed.signedTransactionBase64,
          blockhash: signed.blockhash,
          lastValidBlockHeight: signed.lastValidBlockHeight,
          outcome: "submitted",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        if (!persisted) {
          patch({
            error: "PAYMENT_ATTEMPT_NOT_PERSISTED",
            phase: "error",
            isProcessing: false,
          })
          return
        }

        // Bind the signature to the intent atomically, then broadcast the
        // SAME bytes through the strict endpoint.
        const broadcast = await broadcastSignedPayment(
          fetchImpl,
          {
            paymentIntentId: quote.paymentIntentId,
            creatorIdentityId: effectiveCreatorIdentityId,
            signedTransaction: signed.signedTransactionBase64,
          },
          isSafePreBroadcastRelease()
        )
        if (!broadcast.ok) {
          /**
           * The pending record is deliberately KEPT for every UNKNOWN
           * outcome (RPC error / timeout / unclassified refusal): a
           * transaction may exist on chain, and a retry must resume the
           * SAME signature instead of sending a second transfer.
           *
           * It is released ONLY when the server explicitly proved it never
           * called `sendTransaction` (`broadcastAttempted: false`) AND the
           * payment path was proven sign-only — done inside
           * `broadcastSignedPayment`, never here from the error text.
           */
          patch({
            error: broadcast.error,
            phase: "error",
            isProcessing: false,
          })
          return
        }
        if (broadcast.signature !== signed.signature) {
          patch({
            error: "RPC_SIGNATURE_MISMATCH",
            phase: "error",
            isProcessing: false,
          })
          return
        }
        txHash = signed.signature
      }

      const evidenceId = `payment-modal-${quote.paymentIntentId}-${Date.now()}`

      const verifyOutcome = await pollServicePaymentVerification(fetchImpl, {
        paymentIntentId: quote.paymentIntentId,
        creatorIdentityId: effectiveCreatorIdentityId,
        evidenceId,
        transactionId: txHash,
      })

      if (!verifyOutcome.ok) {
        throw new Error(
          verifyOutcome.pending
            ? "PAYMENT_NOT_OBSERVED_ON_CHAIN: this transaction has not been observed on Solana yet. That is NOT proof that it was not sent — it may still confirm. No new payment is offered; the SAME transaction will be checked again."
            : verifyOutcome.error
        )
      }

      if (verifyOutcome.status !== "VERIFIED") {
        throw new Error("PAYMENT_NOT_VERIFIED")
      }

      const grantRes = await fetchImpl("/api/creator/grant-credit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentIntentId: quote.paymentIntentId,
          creatorIdentityId: effectiveCreatorIdentityId,
          verifiedPaymentId: evidenceId,
          transactionId: txHash,
        }),
      })

      const grantData = await grantRes.json()
      if (!grantRes.ok || !grantData?.ok) {
        throw new Error(grantData?.error || "PAYMENT_VERIFICATION_FAILED")
      }

      const status = normalizeGrantCreditStatus(grantData.status)
      /**
       * The payment is now settled server-side (a Creator Credit exists
       * for this intent): the local pending-attempt pointer has served
       * its purpose and must not block a FUTURE, separate purchase.
       */
      clearPendingPaymentAttempt()
      patch({ phase: status === "available" ? "available" : "verifying", isProcessing: false })
      callbacks.onCreditReady?.({
        status,
        creatorIdentityId: effectiveCreatorIdentityId,
        creatorCreditId: grantData.creatorCreditId,
        account: currentAccount,
        paymentIntentId: quote.paymentIntentId,
      })

      if (status !== "available" || !grantData.creatorCreditId) {
        return
      }

      if (params.stopAfterCredit) {
        patch({ phase: "available" })
        return
      }

      patch({ phase: "reserving", error: null })
      const lifecycleId = `lifecycle-${quote.paymentIntentId}-${Date.now()}`

      const lifecycleRes = await fetchImpl("/api/creator/reserve-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentIntentId: quote.paymentIntentId,
          creatorIdentityId: effectiveCreatorIdentityId,
          capsuleId: `reserve-${quote.paymentIntentId}-${Date.now()}`,
          lifecycleId,
        }),
      })

      const lifecycleData = await lifecycleRes.json()
      if (!lifecycleRes.ok || !lifecycleData?.ok) {
        throw new Error(lifecycleData?.error || "LIFECYCLE_RESERVATION_FAILED")
      }

      callbacks.onReserveReady?.({
        creatorCreditId: grantData.creatorCreditId,
        lifecycleId: lifecycleData.lifecycleId ?? lifecycleId,
        paymentIntentId: quote.paymentIntentId,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "PAYMENT_VERIFICATION_FAILED"
      patch({ error: message, phase: "error", isProcessing: false })
    }
  }

  return {
    subscribe,
    getState,
    setParams,
    setCallbacks,
    syncWallet,
    requestQuote,
    connectWallet,
    verifyIdentity,
    confirmAndVerify,
    recheckEntitlement,
    reset,
  }
}
