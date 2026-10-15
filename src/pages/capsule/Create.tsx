/**
 * Create page
 *
 * Creator pipeline entry boundary — ADMISSION GATE.
 *
 * Responsibilities:
 * - render the canonical capsule preparation workspace ONLY when the Home
 *   access gate has granted an in-memory admission (CreateAccessContext).
 *   Admission exists only after a server-verified outcome: an AVAILABLE
 *   Creator Credit discovered for the connected identity, or a freshly
 *   granted credit after a verified $1 payment. The wallet connect, the
 *   entitlement discovery and the $1 step live on Home (PATCH: Home
 *   access gate) and are never repeated here;
 * - direct open without admission (hand-typed URL, bookmark, external
 *   link, stale router state) redirects Home BEFORE any editor surface
 *   renders: no CapsuleInput / ActionMenu / MediaCapture / date picker;
 * - preserve draft/sessionStorage recovery;
 * - never treat client-side state as business authority: admission is a
 *   non-persisted in-memory token, and every creation operation still
 *   runs the server-side gates (reserve / storage quote / upload-token /
 *   seal / finalize).
 *
 * Spec:
 * AETERNA_RUNTIME_FLOW_SPEC.md
 */

import { Navigate } from "react-router-dom";

import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";
import { useCreateAccess } from "@/context/CreateAccessContext";

export default function Create() {
  const { admission } = useCreateAccess();

  if (!admission) {
    // URL / router state / React flags are NOT proof of payment — the
    // server remains the authority. Without admission the creator is
    // returned to the Home access gate, which re-runs the canonical
    // discovery (a previously paid, unused right is recognised there
    // without a second payment).
    return <Navigate to="/" replace />;
  }

  return <CapsuleBuilder />;
}
