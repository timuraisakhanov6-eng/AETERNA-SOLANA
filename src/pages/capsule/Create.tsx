/**
 * Create page
 *
 * Creator pipeline entry boundary.
 *
 * Responsibilities:
 * - render the canonical capsule preparation workspace
 * - never auto-trigger wallet, signing, or entitlement checks on mount
 * - preserve draft/sessionStorage recovery
 * - never treat client-side state as business authority
 *
 * Spec:
 * AETERNA_RUNTIME_FLOW_SPEC.md
 */

import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";
import { useCreatorCredit } from "@/context/CreatorRuntimeContext";
import { useLandingPaymentGate } from "@/context/LandingPaymentGateContext";

export default function Create() {
  const { clear: clearCredit } = useCreatorCredit();
  const { openLandingPaymentModal } = useLandingPaymentGate();

  return (
    <CapsuleBuilder
      onOpenServicePayment={() => {
        clearCredit();
        openLandingPaymentModal();
      }}
    />
  );
}
