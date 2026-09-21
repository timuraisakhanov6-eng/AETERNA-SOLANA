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

import {
  CoreHelperUtil,
  MobileWalletUtil,
  type WalletItem,
} from "@reown/appkit-controllers";
import type { AppKit } from "@reown/appkit/react";

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
 * Mobile copy. On mobile, Phantom connects through its own in-app browser
 * rather than an injected provider, so the action is "open", not "install".
 */
export const PHANTOM_MOBILE_TITLE = "Open AETERNA in Phantom";

export const PHANTOM_MOBILE_BODY =
  "On mobile, Phantom connects through the Phantom app.";

export const PHANTOM_MOBILE_OPEN_LABEL = "Open in Phantom";

/** Thrown when no injected Phantom wallet is available to connect. */
export const PHANTOM_NOT_AVAILABLE = "PHANTOM_NOT_AVAILABLE";

/**
 * WalletConnect explorer id for Phantom, from the installed AppKit registry
 * (PresetsUtil.ConnectorExplorerIds). An injected Wallet Standard wallet is
 * registered with this id when its name resolves to "Phantom".
 */
export const PHANTOM_EXPLORER_ID =
  "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393";

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

/**
 * Selects the injected Phantom entry from an AppKit headless wallet list.
 *
 * Pure and side-effect free so it can be unit tested without AppKit.
 * Only injected wallets are considered — announced/explorer (WalletConnect)
 * entries are never eligible, which is what keeps the Model 01 connection
 * surface Phantom-only.
 */
export function findPhantomWalletItem(
  wallets: readonly WalletItem[] | undefined
): WalletItem | null {
  if (!Array.isArray(wallets)) {
    return null;
  }

  for (const wallet of wallets) {
    if (!wallet || wallet.isInjected !== true) {
      continue;
    }

    const idMatches =
      wallet.id === PHANTOM_EXPLORER_ID || wallet.id === "Phantom";

    const nameMatches =
      typeof wallet.name === "string" &&
      wallet.name.trim().toLowerCase() === "phantom";

    if (idMatches || nameMatches) {
      return wallet;
    }
  }

  return null;
}

/**
 * Connects Phantom WITHOUT opening the AppKit modal.
 *
 * Uses AppKit's supported headless path:
 * `appKit.getWalletList()` (injected wallets are already present, no
 * explorer fetch required) → `appKit.connectWallet(item, 'solana')`, which
 * for an injected wallet calls the internal `connectExternal` — no modal,
 * no WalletConnect entry, no QR.
 *
 * The account and provider it produces are the same AppKit state the
 * AeternaWallet context already consumes (`useAppKitAccount`,
 * `useAppKitProvider`), so SIWS, payment, Irys and account binding are
 * unchanged.
 *
 * Fail-closed: throws PHANTOM_NOT_AVAILABLE instead of falling back to the
 * modal, so a missing Phantom can never degrade into a generic wallet flow.
 */
export async function connectPhantomHeadless(appKit: AppKit): Promise<void> {
  const phantom = findPhantomWalletItem(appKit.getWalletList().wallets);

  if (!phantom) {
    throw new Error(PHANTOM_NOT_AVAILABLE);
  }

  await appKit.connectWallet(phantom, "solana");
}

/**
 * True on mobile browsers.
 *
 * Uses AppKit's own public detector (`CoreHelperUtil.isMobile()`) instead of
 * a hand-rolled user-agent parser.
 */
export function isMobileBrowser(): boolean {
  try {
    return CoreHelperUtil.isMobile();
  } catch {
    return false;
  }
}

/**
 * Opens AETERNA inside Phantom's in-app browser on mobile.
 *
 * Phantom does NOT inject `window.phantom` into mobile Safari/Chrome — it
 * connects dApps through its in-app browser. AppKit ships the official
 * mechanism for this in `MobileWalletUtil`: Phantom is registered as a
 * "custom deeplink" wallet that uses Universal Links (iOS) / an Android
 * intent, because (per AppKit's own source) *"Phantom doesn't support
 * WalletConnect, uses Universal Links for all supported chains"*.
 *
 * This delegates to that installed public utility — no deep-link or
 * intent URL is constructed by AETERNA. It performs a top-level
 * navigation only; no wallet connection, SIWS, quote or payment happens
 * here.
 */
export function openAeternaInPhantomMobile(): void {
  MobileWalletUtil.handleMobileDeeplinkRedirect(PHANTOM_EXPLORER_ID, "solana");
}
