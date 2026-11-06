/**
 * =========================================================
 * AETERNA — Letter Preview, Card & Reader
 * =========================================================
 *
 * Presentation-only card for a text item inside an OPENED
 * capsule. The card exists so text content reads as a personal
 * letter rather than as a loose line that is hard to tell
 * apart from a media caption.
 *
 * R9-A90.1 adds a `compact` variant used by the opened-capsule
 * renderer:
 *
 *  • The default variant keeps the older three-line preview.
 *  • The compact variant is a metadata-only document card. It shows
 *    the content-type badge, a neutral label ("Personal letter") and
 *    an explicit `Open letter` action — never the letter body.
 *  • Clicking either variant opens the same dedicated reader.
 *
 * Boundaries (kept deliberate):
 *
 *  • The stored text is NEVER mutated. The reader renders the real
 *    string with its Unicode characters and line breaks intact.
 *  • No letter title is invented. `TextItemV1`/`TextItemV2`
 *    carry only `type` / `text` / `createdAt`; the dialog's
 *    accessible name is the CONTENT-TYPE label ("Letter"), not
 *    a fabricated subject line.
 *  • The decrypted text never leaves the browser — this module
 *    performs no fetch, no upload, no storage access.
 *  • State is local to this component. Opening or closing the
 *    dialog cannot remount a sibling media player, reset its
 *    playback position, or revoke its Object URL, because no
 *    shared state, effect, or ref is touched.
 *  • R9-A90.1 — the reader is a PERMANENTLY WHITE sheet of paper.
 *    The paper's surface and text colours are explicit, fixed
 *    values rather than theme tokens, so changing the application
 *    theme (including while the reader is open) cannot recolour it.
 *
 * Visual language: AETERNA's restrained dark surfaces and the
 * warm amber accent (hsl `--accent`), with the readable "paper
 * letter" typography used by the creation-side letter modal.
 */

import { useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { Mail, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------ *
 * Paragraph handling
 *
 * Paragraphs are split on BLANK lines only; single newlines inside
 * a paragraph are preserved verbatim via `whitespace-pre-wrap`.
 *
 * This is a PRESENTATION split. The original string is never
 * modified — the reader reassembles each paragraph's own text and
 * the caller's string object is left untouched.
 * ------------------------------------------------------------------ */

function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/* ------------------------------------------------------------------ *
 * Letter preview / compact card
 * ------------------------------------------------------------------ */

export function LetterCard({
  content,
  variant = "preview",
}: {
  content: string;
  /**
   * `preview` (default) keeps the historical three-line card used by
   * letter-preview surfaces. `compact` is the R9-A90 opened-capsule
   * card that never renders the letter body.
   */
  variant?: "preview" | "compact";
}) {
  const [isReading, setIsReading] = useState(false);
  const titleId = useId();

  /** The control that opened the reader; focus returns here on close. */
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Whether the preview is visually truncated. The text is always
   * rendered in full — the clamp is purely a visual bound, so a
   * screen reader still reads the entire letter from the card and
   * the underlying data is never altered.
   */
  const isLong = splitParagraphs(content).length > 1 ||
    content.length > 220;

  if (variant === "compact") {
    return (
      <>
        <article className="rounded-2xl border border-border/60 bg-card/40 p-4 shadow-[0_18px_50px_-32px_rgba(0,0,0,0.75)] sm:p-5">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-accent"
            >
              <Mail className="h-4 w-4" strokeWidth={1.75} />
            </span>

            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex shrink-0 items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
                  LETTER
                </span>

                <span className="min-w-0 flex-1 font-medium break-words">
                  Personal letter
                </span>
              </div>

              {/*
                Metadata only. The letter body is deliberately absent
                from the collapsed capsule presentation.
              */}
              <p className="text-xs text-muted-foreground break-words">
                A personal letter, opened in the paper reader.
              </p>
            </div>
          </div>

          <div className="mt-3">
            <Button
              ref={triggerRef}
              type="button"
              onClick={() => setIsReading(true)}
              aria-haspopup="dialog"
              aria-expanded={isReading}
              aria-label="Open letter"
              variant="capsuleOutline"
              size="lg"
              className="h-12 min-h-12 w-full justify-center rounded-lg px-5 text-sm sm:w-auto sm:px-6"
            >
              <Mail aria-hidden="true" className="h-4 w-4" />
              Open letter
            </Button>
          </div>
        </article>

        <LetterReader
          content={content}
          isOpen={isReading}
          onClose={() => setIsReading(false)}
          titleId={titleId}
          returnFocusTo={triggerRef}
        />
      </>
    );
  }

  return (
    <>
      <article className="group relative overflow-hidden rounded-2xl border border-border/60 bg-card/60 shadow-[0_18px_50px_-28px_rgba(0,0,0,0.75)]">

        {/* Content-type marker — a quiet signal, never a loud label */}
        <div className="flex items-center gap-2.5 border-b border-border/40 px-5 py-3 sm:px-6">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-accent"
          >
            <Mail className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>

          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Letter
          </span>
        </div>

        {/*
          The whole card is one activation target: a real <button> for
          pointer, keyboard and assistive-tech parity.
        */}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setIsReading(true)}
          aria-haspopup="dialog"
          aria-expanded={isReading}
          className="block w-full px-5 pb-4 pt-4 text-left transition-colors hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-6 sm:pb-5"
        >
          <p className="sr-only">
            {`Letter, ${content.length} characters. Opens the full letter.`}
          </p>

          {/*
            PREVIEW — three lines, real text, CSS clamp + fade.
            `whitespace-pre-wrap` keeps the author's line breaks, so
            the preview shows the letter's OWN first lines.
          */}
          <div className="relative">
            <p className="whitespace-pre-wrap break-words font-serif text-[15px] leading-[1.75] text-foreground/90 line-clamp-3">
              {content}
            </p>

            {isLong && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card via-card/80 to-transparent"
              />
            )}
          </div>

          <span className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent/90 underline decoration-accent/30 decoration-1 underline-offset-4 transition-colors group-hover:text-accent group-hover:decoration-accent/60">
            Read letter
          </span>
        </button>
      </article>

      <LetterReader
        content={content}
        isOpen={isReading}
        onClose={() => setIsReading(false)}
        titleId={titleId}
        returnFocusTo={triggerRef}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Full letter reader — permanently white paper
 * ------------------------------------------------------------------ */

function LetterReader({
  content,
  isOpen,
  onClose,
  titleId,
  returnFocusTo,
}: {
  content: string;
  isOpen: boolean;
  onClose: () => void;
  titleId: string;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const paragraphs = splitParagraphs(content);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent
        showClose={false}
        aria-labelledby={titleId}
        aria-describedby={undefined}
        /*
         * This Radix version relies on the focus trap plus `aria-hidden`
         * on outside content instead of emitting `aria-modal`. The reader
         * is a true modal sheet, so the attribute is stated explicitly —
         * the same deliberate choice as the image viewer.
         */
        aria-modal="true"
        /**
         * The reader is opened imperatively (there is no DialogTrigger),
         * so Radix's own restore target is null. The owning card's
         * control is supplied explicitly; without it focus would fall
         * back to <body> and a keyboard user would lose their place.
         */
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo?.current) return;
          event.preventDefault();
          returnFocusTo.current.focus();
        }}
        className={[
          // Mobile: anchored to the bottom edge, full width, no radius.
          "inset-x-0 bottom-0 top-auto w-full max-w-none",
          "translate-x-0 translate-y-0 gap-0 rounded-none",
          // The dialog shell is deliberately transparent: the white
          // paper inside is the surface, and the dark page shows around it.
          "border-0 bg-transparent p-0 shadow-none",
          "max-h-[100dvh] overflow-hidden",
          // Desktop: centred and width-limited so long lines stay readable.
          "sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto",
          "sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2",
          "sm:rounded-2xl",
        ].join(" ")}
      >
        <div className="flex max-h-[100dvh] w-full flex-col overflow-hidden sm:max-h-[85dvh]">

          <div className="flex shrink-0 items-center gap-2.5 px-5 pb-3 pr-16 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-6 sm:pt-5">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-accent"
            >
              <Mail className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>

            {/*
              Accessible name = the content-type label. No letter title is
              invented — the vault stores none.
            */}
            <DialogTitle
              id={titleId}
              className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/80"
            >
              Letter
            </DialogTitle>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close letter"
            className={[
              "absolute top-[calc(env(safe-area-inset-top)+1rem)] z-10",
              "right-[calc(env(safe-area-inset-right)+1rem)]",
              "flex h-10 w-10 items-center justify-center rounded-full",
              "border border-white/25 bg-black/60 text-white",
              "transition-colors hover:bg-black/80",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black",
            ].join(" ")}
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>

          {/*
            Scrollable body. The paper surface is an explicit fixed
            white/dark pair — never `bg-background` / `text-foreground` —
            so neither the active theme nor a theme switch while open can
            recolour it. Long letters scroll INSIDE the sheet; the page
            behind does not move.
          */}
          <div className="min-h-0 flex-1 overflow-hidden px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:px-4 sm:pb-4">
            <div
              ref={bodyRef}
              data-testid="letter-paper"
              style={{ backgroundColor: "#ffffff", color: "#111111" }}
              className="max-h-[calc(100dvh-9rem)] overflow-y-auto overscroll-contain rounded-xl border border-black/10 p-5 shadow-[0_24px_70px_-24px_rgba(0,0,0,0.85)] sm:max-h-[70dvh] sm:p-8"
            >
              <div className="space-y-5 font-serif text-[16px] leading-[1.8]">
                {paragraphs.map((paragraph, index) => (
                  <p
                    key={index}
                    className="whitespace-pre-wrap break-words"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default LetterCard;
