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
  entitlement: LandingEntitlement | null
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

  return (
    <LandingPaymentGateContext.Provider value={{ openLandingPaymentModal, entitlement }}>
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
        onReserveReady={(result) => {
          setOpen(false)
          onEntitlementReady?.(result.paymentIntentId)
        }}
      />
    </LandingPaymentGateContext.Provider>
  )
}
