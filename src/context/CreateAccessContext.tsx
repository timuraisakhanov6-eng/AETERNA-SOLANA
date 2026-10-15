/**
 * AETERNA — Create Access Context (Home access gate → /create admission)
 *
 * The Home page is the admission gate for capsule creation: it owns the
 * wallet connection, the server-authoritative entitlement discovery and
 * the one-time $1 creation-right payment (through the SAME canonical
 * servicePaymentController / LandingPaymentGate machinery that used to run
 * inline on /create — there is exactly one payment system). Only AFTER a
 * server-verified outcome — either an AVAILABLE Creator Credit discovered
 * for this identity, or a freshly granted credit after a verified $1
 * payment — does the creator reach /create.
 *
 * This context carries the in-memory ADMISSION that /create checks:
 *
 *  - it is granted ONLY by the access gate after a server-verified result
 *    (credit-status "available" discovery or grant-credit);
 *  - it is NOT a payment proof and NOT an authority: the Creator Credit
 *    record and the challenge-proof identity remain server-side. Every
 *    creation operation on /create is still gated server-side (reserve,
 *    storage quote, upload-token, seal, finalize);
 *  - it is NEVER persisted (no localStorage/sessionStorage/URL/router
 *    state): a reload, a closed browser or a hand-typed URL cannot
 *    fabricate admission. A fresh visit re-runs the server discovery —
 *    previously-paid creators are recognised WITHOUT a second payment
 *    because the server still holds their unused AVAILABLE credit;
 *  - it is cleared when its entitlement is consumed (terminal seal
 *    success), on an account switch, and on a disconnect — a new or
 *    different identity must re-run the Home gate.
 */

import { createContext, useCallback, useContext, useState, ReactNode } from "react";

/**
 * Mirror of the server-granted entitlement result (same shape the
 * service-payment controller reports). Never an authority.
 */
export interface CreateAccessAdmission {
  creatorCreditId: string;
  creatorIdentityId: string;
  account: string;
  paymentIntentId?: string;
}

type CreateAccessContextType = {
  admission: CreateAccessAdmission | null;
  /** Grant admission after a server-verified AVAILABLE discovery or grant. */
  grantAccess: (admission: CreateAccessAdmission) => void;
  /** Drop admission (consumed / account changed / disconnected). */
  clearAccess: () => void;
};

const CreateAccessContext = createContext<CreateAccessContextType | null>(null);

export function useCreateAccess(): CreateAccessContextType {
  const ctx = useContext(CreateAccessContext);
  if (!ctx) {
    throw new Error(
      "useCreateAccess must be used within CreateAccessProvider"
    );
  }
  return ctx;
}

export function CreateAccessProvider({
  children,
  initialAdmission,
}: {
  children: ReactNode;
  /**
   * Test seam ONLY (production wiring never passes it): pre-seed the
   * in-memory admission with the exact shape the Home access gate grants
   * after a server-verified outcome. Still never persisted, still never a
   * payment proof — it only lets component tests construct the state the
   * gate would have committed, instead of racing an effect against the
   * /create redirect.
   */
  initialAdmission?: CreateAccessAdmission | null;
}): React.ReactElement {
  const [admission, setAdmission] = useState<CreateAccessAdmission | null>(
    initialAdmission ?? null
  );

  const grantAccess = useCallback((next: CreateAccessAdmission) => {
    setAdmission(next);
  }, []);

  const clearAccess = useCallback(() => {
    setAdmission(null);
  }, []);

  return (
    <CreateAccessContext.Provider value={{ admission, grantAccess, clearAccess }}>
      {children}
    </CreateAccessContext.Provider>
  );
}
