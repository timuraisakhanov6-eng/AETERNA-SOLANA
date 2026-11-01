import { useEffect } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";

import {
  resolveProtocolReturn,
} from "@/lib/navigation/protocolReturn";

import {
  HowItWorksSection,
  OpeningPresenceSection,
} from "./legal/ProtocolDocument";

/**
 * AETERNA — Protocol page (R9-A45).
 *
 * ONE user-facing document with two sections, addressed through a stable
 * `section` query parameter:
 *
 *   /protocol                          → How It Works (default)
 *   /protocol?section=opening-presence → Opening & Presence
 *
 * The bare `/protocol` route keeps working for every existing link and
 * bookmark. The page intentionally has NO creation CTA: only a `<- Back`
 * control.
 *
 * R9-A57 - that control is context-aware. In-app links into the Protocol
 * carry a fixed origin token in navigation state:
 *
 *   home    -> "/"        (Home consent link)
 *   create  -> "/create"  (calendar modal link)
 *   capsule -> history back, so the recipient capsule returns with its
 *              original `#fragment` restored by the browser (the fragment
 *              is never read, copied or rebuilt)
 *
 * Direct visits / missing or malformed state fall back to Home.
 */

type SectionKey = "how-it-works" | "opening-presence";

const SECTIONS: ReadonlyArray<{ key: SectionKey; label: string }> = [
  { key: "how-it-works", label: "How It Works" },
  { key: "opening-presence", label: "Opening & Presence" },
];

const isSectionKey = (value: string | null): value is SectionKey =>
  value === "how-it-works" || value === "opening-presence";

const Protocol = () => {
  const [searchParams] = useSearchParams();

  const location = useLocation();
  const navigate = useNavigate();

  const returnTarget =
    resolveProtocolReturn(location.state);

  const rawSection = searchParams.get("section");
  const section: SectionKey = isSectionKey(rawSection)
    ? rawSection
    : "how-it-works";

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [section]);

  return (
    <div className="relative min-h-screen bg-background text-foreground flex flex-col overflow-hidden">

      <main
        role="main"
        className="relative z-10 w-full max-w-3xl mx-auto px-6 md:px-10 lg:px-12 pt-20 pb-28 flex-1"
      >
        <header className="mb-10">
          <h1 className="font-display text-2xl md:text-3xl font-semibold">
            <span translate="no">AETERNA</span> Protocol
          </h1>
        </header>

        {/*
          Section tabs. Real links (not buttons) so both sections have a
          stable, shareable URL; react-router keeps back/forward working.
        */}
        <nav
          aria-label="Protocol sections"
          className="mb-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border/70"
        >
          {SECTIONS.map((tab) => {
            const active = section === tab.key;
            const target =
              tab.key === "how-it-works"
                ? { pathname: "/protocol", search: "" }
                : { pathname: "/protocol", search: "?section=opening-presence" };

            return (
              <Link
                key={tab.key}
                to={target}
                /* Always replace: switching tabs must not add history entries,
                   otherwise "Back" would step between sections instead of
                   returning to the page the reader came from. The return
                   context rides along on every tab. */
                replace
                state={location.state}
                aria-current={active ? "page" : undefined}
                className={[
                  "-mb-px border-b-2 pb-2 text-sm tracking-wide transition-colors",
                  active
                    ? "border-amber-400/80 text-amber-300"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="text-[15px] leading-[1.85]">
          {section === "how-it-works" && <HowItWorksSection />}
          {section === "opening-presence" && <OpeningPresenceSection />}
        </div>

        <footer className="relative z-20 pt-10 border-t border-border bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              <span translate="no">AETERNA</span> — a cryptographic time capsule
              protocol. Sealed now. Opened later.
            </p>

            {returnTarget.kind === "history" ? (
              <button
                type="button"
                onClick={() => navigate(-1)}
                data-protocol-back="history"
                className="text-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 text-left"
              >
                ← Back
              </button>
            ) : (
              <Link
                to={returnTarget.path}
                data-protocol-back={returnTarget.path}
                className="text-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                ← Back
              </Link>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
};

export default Protocol;
