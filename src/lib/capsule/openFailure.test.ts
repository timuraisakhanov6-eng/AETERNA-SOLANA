/**
 * AETERNA — capsule-open failure classification.
 *
 * Pins the contract that makes safe RETRY possible without weakening
 * any authorization check:
 *
 *   1. retryable  — infrastructure only; the capability may be kept
 *                   and the FULL pipeline re-run;
 *   2. not-open   — trusted time authoritatively said "still sealed";
 *   3. terminal   — invalid capability / crypto / integrity; must never
 *                   open and must never be retried.
 *
 * Plus the two non-negotiable properties of the classifier itself:
 *
 *   • FAIL-CLOSED DEFAULT — an unclassifiable failure is treated as
 *     "retryable" for CAPABILITY RETENTION (a retry re-runs the full
 *     pipeline, so nothing is authorized by the classification), and
 *     the confidence flag documents that uncertainty;
 *   • NON-SECRET — classification reads only fixed literals and bounded
 *     codes; it never reads a message body, a URL, a token, a key, a
 *     pointer or any plaintext.
 */

import { describe, it, expect } from "vitest";

import {
  classifyOpenFailure,
  isClassificationCertain,
  notOpenError,
  retryableOpenError,
  tagOpenFailure,
  terminalOpenError,
  CapsuleOpenError,
} from "./openFailure";

describe("openFailure — retryable infrastructure failures", () => {
  it("classifies a typed retryable error as retryable (certain)", () => {
    const err = retryableOpenError("trusted-time-unavailable");

    expect(classifyOpenFailure(err)).toBe("retryable");
    expect(isClassificationCertain(err)).toBe(true);
    expect(err).toBeInstanceOf(CapsuleOpenError);
    expect(err.severity).toBe("retryable");
  });

  it("classifies an unclassifiable error as retryable (fail-closed default)", () => {
    // A bare network-ish failure carrying no recognised categorical
    // signal. The default RETAINS the capability; the retry re-runs the
    // full pipeline, so this does NOT authorize anything.
    expect(classifyOpenFailure(new Error("NetworkError when attempting to fetch"))).toBe(
      "retryable"
    );
    expect(classifyOpenFailure(new TypeError("Failed to fetch"))).toBe("retryable");
    expect(classifyOpenFailure(undefined)).toBe("retryable");
    expect(classifyOpenFailure(null)).toBe("retryable");
    expect(classifyOpenFailure("boom")).toBe("retryable");
  });

  it("reports an unclassifiable failure as UNCERTAIN (documented)", () => {
    expect(isClassificationCertain(new Error("Failed to fetch"))).toBe(false);
    expect(isClassificationCertain(undefined)).toBe(false);
  });

  it("is tolerant of a cross-realm structured clone of a retryable error", () => {
    // The severity literal travels even if the prototype is lost.
    const clone = { ...retryableOpenError("gateway-timeout") };

    expect(classifyOpenFailure(clone)).toBe("retryable");
    expect(isClassificationCertain(clone)).toBe(true);
  });
});

describe("openFailure — not-yet-open", () => {
  it("classifies a typed not-open condition", () => {
    const err = notOpenError("nowUtc < effectiveOpenAt");

    expect(classifyOpenFailure(err)).toBe("not-open");
    expect(err.severity).toBe("not-open");
    expect(err.message).toMatch(/sealed/i);
  });
});

describe("openFailure — terminal capability / integrity failures", () => {
  it("classifies the canonical INVALID_SECRET code as terminal", () => {
    const err = Object.assign(new Error("bad secret"), {
      code: "INVALID_SECRET",
    });

    expect(classifyOpenFailure(err)).toBe("terminal");
    expect(isClassificationCertain(err)).toBe(true);
  });

  it("classifies every recognised terminal code / name as terminal", () => {
    for (const token of [
      "INVALID_SECRET",
      "INVALID_CAPABILITY",
      "CRYPTO_FAILURE",
      "INTEGRITY_VIOLATION",
    ]) {
      expect(classifyOpenFailure({ code: token })).toBe("terminal");
      expect(classifyOpenFailure({ name: token })).toBe("terminal");
    }
  });

  it("classifies a typed terminal error as terminal", () => {
    const err = new CapsuleOpenError(
      "terminal",
      "INTEGRITY_VIOLATION",
      "[AETERNA] Vault integrity verification failed"
    );

    expect(classifyOpenFailure(err)).toBe("terminal");
    expect(err.reason).toBe("INTEGRITY_VIOLATION");
  });

  it("does NOT treat an unrelated free-form message as terminal", () => {
    // Brittle string matching is explicitly avoided: a message that
    // merely CONTAINS a token must not promote an otherwise unclassified
    // failure to terminal (that would strand the capability).
    expect(
      classifyOpenFailure(new Error("upstream said INVALID_SECRET"))
    ).toBe("retryable");
    expect(
      classifyOpenFailure(new Error("[AETERNA] Cryptographic failure"))
    ).toBe("retryable");
  });
});

describe("openFailure — boundary tagging (tagOpenFailure)", () => {
  it("tags a bare infrastructure error as retryable", () => {
    const tagged = tagOpenFailure(
      new Error("[AETERNA] Range read failed"),
      "retryable",
      "STORAGE_READ_FAILED"
    );

    expect(classifyOpenFailure(tagged)).toBe("retryable");
    expect(tagged.severity).toBe("retryable");
    expect(tagged.reason).toBe("STORAGE_READ_FAILED");
  });

  it("tags a bare integrity failure as terminal", () => {
    const tagged = tagOpenFailure(
      new Error("[AETERNA] Vault integrity verification failed"),
      "terminal",
      "INTEGRITY_VIOLATION"
    );

    expect(classifyOpenFailure(tagged)).toBe("terminal");
    expect(tagged.reason).toBe("INTEGRITY_VIOLATION");
  });

  it("NEVER overwrites a precise typed severity (innermost boundary wins)", () => {
    // A terminal crypto failure from the deepest layer must not be
    // re-tagged retryable by an outer boundary.
    const inner = terminalOpenError("CRYPTO_FAILURE");
    const outer = tagOpenFailure(inner, "retryable", "STORAGE_READ_FAILED");

    expect(classifyOpenFailure(outer)).toBe("terminal");
    expect(outer.reason).toBe("CRYPTO_FAILURE");
  });

  it("NEVER overwrites a precise legacy terminal code", () => {
    const inner = Object.assign(new Error("bad secret"), {
      code: "INVALID_SECRET",
    });
    const outer = tagOpenFailure(inner, "retryable", "STORAGE_READ_FAILED");

    expect(classifyOpenFailure(outer)).toBe("terminal");
  });

  it("produces a fixed, non-secret message for every severity", () => {
    for (const severity of ["retryable", "not-open", "terminal"] as const) {
      const tagged = tagOpenFailure(new Error("x"), severity, "REASON");
      // The original message (which could hold a payload) never travels.
      expect(tagged.message).not.toContain("x");
      expect(tagged.message).toMatch(/^\[AETERNA\]/);
    }
  });

  it("never carries the original error's payload fields", () => {
    const hostile = Object.assign(new Error("boom"), {
      body: "SECRET-MATERIAL",
      url: "https://x/#secret",
    });
    const tagged = tagOpenFailure(hostile, "terminal", "CRYPTO_FAILURE");

    const serialized = JSON.stringify(tagged, Object.getOwnPropertyNames(tagged));
    expect(serialized).not.toContain("SECRET-MATERIAL");
    expect(serialized).not.toContain("secret");
  });
});

describe("openFailure — non-secret by construction", () => {
  it("never reads a payload: only fixed keys matter", () => {
    // Two objects identical except for arbitrary payload fields — the
    // classification is unchanged. No message/body/URL/token is consulted.
    const a = { code: "INVALID_SECRET", body: "x".repeat(10_000) };
    const b = { code: "INVALID_SECRET", url: "https://example/#secret" };

    expect(classifyOpenFailure(a)).toBe("terminal");
    expect(classifyOpenFailure(b)).toBe("terminal");
  });

  it("is safe for a cyclic / hostile input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => classifyOpenFailure(cyclic)).not.toThrow();
    expect(classifyOpenFailure(cyclic)).toBe("retryable");
  });
});
