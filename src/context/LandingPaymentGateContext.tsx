/**
 * AETERNA — Landing Payment Gate Context
 *
 * Minimal global modal trigger for the canonical
 * landing -> service payment flow.
 *
 * This context:
 * - provides openLandingPaymentModal() from anywhere;
 * - renders the canonical PaymentModal once at the app root;
 * - never grants entitlement or payment authority itself;
 * - MUST NOT be used as server authority.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from "react"

import { PaymentModal } from "@/components/capsule/PaymentModal"

type LandingPaymentGateContextType = {
  openLandingPaymentModal: () => void
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
  const [open, setOpen] = useState(false)

  const openLandingPaymentModal = useCallback(() => {
    setOpen(true)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  return (
    <LandingPaymentGateContext.Provider value={{ openLandingPaymentModal }}>
      {children}
      <PaymentModal
        open={open}
        onClose={handleClose}
        description="AETERNA Service Payment"
        unlockAt={null}
        protocolAccepted={true}
        creatorIdentityId={null}
        onCreditReady={({ paymentIntentId }) => {
          if (paymentIntentId) {
            onEntitlementReady?.(paymentIntentId)
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
