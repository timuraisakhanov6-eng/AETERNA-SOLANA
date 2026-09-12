/**
 * AETERNA — Landing Payment Gate Context
 *
 * Minimal global modal trigger for the canonical
 * landing -> service payment flow.
 *
 * This context:
 * - provides openLandingPaymentModal() from anywhere;
 * - renders the canonical PaymentModal once at the app root;
 * - retains the FULL server-granted entitlement result
 *   (creatorIdentityId / creatorCreditId / account / paymentIntentId)
 *   so the /create workspace can restore it in-session;
 * - never grants entitlement or payment authority itself;
 * - MUST NOT be used as server authority. The retained entitlement is
 *   a mirror of the server's grant response, and the verified
 *   creatorIdentityId is adopted into CreatorIdentityProvider, which
 *   itself remains a mirror of server-authenticated state.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from "react"

import { PaymentModal } from "@/components/capsule/PaymentModal"
import { useCreatorIdentity } from "@/context/CreatorRuntimeContext"

export interface LandingEntitlement {
  creatorIdentityId?: string
  creatorCreditId?: string
  account?: string
  paymentIntentId?: string
}

type LandingPaymentGateContextType = {
  openLandingPaymentModal: () => void
  closeLandingPaymentModal: () => void
  entitlement: LandingEntitlement | null
  /**
   * Live mirror of the app-root payment modal's open state. Consumers
   * (CapsuleBuilder) use it to detect an abandoned modal close — the
   * only exit from their "payment_in_progress" state that is not a
   * granted credit.
   */
  isPaymentModalOpen: boolean
}

const LandingPaymentGateContext =
  createContext<LandingPaymentGateContextType | null>(null)

export function useLandingPaymentGate(): LandingPaymentGateContextType {
  const ctx = useContext(LandingPaymentGateContext)
  if (!ctx) {
    throw new Error(
      "useLandingPaymentGate must be used within LandingPaymentGateProvider"
    )
  }
  return ctx
}

export function LandingPaymentGateProvider({
  children,
  onEntitlementReady,
}: {
  children: ReactNode
  onEntitlementReady?: (paymentIntentId: string) => void
}) {
  const { adoptIdentity } = useCreatorIdentity()
  const [open, setOpen] = useState(false)
  const [entitlement, setEntitlement] = useState<LandingEntitlement | null>(null)

  const openLandingPaymentModal = useCallback(() => {
    setOpen(true)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  /**
   * Programmatic close for callers outside the modal (e.g. CapsuleBuilder
   * entitlement discovery): when an AVAILABLE Creator Credit is restored,
   * the open payment modal must not stay mounted above the workspace.
   */
  const closeLandingPaymentModal = useCallback(() => {
    setOpen(false)
  }, [])

  return (
    <LandingPaymentGateContext.Provider value={{ openLandingPaymentModal, closeLandingPaymentModal, entitlement, isPaymentModalOpen: open }}>
      {children}
      <PaymentModal
        open={open}
        onClose={handleClose}
        unlockAt={null}
        protocolAccepted={true}
        creatorIdentityId={null}
        stopAfterCredit
        onCreditReady={(result) => {
          if (result.creatorCreditId) {
            const next: LandingEntitlement = {
              creatorCreditId: result.creatorCreditId,
            };
            if (result.creatorIdentityId !== undefined) {
              next.creatorIdentityId = result.creatorIdentityId;
            }
            if (result.account !== undefined) {
              next.account = result.account;
            }
            if (result.paymentIntentId !== undefined) {
              next.paymentIntentId = result.paymentIntentId;
            }
            setEntitlement(next);
            if (result.creatorIdentityId) {
              // Identity was challenge-verified moments ago inside the
              // payment modal — adopt the server-proven id.
              adoptIdentity(result.creatorIdentityId)
            }
          }
          if (result.paymentIntentId) {
            onEntitlementReady?.(result.paymentIntentId)
          }
        }}
        onCreditDiscovered={(result) => {
          if (
            result.status === "available" &&
            result.creatorCreditId &&
            result.creatorIdentityId &&
            result.account
          ) {
            // PATCH-2F preserved: a discovered AVAILABLE Creator Credit is
            // a server-authenticated entitlement — the CapsuleBuilder
            // entitlement effect restores "paid" and closes this modal.
            setEntitlement({
              creatorCreditId: result.creatorCreditId,
              creatorIdentityId: result.creatorIdentityId,
              account: result.account,
            })
            if (result.creatorIdentityId) {
              adoptIdentity(result.creatorIdentityId)
            }
          } else if (result.status === "none" && result.account) {
            // Server-authoritative "no AVAILABLE credit" for this account:
            // a stale in-session entitlement mirror must not restore a
            // consumed credit.
            setEntitlement((prev) =>
              prev && prev.account === result.account ? null : prev
            )
          }
        }}
        onReserveReady={(result) => {
          setOpen(false)
          onEntitlementReady?.(result.paymentIntentId)
        }}
      />
    </LandingPaymentGateContext.Provider>
  )
}
