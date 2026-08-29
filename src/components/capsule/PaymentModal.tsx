/**
 * AETERNA — PaymentModal
 *
 * Canonical service-payment modal.
 *
 * Active flow:
 *   paymentIntentId -> immutable quote -> Solana USDC payment
 *   -> server verification -> Creator Credit -> entitlement -> /create
 *
 * This modal MUST NOT:
 * - calculate authoritative price
 * - declare payment success locally
 * - write Credit state
 * - treat frontend state as authority
 */

import { useState, useEffect, useRef } from "react"

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"

import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"

import { useAeternaWallet } from "@/context/AETERNAWalletContext"
import { sendSolanaUSDCPayment } from "@/lib/wallet/solanaWallet"

/* ───────────────── HELPERS ───────────────── */

async function issueChallenge(publicKey: string) {
  const res = await fetch("/api/creator/issue-challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ network: "solana", publicKey }),
  })

  const data = (await res.json()) as { ok: boolean; challengeId?: string; challenge?: string; message?: string; expiresAt?: number; error?: string }
  if (!res.ok || !data?.ok || !data.challengeId || !data.challenge || !data.message) {
    throw new Error(data?.error || "IDENTITY_CHALLENGE_FAILED")
  }

  return {
    challengeId: data.challengeId,
    challenge: data.challenge,
    message: data.message,
    expiresAt: Number(data.expiresAt),
  }
}

async function verifyProof(input: { challengeId: string; network: string; account: string; signature: string }) {
  const res = await fetch("/api/creator/verify-proof", {
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

/* ───────────────── TYPES ───────────────── */

interface PaymentModalProps {
  open: boolean
  onClose: () => void
  unlockAt: number | null
  protocolAccepted: boolean
  creatorIdentityId?: string | null
  onCreditReady?: (result: {
    status: string
    creatorCreditId?: string
    paymentIntentId?: string
  }) => void
  onReserveReady?: (result: {
    creatorCreditId: string
    lifecycleId: string
    paymentIntentId: string
  }) => void
}

/* ───────────────── HELPERS ───────────────── */

function formatUTCDate(ts: number): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(ts))
}

/* ───────────────── STATE ───────────────── */

type PaymentPhase =
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

/* ───────────────── COMPONENT ───────────────── */

export function PaymentModal({
  open,
  onClose,
  unlockAt,
  protocolAccepted,
  creatorIdentityId,
  onCreditReady,
  onReserveReady,
}: PaymentModalProps) {
  const wallet = useAeternaWallet()
  const [phase, setPhase] = useState<PaymentPhase>("idle")
  const [quote, setQuote] = useState<{
    paymentIntentId: string
    expectedAmount: number
    currency: string
    expiresAt: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [verifiedCreatorIdentityId, setVerifiedCreatorIdentityId] = useState<string | null>(null)
  const [verificationError, setVerificationError] = useState<string | null>(null)

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setPhase("idle")
      setQuote(null)
      setError(null)
      setIsProcessing(false)
      setVerifiedCreatorIdentityId(null)
      setVerificationError(null)
    }
  }, [open])

  const unlockDate =
    typeof unlockAt === "number" &&
    Number.isFinite(unlockAt) &&
    Number.isInteger(unlockAt)
      ? formatUTCDate(unlockAt)
      : null

  /* ───────────────── CANONICAL FLOW ───────────────── */

  const requestQuote = async () => {
    setPhase("quoting")
    setError(null)
    setIsProcessing(true)

    try {
      const paymentIntentId = crypto.randomUUID()

      const res = await fetch("/api/service-payment/create-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      })

      const data = await res.json()
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "QUOTE_REQUEST_FAILED")
      }

      const q = {
        paymentIntentId: typeof data.paymentIntentId === "string" ? data.paymentIntentId : paymentIntentId,
        expectedAmount: Number(data.expectedAmount ?? 1),
        currency: String(data.currency ?? "USD"),
        expiresAt: Number(data.expiresAt),
      }
      setQuote(q)
      setPhase("quote_ready")
      setIsProcessing(false)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "QUOTE_REQUEST_FAILED"
      setError(message)
      setPhase("error")
      setIsProcessing(false)
    }
  }

  const connectWallet = async () => {
    if (wallet.connected && wallet.account) {
      if (!creatorIdentityId && !verifiedCreatorIdentityId) {
        await verifyIdentity()
      } else {
        setPhase("quote_ready")
      }
      return
    }

    setPhase("connecting_wallet")
    setError(null)
    setVerificationError(null)

    try {
      await wallet.openWalletPicker()

      if (!wallet.account) {
        throw new Error("Wallet account is not available.")
      }

      if (!creatorIdentityId && !verifiedCreatorIdentityId) {
        await verifyIdentity()
      } else {
        setPhase("quote_ready")
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "WALLET_CONNECT_FAILED"
      setError(message)
      setPhase("error")
      setIsProcessing(false)
    }
  }

  const verifyIdentity = async () => {
    if (!wallet.account) {
      setError("Wallet account is required for verification.")
      setPhase("error")
      return
    }

    setPhase("verifying_identity")
    setError(null)
    setVerificationError(null)
    setIsProcessing(true)

    try {
      const { challengeId, message } = await issueChallenge(wallet.account)

      const encoded =
        typeof message === "string" ? new TextEncoder().encode(message) : message

      if (!wallet.account) {
        throw new Error("Wallet account changed during verification.")
      }

      const { signature } = await wallet.signMessage(encoded)

      if (!wallet.account) {
        throw new Error("Wallet account changed after signing.")
      }

      const uint8 = new Uint8Array(signature)
      const base64Signature = btoa(
        String.fromCharCode(...uint8)
      )

      const { creatorIdentityId } = await verifyProof({
        challengeId,
        network: "solana",
        account: wallet.account,
        signature: base64Signature,
      })

      setVerifiedCreatorIdentityId(creatorIdentityId)
      setPhase("wallet_verified")
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "WALLET_VERIFICATION_FAILED"
      setVerificationError(message)
      setError(message)
      setPhase("error")
    } finally {
      setIsProcessing(false)
    }
  }

  const confirmAndVerify = async () => {
    const effectiveCreatorIdentityId =
      creatorIdentityId || verifiedCreatorIdentityId
    if (!protocolAccepted || !effectiveCreatorIdentityId || !quote) {
      setError(
        !effectiveCreatorIdentityId
          ? "Creator identity is required."
          : "Protocol acceptance is required."
      )
      setPhase("error")
      setIsProcessing(false)
      return
    }

    setPhase("verifying")
    setError(null)
    setIsProcessing(true)

    try {
      if (!wallet.account) {
        throw new Error("Wallet account is required for payment.")
      }

      const txHash = await sendSolanaUSDCPayment({
        destination: "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu",
        amountAtomic: "1000000",
        publicKey: wallet.account,
        signAndSendTransaction: wallet.signAndSendTransaction,
      })

      if (!txHash) {
        throw new Error("No transaction signature from wallet.")
      }

      const evidenceId = `payment-modal-${quote.paymentIntentId}-${Date.now()}`

      const verifyRes = await fetch("/api/service-payment/verify", {
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

      const grantRes = await fetch("/api/creator/grant-credit", {
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

      const status = grantData.status ?? "available"
      setPhase(status === "available" ? "available" : "verifying")
      setIsProcessing(false)
      onCreditReady?.({
        status,
        creatorCreditId: grantData.creatorCreditId,
        paymentIntentId: quote.paymentIntentId,
      })

      if (status !== "available" || !grantData.creatorCreditId) {
        return
      }

      setPhase("reserving")
      setError(null)
      const lifecycleId = `lifecycle-${quote.paymentIntentId}-${Date.now()}`

      const lifecycleRes = await fetch("/api/creator/reserve-lifecycle", {
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

      onReserveReady?.({
        creatorCreditId: grantData.creatorCreditId,
        lifecycleId: lifecycleData.lifecycleId ?? lifecycleId,
        paymentIntentId: quote.paymentIntentId,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "PAYMENT_VERIFICATION_FAILED"
      setError(message)
      setPhase("error")
      setIsProcessing(false)
    }
  }

  /* ───────────────── EFFECTS ───────────────── */

  useEffect(() => {
    if (open && phase === "idle") {
      void requestQuote()
    }
  }, [open, phase])

  /* ───────────────── RENDER ───────────────── */

  return (
    <Dialog open={open}>
      <DialogContent
        className="space-y-6 px-4 py-6 sm:px-8 sm:py-8 aeterna-modal-capsule"
        showClose={false}
      >
        <div className="flex items-center justify-between">
          <DialogTitle>AETERNA Service Payment</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 min-w-0">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Amount</div>
            <div className="text-base font-medium">$1.00 USDC</div>
            <div className="text-xs text-muted-foreground">
              One verified payment unlocks one capsule creation entitlement.
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Payment Rail</div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="default"
                disabled={isProcessing}
                className="px-3 py-1 text-xs"
              >
                Solana
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Solana Mainnet / native USDC
            </div>
          </div>

          {quote && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Quote</div>
              <div className="text-xs">
                ${quote.expectedAmount.toFixed(2)} {quote.currency}
              </div>
            </div>
          )}

          {wallet.connected && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Wallet</div>
              <div className="text-xs">
                {wallet.walletName ?? "Connected wallet"}{" "}
                {wallet.account ? `(${wallet.account.slice(0, 4)}...${wallet.account.slice(-4)})` : null}
              </div>
            </div>
          )}

          {unlockDate && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Opens</div>
              <div className="text-xs">{unlockDate}</div>
            </div>
          )}

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Status</div>
            <div
              className={
                phase === "available"
                  ? "text-emerald-500 text-xs"
                  : phase === "error"
                  ? "text-red-500 text-xs"
                  : "text-muted-foreground text-xs"
              }
            >
              {phase === "idle" && "Initializing..."}
              {phase === "quoting" && "Requesting service quote..."}
              {phase === "quote_ready" && "Quote ready"}
              {phase === "connecting_wallet" && "Connecting wallet..."}
              {phase === "confirming" && "Awaiting wallet confirmation..."}
              {phase === "verifying" && "Verifying payment..."}
              {phase === "available" && "Creator Credit AVAILABLE"}
              {phase === "reserving" && "Reserving lifecycle..."}
              {phase === "error" && "Payment failed"}
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground">
            Storage and publication costs are separate.
          </div>
        </div>

        <div className="space-y-3">
          <Button
            disabled={
              !protocolAccepted ||
              (!creatorIdentityId && !wallet.connected) ||
              isProcessing ||
              phase === "quoting" ||
              phase === "available" ||
              phase === "connecting_wallet" ||
              phase === "verifying" ||
              phase === "verifying_identity" ||
              phase === "reserving"
            }
            onClick={
              phase === "quote_ready" || phase === "error" || phase === "wallet_verified"
                ? phase === "wallet_verified"
                  ? confirmAndVerify
                  : connectWallet
                : connectWallet
            }
            className="w-full"
          >
            {isProcessing && <Loader2 className="mr-2 animate-spin" />}
            {phase === "quoting" && "Requesting quote..."}
            {phase === "quote_ready" && !wallet.connected && "Connect Wallet"}
            {phase === "quote_ready" && wallet.connected && !creatorIdentityId && !verifiedCreatorIdentityId && "Verify your wallet"}
            {phase === "quote_ready" && wallet.connected && (creatorIdentityId || verifiedCreatorIdentityId) && "Confirm $1.00 USDC"}
            {phase === "connecting_wallet" && "Connecting..."}
            {phase === "verifying_identity" && (
              <span>
                Verify your wallet
                <span className="ml-2 text-xs opacity-80">No funds will be moved.</span>
              </span>
            )}
            {phase === "wallet_verified" && "Wallet verified"}
            {phase === "confirming" && "Confirm $1.00 USDC"}
            {phase === "verifying" && "Verifying..."}
            {phase === "available" && "Credit granted"}
            {phase === "reserving" && "Reserving..."}
            {phase === "error" && (verificationError ? "Retry verification" : "Retry")}
            {phase === "idle" && "Pay $1 to continue"}
          </Button>

          {error && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500">
              {error}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
