/**
 * =========================================================
 * AETERNA — Capsule content summary
 * =========================================================
 *
 * R9-A90.1 — a compact, derived overview rendered above the opened
 * capsule's collapsed file cards.
 *
 * Presentation only:
 *
 *  • The counts come from `summarizeCapsuleContents`, a pure fold over
 *    the Vault descriptors this renderer already has.
 *  • Zero-count categories are hidden; the total is always displayed,
 *    including `0 files` for an empty capsule.
 *  • No letter text, preview, transcript or private metadata is shown.
 *  • `flex-wrap` keeps the category chips inside a narrow mobile
 *    viewport instead of producing horizontal overflow.
 */

import { useId, useMemo } from "react";
import {
  AudioLines,
  File,
  FileArchive,
  Image as ImageIcon,
  Mail,
  Video,
  type LucideIcon,
} from "lucide-react";

import type {
  CapsuleItemV1,
  CapsuleItemV2,
} from "@/types/vault";

import {
  summarizeCapsuleContents,
  type CapsuleContentCategory,
} from "./capsuleContents";

const CATEGORY_ICONS: Record<CapsuleContentCategory, LucideIcon> = {
  photos: ImageIcon,
  videos: Video,
  letters: Mail,
  audio: AudioLines,
  zip: FileArchive,
  other: File,
};

export function CapsuleContentsSummary({
  items,
}: {
  items:
    | readonly (CapsuleItemV1 | CapsuleItemV2)[]
    | null
    | undefined;
}) {
  const headingId = useId();

  /**
   * Memoised on the descriptor list identity. Opening/closing a viewer
   * or switching a card never changes `items`, so the counts remain
   * stable; a replaced list recomputes immediately.
   */
  const summary = useMemo(
    () => summarizeCapsuleContents(items),
    [items],
  );

  const totalLabel =
    `${summary.total} ${summary.total === 1 ? "file" : "files"}`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="capsule-contents-summary"
      className="rounded-2xl border border-border/60 bg-card/40 p-4 shadow-[0_18px_50px_-32px_rgba(0,0,0,0.75)] sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id={headingId}
          className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
        >
          Capsule contents
        </h2>

        <p
          data-testid="capsule-contents-total"
          className="text-lg font-semibold leading-none tracking-tight text-foreground tabular-nums"
        >
          {totalLabel}
        </p>
      </div>

      <ul
        aria-label="Content categories"
        className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2"
      >
        {summary.categories
          .filter((category) => category.count > 0)
          .map((category) => {
            const Icon = CATEGORY_ICONS[category.key];

            return (
              <li
                key={category.key}
                data-category={category.key}
                aria-label={`${category.label}: ${category.count}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-xs"
              >
                <Icon
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-accent"
                  strokeWidth={1.75}
                />
                <span className="text-muted-foreground">
                  {category.label}
                </span>
                <span className="font-semibold text-foreground tabular-nums">
                  {category.count}
                </span>
              </li>
            );
          })}
      </ul>
    </section>
  );
}

export default CapsuleContentsSummary;
