import { useEffect } from "react";

/**
 * AETERNA - application-mounted signal (R9-A65).
 *
 * The boot supervisor in `public/boot-recovery.js` must distinguish
 *
 *   - the entry module finishing (the legacy `aeterna:ready` event, which
 *     fires at the end of `main.tsx` BEFORE React has committed anything),
 *   - the application actually mounting.
 *
 * Only the second one proves the app is usable. This component dispatches
 * `aeterna:mounted` from a passive effect, which React runs after the first
 * successful commit of the whole tree: if any provider or route throws during
 * the initial render, no commit happens and the event is never sent.
 *
 * It is rendered as the first child of the router, OUTSIDE the providers, so
 * a provider failure prevents the signal instead of masking it.
 *
 * Renders nothing; adds no DOM, no styling and no network activity.
 */
export default function AppMountedSignal() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.dispatchEvent(new Event("aeterna:mounted"));
  }, []);

  return null;
}