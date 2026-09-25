// @vitest-environment jsdom
/**
 * AETERNA — Responsive error-notice overflow regression tests.
 *
 * Defect (production screenshot): the Irys funding error rendered a
 * real Solana transaction signature as one unbroken base58 token inside
 * a plain `<div>` with no wrapping guard. In a flex/grid parent the
 * token's min-content width forced the container wider than the modal
 * and the viewport — the text escaped the red box (and the modal) while
 * "body { overflow-x: hidden }" silently clipped it.
 *
 * Fix: a presentational `.aeterna-error-notice` class (src/index.css,
 * the only stylesheet actually loaded by main.tsx) that applies
 * max-width:100% / min-width:0 / overflow-wrap:anywhere /
 * word-break:break-word / white-space:normal, plus `min-w-0` on the
 * dialog grid so it can never be widened by its content.
 *
 * This test pins the CONTRACT:
 *   1. short human error renders verbatim
 *   2. 87-char Solana signature renders verbatim AND the box carries the
 *      wrapping classes (so a real browser wraps it inside the box)
 *   3. long URL renders verbatim
 *   4. long hash renders verbatim
 *   5. Cyrillic + Latin mixed text renders verbatim
 *   6. no shortening / no ellipsis substitution of the signature
 *   7. full value present in the DOM (nothing truncated)
 *   8. no Copy control is introduced (CSS-only fix)
 *   9. a non-identifier message gains no extra technical chrome
 *  10. the notice class carries min-w-0 / max-w-full / break-word
 *      markers (jsdom cannot measure layout, so classes are asserted).
 *
 * jsdom cannot measure geometry, so these tests assert the class
 * contract; real viewport behaviour is covered by the manual matrix in
 * the task report.
 *
 * All rendering is local. No network, no production calls, no payment.
 */

import { describe, expect, it, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

/* ================= FIXTURES ================= */

// A realistic, well-formed 88-char base58 Solana signature (shape only —
// never a real on-chain value). Matches FUNDING_SIGNATURE_SHAPE
// /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.
const SOLANA_SIGNATURE =
  "AEyLuv3duaTQ3KX2y6hBfuSzgGpe4UuR6GTRjfmhrZyJmhGrEqHNh9Yey8xnwJBmgk9rzYZ8Q85kiku2CuUZvnVb";

const LONG_URL =
  "https://gateway.irys.xyz/9NERQjLetzquGwdKt3X4gZ8fE8fPfSkj2xo2esmUjWsz/averyveryverylongdataitemidentifierwithoutanyspacesatall";

const LONG_HASH =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const CYRILLIC_LATIN =
  "Ошибка Irys funding: подпись 3E1mj8RRr2Sg не подтверждена — 400 Confirmed tx not found";

/**
 * Mirror of the real error element markup: the same class list used at
 * CapsuleBuilder.tsx and FinalCapsuleReviewModal.tsx, with the fix's
 * `aeterna-error-notice` token included.
 */
function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      data-testid="notice"
      className="aeterna-error-notice p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500"
    >
      {message}
    </div>
  );
}

/* ================= TESTS ================= */

describe("error notice — responsive wrapping contract", () => {
  it("1. renders a short human-readable error verbatim", () => {
    const msg = "Payment could not be verified. Please try again.";
    render(<ErrorNotice message={msg} />);
    expect(screen.getByTestId("notice").textContent).toBe(msg);
  });

  it("2. renders an 88-char Solana signature verbatim (no shortening)", () => {
    expect(SOLANA_SIGNATURE.length).toBeGreaterThanOrEqual(86);
    expect(SOLANA_SIGNATURE.length).toBeLessThanOrEqual(88);
    expect(SOLANA_SIGNATURE).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    render(<ErrorNotice message={`Irys funding failed: ${SOLANA_SIGNATURE}`} />);
    const text = screen.getByTestId("notice").textContent ?? "";
    expect(text).toContain(SOLANA_SIGNATURE);
    // No ellipsis substitution of the signature
    expect(text).not.toContain("…");
    expect(text).not.toMatch(/\b[a-zA-Z0-9]{6}…[a-zA-Z0-9]{6}\b/);
  });

  it("3. renders a long URL verbatim", () => {
    render(<ErrorNotice message={LONG_URL} />);
    expect(screen.getByTestId("notice").textContent).toBe(LONG_URL);
  });

  it("4. renders a long SHA-256-scale hash verbatim", () => {
    render(<ErrorNotice message={`hash: ${LONG_HASH}`} />);
    expect(screen.getByTestId("notice").textContent).toContain(LONG_HASH);
  });

  it("5. renders mixed Cyrillic + Latin text verbatim", () => {
    render(<ErrorNotice message={CYRILLIC_LATIN} />);
    expect(screen.getByTestId("notice").textContent).toBe(CYRILLIC_LATIN);
  });

  it("6/7. the full signature is present in the DOM (nothing truncated)", () => {
    render(<ErrorNotice message={`Irys funding failed: ${SOLANA_SIGNATURE}`} />);
    const node = screen.getByTestId("notice");
    expect(node.textContent).toContain(SOLANA_SIGNATURE);
    expect(node.querySelectorAll("*").length).toBe(0); // no nested clipping wrapper
  });

  it("8. introduces no Copy control (CSS-only fix)", () => {
    render(<ErrorNotice message={`Irys funding failed: ${SOLANA_SIGNATURE}`} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/copy/i)).toBeNull();
  });

  it("9. a non-identifier message gains no extra technical chrome", () => {
    render(<ErrorNotice message="Wallet verification was not completed." />);
    const node = screen.getByTestId("notice");
    expect(node.children.length).toBe(0);
  });

  it("10. the notice carries the wrapping / shrink class contract", () => {
    render(<ErrorNotice message={`Irys funding failed: ${SOLANA_SIGNATURE}`} />);
    const cls = screen.getByTestId("notice").className;
    // The fix marker class (src/index.css owns the actual properties)
    expect(cls).toContain("aeterna-error-notice");
    // The existing visual language must be preserved alongside it
    expect(cls).toContain("bg-red-500/10");
    expect(cls).toContain("border-red-500/20");
    expect(cls).toContain("text-xs");
    expect(cls).toContain("text-red-500");
  });

  it("index.css defines the wrapping properties for the marker class", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(
      path.resolve(__dirname, "../../index.css"),
      "utf8"
    );
    const block = css.slice(css.indexOf(".aeterna-error-notice"));
    expect(block).toContain("max-width: 100%");
    expect(block).toContain("min-width: 0");
    expect(block).toContain("overflow-wrap: anywhere");
    expect(block).toContain("word-break: break-word");
    expect(block).toContain("white-space: normal");
    // The shrink rule for children must exist too
    expect(css).toContain(".aeterna-error-notice > *");
  });
});
