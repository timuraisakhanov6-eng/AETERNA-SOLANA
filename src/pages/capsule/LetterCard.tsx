/**
 * =========================================================
 * AETERNA — Letter Preview & Reader
 * =========================================================
 *
 * Presentation-only card for a text item inside an OPENED
 * capsule. The card exists so text content reads as a personal
 * letter rather than as a loose line that is hard to tell
 * apart from a media caption.
 *
 * Boundaries (kept deliberate):
 *
 *  • The stored text is NEVER mutated. The preview is a CSS
 *    clamp over the real string — the full string stays in the
 *    DOM, unobscured and unmodified, so no data is fabricated
 *    and nothing is truncated on disk.
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
 *
 * Visual language: AETERNA's restrained dark surfaces and the
 * warm amber accent (hsl `--accent`), with the readable "paper
 * letter" typography used by the creation-side letter modal.
 */

import { useId, useRef, useState } from "react";
import { Mail } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

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
 * Letter preview card
 * ------------------------------------------------------------------ */

export function LetterCard({
  content,
}: {
  content: string;
}) {
  const [isReading, setIsReading] = useState(false);
  const titleId = useId();

  /**
   * Whether the preview is visually truncated. The text is always
   * rendered in full — the clamp is purely a visual bound, so a
   * screen reader still reads the entire letter from the card and
   * the underlying data is never altered.
   */
  const isLong = splitParagraphs(content).length > 1 ||
    content.length > 220;

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
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Full letter reader
 * ------------------------------------------------------------------ */

function LetterReader({
  content,
  isOpen,
  onClose,
  titleId,
}: {
  content: string;
  isOpen: boolean;
  onClose: () => void;
  titleId: string;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const paragraphs = splitParagraphs(content);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent
        aria-labelledby={titleId}
        className={[
          // Mobile: anchored to the bottom edge, safe-area aware,
          // full width with no radius (it is flush with the screen edge).
          "inset-x-0 bottom-0 top-auto w-full max-w-none",
          "translate-x-0 translate-y-0 rounded-none",
          // Desktop: centred, width-limited so long lines stay readable.
          "sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto",
          "sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2",
          "sm:rounded-2xl",
        ].join(" ")}
      >
        <div className="flex items-center gap-2.5 pr-10">
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
            className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
          >
            Letter
          </DialogTitle>
        </div>

        {/* Scrollable body — a long letter scrolls inside the panel */}
        <div
          ref={bodyRef}
          className="max-h-[60vh] overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] pr-1 sm:max-h-[65vh]"
        >
          <div className="space-y-5 font-serif text-[15px] leading-[1.8] text-foreground/90">
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
      </DialogContent>
    </Dialog>
  );
}

export default LetterCard;
