/**
 * Create page
 *
 * Creator pipeline entry boundary.
 *
 * Responsibilities:
 * - enforce server-authoritative /create access gate
 * - render CapsuleBuilder only after confirmed entitlement
 * - never treat client-side state as entitlement authority
 *
 * Spec:
 * AETERNA_RUNTIME_FLOW_SPEC.md
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";
import { useCreatorIdentity, useCreatorCredit } from "@/context/CreatorRuntimeContext";
import { useLandingPaymentGate } from "@/context/LandingPaymentGateContext";
import { connectSolanaWallet } from "@/lib/wallet/solanaWallet";

type AccessView = "loading" | "workspace" | "access-required" | "unavailable";

export default function Create() {
  const navigate = useNavigate();
  const { creatorIdentityId, status: identityStatus, issueChallenge, hasDevBypass, hasCreatePreview } =
    useCreatorIdentity();
  const { accessStatus, creatorCreditId, lifecycleId, checkEntitlement, clear: clearCredit } =
    useCreatorCredit();
  const { openLandingPaymentModal } = useLandingPaymentGate();

  const [view, setView] = useState<AccessView>(() => {
    if (hasDevBypass || hasCreatePreview) {
      return "workspace"
    }

    return creatorIdentityId ? "loading" : "access-required"
  });

  useEffect(() => {
    if (!creatorIdentityId || !creatorCreditId) {
      if (creatorIdentityId) {
        setView("access-required");
      }
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const { challengeId, challenge } = await issueChallenge(
          "solana"
        );

        let wallet;
        try {
          wallet = await connectSolanaWallet();
        } catch {
          if (!cancelled) setView("access-required");
          return;
        }

        const account = wallet.getPublicKey();
        if (!account) {
          if (!cancelled) setView("access-required");
          return;
        }

        const encoded = typeof challenge === "string" ? new TextEncoder().encode(challenge) : challenge;
        const signatureResult = await wallet.signMessage(encoded);
        const signature = signatureResult.signature;

        const result = await checkEntitlement(
          challengeId,
          "solana",
          account,
          signature,
          creatorCreditId,
          lifecycleId
        );

        if (!cancelled) {
          if (result === "available") {
            setView("workspace");
          } else if (result === "access-required") {
            setView("access-required");
          } else {
            setView("unavailable");
          }
        }
      } catch {
        if (!cancelled) {
          setView("unavailable");
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [creatorIdentityId, identityStatus, issueChallenge, checkEntitlement, creatorCreditId, lifecycleId]);

  const isDevPreview = import.meta.env.DEV && (hasDevBypass || hasCreatePreview);

  if ((view === "loading" || accessStatus === "loading") && !isDevPreview) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="animate-spin" size={20} />
          <span>Checking creation access...</span>
        </div>
      </div>
    );
  }

  if (view === "workspace") {
    return <CapsuleBuilder />;
  }

  const isBlocked =
    view === "unavailable" || accessStatus === "unavailable";

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-5">
      <div className="max-w-md w-full space-y-6 text-center">
        <h1 className="text-2xl font-display tracking-wide">
          Capsule creation access required.
        </h1>
        <p className="text-sm text-muted-foreground">
          {isBlocked
            ? "Creation access is currently unavailable."
            : "Verified payment is required before capsule creation."}
        </p>
        <div className="space-y-3">
          <Button
            onClick={() => {
              clearCredit();
              navigate("/");
            }}
            className="w-full"
          >
            CREATE CAPSULE
          </Button>
          <Button
            variant="secondary"
            onClick={() => openLandingPaymentModal()}
            className="w-full"
          >
            Open Service Payment
          </Button>
        </div>
      </div>
    </div>
  );
}
