/**
 * AETERNA — approved circular brand mark (R9-A83).
 *
 * One shared presentation of the approved artwork
 * (`public/assets/aeterna-brand-mark.png`): gold "A" with an integrated
 * keyhole, a thin luminous blue ring, a dark navy disc and transparent
 * corners outside the circular badge.
 *
 * Replaces the old small vertical capsule emblem on every surface that
 * carried it (Home, the recipient capsule view, Emergency Runtime).
 * Purely presentational: no state, no handlers, no dependencies.
 *
 * The asset is referenced through a root-relative public URL so the same
 * file resolves on the Home route, on nested capsule routes and from
 * /emergency.html.
 */

const BRAND_MARK_SRC = "/assets/aeterna-brand-mark.png";

interface BrandMarkProps {
  /** Sizing classes from the caller; the artwork scales as one square. */
  className?: string;
}

export const BrandMark = ({ className = "" }: BrandMarkProps) => (
  <img
    src={BRAND_MARK_SRC}
    alt="AETERNA"
    width={512}
    height={512}
    draggable={false}
    className={
      className === ""
        ? "select-none object-contain"
        : `select-none object-contain ${className}`
    }
  />
);