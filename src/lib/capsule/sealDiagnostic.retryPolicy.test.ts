/**
 * R9-A92 F3 — bounded retry policy on seal failures.
 *
 * The publication-claim boundary attaches a NON-SECRET, fixed-literal
 * retry policy to the failures it classifies. `tagSealFailure` re-wraps
 * any failure into the canonical public error; the policy MUST survive
 * that re-wrapping so the caller's retry loop can stop on a definitive
 * conflict instead of repeating an identical, outcome-neutral request.
 */

import { describe, expect, it } from "vitest";

import {
  readSealRetryPolicy,
  tagSealFailure,
  tagSealRetryPolicy,
  SEAL_FAILURE_MESSAGE,
  type SealDiagnosticCode,
} from "./sealDiagnostic";
import { isTerminalSealFailure } from "./sealCapsuleCore";

describe("sealDiagnostic — bounded retry policy", () => {
  it("attaches and reads the policy", () => {
    const error = tagSealRetryPolicy(new Error("x"), "terminal");
    expect(readSealRetryPolicy(error)).toBe("terminal");
  });

  it("is idempotent: the innermost policy wins", () => {
    const first = tagSealRetryPolicy(new Error("x"), "terminal");
    const second = tagSealRetryPolicy(first, "retryable");
    expect(readSealRetryPolicy(second)).toBe("terminal");
  });

  it("is safe for non-object throwables", () => {
    expect(readSealRetryPolicy("boom")).toBeNull();
    expect(readSealRetryPolicy(null)).toBeNull();
    expect(readSealRetryPolicy(42)).toBeNull();
    expect(tagSealRetryPolicy("boom", "terminal")).toBe("boom");
  });

  it("survives tagSealFailure re-wrapping (the canonical public error)", () => {
    const inner = tagSealRetryPolicy(
      new Error("[AETERNA] creatorIrys: publication claim failed: LIFECYCLE_NOT_RESERVED"),
      "terminal"
    );

    const tagged = tagSealFailure(inner, "CONTAINER_PUBLICATION");

    expect(tagged.message).toBe(`${SEAL_FAILURE_MESSAGE}: CONTAINER_PUBLICATION`);
    expect(readSealRetryPolicy(tagged)).toBe("terminal");
  });

  it("re-wrapped failures without a policy carry none", () => {
    const tagged = tagSealFailure(
      new Error("unclassified"),
      "SEAL_UNKNOWN" as SealDiagnosticCode
    );
    expect(readSealRetryPolicy(tagged)).toBeNull();
  });

  it("isTerminalSealFailure honours the policy (and the 402 marker regresses)", () => {
    const terminal = tagSealRetryPolicy(new Error("conflict"), "terminal");
    expect(isTerminalSealFailure(terminal)).toBe(true);

    const transient = tagSealRetryPolicy(new Error("pending"), "retryable");
    expect(isTerminalSealFailure(transient)).toBe(false);

    expect(isTerminalSealFailure(new Error("plain"))).toBe(false);

    // Pre-existing 402 payment-gate marker still classifies as terminal.
    const paymentGate = new Error("payment");
    Object.defineProperty(paymentGate, "sealTerminal", { value: true });
    expect(isTerminalSealFailure(paymentGate)).toBe(true);
  });

  it("a terminal policy survives the full SEAL_UNKNOWN re-wrap at the outer boundary", () => {
    const inner = tagSealRetryPolicy(new Error("conflict"), "terminal");
    // A boundary without a more precise tag collapses to SEAL_UNKNOWN;
    // the policy must still reach the caller.
    const outer = tagSealFailure(inner, "SEAL_UNKNOWN");
    expect(isTerminalSealFailure(outer)).toBe(true);
  });
});
