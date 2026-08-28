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

export type CreateAccessStatus =
  | "loading"
  | "available"
  | "access-required"
  | "unavailable";

export interface CreatorRuntimeContextValue {
  creatorIdentityId: string | null;
  status: CreatorIdentityStatus;
  error: string | null;
  authenticate: (network: string, account: string, signature: string, challengeId: string) => Promise<void>;
  issueChallenge: (network: string) => Promise<{ challengeId: string; challenge: string }>;
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
  refreshCredit: (challengeId: string, network: string, account: string, signature: string, creatorCreditId: string, lifecycleId?: string | null) => Promise<void>;
  checkEntitlement: (challengeId: string, network: string, account: string, signature: string, creatorCreditId: string, lifecycleId?: string | null) => Promise<CreateAccessStatus>;
  reserveLifecycle: (creatorCreditId: string, lifecycleId: string, capsuleId: string) => Promise<{ ok: boolean; status?: string }>;
  accessStatus: CreateAccessStatus;
  setAccessStatus: (status: CreateAccessStatus) => void;
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

  const issueChallenge = useCallback(async (network: string) => {
    setError(null);
    const res = await fetch("/api/creator/issue-challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok || !data?.challengeId || !data?.challenge) {
      throw new Error(data?.error || "CHALLENGE_ISSUANCE_FAILED");
    }
    return { challengeId: data.challengeId, challenge: data.challenge };
  }, []);

  const clear = useCallback(() => {
    setCreatorIdentityId(null);
    setStatus("idle");
    setError(null);
  }, []);

  return (
    <CreatorIdentityContext.Provider value={{ creatorIdentityId, status, error, authenticate, issueChallenge, clear, hasDevBypass, hasCreatePreview }}>
      {children}
    </CreatorIdentityContext.Provider>
  );
}

export function CreatorCreditProvider({ children }: { children: ReactNode }) {
  const { creatorIdentityId } = useCreatorIdentity();
  const [creditStatus, setCreditStatus] = useState<CreditStatus>("idle");
  const [creditId, setCreditId] = useState<string | null>(null);
  const [creatorCreditId, setCreatorCreditId] = useState<string | null>(null);
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessStatus, setAccessStatus] = useState<CreateAccessStatus>("loading");

  const refreshCredit = useCallback(async (challengeId: string, network: string, account: string, signature: string, creatorCreditId: string, lifecycleId?: string | null) => {
    setCreditStatus("pending");
    setError(null);
    try {
      const res = await fetch("/api/creator/credit-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, network, account, signature, creatorCreditId, lifecycleId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || typeof data?.status !== "string") {
        throw new Error(data?.error || "CREDIT_STATUS_FAILED");
      }
      const status = data.status;
      const mapped: CreditStatus = status === "available" || status === "consuming" || status === "consumed" ? status : "idle";
      setCreditStatus(mapped);
      setCreditId(data.creatorCreditId ?? creditId);
      setCreatorCreditId(data.creatorCreditId ?? creatorCreditId);
      setLifecycleId(data.lifecycleId ?? lifecycleId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "CREDIT_ERROR");
      setCreditStatus("error");
    }
  }, []);

  const checkEntitlement = useCallback(async (
    challengeId: string,
    network: string,
    account: string,
    signature: string,
    creatorCreditId: string,
    lifecycleId?: string | null
  ) => {
    setAccessStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/creator/credit-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, network, account, signature, creatorCreditId, lifecycleId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || typeof data?.status !== "string") {
        throw new Error(data?.error || "ENTITLEMENT_CHECK_FAILED");
      }
      const status = data.status;
      if (status === "available" || status === "consuming") {
        setAccessStatus("available");
        setCreditId(data.creatorCreditId ?? creditId);
        setCreatorCreditId(data.creatorCreditId ?? creatorCreditId);
        setLifecycleId(data.lifecycleId ?? lifecycleId ?? null);
        return "available";
      } else if (status === "consumed") {
        setAccessStatus("unavailable");
        return "unavailable";
      }
      setAccessStatus("access-required");
      return "access-required";
    } catch (err) {
      setError(err instanceof Error ? err.message : "ENTITLEMENT_ERROR");
      setAccessStatus("unavailable");
      return "unavailable";
    }
  }, []);

  const reserveLifecycle = useCallback(async (creatorCreditId: string, lifecycleId: string, capsuleId: string) => {
    setCreditStatus("pending");
    setError(null);
    try {
      const res = await fetch("/api/creator/reserve-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorIdentityId: creatorIdentityId,
          creatorCreditId,
          lifecycleId,
          capsuleId,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "LIFECYCLE_RESERVATION_FAILED");
      }
      setCreditStatus(data.status ?? "consuming");
      setCreditId(data.creatorCreditId ?? creatorCreditId);
      setLifecycleId(lifecycleId);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "LIFECYCLE_ERROR");
      setCreditStatus("error");
      throw err;
    }
  }, [creatorIdentityId]);

  const clear = useCallback(() => {
    setCreditStatus("idle");
    setCreditId(null);
    setCreatorCreditId(null);
    setLifecycleId(null);
    setPaymentIntentId(null);
    setError(null);
    setAccessStatus("loading");
  }, []);

  return (
    <CreatorCreditContext.Provider value={{ creditStatus, creditId, creatorCreditId, lifecycleId, paymentIntentId, error, refreshCredit, checkEntitlement, reserveLifecycle, accessStatus, setAccessStatus, clear }}>
      {children}
    </CreatorCreditContext.Provider>
  );
}
