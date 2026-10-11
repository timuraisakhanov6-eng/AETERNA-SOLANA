/**
 * =========================================================
 * Phase F2.1 — rejection reasons map to distinct diagnostic codes
 * =========================================================
 *
 * Complements `mediaFailureDiagnostics.phaseF1.test.ts` (which proved
 * `PREVIEW_RANGE_TIMEOUT` / `_NETWORK` / generic `_FAILED`). Here we
 * assert the F2.1 refinement: a SINGLE observed rejection reason becomes
 * its OWN code, while MIXED / empty reason sets keep the generic
 * `PREVIEW_RANGE_FAILED` catch-all.
 *
 * Pure classifier — no mocking. Every error is constructed directly.
 * This proves the MAPPING, not any physical-device behaviour.
 */
import { describe, it, expect } from "vitest";

import {
  classifyMediaFailure,
  MEDIA_DIAGNOSTIC_CODES,
  type MediaOpenDiagnosticContext,
} from "./mediaFailureDiagnostics";
import {
  StorageRangeError,
  type StorageRangeRejectionReason,
} from "@/lib/storage/storageRangeFailure";

const CAP: MediaOpenDiagnosticContext = {
  mediaType: "video",
  fallbackTrigger: "capability",
};

function rejected(...reasons: StorageRangeRejectionReason[]): StorageRangeError {
  return new StorageRangeError("range-rejected", reasons);
}

describe("Phase F2.1 — a single reason maps to its own code", () => {
  it.each([
    [["status-not-206"], "PREVIEW_RANGE_STATUS_REJECTED"],
    [["html-response"], "PREVIEW_RANGE_HTML_RESPONSE"],
    [["content-range-mismatch"], "PREVIEW_RANGE_CONTENT_RANGE_MISMATCH"],
    [["body-short"], "PREVIEW_RANGE_BODY_SHORT"],
    [["body-long"], "PREVIEW_RANGE_BODY_LONG"],
  ] as ReadonlyArray<[StorageRangeRejectionReason[], string]>)(
    "%j → %s",
    (reasons, expected) => {
      const d = classifyMediaFailure(rejected(...reasons), CAP);
      expect(d.code).toBe(expected);
      expect(MEDIA_DIAGNOSTIC_CODES).toContain(d.code);
      expect(d.fallbackTrigger).toBe("capability");
    },
  );
});

describe("Phase F2.1 — mixed / empty reason sets keep the generic catch-all", () => {
  it("two distinct reasons → PREVIEW_RANGE_FAILED (no single cause overstated)", () => {
    const d = classifyMediaFailure(
      rejected("status-not-206", "body-short"),
      CAP,
    );
    expect(d.code).toBe("PREVIEW_RANGE_FAILED");
  });

  it("an empty reason set (unclassifiable) → PREVIEW_RANGE_FAILED", () => {
    const d = classifyMediaFailure(new StorageRangeError("range-rejected"), CAP);
    expect(d.code).toBe("PREVIEW_RANGE_FAILED");
  });
});

describe("Phase F2.1 — off-fallback behaviour is unchanged", () => {
  it("a typed reason with NO trigger is still STREAM_READ_FAILED", () => {
    const d = classifyMediaFailure(rejected("body-short"), {
      mediaType: "video",
    });
    expect(d.code).toBe("STREAM_READ_FAILED");
  });
});

describe("Phase F2.1 — every new code's copy is fixed and safe", () => {
  it.each([
    [rejected("status-not-206"), "PREVIEW_RANGE_STATUS_REJECTED"],
    [rejected("html-response"), "PREVIEW_RANGE_HTML_RESPONSE"],
    [rejected("content-range-mismatch"), "PREVIEW_RANGE_CONTENT_RANGE_MISMATCH"],
    [rejected("body-short"), "PREVIEW_RANGE_BODY_SHORT"],
    [rejected("body-long"), "PREVIEW_RANGE_BODY_LONG"],
  ] as ReadonlyArray<[StorageRangeError, string]>)(
    "%# — message is fixed and leaks nothing",
    (err, expected) => {
      const d = classifyMediaFailure(err, CAP);
      expect(d.code).toBe(expected);
      expect(d.message).toContain(expected);
      expect(d.message).not.toContain("[AETERNA]");
      expect(d.message).not.toMatch(/https?:|blob:|[0-9a-f]{20,}/i);
      // The rendered copy is never the error's own message.
      expect(d.message).not.toBe(err.message);
    },
  );
});
