import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import {
  protocolReturnState,
} from "@/lib/navigation/protocolReturn";

/**
 * AETERNA - Creator Presence compact links (R9-A52).
 *
 * R9-A51 rendered long explanatory blocks in two places. R9-A52 replaces
 * both with a single, understated gold link that opens the canonical
 * Protocol section. Creator Presence is part of EVERY capsule, so the link
 * is unconditional in both locations - there is no enable/disable state
 * and no presence-gated rendering anywhere.
 *
 * Presentation only: copy, layout and a Router link. No lifecycle, timing,
 * storage, wallet, payment, identity or network work, and no data access.
 *
 * Both links also carry the R9-A57 return context, derived from the surface
 * they live on - never from the current URL:
 *
 *   calendar  -> Protocol returns to /create (the creation flow)
 *   recipient -> Protocol returns by browser history, restoring the exact
 *                capsule entry and its `#fragment` without this module ever
 *                reading or copying the secret
 *
 * Both links share one component and one class set, so wording, destination
 * and styling can never drift apart:
 *
 *   calendar modal  -> "Learn how the Confirm Presence button works ->"
 *   recipient card  -> "Why can the opening date change? ->"
 */

/**
 * Canonical Protocol destination for the Opening & Presence section.
 *
 * Protocol.tsx selects its sections through the `section` query parameter
 * (it does not read a URL fragment), so this is the only deep link that
 * actually lands on the section.
 */
export const CREATOR_PRESENCE_PROTOCOL_HREF =
  "/protocol?section=opening-presence";

/** Calendar-modal link label (exact approved wording). */
export const CREATOR_PRESENCE_CALENDAR_LABEL =
  "Learn how the Confirm Presence button works →";

/** Recipient-page link label (exact approved wording). */
export const CREATOR_PRESENCE_RECIPIENT_LABEL =
  "Why can the opening date change? →";

type PresenceLinkProps = {

  /** Exact approved label for the location. */
  label: string;

  /**
   * Location marker. Purely diagnostic (tests, dev tools); it carries no
   * behaviour.
   */
  location: "calendar" | "recipient";

  className?: string;
};

/**
 * The single Creator Presence link used by both surfaces.
 *
 * Styling contract: small, understated, gold, underlined, brighter on
 * hover, and theme-aware (amber-700 on the light modal/page, amber-300 on
 * the dark theme) so it stays legible in both themes. Same-tab Router
 * link: it always navigates inside the current tab.
 */
export function CreatorPresenceLink({
  label,
  location,
  className,
}: PresenceLinkProps) {

  return (
    <Link
      to={{
        pathname: "/protocol",
        search: "?section=opening-presence",
      }}
      state={
        protocolReturnState(
          location === "calendar" ? "create" : "capsule"
        )
      }
      data-aeterna-presence-link={location}
      className={cn(
        "inline-flex items-center gap-1",
        "rounded-sm",
        "text-[11px]",
        "font-medium",
        "tracking-wide",
        "text-amber-700",
        "underline",
        "decoration-amber-500/50",
        "decoration-1",
        "underline-offset-[3px]",
        "transition-colors",
        "hover:text-amber-600",
        "hover:decoration-amber-500",
        "dark:text-amber-300",
        "dark:decoration-amber-400/50",
        "dark:hover:text-amber-200",
        "dark:hover:decoration-amber-300",
        "focus-visible:outline-none",
        "focus-visible:ring-1",
        "focus-visible:ring-amber-500/70",
        "focus-visible:ring-offset-1",
        "focus-visible:ring-offset-background",
        className,
      )}
    >
      {label}
    </Link>
  );
}
