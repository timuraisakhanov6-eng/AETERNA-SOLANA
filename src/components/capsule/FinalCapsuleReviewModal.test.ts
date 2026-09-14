/**
 * AETERNA — Final Capsule Review modal regression tests (node env).
 *
 * Scope (Final Capsule Review patch):
 * - the dialog renders ONLY the canonical review fields and the price is
 *   the server quote's displayAmountUSDC verbatim (the component's props
 *   deliberately exclude expectedAmountAtomic, so the review can never
 *   recalculate, round or reconstruct the transaction amount);
 * - the confirm button is wired to the existing storage payment handler
 *   by identity, and payment is reachable ONLY through an explicit
 *   confirm click — never on open, never on close;
 * - Cancel reports a close request only (onOpenChange(false)); the
 *   parent keeps storageReview and the prepared identity (X / Escape /
   * overlay go through the same Dialog onOpenChange wiring, asserted by
 *   identity below);
 * - preparing/wallet-mismatch states preserve the existing spinner and
 *   disabled semantics (duplicate-click protection);
 * - the stale-quote decision point (shouldClearStorageReviewOnVerifyFailure)
 *   drops the review ONLY on STORAGE_QUOTE_EXPIRED.
 *
 * Rendering strategy: this repo's jsdom cannot load on the current
 * runtime (undici 8 needs Node ≥ 22; the runtime is Node 20), so the
 * content component is exercised via react-dom/server static markup and
 * direct element-tree invocation — no DOM, no network, no production
 * calls. Same philosophy as CapsuleBuilderDiscoveryGuard.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import FinalCapsuleReviewModal, {
  FinalCapsuleReviewContent,
} from "@/components/capsule/FinalCapsuleReviewModal";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { shouldClearStorageReviewOnVerifyFailure } from "@/components/capsule/CapsuleBuilder";

// Fixed canonical unlock value (12:00 UTC normalization as produced by
// normalizeOpenAt): 2026-09-20T12:00:00.000Z
const UNLOCK_AT = Date.UTC(2026, 8, 20, 12, 0, 0, 0);

const BASE_REVIEW = {
  displayAmountUSDC: "0.004385",
  storageSizeBytes: 2048,
};

type ModalProps = Parameters<typeof FinalCapsuleReviewModal>[0];

function baseProps(overrides: Partial<ModalProps> = {}): ModalProps {
  return {
    open: true,
    storageReview: BASE_REVIEW,
    description: null,
    unlockAt: UNLOCK_AT,
    walletMismatch: false,
    sealError: null,
    isPreparing: false,
    onConfirm: vi.fn(),
    onOpenChange: vi.fn(),
    ...overrides,
  };
}

function contentProps(modal: ModalProps) {
  return {
    storageReview: modal.storageReview!,
    description: modal.description,
    unlockAt: modal.unlockAt,
    walletMismatch: modal.walletMismatch,
    sealError: modal.sealError,
    isPreparing: modal.isPreparing,
    onConfirm: modal.onConfirm,
    onClose: () => modal.onOpenChange(false),
  };
}

/* ================= tiny element-tree helpers ================= */

function isReactElement(node: unknown): node is ReactElement {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    "props" in node
  );
}

function collectElements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectElements(child, out));
    return out;
  }
  if (isReactElement(node)) {
    out.push(node);
    collectElements(
      (node.props as { children?: ReactNode }).children,
      out
    );
  }
  return out;
}

function findButtons(root: ReactElement): ReactElement[] {
  return collectElements(root).filter((el) => el.type === Button);
}

function markupText(modal: ModalProps): string {
  const html = renderToStaticMarkup(
    createElement(FinalCapsuleReviewContent, contentProps(modal))
  );
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ================= content ================= */

describe("Final Capsule Review content", () => {
  it("1: shows the Description block for a non-empty description", () => {
    const text = markupText(baseProps({ description: "Birthday memories" }));
    expect(text).toContain("Description: Birthday memories");
  });

  it("2: hides the Description block for an empty or absent description", () => {
    for (const description of ["", null]) {
      const text = markupText(baseProps({ description }));
      expect(text).not.toContain("Description:");
      expect(text).toContain("Irys storage price: $0.004385 USDC (set by Irys)");
    }
  });

  it("3: shows the exact unlockAt value with the canonical UTC presentation", () => {
    const text = markupText(baseProps({}));
    // formatUTCDate pins the canonical UTC rendering of the exact state
    // value — no second date is created.
    expect(text).toContain("Unlock date (UTC): Sep 20, 2026");
  });

  it("4: shows the price line verbatim from displayAmountUSDC", () => {
    const text = markupText(baseProps({}));
    expect(text).toContain("Irys storage price: $0.004385 USDC (set by Irys)");
  });

  it("5: never exposes an atomic or derived amount — displayAmountUSDC is the only price", () => {
    const text = markupText(baseProps({}));
    expect(text).toContain("$0.004385 USDC (set by Irys)");
    // No atomic integer representation of the price may appear anywhere.
    expect(text).not.toContain("4385000");
    // Exactly one price sentence exists in the review.
    expect(text.match(/USDC \(set by Irys\)/g)?.length).toBe(1);
    expect(text).not.toContain("expectedAmountAtomic");
  });

  it("6: shows final storage size and the wallet mismatch warning", () => {
    const text = markupText(baseProps({ walletMismatch: true }));
    expect(text).toContain("Final storage size: 2.0 KB");
    expect(text).toContain(
      "Reconnect the same wallet used for the $1 payment to continue."
    );
  });

  it("7: shows the review title, the sealError surface, and renders nothing for a null review", () => {
    const text = markupText(baseProps({ sealError: "Irys storage payment not verified: FAILED" }));
    expect(text).toContain("Irys storage payment not verified: FAILED");

    // The accessible title lives in the Dialog wrapper (Radix context).
    const dialogEl = FinalCapsuleReviewModal(baseProps({})) as ReactElement;
    const title = collectElements(dialogEl).find(
      (el) => el.type === DialogTitle
    );
    expect(title).toBeDefined();
    expect(
      (title!.props as { children?: ReactNode }).children
    ).toBe("Review capsule before storage payment");

    const empty = renderToStaticMarkup(
      createElement(FinalCapsuleReviewModal, baseProps({ storageReview: null }))
    );
    expect(empty).toBe("");
  });
});

/* ================= confirm / cancel wiring ================= */

describe("Final Capsule Review confirm / cancel behavior", () => {
  it("8: the confirm button is the existing payment handler by identity, invoked only on click", () => {
    const props = baseProps({});
    const contentTree = FinalCapsuleReviewContent(
      contentProps(props)
    ) as ReactElement;
    const confirm = findButtons(contentTree).find(
      (el) => (el.props as { children?: ReactNode }).children === "Create Capsule"
    );
    expect(confirm).toBeDefined();
    // Identity wiring: the modal does not wrap, rename or re-route the
    // handler — it IS handleConfirmStoragePayment.
    expect((confirm!.props as { onClick?: unknown }).onClick).toBe(
      props.onConfirm
    );

    // Rendering the review never pays; only an explicit click does.
    expect(props.onConfirm).not.toHaveBeenCalled();
    (confirm!.props as { onClick: () => void }).onClick();
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("9: cancel only requests a close — no payment, no review clearing", () => {
    const props = baseProps({});
    const contentTree = FinalCapsuleReviewContent(
      contentProps(props)
    ) as ReactElement;
    const cancel = findButtons(contentTree).find(
      (el) => (el.props as { children?: ReactNode }).children === "Cancel"
    );
    expect(cancel).toBeDefined();

    (cancel!.props as { onClick: () => void }).onClick();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("10: the Dialog wrapper wires open/onOpenChange/onConfirm verbatim", () => {
    const props = baseProps({});
    const dialogEl = FinalCapsuleReviewModal(props) as ReactElement;
    // The Dialog root receives open and onOpenChange verbatim: Radix
    // reports X / Escape / overlay dismissal through this exact callback.
    expect(dialogEl.props.open).toBe(true);
    expect(dialogEl.props.onOpenChange).toBe(props.onOpenChange);

    // The content inside receives the payment handler verbatim and a
    // close request that resolves to onOpenChange(false).
    const contentEl = collectElements(dialogEl).find(
      (el) => el.type === FinalCapsuleReviewContent
    );
    expect(contentEl).toBeDefined();
    const contentElProps = contentEl!.props as {
      onConfirm?: unknown;
      onClose: () => void;
    };
    expect(contentElProps.onConfirm).toBe(props.onConfirm);
    contentElProps.onClose();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("11: re-opening with the same storageReview renders the identical review", () => {
    const props = baseProps({});
    const first = renderToStaticMarkup(
      createElement(FinalCapsuleReviewContent, contentProps(props))
    );
    const second = renderToStaticMarkup(
      createElement(FinalCapsuleReviewContent, contentProps(props))
    );
    // Same quote in → same review out (no re-quote, no mutation).
    expect(first).toBe(second);
    expect(first).toContain("$0.004385 USDC (set by Irys)");
  });

  it("12: preparing state preserves spinner and duplicate-click protection", () => {
    const props = baseProps({ isPreparing: true });
    const text = markupText(props);
    expect(text).toContain("PREPARING VAULT");
    expect(text).not.toContain("Create Capsule");

    const contentTree = FinalCapsuleReviewContent(
      contentProps(props)
    ) as ReactElement;
    const buttons = findButtons(contentTree);
    const confirm = buttons[buttons.length - 1];
    expect(confirm).toBeDefined();
    expect((confirm!.props as { disabled?: boolean }).disabled).toBe(true);
    // A disabled button cannot fire the payment handler again.
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("13: wallet mismatch disables the confirm button (existing safety UX)", () => {
    const props = baseProps({ walletMismatch: true });
    const contentTree = FinalCapsuleReviewContent(
      contentProps(props)
    ) as ReactElement;
    const confirm = findButtons(contentTree).find(
      (el) => (el.props as { children?: ReactNode }).children === "Create Capsule"
    );
    expect((confirm!.props as { disabled?: boolean }).disabled).toBe(true);
  });
});

/* ================= stale quote hardening ================= */

describe("Stale quote hardening decision point", () => {
  it("14: only STORAGE_QUOTE_EXPIRED drops the review", () => {
    expect(shouldClearStorageReviewOnVerifyFailure("STORAGE_QUOTE_EXPIRED")).toBe(true);
    expect(shouldClearStorageReviewOnVerifyFailure("STORAGE_PAYMENT_NOT_VERIFIED")).toBe(false);
    expect(shouldClearStorageReviewOnVerifyFailure("PAYER_MISMATCH")).toBe(false);
    expect(shouldClearStorageReviewOnVerifyFailure("AMOUNT_MISMATCH")).toBe(false);
    expect(shouldClearStorageReviewOnVerifyFailure("")).toBe(false);
  });
});
