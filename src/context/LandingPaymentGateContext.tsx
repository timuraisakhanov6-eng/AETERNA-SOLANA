/**
 * AETERNA — Landing Payment Gate Context (PATCH-2K-B)
 *
 * In-session mirror of the server's Creator Credit entitlement for the
 * inline Service Payment Gate. Since PATCH-2K-B there is NO payment
 * modal: CapsuleBuilder hosts the headless servicePaymentController and
 * feeds server-verified outcomes into this gate via reportCreditDiscovery
 * / reportCreditReady.
 *
 * This context:
 * - retains the FULL server-granted entitlement result
 *   (creatorIdentityId / creatorCreditId / account / paymentIntentId)
 *   so the /create workspace can restore it in-session without another
 *   signature or another $1 (PATCH-2F semantics, unchanged);
 * - clears a stale entitlement mirror ONLY on a server-authoritative
 *   "no AVAILABLE credit" answer for the SAME account (PATCH-2J);
 * - never grants entitlement or payment authority itself;
 * - MUST NOT be used as server authority. The retained entitlement is
 *   a mirror of the server's grant/discovery response, and the verified
 *   creatorIdentityId is adopted into CreatorIdentityProvider, which
 *   itself remains a mirror of server-authenticated state.
 * - adds no persistence: the mirror lives for the app-root session only.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from "react"

import { useCreatorIdentity } from "@/context/CreatorRuntimeContext"
import type {
  ServicePaymentCreditResult,
  ServicePaymentDiscoveryResult,
} from "@/lib/payment/servicePaymentController"

export interface LandingEntitlement {
  creatorIdentityId?: string
  creatorCreditId?: string
  account?: string
  paymentIntentId?: string
}

type LandingPaymentGateContextType = {
  entitlement: LandingEntitlement | null
  /**
   * Server-verified credit-status discovery outcome (PATCH-2J). Available
   * answers restore the entitlement mirror and adopt the proven identity;
   * authoritative "none" answers clear a stale mirror for that account
   * only. Entitlement facts only — the raw proof never passes through.
   */
  reportCreditDiscovery: (result: ServicePaymentDiscoveryResult) => void
  /**
   * Server-verified grant-credit result after a successful $1 payment.
   * Retains the FULL server result so the prepared /create workspace sees
   * the paid entitlement immediately.
   */
  reportCreditReady: (result: ServicePaymentCreditResult) => void
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
}: {
  children: ReactNode
}) {
  const { adoptIdentity } = useCreatorIdentity()
  const [entitlement, setEntitlement] = useState<LandingEntitlement | null>(null)

  // Bodies preserved verbatim from the app-root PaymentModal wiring they
  // replaced (PATCH-2F / PATCH-2J semantics unchanged).
  const reportCreditDiscovery = useCallback(
    (result: ServicePaymentDiscoveryResult) => {
      if (
        result.status === "available" &&
        result.creatorCreditId &&
        result.creatorIdentityId &&
        result.account
      ) {
        // PATCH-2F preserved: a discovered AVAILABLE Creator Credit is a
        // server-authenticated entitlement — the CapsuleBuilder
        // entitlement effect restores "paid".
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
    },
    [adoptIdentity]
  )

  const reportCreditReady = useCallback(
    (result: ServicePaymentCreditResult) => {
      if (result.creatorCreditId) {
        const next: LandingEntitlement = {
          creatorCreditId: result.creatorCreditId,
        }
        if (result.creatorIdentityId !== undefined) {
          next.creatorIdentityId = result.creatorIdentityId
        }
        if (result.account !== undefined) {
          next.account = result.account
        }
        if (result.paymentIntentId !== undefined) {
          next.paymentIntentId = result.paymentIntentId
        }
        setEntitlement(next)
        if (result.creatorIdentityId) {
          // Identity was challenge-verified moments ago inside the
          // controller — adopt the server-proven id.
          adoptIdentity(result.creatorIdentityId)
        }
      }
    },
    [adoptIdentity]
  )

  return (
    <LandingPaymentGateContext.Provider
      value={{ entitlement, reportCreditDiscovery, reportCreditReady }}
    >
      {children}
    </LandingPaymentGateContext.Provider>
  )
}
