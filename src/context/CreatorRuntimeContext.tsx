/**
 * AETERNA — Creator Runtime Context
 *
 * Minimal frontend context for canonical creator authority.
 *
 * Responsibilities:
 * - expose non-authoritative creator session state for UX
 * - provide methods to call canonical server endpoints
 * - never treat local state as security authority
 */

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

export type CreatorIdentityStatus = "idle" | "authenticating" | "authenticated" | "error";

export type CreditStatus = "idle" | "pending" | "available" | "consuming" | "consumed" | "error";

export interface CreatorRuntimeContextValue {
  creatorIdentityId: string | null;
  status: CreatorIdentityStatus;
  error: string | null;
  authenticate: (network: string, account: string, signature: string, challengeId: string) => Promise<void>;
  issueChallenge: (network: string, publicKey: string) => Promise<{ challengeId: string; challenge: string; message: string }>;
  /**
   * Adopt a creatorIdentityId that was just server-verified (e.g. by
   * the payment modal's challenge/proof or by credit-status
   * discovery). Runtime state is only a MIRROR of server-authenticated
   * state — the server remains authoritative.
   */
  adoptIdentity: (creatorIdentityId: string) => void;
  clear: () => void;
  hasDevBypass: boolean;
  // TEMPORARY DEV PREVIEW — REMOVE AFTER CREATE UI WORK
  hasCreatePreview: boolean;
}

export interface CreatorCreditContextValue {
  creditStatus: CreditStatus;
  creditId: string | null;
  creatorCreditId: string | null;
  lifecycleId: string | null;
  paymentIntentId: string | null;
  error: string | null;
  clear: () => void;
}

const CreatorIdentityContext = createContext<CreatorRuntimeContextValue | null>(null);
const CreatorCreditContext = createContext<CreatorCreditContextValue | null>(null);

export function useCreatorIdentity(): CreatorRuntimeContextValue {
  const ctx = useContext(CreatorIdentityContext);
  if (!ctx) throw new Error("useCreatorIdentity must be used within CreatorIdentityProvider");
  return ctx;
}

export function useCreatorCredit(): CreatorCreditContextValue {
  const ctx = useContext(CreatorCreditContext);
  if (!ctx) throw new Error("useCreatorCredit must be used within CreatorCreditProvider");
  return ctx;
}

export function CreatorIdentityProvider({ children }: { children: ReactNode }) {
  const [creatorIdentityId, setCreatorIdentityId] = useState<string | null>(null);
  const [status, setStatus] = useState<CreatorIdentityStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const hasDevBypass = import.meta.env.DEV && typeof sessionStorage !== "undefined"
    ? sessionStorage.getItem("aeterna-dev-bypass") === "1"
    : false;

  // TEMPORARY DEV PREVIEW — REMOVE AFTER CREATE UI WORK
  const hasCreatePreview = import.meta.env.DEV ? true : false;

  const authenticate = useCallback(async (network: string, account: string, signature: string, challengeId: string) => {
    setStatus("authenticating");
    setError(null);
    try {
      const res = await fetch("/api/creator/verify-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network, account, signature, challengeId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data?.creatorIdentityId) {
        throw new Error(data?.error || "IDENTITY_VERIFICATION_FAILED");
      }
      setCreatorIdentityId(data.creatorIdentityId);
      setStatus("authenticated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "IDENTITY_ERROR");
      setStatus("error");
      throw err;
    }
  }, []);

  const adoptIdentity = useCallback((creatorIdentityId: string) => {
    setCreatorIdentityId(creatorIdentityId);
    setStatus("authenticated");
    setError(null);
  }, []);

  const issueChallenge = useCallback(async (network: string, publicKey: string) => {
    setError(null);
    const res = await fetch("/api/creator/issue-challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network, publicKey }),
    });
    const data = await res.json();
    // Production endpoint returns `id`; normalize the legacy
    // `challengeId` alias so both response shapes resolve identically.
    const challengeId = data?.id ?? data?.challengeId;
    if (!res.ok || !data?.ok || !challengeId || !data?.challenge || !data?.message) {
      throw new Error(data?.error || "CHALLENGE_ISSUANCE_FAILED");
    }
    return { challengeId, challenge: data.challenge, message: data.message as string };
  }, []);

  const clear = useCallback(() => {
    setCreatorIdentityId(null);
    setStatus("idle");
    setError(null);
  }, []);

  const providerIdentityValue: CreatorRuntimeContextValue = {
    creatorIdentityId,
    status,
    error,
    authenticate,
    issueChallenge,
    adoptIdentity,
    clear,
    hasDevBypass,
    hasCreatePreview,
  };

  return (
    <CreatorIdentityContext.Provider value={providerIdentityValue}>
      {children}
    </CreatorIdentityContext.Provider>
  );
}

export function CreatorCreditProvider({ children }: { children: ReactNode }) {
  const [creditStatus, setCreditStatus] = useState<CreditStatus>("idle");
  const [creditId, setCreditId] = useState<string | null>(null);
  const [creatorCreditId, setCreatorCreditId] = useState<string | null>(null);
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    setCreditStatus("idle");
    setCreditId(null);
    setCreatorCreditId(null);
    setLifecycleId(null);
    setPaymentIntentId(null);
    setError(null);
  }, []);

  return (
    <CreatorCreditContext.Provider value={{ creditStatus, creditId, creatorCreditId, lifecycleId, paymentIntentId, error, clear }}>
      {children}
    </CreatorCreditContext.Provider>
  );
}
