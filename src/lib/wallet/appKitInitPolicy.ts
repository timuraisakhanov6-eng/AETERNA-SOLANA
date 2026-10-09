/**
 * AETERNA — AppKit eager-initialization policy
 *
 * Security rationale
 * ------------------
 * Reown AppKit sends an `INITIALIZE` telemetry event on construction
 * (`AppKit.initialize()` -> `sendInitializeEvent()`). That event is
 * MANDATORY (it is emitted even when `features.analytics === false`) and
 * its payload carries `url: window.location.href`.
 *
 * Capsule capability links keep the capability in the URL fragment
 * (`/capsule/:capsuleId#<capability>`), and the SPA never strips it. So an
 * EAGER AppKit construction on a capsule-open route would place the
 * capability fragment into a third-party telemetry payload.
 *
 * This module is the single decision point that tells the wallet provider
 * when eager construction must be deferred. Deferring does NOT disable the
 * wallet: the connect flow still builds AppKit lazily through
 * `ensureReownAppKitInstance()` when the user actually connects.
 *
 * Coverage rule (intentionally NOT format-based)
 * ---------------------------------------------
 * The policy keys off the ROUTE and the PRESENCE of a capability-bearing
 * fragment, never off a specific 64-hex shape. This guarantees coverage of
 * every supported recipient and creator capability URL form, now and later.
 */

/**
 * Capsule-open route prefix. `/capsule/:capsuleId` is the recipient runtime
 * entry boundary (`src/App.tsx`). `/capsule/preview` is the creator-side
 * pre-seal staging route and carries no capability, so it is explicitly
 * excluded from the route-based rule.
 */
const CAPSULE_OPEN_PREFIX = "/capsule/";

const CAPSULE_PREVIEW_PATH = "/capsule/preview";

/**
 * Path helper: is this the recipient capsule-OPEN route?
 *
 * True for `/capsule/<capsuleId>` (any non-empty id), false for
 * `/capsule/preview` and for every non-capsule path.
 */
export function isCapsuleOpenPath(pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname) {
    return false;
  }

  // Normalize a trailing slash so `/capsule/abc/` still matches.
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  if (normalized === CAPSULE_PREVIEW_PATH) {
    return false;
  }

  return normalized.startsWith(CAPSULE_OPEN_PREFIX) &&
    normalized.length > CAPSULE_OPEN_PREFIX.length;
}

/**
 * Fragment helper: does the URL fragment carry a capability?
 *
 * Presence-based on purpose: any non-empty fragment on a capsule URL is
 * treated as capability-bearing. We do NOT validate a 64-hex shape here —
 * an unknown/new capability form must also be protected.
 */
export function hasCapabilityFragment(hash: string): boolean {
  if (typeof hash !== "string") {
    return false;
  }
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  return fragment.length > 0;
}

/**
 * The single policy entry point.
 *
 * Returns true when the wallet provider MUST NOT eagerly construct AppKit
 * for the current location.
 *
 * Deferral applies when EITHER:
 *  - the path is the capsule-open route (`/capsule/:capsuleId`), or
 *  - the URL carries any capability-bearing fragment (covers recipient and
 *    creator capability links on any path).
 *
 * In all other cases eager initialization proceeds exactly as before.
 */
export function shouldDeferAppKitInitialization(
  pathname: string,
  hash: string
): boolean {
  return isCapsuleOpenPath(pathname) || hasCapabilityFragment(hash);
}
