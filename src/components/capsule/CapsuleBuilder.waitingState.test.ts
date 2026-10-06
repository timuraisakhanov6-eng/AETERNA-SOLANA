/**
 * AETERNA — post-storage-payment waiting surface (UX contract, node env).
 *
 * SCOPE: the EARLIEST safe waiting state after the creator returns from
 * Phantom for the SECOND (storage) payment.
 *
 * GUARANTEE (unchanged): the internal sequence
 *   funding → verifyStoragePaymentWithRetry → reserveLifecycle →
 *   sessionStorage → navigate("/create/hold")
 * is NOT touched. The ONLY change is a PRESENTATION phase set strictly
 * AFTER the funding signature (the wallet-return point) and strictly
 * BEFORE verification: `sealPhase = "awaiting-verification"` renders the
 * "Capsule is being prepared" surface immediately, then every failure
 * path resets to "idle" (existing error surface).
 *
 * Rendering strategy mirrors FinalCapsuleReviewModal.test.ts: this repo's
 * jsdom cannot load on the current runtime (undici 8 needs Node ≥ 22; the
 * runtime is Node 20), so the exported surface component is exercised via
 * react-dom/server static markup and the pure predicates directly — no
 * DOM, no network, no payment, no wallet.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CapsulePreparingSurface,
  showCapsulePreparing,
} from "@/components/capsule/CapsuleBuilder";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER_SRC = readFileSync(resolve(HERE, "CapsuleBuilder.tsx"), "utf8");

function markup(): string {
  return renderToStaticMarkup(createElement(CapsulePreparingSurface))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/* ================= A. before storage payment → old UI ================= */

describe("A. before the storage payment the old UI is shown", () => {
  it("the waiting surface is NOT shown in the idle phase", () => {
    expect(showCapsulePreparing("idle")).toBe(false);
  });

  it("the waiting surface is NOT shown during preparation (pre-Phantom, pre-payment)", () => {
    // "preparing" is entered at the top of handleConfirmStoragePayment, i.e.
    // BEFORE the wallet prompt — the creator is still interacting with
    // Phantom. The waiting surface must not replace that.
    expect(showCapsulePreparing("preparing")).toBe(false);
  });
});

/* ================= B. after Phantom return → waiting appears ================= */

describe("B. immediately after a successful Phantom return the waiting state shows", () => {
  it("the waiting surface IS shown in the awaiting-verification phase", () => {
    expect(showCapsulePreparing("awaiting-verification")).toBe(true);
  });

  it("the surface reports payment confirmed, being-prepared and the do-not-repay guidance", () => {
    const text = markup();
    expect(text).toContain("Payment confirmed");
    expect(text).toContain("Capsule is being prepared");
    expect(text).toContain("Please don't pay again");
    expect(text).toContain("close this window");
  });
});

/* ================= C. sequence unchanged ================= */

describe("C. verify → reserve → sessionStorage → navigate sequence is unchanged", () => {
  it("the waiting phase is set AFTER the funding signature and BEFORE verify", () => {
    const src = BUILDER_SRC;
    const fundIdx = src.indexOf("const { fundingSignature } = await ensureStorageFundingSignature(");
    const phaseIdx = src.indexOf('setSealPhase("awaiting-verification")');
    const verifyIdx = src.indexOf("await verifyStoragePaymentWithRetry(");
    const reserveIdx = src.indexOf("await handleReserveReady(");

    // Every anchor must exist (guards against a silent rename removing the pin).
    expect(fundIdx).toBeGreaterThan(-1);
    expect(phaseIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(reserveIdx).toBeGreaterThan(-1);

    // Ordering: funding → [waiting surface] → verify → reserve.
    expect(phaseIdx).toBeGreaterThan(fundIdx);
    expect(phaseIdx).toBeLessThan(verifyIdx);
    expect(verifyIdx).toBeLessThan(reserveIdx);
  });

  it("the waiting phase is NOT set before the wallet prompt (no pre-wallet waiting screen)", () => {
    // The `setSealPhase("preparing")` that precedes the funding call must
    // NOT be "awaiting-verification" — the wallet is still pending there.
    const preparingIdx = BUILDER_SRC.indexOf('setSealPhase("preparing")');
    const awaitingIdx = BUILDER_SRC.indexOf('setSealPhase("awaiting-verification")');
    expect(preparingIdx).toBeGreaterThan(-1);
    expect(awaitingIdx).toBeGreaterThan(preparingIdx);
  });

  it("navigate('/create/hold') still happens inside handleReserveReady AFTER sessionStorage", () => {
    const storageIdx = BUILDER_SRC.indexOf("sessionStorage.setItem(");
    // Anchor on the CALL (with the following options object), not the
    // mention inside the doc comment near the top of the file.
    const navigateIdx = BUILDER_SRC.indexOf('navigate("/create/hold", {');
    expect(storageIdx).toBeGreaterThan(-1);
    expect(navigateIdx).toBeGreaterThan(storageIdx);
  });
});

/* ================= D. success path unchanged ================= */

describe("D. successful flow to /create/hold is unchanged", () => {
  it("the reserve/hold navigation payload keys are untouched", () => {
    // The waiting surface adds no work to the success path: handleReserveReady
    // still writes the recovery record and navigates with the same state keys.
    expect(BUILDER_SRC).toContain("holdState: structuredClone(prepared)");
    expect(BUILDER_SRC).toContain("canonicalLifecycleId: reserved.lifecycleId");
    expect(BUILDER_SRC).toContain("creatorCreditId: result.creatorCreditId");
    expect(BUILDER_SRC).toContain("storagePaymentId: result.storagePaymentId");
  });

  it("handleReserveReady resets the phase to idle on both terminal paths", () => {
    // On success AND on failure the phase returns to "idle" (so a re-entry
    // never inherits a stuck waiting surface).
    const index = BUILDER_SRC.indexOf("const handleReserveReady = async");
    const end = BUILDER_SRC.indexOf("const remainingChars");
    const block = BUILDER_SRC.slice(index, end);
    const idleCount = block.match(/setSealPhase\("idle"\)/g)?.length ?? 0;
    expect(idleCount).toBeGreaterThanOrEqual(2);
  });
});

/* ================= E. storage verification failure → error UI ================= */

describe("E. a failed storage verification falls back to the error surface", () => {
  it("the verify-failure branch resets the phase to idle and sets sealError", () => {
    const index = BUILDER_SRC.indexOf("if (!verifyOutcome.ok) {");
    const end = BUILDER_SRC.indexOf("await handleReserveReady(");
    const block = BUILDER_SRC.slice(index, end);
    expect(block).toContain('setSealPhase("idle")');
    expect(block).toContain("Irys storage payment not verified:");
    // The waiting surface is a pure function of the phase, so idle ⇒ hidden.
    expect(showCapsulePreparing("idle")).toBe(false);
  });
});

/* ================= F. reserve failure → error UI ================= */

describe("F. a failed lifecycle reservation falls back to the error surface", () => {
  it("handleReserveReady's catch resets the phase to idle and sets sealError", () => {
    const index = BUILDER_SRC.indexOf("const handleReserveReady = async");
    const end = BUILDER_SRC.indexOf("const remainingChars");
    const block = BUILDER_SRC.slice(index, end);
    expect(block).toContain("setSealError(");
    expect(block).toContain('setSealPhase("idle")');
    expect(showCapsulePreparing("idle")).toBe(false);
  });

  it("the outer catch of handleConfirmStoragePayment also resets to idle", () => {
    const index = BUILDER_SRC.indexOf("const handleConfirmStoragePayment = async");
    const end = BUILDER_SRC.indexOf("const canSeal =");
    const block = BUILDER_SRC.slice(index, end);
    // Both the verify-failure return and the catch set idle; the surface
    // therefore never lingers after any failure.
    const idleCount = block.match(/setSealPhase\("idle"\)/g)?.length ?? 0;
    expect(idleCount).toBeGreaterThanOrEqual(2);
  });
});

/* ================= G. reload/resume unchanged ================= */

describe("G. reload/resume behaviour is unchanged", () => {
  it("restorePreparedFromSession and the recovery record are untouched", () => {
    expect(BUILDER_SRC).toContain("restorePreparedFromSession(");
    expect(BUILDER_SRC).toContain("sessionStorage.setItem(");
    expect(BUILDER_SRC).toContain('"aeterna-prepared-capsule"');
  });

  it("a restored session enters the storage review, NOT the waiting surface", () => {
    // Entering the review flow happens with sealPhase "idle"; the waiting
    // surface is only ever entered from inside handleConfirmStoragePayment.
    const restoreIdx = BUILDER_SRC.indexOf("restored !== null");
    expect(restoreIdx).toBeGreaterThan(-1);
    // The restore path routes to enterStorageReviewForPrepared(), which sets
    // sealPhase "idle" — it never sets "awaiting-verification".
    const reviewIdx = BUILDER_SRC.indexOf("const enterStorageReviewForPrepared = async");
    const reviewEnd = BUILDER_SRC.indexOf("const handleFinalCreateClick = async");
    const reviewBlock = BUILDER_SRC.slice(reviewIdx, reviewEnd);
    expect(reviewBlock).not.toContain('"awaiting-verification"');
  });
});

/* ================= H. no second $1 ================= */

describe("H. no second $1 payment is introduced", () => {
  it("the storage payment handler still guards against re-entry and double-funding", () => {
    const index = BUILDER_SRC.indexOf("const handleConfirmStoragePayment = async");
    const end = BUILDER_SRC.indexOf("const canSeal =");
    const block = BUILDER_SRC.slice(index, end);
    // The existing guards are untouched: paid-state + busy gate + funding ledger.
    expect(block).toContain('if (createFlowState !== "paid" || !servicePaymentResult) return;');
    expect(block).toContain('if (sealPhase !== "idle" || sealingRef.current) return;');
    expect(block).toContain("ensureStorageFundingSignature(");
    // No new payment/quote call was added by the waiting surface.
    expect(block).not.toContain("/api/storage/quote");
    expect(block).not.toContain("handleConfirmServicePayment");
  });
});

/* ================= I. no extra wallet prompt ================= */

describe("I. no extra wallet prompt is introduced", () => {
  it("the waiting surface performs no wallet or signature call", () => {
    const surfaceStart = BUILDER_SRC.indexOf("export function CapsulePreparingSurface()");
    const surfaceEnd = BUILDER_SRC.indexOf("/* ================= COMPONENT ================= */", surfaceStart) === -1
      ? BUILDER_SRC.length
      : BUILDER_SRC.indexOf("/* ================= PATCH-2K-B GATE ERROR UX", surfaceStart);
    const block = BUILDER_SRC.slice(
      surfaceStart,
      surfaceEnd > surfaceStart ? surfaceEnd : surfaceStart + 3000
    );
    expect(block).not.toContain("signMessage");
    expect(block).not.toContain("signTransaction");
    expect(block).not.toContain("sendTransaction");
    expect(block).not.toContain("fundCreatorPaidStorage");
    expect(block).not.toContain("toCreatorIrysWallet");
  });

  it("exactly one funding-signature CALL site exists (the ledger-protected one)", () => {
    const callCount = (
      BUILDER_SRC.match(/await ensureStorageFundingSignature\(/g) ?? []
    ).length;
    expect(callCount).toBe(1);
  });

  it("the surface renders without invoking any handler", () => {
    const html = renderToStaticMarkup(createElement(CapsulePreparingSurface));
    expect(html).toContain("Capsule is being prepared");
    // Purely presentational: no buttons at all (nothing to click / re-submit).
    expect(html).not.toContain("<button");
  });
});

/* ================= surface structure ================= */

describe("waiting surface structure", () => {
  it("is an accessible live status region with a spinner", () => {
    const html = renderToStaticMarkup(createElement(CapsulePreparingSurface));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("animate-spin");
  });

  it("never exposes provider/technical internals", () => {
    const text = markup().toLowerCase();
    expect(text).not.toContain("irys");
    expect(text).not.toContain("phantom");
    expect(text).not.toContain("solana");
    expect(text).not.toContain("storagepaymentid");
  });
});
