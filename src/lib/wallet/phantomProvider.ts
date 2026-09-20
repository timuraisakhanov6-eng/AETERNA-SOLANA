/**
 * AETERNA — Phantom availability detection (Model 01 UX gate)
 *
 * Model 01 supports Phantom only at the wallet UX/integration layer
 * (see docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1).
 *
 * This helper answers exactly one question: "is a Phantom Solana
 * provider injected in this browser?"
 *
 * It is a UX GATE ONLY and is NEVER protocol authority:
 * - creator identity is still established by the server through SIWS;
 * - the AETERNA $1 payment is still verified server-side;
 * - Creator Credit authority is unchanged.
 *
 * The primary check deliberately uses `window.phantom.solana` instead of
 * the generic `window.solana` namespace, because another injected wallet
 * may claim `window.solana`.
 *
 * Availability is NOT account state: a provider may be present while the
 * wallet is locked or has no active account. In that case the existing
 * connect flow is used unchanged — this helper never reports account,
 * balance, or entitlement state.
 */

/**
 * Official Phantom installation page.
 *
 * UI/integration only. No referral parameter is included and none is
 * invented; a referral link may be configured separately at a later time
 * without touching protocol, payment, identity, or Irys code.
 */
export const PHANTOM_INSTALL_URL = "https://phantom.com/download";

export const PHANTOM_REQUIRED_TITLE = "Phantom Wallet Required";

export const PHANTOM_REQUIRED_BODY =
  "Install Phantom to create an AETERNA capsule.";

/**
 * Returns true when a Phantom Solana provider is injected.
 *
 * Fail-closed: any missing/malformed shape returns false, so an
 * unrecognised environment is treated as "Phantom not available".
 */
export function isPhantomAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const phantom = window.phantom;

  if (!phantom || typeof phantom !== "object") {
    return false;
  }

  const provider = phantom.solana;

  return Boolean(provider) && typeof provider === "object";
}
