/**
 * Create page
 *
 * Creator pipeline entry boundary.
 *
 * Delegates capsule construction flow to CapsuleBuilder.
 *
 * Spec:
 * AETERNA_RUNTIME_FLOW_SPEC.md
 */

import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

export default function Create() {
  return <CapsuleBuilder />;
}