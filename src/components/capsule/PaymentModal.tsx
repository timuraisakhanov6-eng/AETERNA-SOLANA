/**
 * AETERNA — PaymentModal
 *
 * Selector-enabled Web3 payment runtime
 * FULL UI RESTORED
 * Paddle overlay checkout integrated
 */

import { useState, useEffect, useRef } from "react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { Button } from "@/components/ui/button"

import {
  CreditCard,
  Wallet,
  Loader2,
} from "lucide-react"

import {
  useUSDCPayment,
  USDCPaymentException,
} from "@/hooks/useUSDCPayment"

import type { EIP1193Provider } from "viem"

import WalletSelectorModal from "@/components/web3/WalletSelectorModal"

import {
  discoverInjectedWallets,
  type InjectedWallet
} from "@/lib/web3/discovery"

import {
  getLastWallet,
  saveLastWallet,
} from "@/lib/web3/lastUsedWallet"


/* ───────────────── TYPES ───────────────── */

interface PaymentModalProps {

  open: boolean
  onClose: () => void

  description?: string
  billableSizeBytes: number
  expectedAmount: number

  unlockAt: number | null
  capsuleId: string

  onConfirmPayment: (
    opts?: { web3TxHash?: string }
  ) => Promise<void> | void

  protocolAccepted: boolean

}


/* ───────────────── HELPERS ───────────────── */

function formatUTCDate(ts: number): string {

  return new Intl.DateTimeFormat(
    "en-US",
    {
      year: "numeric",
      month: "long",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    }
  ).format(new Date(ts))

}


/* ───────────────── STATE TYPES ───────────────── */

type PaymentMethod =
  | "card"
  | "web3"

type Web3State =
  | "idle"
  | "connecting"
  | "pending"
  | "verifying"
  | "failed"


/* ───────────────── COMPONENT ───────────────── */

export function PaymentModal({

  open,
  onClose,
  description,
  billableSizeBytes,
  expectedAmount,
  unlockAt,
  capsuleId,
  onConfirmPayment,
  protocolAccepted,

}: PaymentModalProps) {

  // PaymentModal is passive w.r.t. pricing: it displays the
  // Business Quote (expectedAmount) computed upstream by
  // CapsuleBuilder / server, rather than recomputing from size.
  // This keeps a single source of truth for price and avoids
  // drift if the pricing formula changes.
  const price = expectedAmount

  // PATCH 1 — integer temporal invariant enforcement
  // Prevents fractional timestamp drift between UI formatting
  // and runtime rejection boundary.
  const unlockDate =
    typeof unlockAt === "number" &&
    Number.isFinite(unlockAt) &&
    Number.isInteger(unlockAt)
      ? formatUTCDate(unlockAt)
      : null


  const [paymentMethod, setPaymentMethod] =
    useState<PaymentMethod>("card")

  const [web3State, setWeb3State] =
    useState<Web3State>("idle")

  const [isProcessing, setIsProcessing] =
    useState(false)

  const [error, setError] =
    useState<string | null>(null)

  const [selectorOpen, setSelectorOpen] =
    useState(false)

  const [wallets, setWallets] =
    useState<InjectedWallet[]>([])


  const { sendUSDC } =
    useUSDCPayment()


  // PATCH 2 — mounted lifecycle guard
  // Prevents async state updates after modal close or unmount.
  // Stabilizes slow wallet, suspended tab, and navigation race scenarios.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])


  /* ───────────────── RESET STATE ON CLOSE ───────────────── */

  useEffect(() => {

    if (!open) {

      setIsProcessing(false)
      setWeb3State("idle")
      setPaymentMethod("card")
      setError(null)
      setSelectorOpen(false)
      setWallets([])

    }

  }, [open])


  const canProceed =
    billableSizeBytes > 0 &&
    protocolAccepted


  /* ───────────────── WALLET DISCOVERY ───────────────── */

  async function handleWalletDiscovery() {

    const detected =
      await discoverInjectedWallets()

    if (detected.length === 0) {

      return executeWeb3Payment()

    }

    const lastWalletId =
      getLastWallet()

    if (lastWalletId) {

      const restored =
        detected.find(
          w => w.id === lastWalletId
        )

      if (restored) {

        saveLastWallet(restored.id)

        return executeWeb3Payment(
          restored.provider
        )

      }

    }

    if (detected.length === 1) {

      const wallet = detected[0]

      if (!wallet)
        throw new Error(
          "[AETERNA] Wallet detection failed"
        )

      saveLastWallet(wallet.id)

      return executeWeb3Payment(
        wallet.provider
      )

    }

    /**
     * ISSUE 2 FIX: selector must not open after modal close.
     *
     * discoverInjectedWallets() is async — if the modal was closed
     * or the component unmounted during discovery, opening the
     * selector here produces an orphan UI with stale wallet state.
     * Guard both conditions before mutating selector state.
     */

    if (!mountedRef.current || !open)
      return

    setWallets(detected)

    setSelectorOpen(true)

  }


  /* ───────────────── WEB3 PAYMENT ───────────────── */

  async function executeWeb3Payment(
    provider?: EIP1193Provider
  ) {

    /**
     * ISSUE 1 FIX: processing state ownership belongs to handleConfirm.
     *
     * Setting setIsProcessing(true) here created split ownership:
     * handleConfirm() and executeWeb3Payment() both drove the same
     * state flag, creating ordering ambiguity under React concurrent
     * rendering, mobile tab restore, and slow WalletConnect reconnect.
     *
     * handleConfirm() is the single entry point that sets
     * isProcessing — executeWeb3Payment() inherits that state
     * and only drives web3State transitions.
     */

    try {

      if (!mountedRef.current) return
      setWeb3State("connecting")

      /**
       * Establish the canonical Business Quote BEFORE the on-chain
       * transfer is sent. Without this, /api/web3/verify has no Quote
       * to read against and rejects with BUSINESS_QUOTE_NOT_FOUND —
       * the Paddle path gets this for free from create-checkout.ts,
       * the web3 path must call its counterpart explicitly.
       */
      const quoteRes =
        await fetch("/api/web3/create-quote", {

          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            capsuleId,
            billableSizeBytes,
            expectedAmount: price,
          }),

        })

      if (!quoteRes.ok) {

        throw new Error(
          "Could not establish payment quote."
        )

      }

      const hash =
        await sendUSDC(
          price,
          provider
        )

      if (!mountedRef.current) return
      setWeb3State("pending")

      if (!mountedRef.current) return
      setWeb3State("verifying")

      const verified =
        await verifyWeb3Tx({

          txHash: hash,
          capsuleId,
          billableSizeBytes,
          signal: new AbortController().signal,

        })

      if (!verified)
        throw new Error(
          "Server could not confirm payment."
        )

      await onConfirmPayment({
        web3TxHash: hash
      })

    }

    catch (err) {

      if (!mountedRef.current) return

      setWeb3State("failed")

      if (err instanceof USDCPaymentException) {

        switch (err.code) {

          case "NO_WALLET":
            setError("No Web3 wallet found.")
            break

          case "USER_REJECTED":
            setError("Transaction rejected.")
            break

          case "WRONG_NETWORK":
            setError("Please switch wallet network to Base.")
            break

          default:
            setError(err.message)

        }

      }

      else {

        setError(
          err instanceof Error
            ? err.message
            : "Web3 payment failed"
        )

      }

      setIsProcessing(false)

    }

  }


  /* ───────────────── CONFIRM BUTTON ───────────────── */

  const handleConfirm = async () => {

    if (!canProceed || isProcessing)
      return

    setError(null)

    // Single ownership point for processing state.
    // executeWeb3Payment() inherits this — does not re-set it.
    setIsProcessing(true)


    /* ───────── CARD PAYMENT (PADDLE HOSTED CHECKOUT) ───────── */

    if (paymentMethod === "card") {

      try {

        /**
         * Canonical orchestration:
         * PaymentModal never owns checkout creation or redirect
         * authority — CapsuleBuilder.handleConfirmPayment is the
         * single owner of createPaddleCheckout() + opening the
         * Paddle overlay. PaymentModal only signals intent here,
         * for BOTH card and web3 payment flows.
         */

        await onConfirmPayment()

      }

      catch {

        if (!mountedRef.current) return

        setError(
          "Card payment failed"
        )

        setIsProcessing(false)

      }

      return

    }


    /* ───────── WEB3 PAYMENT ───────── */

    await handleWalletDiscovery()

  }


  /* ───────────────── RENDER ───────────────── */

  return (

    <>

      <Dialog
        open={open}
        onOpenChange={(v) => {

          if (isProcessing)
            return

          if (!v)
            onClose()

        }}
      >

        <DialogContent className="space-y-6">

          <DialogHeader>

            <DialogTitle>
              Review & Seal
            </DialogTitle>

          </DialogHeader>


          <div className="space-y-3">

            {unlockDate && (

              <div>

                <div className="text-xs text-muted-foreground">
                  Release Date (UTC)
                </div>

                <div>
                  {unlockDate}
                </div>

              </div>

            )}


            {description && (

              <div>

                <div className="text-xs text-muted-foreground">
                  Label
                </div>

                <div>
                  "{description}"
                </div>

              </div>

            )}


            <div className="flex justify-between">

              <span>
                Total Amount
              </span>

              <span className="text-emerald-500">

                ${price.toFixed(2)}

              </span>

            </div>

          </div>


          <div className="grid grid-cols-2 gap-3">

            <button
              type="button"
              onClick={() =>
                setPaymentMethod("card")
              }
              className={`p-4 border rounded-xl ${
                paymentMethod === "card"
                  ? "border-emerald-500"
                  : "border-border"
              }`}
            >

              <CreditCard size={20} />

              Credit Card

            </button>


            <button
              type="button"
              onClick={() =>
                setPaymentMethod("web3")
              }
              className={`p-4 border rounded-xl ${
                paymentMethod === "web3"
                  ? "border-emerald-500"
                  : "border-border"
              }`}
            >

              <Wallet size={20} />

              USDC (Base)

            </button>

          </div>


          <Button
            disabled={!canProceed || isProcessing}
            onClick={handleConfirm}
          >

            {isProcessing && (
              <Loader2 className="mr-2 animate-spin" />
            )}

            {
              web3State === "connecting"
                ? "Connecting wallet..."
                : web3State === "pending"
                ? "Transaction pending..."
                : web3State === "verifying"
                ? "Verifying payment..."
                : "CONTINUE"
            }

          </Button>


          {error && (

            <div className="text-red-500 text-sm">
              {error}
            </div>

          )}

        </DialogContent>

      </Dialog>


      <WalletSelectorModal

        open={selectorOpen}

        wallets={wallets}

        onSelect={(wallet) => {

          saveLastWallet(wallet.id)

          setSelectorOpen(false)

          executeWeb3Payment(wallet.provider)

        }}

        onWalletConnect={() => {

          saveLastWallet("walletconnect")

          setSelectorOpen(false)

          executeWeb3Payment()

        }}

      />

    </>

  )

}


/* ───────────────── VERIFY TX ───────────────── */

interface VerifyParams {

  txHash: string
  capsuleId: string
  billableSizeBytes: number
  signal?: AbortSignal

}

/**
 * Polling verify loop.
 *
 * Backend returns 202 + { ok: false, error: "Pending" } while the
 * transaction is not yet mined or hasn't reached MIN_CONFIRMATIONS.
 * Any other non-ok status is a hard failure — no point retrying.
 *
 * Timing:
 *   MAX_ATTEMPTS × POLL_INTERVAL_MS = 20 × 3000 = 60 sec max wait.
 *   Base produces a block ~every 2 sec, so 20 attempts is generous
 *   even for a heavily congested mempool.
 */

const MAX_ATTEMPTS     = 20
const POLL_INTERVAL_MS = 3_000

async function verifyWeb3Tx({

  txHash,
  capsuleId,
  billableSizeBytes,
  signal,

}: VerifyParams): Promise<boolean> {

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {

    if (signal?.aborted) return false

    const res =
      await fetch("/api/web3/verify", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          txHash,
          capsuleId,
          billableSizeBytes
        }),

        signal: signal ?? null,

      })

    // Hard failure — server rejected the request outright.
    // 4xx (except 202) means no point retrying.
    if (!res.ok && res.status !== 202) {

      console.error(
        "[AETERNA] verify failed:",
        res.status
      )

      return false

    }

    const data = await res.json() as {
      ok: boolean
      error?: string
    }

    // Confirmed.
    if (data.ok === true)
      return true

    // Any error other than "Pending" is terminal.
    if (data.error !== "Pending") {

      console.error(
        "[AETERNA] verify terminal error:",
        data.error
      )

      return false

    }

    // Still pending — wait before next attempt.
    // Last iteration: skip the sleep, just return false below.
    if (attempt < MAX_ATTEMPTS - 1) {

      await new Promise<void>((resolve, reject) => {

        const timer =
          setTimeout(resolve, POLL_INTERVAL_MS)

        signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new DOMException("Aborted", "AbortError"))
        }, { once: true })

      })

    }

  }

  // Exhausted all attempts — tx didn't confirm within the window.
  console.error(
    "[AETERNA] verify timed out after",
    MAX_ATTEMPTS,
    "attempts"
  )

  return false

}