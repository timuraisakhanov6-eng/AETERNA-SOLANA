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

import { sendSolanaUSDCPayment } from "@/lib/wallet/solanaWallet"

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
  expectedAmount: number
  currency: string
  expiresAt: number
}

export interface ServicePaymentState {
  phase: ServicePaymentPhase
  quote: ServicePaymentQuote | null
  error: string | null
  isProcessing: boolean
  verifiedCreatorIdentityId: string | null
  verifiedCreatorAccount: string | null
  verificationError: string | null
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
}

export interface ServicePaymentControllerDeps extends ServicePaymentCallbacks {
  /**
   * Cancellation probe (UI unmount / modal closed). In PaymentModal this
   * replaces the mountedRef check inside the wallet-connection wait loop.
   */
  isCancelled?: (() => boolean) | undefined
  /** Test seam only — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch | undefined
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

  const data = (await res.json()) as { ok: boolean; creatorIdentityId?: string; account?: string; error?: string }
  if (!res.ok || !data?.ok || !data.creatorIdentityId) {
    throw new Error(data?.error || "IDENTITY_VERIFICATION_FAILED")
  }

  return {
    creatorIdentityId: data.creatorIdentityId,
    account: data.account ?? input.account,
  }
}

/* ───────────────── FACTORY ───────────────── */

export function createServicePaymentController(
  deps: ServicePaymentControllerDeps = {}
): ServicePaymentController {
  const fetchImpl = deps.fetchImpl ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init))

  let state: ServicePaymentState = {
    phase: "idle",
    quote: null,
    error: null,
    isProcessing: false,
    verifiedCreatorIdentityId: null,
    verifiedCreatorAccount: null,
    verificationError: null,
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
  }

  const setParams = (next: ServicePaymentParams) => {
    params = next
  }

  const setCallbacks = (next: ServicePaymentCallbacks) => {
    callbacks = next
  }

  const resetVerificationState = () => {
    patch({
      verifiedCreatorIdentityId: null,
      verifiedCreatorAccount: null,
      verificationError: null,
      error: null,
      isProcessing: false,
      phase: "quote_ready",
    })
  }

  const reset = () => {
    patch({
      phase: "idle",
      quote: null,
      error: null,
      isProcessing: false,
      verifiedCreatorIdentityId: null,
      verifiedCreatorAccount: null,
      verificationError: null,
    })
  }

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

  const requestQuote = async () => {
    patch({ phase: "quoting", error: null, isProcessing: true })

    try {
      const paymentIntentId = crypto.randomUUID()

      const res = await fetchImpl("/api/service-payment/create-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      })

      const data = await res.json()
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "QUOTE_REQUEST_FAILED")
      }

      const q: ServicePaymentQuote = {
        paymentIntentId: typeof data.paymentIntentId === "string" ? data.paymentIntentId : paymentIntentId,
        expectedAmount: Number(data.expectedAmount ?? 1),
        currency: String(data.currency ?? "USD"),
        expiresAt: Number(data.expiresAt),
      }
      patch({ quote: q, phase: "quote_ready", isProcessing: false })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "QUOTE_REQUEST_FAILED"
      patch({ error: message, phase: "error", isProcessing: false })
    }
  }

  const verifyIdentity = async () => {
    const currentAccount = wallet?.account ?? null
    if (!currentAccount) {
      patch({ error: "Wallet account is required for verification.", phase: "error" })
      return
    }

    patch({ phase: "verifying_identity", error: null, verificationError: null, isProcessing: true })

    try {
      const { challengeId, message } = await issueChallenge(currentAccount, fetchImpl)

      const encoded =
        typeof message === "string" ? new TextEncoder().encode(message) : message

      if (!wallet?.account) {
        throw new Error("Wallet account changed during verification.")
      }

      const { signature } = await wallet.signMessage(encoded)

      if (!wallet?.account) {
        throw new Error("Wallet account changed after signing.")
      }

      const uint8 = new Uint8Array(signature)
      const base64Signature = btoa(
        String.fromCharCode(...uint8)
      )

      const { creatorIdentityId, account } = await verifyProof(
        {
          challengeId,
          network: "solana",
          account: currentAccount,
          signature: base64Signature,
        },
        fetchImpl
      )

      patch({
        verifiedCreatorIdentityId: creatorIdentityId,
        verifiedCreatorAccount: account,
        phase: "wallet_verified",
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "WALLET_VERIFICATION_FAILED"
      patch({ verificationError: message, error: message, phase: "error" })
    } finally {
      patch({ isProcessing: false })
    }
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

    patch({ phase: "verifying", error: null, isProcessing: true })

    try {
      const paymentWallet = wallet
      if (!paymentWallet?.account) {
        throw new Error("Wallet account is required for payment.")
      }

      const txHash = await sendSolanaUSDCPayment({
        destination: "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu",
        amountAtomic: "1000000",
        publicKey: paymentWallet.account,
        signAndSendTransaction: paymentWallet.signAndSendTransaction,
      })

      if (!txHash) {
        throw new Error("No transaction signature from wallet.")
      }

      const quote = state.quote
      if (!quote) {
        throw new Error("QUOTE_REQUEST_FAILED")
      }

      const evidenceId = `payment-modal-${quote.paymentIntentId}-${Date.now()}`

      const verifyRes = await fetchImpl("/api/service-payment/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentIntentId: quote.paymentIntentId,
          creatorIdentityId: effectiveCreatorIdentityId,
          evidenceId,
          transactionId: txHash,
        }),
      })

      const verifyData = await verifyRes.json()
      if (!verifyRes.ok || !verifyData?.ok) {
        throw new Error(verifyData?.error || "PAYMENT_VERIFICATION_FAILED")
      }

      if (verifyData.status !== "VERIFIED") {
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
    reset,
  }
}
