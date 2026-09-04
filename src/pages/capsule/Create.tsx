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

import { useMemo } from "react";

import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";
import { useCreatorIdentity, useCreatorCredit } from "@/context/CreatorRuntimeContext";
import { useLandingPaymentGate } from "@/context/LandingPaymentGateContext";

type AccessView = "loading" | "workspace";

export default function Create() {
  const { status: identityStatus, hasDevBypass, hasCreatePreview } =
    useCreatorIdentity();
  const { accessStatus, clear: clearCredit } = useCreatorCredit();
  const { openLandingPaymentModal } = useLandingPaymentGate();

  const isDevPreview = import.meta.env.DEV && (hasDevBypass || hasCreatePreview);

  const view: AccessView = useMemo(() => {
    if (isDevPreview) return "workspace";
    if (identityStatus === "loading" || accessStatus === "loading") return "loading";
    return "workspace";
  }, [accessStatus, identityStatus, isDevPreview]);

  if (view === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Loading workspace...</span>
        </div>
      </div>
    );
  }

  return (
    <CapsuleBuilder
      onOpenServicePayment={() => {
        clearCredit();
        openLandingPaymentModal();
      }}
    />
  );
}
