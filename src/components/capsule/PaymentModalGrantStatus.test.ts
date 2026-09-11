/**
 * AETERNA — PATCH-2E regression test
 *
 * Production /api/creator/grant-credit responds with the raw Creator
 * Credit store enum ("AVAILABLE"), but the modal's phase logic compares
 * against the lowercase credit-status convention ("available"). The
 * un-normalized comparison stranded the UI in "Verifying..." after a
 * successful grant (HTTP 200).
 *
 * Node-env executable test: the normalization lives in PaymentModal.tsx
 * (exported normalizeGrantCreditStatus); no DOM/browser env is involved.
 */

import { describe, expect, it } from "vitest";

import { normalizeGrantCreditStatus } from "@/components/capsule/PaymentModal";

describe("PATCH-2E grant-credit status case normalization", () => {
  it("maps the production uppercase 'AVAILABLE' onto the available path", () => {
    expect(normalizeGrantCreditStatus("AVAILABLE")).toBe("available");
  });

  it("is stable for lowercase and mixed-case inputs", () => {
    expect(normalizeGrantCreditStatus("available")).toBe("available");
    expect(normalizeGrantCreditStatus("Available")).toBe("available");
  });

  it("maps the remaining store enums to lowercase non-available values", () => {
    expect(normalizeGrantCreditStatus("CONSUMING")).toBe("consuming");
    expect(normalizeGrantCreditStatus("CONSUMED")).toBe("consumed");
  });

  it("falls back to available when the status field is missing", () => {
    expect(normalizeGrantCreditStatus(undefined)).toBe("available");
  });
});
