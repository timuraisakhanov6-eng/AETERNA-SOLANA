/**
 * =========================================================
 * AETERNA — Full-screen image viewer
 * =========================================================
 *
 * Presentation-only overlay for an image that is ALREADY decoded and
 * displayed inside an opened capsule.
 *
 * Boundaries (deliberate):
 *
 *  • It owns NO bytes, NO Blob and NO object URL. `src` is the URL the
 *    item already holds; opening or closing the viewer must never fetch,
 *    decode or copy the image again, and must never revoke the caller's
 *    URL (the caller still displays it inline).
 *  • No storage, no crypto, no capsule or wallet access. Closing cannot
 *    navigate: the capsule URL and its secret fragment are untouched.
 *  • CSS-only full screen (`fixed inset-0`), not the browser Fullscreen
 *    API, so it works on iOS Safari without special permissions.
 *  • Sizing is `object-contain` with `max-h-full max-w-full`: the image
 *    is never cropped, stretched or re-encoded, and its intrinsic
 *    aspect ratio is preserved by the browser.
 *
 * Accessibility: the dialog semantics, focus trap, Escape handling,
 * backdrop dismissal and focus restoration come from Radix `Dialog`,
 * the same primitive the capsule's letter reader uses. A visible close
 * button carries an explicit accessible label.
 */

import type { RefObject } from "react";

import { X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  src: string;
  alt: string;
  onClose: () => void;
  /**
   * The control that opened the viewer. Focus returns here on close.
   *
   * Radix restores focus itself only when the dialog is opened through its
   * own `DialogTrigger`; this viewer is opened imperatively, so the owner
   * supplies the element to restore. Without it, focus would fall back to
   * the document body and a keyboard user would lose their place.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
};

export function ImageViewer({
  src,
  alt,
  onClose,
  returnFocusTo,
}: Props) {

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Radix routes Escape and backdrop dismissal here.
        if (!open) onClose();
      }}
    >
      <DialogContent
        showClose={false}
        // Radix warns when a dialog has no description; this viewer has no
        // prose to describe, so the association is explicitly disabled
        // instead of inventing text.
        aria-describedby={undefined}
        /**
         * This Radix version relies on the focus trap plus `aria-hidden`
         * on outside content instead of emitting `aria-modal`. For a
         * full-viewport modal viewer the attribute is both correct and
         * expected by assistive technology, so it is set explicitly.
         */
        aria-modal="true"
        /**
         * Take over the close-focus step: the dialog was opened without
         * Radix's `DialogTrigger`, so its own restore target is null and
         * the default would drop focus to <body>.
         */
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo?.current) return;
          event.preventDefault();
          returnFocusTo.current.focus();
        }}
        className={[
          // Full viewport, no panel chrome: this is a viewer, not a card.
          "fixed inset-0 z-50 flex h-[100dvh] w-full max-w-none",
          "translate-x-0 translate-y-0",
          "items-center justify-center gap-0 rounded-none border-0 sm:rounded-none",
          /**
           * R9-A88.3 — cancel the panel motion this dialog inherits.
           *
           * `DialogContent` ships `data-[state=open]:animate-in` plus
           * `slide-in-from-*` / `zoom-in-95`; on a full-viewport surface that
           * reads as the whole screen sliding in.
           *
           * The IMPORTANT modifier is required, not cosmetic: both rules are
           * single-class + [data-state] selectors, so they have identical
           * specificity and the later one wins. tailwindcss-animate emits its
           * utilities AFTER Tailwind's core `animation` utilities (measured in
           * the built bundle: `…:animate-none` at byte 67295 vs
           * `…:animate-in` at 69705), so a plain `animate-none` loses the
           * cascade and the panel still flies in. `!animate-none` wins
           * regardless of order.
           *
           * Scoped to this viewer only: the shared Dialog is untouched and
           * every other dialog keeps its motion.
           */
          "data-[state=open]:!animate-none data-[state=closed]:!animate-none",
          "bg-black/95 p-0 shadow-none",
        ].join(" ")}
      >
        {/* Accessible name = the image's own filename/label. */}
        <DialogTitle className="sr-only">
          {alt || "Image"}
        </DialogTitle>

        <div
          data-testid="image-viewer-backdrop"
          /**
           * Backdrop dismissal. The full-viewport layer IS the backdrop, so
           * a click that lands on it (and not on the image inside it) closes
           * the viewer. The target check is what keeps a click on the image
           * itself from closing — no stopPropagation needed on the <img>.
           */
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
          className={[
            "flex h-full w-full items-center justify-center",
            "px-4",
            // Keep the image clear of the close button and of the notch /
            // home indicator on phones. Browsers without `env()` keep the
            // plain padding above.
            "pt-[calc(env(safe-area-inset-top)+4.5rem)]",
            "pb-[calc(env(safe-area-inset-bottom)+1.5rem)]",
          ].join(" ")}
        >
          <img
            src={src}
            alt={alt || "Image"}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
          />
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close image viewer"
          className={[
            "absolute right-4 top-4 z-10 mt-[env(safe-area-inset-top)]",
            "flex h-10 w-10 items-center justify-center rounded-full",
            "border border-white/25 bg-black/60 text-white",
            "transition-colors hover:bg-black/80",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black",
          ].join(" ")}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </DialogContent>
    </Dialog>
  );
}

export default ImageViewer;
