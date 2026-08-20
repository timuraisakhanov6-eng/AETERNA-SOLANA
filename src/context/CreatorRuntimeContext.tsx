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

export interface CreatorIdentityContextValue {
  creatorIdentityId: string | null;
  status: CreatorIdentityStatus;
  error: string | null;
  authenticate: (network: string, account: string, signature: string, challengeId: string) => Promise<void>;
  clear: () => void;
}

export interface CreatorCreditContextValue {
  creditStatus: CreditStatus;
  creditId: string | null;
  lifecycleId: string | null;
  error: string | null;
  refreshCredit: (capsuleId: string) => Promise<void>;
  reserveLifecycle: (capsuleId: string, lifecycleId: string) => Promise<{ ok: boolean; status?: string }>;
  clear: () => void;
}

const CreatorIdentityContext = createContext<CreatorIdentityContextValue | null>(null);
const CreatorCreditContext = createContext<CreatorCreditContextValue | null>(null);

export function useCreatorIdentity(): CreatorIdentityContextValue {
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

  const clear = useCallback(() => {
    setCreatorIdentityId(null);
    setStatus("idle");
    setError(null);
  }, []);

  return (
    <CreatorIdentityContext.Provider value={{ creatorIdentityId, status, error, authenticate, clear }}>
      {children}
    </CreatorIdentityContext.Provider>
  );
}

export function CreatorCreditProvider({ children }: { children: ReactNode }) {
  const [creditStatus, setCreditStatus] = useState<CreditStatus>("idle");
  const [creditId, setCreditId] = useState<string | null>(null);
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshCredit = useCallback(async (capsuleId: string) => {
    setCreditStatus("pending");
    setError(null);
    try {
      const res = await fetch(`/api/creator/credit-status?capsuleId=${encodeURIComponent(capsuleId)}`);
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "CREDIT_STATUS_FAILED");
      }
      setCreditStatus(data.status ?? "idle");
      setCreditId(data.creatorCreditId ?? null);
      setLifecycleId(data.lifecycleId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "CREDIT_ERROR");
      setCreditStatus("error");
    }
  }, []);

  const reserveLifecycle = useCallback(async (capsuleId: string, lifecycleId: string) => {
    setCreditStatus("pending");
    setError(null);
    try {
      const res = await fetch("/api/creator/reserve-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capsuleId, lifecycleId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "LIFECYCLE_RESERVATION_FAILED");
      }
      setCreditStatus(data.status ?? "consuming");
      setCreditId(data.creatorCreditId ?? null);
      setLifecycleId(lifecycleId);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "LIFECYCLE_ERROR");
      setCreditStatus("error");
      throw err;
    }
  }, []);

  const clear = useCallback(() => {
    setCreditStatus("idle");
    setCreditId(null);
    setLifecycleId(null);
    setError(null);
  }, []);

  return (
    <CreatorCreditContext.Provider value={{ creditStatus, creditId, lifecycleId, error, refreshCredit, reserveLifecycle, clear }}>
      {children}
    </CreatorCreditContext.Provider>
  );
}
