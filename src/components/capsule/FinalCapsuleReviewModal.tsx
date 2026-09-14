import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* ================= CANONICAL UTC PRESENTATION ================= */

// Same convention as CapsuleView.tsx formatUTCDate: the unlock value is
// a canonical UTC timestamp (normalizeOpenAt pins 12:00 UTC), so the
// review presents that exact value in UTC — never a second date.
const formatUTCDate = (ts: number) => {
  if (!Number.isFinite(ts)) return "Invalid date";
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
};

/* ================= PROPS ================= */

export interface FinalCapsuleReviewModalProps {
  /** True only while storageReview (the canonical server quote) exists AND the creator hasn't closed the dialog. */
  open: boolean;

  /**
   * The canonical storage review record populated by
   * enterStorageReviewForPrepared. Deliberately carries ONLY
   * displayAmountUSDC for presentation — the transaction amount
   * (expectedAmountAtomic) never enters this component, so the review
   * cannot recalculate, round, or reconstruct the price.
   */
  storageReview: {
    displayAmountUSDC: string;
    storageSizeBytes: number;
  } | null;

  description: string | null;

  unlockAt: number | null;

  walletMismatch: boolean;

  sealError: string | null;

  /** sealPhase === "preparing" — quote fetch or payment in progress. */
  isPreparing: boolean;

  /** The existing storage payment handler (handleConfirmStoragePayment), passed verbatim. */
  onConfirm: () => void;

  /**
   * Radix open-state change (X / Escape / overlay / Cancel). Only hides
   * the dialog — clearing storageReview or the prepared identity is
   * NEVER a close concern.
   */
  onOpenChange: (open: boolean) => void;
}

interface FinalCapsuleReviewContentProps {
  storageReview: NonNullable<FinalCapsuleReviewModalProps["storageReview"]>;
  description: string | null;
  unlockAt: number | null;
  walletMismatch: boolean;
  sealError: string | null;
  isPreparing: boolean;
  onConfirm: () => void;
  /** Request a close (Cancel button). X / Escape / overlay go through Dialog onOpenChange. */
  onClose: () => void;
}

/* ================= REVIEW CONTENT ================= */

/**
 * Radix-context-free review content (rows + actions only). Split from
 * the Dialog wrapper so the review contract is testable in the node
 * environment (this repo's jsdom cannot load on the current runtime);
 * the accessible title lives in the Dialog wrapper below.
 */
export function FinalCapsuleReviewContent({
  storageReview,
  description,
  unlockAt,
  walletMismatch,
  sealError,
  isPreparing,
  onConfirm,
  onClose,
}: FinalCapsuleReviewContentProps) {
  return (
    <>
      <div className="space-y-2">
        {typeof description === "string" && description.length > 0 && (
          <p className="text-sm">
            <span className="text-muted-foreground">Description:</span>{" "}
            {description}
          </p>
        )}
        {typeof unlockAt === "number" && (
          <p className="text-sm">
            <span className="text-muted-foreground">Unlock date (UTC):</span>{" "}
            {formatUTCDate(unlockAt)}
          </p>
        )}
        <p className="text-sm">
          <span className="text-muted-foreground">Final storage size:</span>{" "}
          {(storageReview.storageSizeBytes / 1024).toFixed(1)} KB
        </p>
        <p className="text-sm">
          <span className="text-muted-foreground">Irys storage price:</span>{" "}
          ${storageReview.displayAmountUSDC} USDC (set by Irys)
        </p>
        {walletMismatch && (
          <p className="text-sm text-destructive">
            Reconnect the same wallet used for the $1 payment to continue.
          </p>
        )}
        {sealError && (
          <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500 animate-in fade-in zoom-in-95">
            {sealError}
          </div>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <Button
          variant="outline"
          disabled={isPreparing}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          disabled={isPreparing || walletMismatch}
          onClick={onConfirm}
          className={[
            "min-h-12 whitespace-normal font-display tracking-widest transition-all active:scale-[0.98]",
            isPreparing || walletMismatch
              ? "bg-muted text-muted-foreground cursor-not-allowed"
              : "bg-emerald-600 hover:bg-emerald-500 text-white",
          ].join(" ")}
        >
          {isPreparing ? (
            <span className="flex items-center gap-2">
              <Loader2 className="animate-spin" size={20} />
              PREPARING VAULT...
            </span>
          ) : (
            "Create Capsule"
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

/* ================= COMPONENT ================= */

/**
 * AETERNA — Final Capsule Review (Phase B storage review dialog).
 *
 * Rendered only after a successful canonical Irys quote
 * (storageReview !== null): the price shown is the server quote's
 * displayAmountUSDC verbatim, and confirm invokes the existing storage
 * payment handler — the wallet transaction amount remains
 * storageReview.expectedAmountAtomic (outside this component, verbatim,
 * per the FUND-ONLY spec). No blockchain, reserve, finalize or
 * publication happens before the explicit confirm.
 */
export default function FinalCapsuleReviewModal({
  open,
  storageReview,
  onConfirm,
  onOpenChange,
  ...content
}: FinalCapsuleReviewModalProps) {
  if (!storageReview) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] gap-5">
        <DialogHeader className="space-y-2 text-center sm:text-center">
          <DialogTitle className="font-display tracking-wide uppercase text-base">
            Review capsule before storage payment
          </DialogTitle>
          <DialogDescription>
            Confirm the capsule details — the wallet transaction will use
            the exact Irys price shown here.
          </DialogDescription>
        </DialogHeader>

        <FinalCapsuleReviewContent
          storageReview={storageReview}
          onConfirm={onConfirm}
          onClose={() => onOpenChange(false)}
          {...content}
        />
      </DialogContent>
    </Dialog>
  );
}
