/**
 * =========================================================
 * Phase F2.2 — rejected HTTP statuses are RENDERED, but only for the
 * status-rejection diagnostic
 * =========================================================
 *
 * Complements `mediaFailureDiagnostics.rejectionReason.test.ts` (F2.1,
 * which proved the CODE mapping). Here we assert the F2.2 refinement:
 * the NUMERIC HTTP statuses of rejected range responses become visible
 * in the rendered copy — and ONLY for `PREVIEW_RANGE_STATUS_REJECTED`.
 *
 * Pure classifier — no mocking. Every error is constructed directly.
 * This proves the RENDERING/MAPPING, not any physical-device behaviour.
 * The real iPhone status remains UNKNOWN until tested.
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

function rejected(
  reasons: StorageRangeRejectionReason[],
  statuses: number[] = [],
): StorageRangeError {
  return new StorageRangeError("range-rejected", reasons, statuses);
}

describe("Phase F2.2 — a rejected status renders numerically", () => {
  it.each([
    [[200], "200"],
    [[403], "403"],
    [[404], "404"],
    [[416], "416"],
    [[500], "500"],
    [[503], "503"],
  ] as ReadonlyArray<[number[], string]>)(
    "status %j → code PREVIEW_RANGE_STATUS_REJECTED rendering %s",
    (statuses, expected) => {
      const d = classifyMediaFailure(rejected(["status-not-206"], statuses), CAP);

      expect(d.code).toBe("PREVIEW_RANGE_STATUS_REJECTED");
      expect(MEDIA_DIAGNOSTIC_CODES).toContain(d.code);
      expect(d.rangeStatuses).toEqual(statuses);
      expect(d.message).toContain(expected);
      expect(d.message).toContain("PREVIEW_RANGE_STATUS_REJECTED");
      expect(d.fallbackTrigger).toBe("capability");
    },
  );

  it("mixed statuses render as a UNIQUE, ASCENDING set (not the last one)", () => {
    const d = classifyMediaFailure(
      rejected(["status-not-206"], [403, 200, 403]),
      CAP,
    );

    expect(d.code).toBe("PREVIEW_RANGE_STATUS_REJECTED");
    expect(d.rangeStatuses).toEqual([200, 403]);
    expect(d.message).toContain("HTTP statuses: 200, 403.");
  });

  it("a single status uses the singular label", () => {
    const d = classifyMediaFailure(rejected(["status-not-206"], [404]), CAP);
    expect(d.message).toContain("HTTP status: 404.");
    expect(d.message).not.toContain("HTTP statuses");
  });
});

describe("Phase F2.2 — statuses render ONLY for the status-rejection code", () => {
  it("a body-short rejection renders NO statuses even when some are present", () => {
    const d = classifyMediaFailure(rejected(["body-short"], [200]), CAP);

    expect(d.code).toBe("PREVIEW_RANGE_BODY_SHORT");
    expect(d.rangeStatuses).toBeUndefined();
    expect(d.message).not.toContain("HTTP status");
    expect(d.message).not.toContain("200");
  });

  it("an html-response rejection renders NO statuses", () => {
    const d = classifyMediaFailure(rejected(["html-response"], [206]), CAP);
    expect(d.code).toBe("PREVIEW_RANGE_HTML_RESPONSE");
    expect(d.rangeStatuses).toBeUndefined();
    expect(d.message).not.toContain("HTTP status");
  });

  it("a MIXED reason set stays the generic catch-all with no statuses", () => {
    const d = classifyMediaFailure(
      rejected(["status-not-206", "body-short"], [200]),
      CAP,
    );
    expect(d.code).toBe("PREVIEW_RANGE_FAILED");
    expect(d.rangeStatuses).toBeUndefined();
    expect(d.message).not.toContain("200");
  });

  it("an empty status set falls back to the FIXED copy (F2.1 behaviour preserved)", () => {
    const d = classifyMediaFailure(rejected(["status-not-206"], []), CAP);

    expect(d.code).toBe("PREVIEW_RANGE_STATUS_REJECTED");
    expect(d.rangeStatuses).toEqual([]);
    expect(d.message).toBe(
      "Storage answered the media range with an unexpected status (PREVIEW_RANGE_STATUS_REJECTED).",
    );
  });
});

describe("Phase F2.2 — off-fallback behaviour is unchanged", () => {
  it("a status rejection with NO trigger is STREAM_READ_FAILED with no statuses", () => {
    const d = classifyMediaFailure(rejected(["status-not-206"], [403]), {
      mediaType: "video",
    });
    expect(d.code).toBe("STREAM_READ_FAILED");
    expect(d.rangeStatuses).toBeUndefined();
    expect(d.message).not.toContain("403");
  });
});

describe("Phase F2.2 — the rendered copy stays safe", () => {
  it("no URL, fragment, hex, [AETERNA] marker or 4+ digit number leaks", () => {
    const d = classifyMediaFailure(
      rejected(["status-not-206"], [200, 403, 500]),
      CAP,
    );

    expect(d.message).not.toMatch(/\[AETERNA\]/);
    expect(d.message).not.toMatch(/https?:\/\//);
    expect(d.message).not.toMatch(/#/);
    expect(d.message).not.toMatch(/blob:/);
    // No raw byte sizes / paths — HTTP statuses are 3 digits.
    expect(d.message).not.toMatch(/\b\d{4,}\b/);
    expect(d.message).not.toContain("[AETERNA] Storage failure");
    // The rendered copy is never the underlying error's own message.
    expect(d.message).not.toBe(rejected(["status-not-206"], [200]).message);
  });

  it("only valid HTTP integers are ever rendered — bad values are dropped", () => {
    const d = classifyMediaFailure(
      rejected(["status-not-206"], [200, 0, 1000, 3.5, -1, 99, 600]),
      CAP,
    );

    expect(d.rangeStatuses).toEqual([200]);
    expect(d.message).toContain("HTTP status: 200.");
    expect(d.message).not.toContain("1000");
    expect(d.message).not.toContain("3.5");
  });

  it("the structured status set never carries anything but integers", () => {
    const d = classifyMediaFailure(
      rejected(["status-not-206"], [403, 404]),
      CAP,
    );
    for (const s of d.rangeStatuses ?? []) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(100);
      expect(s).toBeLessThanOrEqual(599);
    }
  });
});
