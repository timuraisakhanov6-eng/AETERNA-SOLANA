/**
 * AETERNA — PaymentModal
 *
 * Canonical service-payment modal.
 *
 * Active path:
 *   Creator Service Quote → AETERNA service payment → server verification
 *   → Creator Credit AVAILABLE
 *
 * This modal MUST NOT:
 * - calculate authoritative price
 * - declare payment success locally
 * - write Credit state
 * - use Paddle as authority
 * - treat frontend state as authority
 *
 * Legacy Paddle/web3 code is intentionally removed from the active path
 * but may be preserved elsewhere for historical reference.
 */

import { useState, useEffect, useRef } from "react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { Button } from "@/components/ui/button"

import { Loader2 } from "lucide-react"

/* ───────────────── TYPES ───────────────── */

interface PaymentModalProps {
  open: boolean
  onClose: () => void
  description?: string
  billableSizeBytes: number
  expectedAmount: number
  unlockAt: number | null
  capsuleId: string
  protocolAccepted: boolean
  creatorIdentityId: string | null
  onCreditReady: (result: {
    status: string
    creatorCreditId?: string
  }) => void
  onReserveReady: (result: {
    creatorCreditId: string
    lifecycleId: string
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
  | "verifying"
  | "available"
  | "reserving"
  | "error"

/* ───────────────── COMPONENT ───────────────── */

export function PaymentModal({
  open,
  onClose,
  description,
  billableSizeBytes,
  expectedAmount,
  unlockAt,
  capsuleId,
  protocolAccepted,
  creatorIdentityId,
  onCreditReady,
  onReserveReady,
}: PaymentModalProps) {
  const [phase, setPhase] = useState<PaymentPhase>("idle")
  const [quote, setQuote] = useState<{
    expectedAmount: number
    currency: string
    expiresAt: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

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
      const res = await fetch("/api/service-payment/create-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capsuleId }),
      })

      const data = await res.json()
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "QUOTE_REQUEST_FAILED")
      }

      const q = {
        expectedAmount: Number(data.expectedAmount),
        currency: String(data.currency ?? "USD"),
        expiresAt: Number(data.expiresAt),
      }
      setQuote(q)
      setPhase("quote_ready")
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "QUOTE_REQUEST_FAILED"
      setError(message)
      setPhase("error")
      setIsProcessing(false)
    }
  }

  const confirmPayment = async () => {
    if (!protocolAccepted || !creatorIdentityId) {
      setError(
        !creatorIdentityId
          ? "Creator identity is required."
          : "Protocol acceptance is required."
      )
      setPhase("error")
      setIsProcessing(false)
      return
    }

    setPhase("verifying")
    setError(null)

    try {
      /* ── Canonical payment evidence submission ── */
      const verifyRes = await fetch("/api/service-payment/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capsuleId,
          creatorIdentityId,
          evidenceId: `payment-modal-${capsuleId}-${Date.now()}`,
          transactionId: "",
        }),
      })

      const verifyData = await verifyRes.json()
      if (!verifyRes.ok || !verifyData?.ok) {
        throw new Error(verifyData?.error || "PAYMENT_VERIFICATION_FAILED")
      }

      if (verifyData.status !== "VERIFIED") {
        throw new Error("PAYMENT_NOT_VERIFIED")
      }

      /* ── Authoritative Credit grant after verified payment ── */
      const res = await fetch("/api/creator/grant-credit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capsuleId,
          creatorIdentityId,
          verifiedPaymentId: `payment-modal-${capsuleId}-${Date.now()}`,
          transactionId: "",
        }),
      })

      const data = await res.json()
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "PAYMENT_VERIFICATION_FAILED")
      }

      const status = data.status ?? "available"
      setPhase(status === "available" ? "available" : "verifying")
      setIsProcessing(false)
      onCreditReady({
        status,
        creatorCreditId: data.creatorCreditId,
      })

      if (status !== "available" || !data.creatorCreditId) {
        return
      }

      setPhase("reserving")
      setError(null)
      const lifecycleRes = await fetch("/api/creator/reserve-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capsuleId,
          creatorIdentityId,
          lifecycleId: `lifecycle-${capsuleId}-${Date.now()}`,
        }),
      })

      const lifecycleData = await lifecycleRes.json()
      if (!lifecycleRes.ok || !lifecycleData?.ok) {
        throw new Error(lifecycleData?.error || "LIFECYCLE_RESERVATION_FAILED")
      }

      onReserveReady({
        creatorCreditId: data.creatorCreditId,
        lifecycleId: lifecycleData.lifecycleId ?? `lifecycle-${capsuleId}-${Date.now()}`,
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
    if (open && phase === "idle" && creatorIdentityId) {
      void requestQuote()
    }
  }, [open, phase, creatorIdentityId])

  /* ───────────────── RENDER ───────────────── */

  return (
    <Dialog open={open}>
      <DialogContent
        className="space-y-6 px-4 py-6 sm:px-8 sm:py-8 aeterna-modal-capsule"
        showClose={false}
      >
        <div className="flex items-center justify-between">
          <DialogTitle>Review & Seal</DialogTitle>
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

        <div className="space-y-3 min-w-0">
          {unlockDate && (
            <div>
              <div className="text-xs text-muted-foreground">
                Release Date (UTC)
              </div>
              <div>{unlockDate}</div>
            </div>
          )}

          {description && (
            <div>
              <div className="text-xs text-muted-foreground">Label</div>
              <div className="min-w-0 break-words">"{description}"</div>
            </div>
          )}

          <div className="flex justify-between">
            <span>Service Fee</span>
            <span className="text-emerald-500">
              ${expectedAmount.toFixed(2)}
            </span>
          </div>

          {quote && (
            <div className="flex justify-between">
              <span>Quote Status</span>
              <span className="text-emerald-500">Authoritative</span>
            </div>
          )}

          <div className="flex justify-between">
            <span>Status</span>
            <span
              className={
                phase === "available"
                  ? "text-emerald-500"
                  : phase === "error"
                  ? "text-red-500"
                  : "text-muted-foreground"
              }
            >
              {phase === "idle" && "Initializing..."}
              {phase === "quoting" && "Requesting service quote..."}
              {phase === "quote_ready" && "Quote ready"}
              {phase === "verifying" && "Verifying payment..."}
              {phase === "available" && "Creator Credit AVAILABLE"}
              {phase === "reserving" && "Reserving lifecycle..."}
              {phase === "error" && "Payment failed"}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          <Button
            disabled={
              !protocolAccepted ||
              !creatorIdentityId ||
              isProcessing ||
              phase === "quoting" ||
              phase === "available"
            }
            onClick={confirmPayment}
            className="w-full"
          >
            {isProcessing && (
              <Loader2 className="mr-2 animate-spin" />
            )}
            {phase === "quoting"
              ? "Requesting quote..."
              : phase === "verifying"
              ? "Verifying..."
              : phase === "available"
              ? "Credit granted"
              : "Pay $1 to continue"}
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
