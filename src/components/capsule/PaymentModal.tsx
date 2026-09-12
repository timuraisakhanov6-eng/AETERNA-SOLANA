/**
 * AETERNA — PaymentModal
 *
 * Canonical service-payment modal — UI shell only (PATCH-2H Phase 1).
 *
 * All orchestration (quote -> wallet -> identity -> payment -> verify
 * -> grant-credit) lives in the headless
 * src/lib/payment/servicePaymentController.ts; this component subscribes
 * to its state and renders it. The user-visible flow is unchanged.
 *
 * Active flow:
 *   paymentIntentId -> immutable quote -> Solana USDC payment
 *   -> server verification -> Creator Credit -> grant-credit
 *
 * When stopAfterCredit=true, the controller stops after grant-credit and
 * returns control to the caller without reserving lifecycle.
 *
 * This modal MUST NOT:
 * - calculate authoritative price
 * - declare payment success locally
 * - write Credit state
 * - treat frontend state as authority
 */

import { useEffect, useRef, useSyncExternalStore } from "react"

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"

import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"

import { useAeternaWallet } from "@/context/AETERNAWalletContext"
import {
  createServicePaymentController,
} from "@/lib/payment/servicePaymentController"
import type { ServicePaymentController } from "@/lib/payment/servicePaymentController"

/**
 * PATCH-2E regression-test surface. The canonical implementation moved to
 * the headless service payment controller (PATCH-2H Phase 1); re-exported
 * here so the existing import path keeps working.
 */
export { normalizeGrantCreditStatus } from "@/lib/payment/servicePaymentController"

/* ───────────────── TYPES ───────────────── */

interface PaymentModalProps {
  open: boolean
  onClose: () => void
  unlockAt: number | null
  protocolAccepted: boolean
  creatorIdentityId?: string | null
  stopAfterCredit?: boolean
  onCreditReady?: (result: {
    status: string
    creatorIdentityId?: string
    creatorCreditId?: string
    account?: string
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

/* ───────────────── COMPONENT ───────────────── */

export function PaymentModal({
  open,
  onClose,
  unlockAt,
  protocolAccepted,
  creatorIdentityId,
  stopAfterCredit = false,
  onCreditReady,
  onReserveReady,
}: PaymentModalProps) {
  const wallet = useAeternaWallet()

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const controllerRef = useRef<ServicePaymentController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createServicePaymentController({
      isCancelled: () => !mountedRef.current,
    })
  }
  const controller = controllerRef.current

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  )

  /* ───────────────── CONTROLLER WIRING ───────────────── */

  // Original flow read props/wallet through render closures and effects;
  // the controller receives the same values explicitly.
  useEffect(() => {
    controller.setCallbacks({ onCreditReady, onReserveReady })
  }, [controller, onCreditReady, onReserveReady])

  useEffect(() => {
    controller.setParams({ creatorIdentityId, protocolAccepted, stopAfterCredit })
  }, [controller, creatorIdentityId, protocolAccepted, stopAfterCredit])

  useEffect(() => {
    controller.syncWallet(wallet)
  }, [controller, wallet])

  useEffect(() => {
    if (!open) {
      controller.reset()
    }
  }, [controller, open])

  /* ───────────────── CANONICAL FLOW ───────────────── */

  useEffect(() => {
    if (open && state.phase === "idle") {
      void controller.requestQuote()
    }
  }, [controller, open, state.phase])

  const unlockDate =
    typeof unlockAt === "number" &&
    Number.isFinite(unlockAt) &&
    Number.isInteger(unlockAt)
      ? formatUTCDate(unlockAt)
      : null

  /* ───────────────── RENDER ───────────────── */

  const { phase, quote, error, verificationError, isProcessing } = state

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
              {phase === "verifying_identity" && "Verifying wallet..."}
              {phase === "wallet_verified" && "Wallet verified"}
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
                  ? controller.confirmAndVerify
                  : wallet.connected
                  ? wallet.changeWallet
                  : controller.connectWallet
                : controller.connectWallet
            }
            className="w-full h-auto min-h-10 whitespace-normal"
          >
            {isProcessing && <Loader2 className="mr-2 animate-spin" />}
            {phase === "quoting" && "Requesting quote..."}
            {phase === "quote_ready" && !wallet.connected && "Connect Wallet"}
            {phase === "quote_ready" && wallet.connected && "Change Wallet"}
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

          {phase === "quote_ready" && wallet.connected && !creatorIdentityId && !state.verifiedCreatorIdentityId && (
            <Button
              type="button"
              variant="secondary"
              onClick={controller.verifyIdentity}
              disabled={isProcessing}
              className="w-full"
            >
              Verify this wallet
            </Button>
          )}

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
