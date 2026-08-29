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
import { useAeternaWallet } from "@/context/AETERNAWalletContext";

type AccessView = "loading" | "workspace" | "access-required" | "unavailable";

export default function Create() {
  const navigate = useNavigate();
  const wallet = useAeternaWallet();
  const { creatorIdentityId, status: identityStatus, issueChallenge, hasDevBypass, hasCreatePreview } =
    useCreatorIdentity();
  const { accessStatus, setAccessStatus, creatorCreditId, lifecycleId, checkEntitlement, clear: clearCredit } =
    useCreatorCredit();
  const { openLandingPaymentModal } = useLandingPaymentGate();

  const [view, setView] = useState<AccessView>(() => {
    if (hasDevBypass || hasCreatePreview) {
      return "workspace";
    }

    return creatorIdentityId ? "loading" : "access-required";
  });

  const [boundAccount, setBoundAccount] = useState<string | null>(null);

  useEffect(() => {
    if (!creatorIdentityId || !creatorCreditId) {
      if (creatorIdentityId) {
        setView("access-required");
      } else if (identityStatus !== "authenticating") {
        setAccessStatus("access-required");
      }
      return;
    }

    if (!wallet.ready) {
      setView("loading");
      return;
    }

    if (!wallet.account) {
      setView("access-required");
      return;
    }

    if (boundAccount && wallet.account !== boundAccount) {
      setView("access-required");
      return;
    }

    if (identityStatus === "authenticated" && boundAccount !== wallet.account) {
      setBoundAccount(wallet.account);
    }

    let cancelled = false;

    const run = async () => {
      try {
        if (!boundAccount || wallet.account !== boundAccount) {
          const { challengeId, challenge } = await issueChallenge("solana");

          try {
            await wallet.openWalletPicker();
          } catch {
            if (!cancelled) {
              setView("access-required");
              setBoundAccount(null);
            }
            return;
          }

          if (!wallet.account) {
            if (!cancelled) {
              setView("access-required");
              setBoundAccount(null);
            }
            return;
          }

          if (boundAccount && wallet.account !== boundAccount) {
            if (!cancelled) {
              setView("access-required");
              setBoundAccount(null);
            }
            return;
          }

          const encoded = typeof challenge === "string" ? new TextEncoder().encode(challenge) : challenge;
          const { signature } = await wallet.signMessage(encoded);

          const result = await checkEntitlement(
            challengeId,
            "solana",
            wallet.account,
            signature,
            creatorCreditId,
            lifecycleId
          );

          if (!cancelled) {
            if (result === "available") {
              setBoundAccount(wallet.account);
              setView("workspace");
            } else if (result === "access-required") {
              setView("access-required");
              setBoundAccount(wallet.account);
            } else {
              setView("unavailable");
            }
          }
        } else if (view !== "workspace") {
          setView("workspace");
        }
      } catch {
        if (!cancelled) {
          setView("unavailable");
          setBoundAccount((prev) => (wallet.account && prev === wallet.account ? prev : null));
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    creatorIdentityId,
    identityStatus,
    issueChallenge,
    checkEntitlement,
    creatorCreditId,
    lifecycleId,
    wallet.account,
    wallet.ready,
    wallet.openWalletPicker,
    wallet.signMessage,
    wallet,
    boundAccount,
    view,
  ]);

  useEffect(() => {
    if (!creatorIdentityId || !boundAccount) {
      return;
    }

    if (wallet.account && wallet.account !== boundAccount) {
      setView("access-required");
      setBoundAccount((prev) => (prev === boundAccount ? null : prev));
    }
  }, [wallet.account, creatorIdentityId, boundAccount]);

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
