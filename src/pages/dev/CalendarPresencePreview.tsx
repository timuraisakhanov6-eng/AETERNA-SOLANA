import { useState } from "react";

import { DateTimePicker, normalizeOpenAt } from "@/components/capsule/DateTimePicker";
import CapsuleView from "@/pages/capsule/CapsuleView";
import { resolveConfirmAvailability } from "@/lib/heartbeat/confirmAvailability";

import type { OpenAtUtc } from "@/types/manifest";

/**
 * AETERNA - Creator Presence local visual preview (R9-A54). DEV ONLY.
 *
 * WHY THIS EXISTS
 * The calendar modal and the capsule card are otherwise reachable only
 * through a paid creation flow (calendar) or a sealed capsule (card). The
 * owner needs to inspect both surfaces locally, without payment.
 *
 * HARD BOUNDARIES
 *  - MOCK DATA ONLY. Nothing here reads or writes protocol state.
 *  - No wallet connection, no payment/quote request, no Creator Credit
 *    purchase, no identity verification, no Irys funding, no upload or
 *    publication, no capsule sealing, no production API or write endpoint.
 *  - The REAL components and the REAL availability rule are reused:
 *    DateTimePicker / DateTimePickerModal (the creation calendar),
 *    CapsuleView (the capsule card) and resolveConfirmAvailability (the
 *    same function the production card uses).
 *  - The route is registered only under `import.meta.env.DEV` in App.tsx
 *    (dynamic import), so production builds contain neither the route nor
 *    this module.
 *
 * CREATOR PRESENCE IS PART OF EVERY CAPSULE
 * No enable/disable switch and no Presence-disabled state exist. All six
 * states use a 90-day interval - the case where the 30-day window matters -
 * and differ only by how far away the effective opening moment is:
 *
 *   1  90 days -> disabled, Available in 60 days
 *   2  89 days -> disabled, Available in 59 days
 *   3  60 days -> disabled, Available in 30 days
 *   4  31 days -> disabled, Available in 1 day
 *   5  30 days -> enabled, Confirm Presence
 *   6   5 days -> enabled, Confirm Presence
 *
 * `mockNowMs` stands in for the trusted instant the production controller
 * obtains from /api/time; it is passed through the same function, so what is
 * rendered here is the production rule, not a copy of it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 64 lowercase hex - shape-valid, never resolved, never fetched. */
const MOCK_CAPSULE_ID = "a5".repeat(32);

const MOCK_TITLE = "For the ones who open this later";

/** Every preview state uses this sealed interval (longer than 30 days). */
const MOCK_INTERVAL_DAYS = 90;

const noop = (): void => {
  /* preview only: no clipboard, no print, no navigation */
};

/**
 * Visual specimen handler for the creator card. The card is rendered inert
 * (pointer-events disabled), so this is never invoked; it performs no I/O
 * and no confirmation.
 */
const previewConfirmPresence = async (): Promise<"rejected"> => "rejected";

type PreviewStateKey =
  | "days-90"
  | "days-89"
  | "days-60"
  | "days-31"
  | "days-30"
  | "days-5";

type PreviewStateDef = {
  key: PreviewStateKey;
  label: string;
  remainingDays: number;
};

const PREVIEW_STATES: ReadonlyArray<PreviewStateDef> = [
  { key: "days-90", label: "1 - 90 days left", remainingDays: 90 },
  { key: "days-89", label: "2 - 89 days left", remainingDays: 89 },
  { key: "days-60", label: "3 - 60 days left", remainingDays: 60 },
  { key: "days-31", label: "4 - 31 days left", remainingDays: 31 },
  { key: "days-30", label: "5 - 30 days left", remainingDays: 30 },
  { key: "days-5", label: "6 - 5 days left", remainingDays: 5 },
];

/** Today at 12:00 UTC - the canonical opening instant, used as mock now. */
function todayNoonUtcMs(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    12,
    0,
    0,
    0
  );
}

/** Exactly the label the production button renders. */
function buttonLabelFor(
  availability: ReturnType<typeof resolveConfirmAvailability>
): string {

  if (
    availability.awaitingWindow &&
    availability.waitDays !== null
  ) {
    return `AVAILABLE IN ${availability.waitDays} ${
      availability.waitDays === 1 ? "DAY" : "DAYS"
    }`;
  }

  if (availability.unknown) {
    return "CHECKING AVAILABILITY…";
  }

  return "CONFIRM PRESENCE";
}

export default function CalendarPresencePreview() {

  const [mock] = useState<{ nowMs: number }>(() => ({
    nowMs: todayNoonUtcMs(),
  }));

  const [activeKey, setActiveKey] =
    useState<PreviewStateKey>("days-90");

  const [openAt, setOpenAt] =
    useState<number>(() => mock.nowMs + 90 * DAY_MS);

  const [mockShareUrl] =
    useState<string>(() =>
      typeof window === "undefined"
        ? ""
        : `${window.location.origin}/capsule/${MOCK_CAPSULE_ID}#preview-fragment`
    );

  const [mockCreatorShareUrl] =
    useState<string>(() =>
      typeof window === "undefined"
        ? ""
        : `${window.location.origin}/capsule/${MOCK_CAPSULE_ID}#preview-fragment&c=preview-authority`
    );

  const active =
    PREVIEW_STATES.find((state) => state.key === activeKey) ??
    PREVIEW_STATES[0];

  if (!active) {
    return null;
  }

  const selectState = (next: PreviewStateDef): void => {
    setActiveKey(next.key);
    setOpenAt(mock.nowMs + next.remainingDays * DAY_MS);
  };

  /**
   * Defence in depth: App.tsx registers this route only under
   * `import.meta.env.DEV`, so the module is not even emitted in a
   * production build. If a bundle somehow reached it anyway, it renders
   * nothing.
   */
  if (!import.meta.env.DEV) {
    return null;
  }

  const availability =
    resolveConfirmAvailability({
      heartbeatInterval: MOCK_INTERVAL_DAYS * DAY_MS,
      effectiveOpenAt: openAt,
      trustedNowMs: mock.nowMs,
    });

  const buttonLabel =
    buttonLabelFor(availability);

  const remainingDaysNow = Math.max(
    0,
    Math.round((openAt - mock.nowMs) / DAY_MS)
  );

  const availabilityKind =
    availability.awaitingWindow
      ? "awaiting-window"
      : availability.unknown
        ? "unknown"
        : "available";

  const creatorSpecimen = (
    <div className="rounded-2xl border border-amber-500/20 bg-card/20 px-2 py-4">
      <p className="px-3 pb-2 text-center text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground/70">
        Creator card (inert specimen)
      </p>
      <div className="pointer-events-none select-none">
        <CapsuleView
          className="min-h-0 py-4"
          state={{
            status: "preview",
            capsuleId: MOCK_CAPSULE_ID,
            authorityMode: true,
            title: MOCK_TITLE,
            openAt: openAt as OpenAtUtc,
            heartbeatInterval: MOCK_INTERVAL_DAYS * DAY_MS,
            trustedNowMs: mock.nowMs,
            shareUrl: mockShareUrl,
            creatorShareUrl: mockCreatorShareUrl,
            onCopyLink: noop,
            onCopyCreatorLink: noop,
            onConfirmPresence: previewConfirmPresence,
            onPrint: noop,
          }}
        />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8">

        <header className="border-b border-border/70 pb-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-600 dark:text-amber-300/80">
            Development only
          </p>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-wide">
            Creator Presence - Local Visual Preview
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Mock data only. This page never connects a wallet, requests a
            payment or quote, purchases Creator Credit, verifies identity,
            funds Irys, uploads, publishes, or seals a capsule. It renders the
            real calendar modal, the real capsule card and the real Confirm
            Presence availability rule, including its countdown.
          </p>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground/70">
            The calendar modal is the real creation-page component: press the
            date control to open it. The route is unavailable in production
            builds.
          </p>
        </header>

        <section className="mt-6" aria-label="Preview states">
          <div
            role="group"
            aria-label="Preview states"
            className="flex flex-wrap gap-2"
          >
            {PREVIEW_STATES.map((state) => {
              const selected = state.key === activeKey;

              return (
                <button
                  key={state.key}
                  type="button"
                  onClick={() => selectState(state)}
                  aria-pressed={selected}
                  data-preview-control={state.key}
                  className={[
                    "rounded-full border px-3.5 py-2 text-[11px] font-medium tracking-wide transition-colors",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/70",
                    selected
                      ? "border-amber-500/70 bg-amber-400/15 text-amber-700 dark:border-amber-400/70 dark:text-amber-200"
                      : "border-border/70 bg-card/40 text-muted-foreground hover:border-amber-500/40 hover:text-foreground",
                  ].join(" ")}
                >
                  {state.label}
                </button>
              );
            })}
          </div>

          <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="font-medium text-foreground/70">Sealed interval</dt>
              <dd>{MOCK_INTERVAL_DAYS} days</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium text-foreground/70">
                Effective opening in
              </dt>
              <dd>{remainingDaysNow} days</dd>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <dt className="font-medium text-foreground/70">
                Confirm Presence
              </dt>
              <dd data-preview-availability={availabilityKind}>
                <span data-preview-button-label>{buttonLabel}</span>
                {availability.awaitingWindow ? " (disabled)" : " (enabled)"}
              </dd>
            </div>
          </dl>

          <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            The mock trusted instant is today at 12:00 UTC. In production the
            same rule runs on the trusted instant the capsule controller
            already fetches from /api/time - never on the device clock. Days
            are rounded up, so the button can never appear available early.
          </p>
        </section>

        <section
          className="mt-6"
          data-preview-state={active.key}
          aria-label="Preview surface"
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div className="rounded-2xl border border-amber-500/20 bg-card/30 px-5 py-8 sm:px-8">
              <DateTimePicker
                date={new Date(openAt)}
                time="12:00"
                onDateChange={(date) => setOpenAt(normalizeOpenAt(date))}
              />
              <p className="mt-6 text-center text-[11px] font-mono text-muted-foreground/70">
                opening date: {remainingDaysNow} days from the mock trusted now
              </p>
            </div>
            {creatorSpecimen}
          </div>
        </section>

        <footer className="mt-10 border-t border-border/70 pt-4">
          <p className="text-[11px] text-muted-foreground/70">
            AETERNA - Creator Presence preview (R9-A54). Local verification
            only; never deployed.
          </p>
        </footer>

      </main>
    </div>
  );
}
