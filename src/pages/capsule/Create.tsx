/**
 * Create page
 *
 * Creator pipeline entry boundary.
 *
 * Responsibilities:
 * - render the canonical capsule preparation workspace with the inline
 *   Service Payment Gate (PATCH-2K-B: no payment modal, no payment
 *   orchestration at this boundary)
 * - never auto-trigger wallet connection, signing, or entitlement checks
 *   on mount
 * - preserve draft/sessionStorage recovery
 * - never treat client-side state as business authority
 *
 * Spec:
 * AETERNA_RUNTIME_FLOW_SPEC.md
 */

import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

export default function Create() {
  return <CapsuleBuilder />;
}
