/**
 * Unit tests for the SPA media failure classifier.
 *
 * These pin the SAFETY properties of the diagnostic surface:
 *  - every failure maps to one of the stable codes;
 *  - the FALLBACK TRIGGER is reported ONLY when the failure actually
 *    happened inside the fallback and is genuinely known;
 *  - a read failure is never mislabelled as a network failure, and a
 *    construction failure is never mislabelled as a read/network
 *    failure;
 *  - an image (no MSE stage) is never reported as an MSE failure;
 *  - NO rendered diagnostic contains raw exception text, `[AETERNA]`
 *    internal messages, URL fragments, or sensitive identifiers.
 */

import { describe, it, expect } from "vitest";

import {
  classifyMediaFailure,
  classifyPreviewConstructionFailure,
  fallbackTriggerLabel,
  MEDIA_DIAGNOSTIC_CODES,
  type MediaDiagnosticCode,
  type MediaOpenDiagnosticContext,
} from "./mediaFailureDiagnostics";
import { MediaNotStreamableError } from "./mediaCompatibility";
import { BoundedAwaitTimeoutError } from "./boundedAwait";
import {
  MediaPreviewTooLargeError,
  MediaPreviewConstructionError,
} from "./mediaPreviewPolicy";

const codes = (): readonly MediaDiagnosticCode[] => MEDIA_DIAGNOSTIC_CODES;

describe("classifyMediaFailure — typed boundary mapping", () => {
  it("a capability-stage MediaNotStreamableError is MEDIA_UNSUPPORTED", () => {
    const err = new MediaNotStreamableError("video/webm", undefined, "capability");
    expect(classifyMediaFailure(err).code).toBe("MEDIA_UNSUPPORTED");
  });

  it("an mse-setup-stage MediaNotStreamableError is MSE_SETUP_FAILED", () => {
    const err = new MediaNotStreamableError("video/webm", "sourceopen timed out", "mse-setup");
    expect(classifyMediaFailure(err).code).toBe("MSE_SETUP_FAILED");
  });

  it("an oversized preview preserves its exact pre-existing message", () => {
    const err = new MediaPreviewTooLargeError(26 * 1024 * 1024);
    const d = classifyMediaFailure(err);
    expect(d.code).toBe("PREVIEW_TOO_LARGE");
    expect(d.message).toMatch(/too large for an inline preview/i);
  });

  it("a construction failure is PREVIEW_OBJECT_URL_FAILED, never a read failure", () => {
    const err = new MediaPreviewConstructionError(new Error("createObjectURL boom"));
    const d = classifyMediaFailure(err, { mediaType: "video", fallbackTrigger: "capability" });
    expect(d.code).toBe("PREVIEW_OBJECT_URL_FAILED");
    // The trigger is preserved as context, but the CODE is construction.
    expect(d.fallbackTrigger).toBe("capability");
    expect(d.code).not.toBe("PREVIEW_READ_FAILED");
    expect(d.code).not.toBe("STREAM_READ_FAILED");
  });

  it("an IMAGE construction failure is PREVIEW_OBJECT_URL_FAILED, never STREAM_READ_FAILED", () => {
    // The image path has no fallback trigger; a construction failure there
    // must still be a construction failure, not a read failure.
    const err = new MediaPreviewConstructionError(new Error("image createObjectURL failed"));
    const d = classifyMediaFailure(err, { mediaType: "image" });
    expect(d.code).toBe("PREVIEW_OBJECT_URL_FAILED");
    expect(d.code).not.toBe("STREAM_READ_FAILED");
    expect(d.fallbackTrigger).toBeUndefined();
  });
});

describe("classifyMediaFailure — read/timeout stages and fallback context", () => {
  it("a read failure BEFORE any fallback is STREAM_READ_FAILED (no trigger)", () => {
    const d = classifyMediaFailure(new Error("range read failed"), { mediaType: "video" });
    expect(d.code).toBe("STREAM_READ_FAILED");
    expect(d.fallbackTrigger).toBeUndefined();
  });

  it("a read failure BEFORE the fallback on an IMAGE is STREAM_READ_FAILED, not MSE", () => {
    const d = classifyMediaFailure(new Error("decrypt failed"), { mediaType: "image" });
    expect(d.code).toBe("STREAM_READ_FAILED");
  });

  it("a fallback read failure reports PREVIEW_READ_FAILED and the known trigger", () => {
    const ctx: MediaOpenDiagnosticContext = { mediaType: "video", fallbackTrigger: "capability" };
    const d = classifyMediaFailure(new Error("blob read failed"), ctx);
    expect(d.code).toBe("PREVIEW_READ_FAILED");
    expect(d.fallbackTrigger).toBe("capability");
  });

  it("a fallback read timeout reports PREVIEW_READ_TIMEOUT and the known trigger", () => {
    const ctx: MediaOpenDiagnosticContext = { mediaType: "video", fallbackTrigger: "capability" };
    const d = classifyMediaFailure(new BoundedAwaitTimeoutError("media fallback read", 30_000), ctx);
    expect(d.code).toBe("PREVIEW_READ_TIMEOUT");
    expect(d.fallbackTrigger).toBe("capability");
  });

  it("an mse-setup fallback trigger is preserved on a fallback read failure", () => {
    const ctx: MediaOpenDiagnosticContext = { mediaType: "video", fallbackTrigger: "mse-setup" };
    const d = classifyMediaFailure(new Error("read failed"), ctx);
    expect(d.code).toBe("PREVIEW_READ_FAILED");
    expect(d.fallbackTrigger).toBe("mse-setup");
  });

  it("a bare timeout with NO trigger is a STREAM_READ_TIMEOUT, never MSE_SETUP_FAILED (A/V path)", () => {
    // An MSE handshake timeout is always raised as a `MediaNotStreamableError`
    // (`mse-setup`), so a BARE BoundedAwaitTimeoutError can only come from a
    // read-layer wait. It must NOT be labelled as an MSE setup failure just
    // because the media type is video/audio.
    const d = classifyMediaFailure(new BoundedAwaitTimeoutError("media chunk read", 30_000), {
      mediaType: "video",
    });
    expect(d.code).toBe("STREAM_READ_TIMEOUT");
    expect(d.code).not.toBe("MSE_SETUP_FAILED");
  });

  it("a bare timeout with NO trigger on the IMAGE path is a STREAM_READ_TIMEOUT", () => {
    const d = classifyMediaFailure(new BoundedAwaitTimeoutError("image preview", 30_000), {
      mediaType: "image",
    });
    expect(d.code).toBe("STREAM_READ_TIMEOUT");
  });

  it("an MSE setup timeout is MSE_SETUP_FAILED (its typed boundary, not a bare timeout)", () => {
    // The MSE handshake converts its timeout to a typed MediaNotStreamableError
    // with stage "mse-setup" — that is what makes it an MSE setup failure.
    const d = classifyMediaFailure(
      new MediaNotStreamableError("video/webm;codecs=vp8,opus", "MediaSource sourceopen timed out.", "mse-setup"),
      { mediaType: "video" },
    );
    expect(d.code).toBe("MSE_SETUP_FAILED");
  });

  it("an updateend timeout is MSE_SETUP_FAILED (typed as mse-setup)", () => {
    const d = classifyMediaFailure(
      new MediaNotStreamableError("video/webm;codecs=vp8,opus", "MediaSource updateend timed out.", "mse-setup"),
      { mediaType: "audio" },
    );
    expect(d.code).toBe("MSE_SETUP_FAILED");
  });

  it("an unknown error with no context degrades to STREAM_READ_FAILED (fail-safe)", () => {
    const d = classifyMediaFailure("not an error at all");
    expect(d.code).toBe("STREAM_READ_FAILED");
    expect(codes()).toContain(d.code);
  });
});

describe("classifyPreviewConstructionFailure", () => {
  it("returns PREVIEW_OBJECT_URL_FAILED and carries the trigger when known", () => {
    const d = classifyPreviewConstructionFailure({ fallbackTrigger: "capability" });
    expect(d.code).toBe("PREVIEW_OBJECT_URL_FAILED");
    expect(d.fallbackTrigger).toBe("capability");
  });

  it("carries no trigger when the construction failure is not inside the fallback", () => {
    const d = classifyPreviewConstructionFailure();
    expect(d.code).toBe("PREVIEW_OBJECT_URL_FAILED");
    expect(d.fallbackTrigger).toBeUndefined();
  });
});

describe("safety — rendered diagnostics are always safe, stable codes", () => {
  const samples: Array<[unknown, MediaOpenDiagnosticContext | undefined]> = [
    [new Error("[AETERNA] Storage failure"), undefined],
    [new Error("range read failed: https://gateway.irys.xyz/AbC123?frag=#secret"), { mediaType: "video" }],
    [new MediaNotStreamableError("video/webm", undefined, "capability"), { mediaType: "video" }],
    [new MediaNotStreamableError("video/webm", "sourceopen timed out", "mse-setup"), { mediaType: "video" }],
    [new MediaPreviewTooLargeError(26 * 1024 * 1024), { mediaType: "image" }],
    [new MediaPreviewConstructionError(new Error("[AETERNA] createObjectURL failed")), { mediaType: "video", fallbackTrigger: "capability" }],
    [new BoundedAwaitTimeoutError("media chunk read", 30_000), { mediaType: "video" }],
    [new BoundedAwaitTimeoutError("media fallback read", 30_000), { mediaType: "video", fallbackTrigger: "capability" }],
  ];

  it("every rendered message uses a known code and no raw/sensitive text", () => {
    for (const [err, ctx] of samples) {
      const d = classifyMediaFailure(err, ctx);
      expect(codes()).toContain(d.code);
      // The code itself must appear (so a screenshot is self-describing).
      expect(d.message).toContain(d.code);
      // Never leak raw exception text or internal markers.
      expect(d.message).not.toMatch(/\[AETERNA\]/);
      expect(d.message).not.toMatch(/https?:\/\//);
      expect(d.message).not.toMatch(/#/);
      expect(d.message).not.toMatch(/blob:/);
      expect(d.message).not.toMatch(/\b\d{4,}\b/); // no raw byte sizes/paths
      expect(d.message).not.toMatch(/AbC123|frag=secret/);
      // The trigger label, when present, is equally safe.
      if (d.fallbackTriggerLabel !== undefined) {
        expect(d.fallbackTriggerLabel).not.toMatch(/\[AETERNA\]/);
        expect(d.fallbackTriggerLabel).not.toMatch(/https?:\/\//);
        expect(d.fallbackTriggerLabel).not.toMatch(/#/);
        expect(d.fallbackTriggerLabel).not.toMatch(/blob:/);
        expect(d.fallbackTriggerLabel).not.toMatch(/\b\d{4,}\b/);
        expect(d.fallbackTriggerLabel).not.toMatch(/AbC123|frag=secret/);
      }
    }
  });

  it("each code maps to a distinct, non-empty message", () => {
    const seen = new Set<string>();
    for (const [err, ctx] of samples) {
      const { message } = classifyMediaFailure(err, ctx);
      expect(message.length).toBeGreaterThan(0);
      seen.add(message);
    }
    // Distinct failure stages must not collapse into one message.
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});

describe("fallbackTriggerLabel — fixed, safe copy for the known trigger", () => {
  it("returns undefined when no fallback was entered", () => {
    expect(fallbackTriggerLabel(undefined)).toBeUndefined();
  });

  it("maps 'capability' to fixed copy about progressive streaming, not device incapability", () => {
    const label = fallbackTriggerLabel("capability");
    expect(label).toBeDefined();
    // Precise claim: progressive (MSE) streaming was unavailable. It must
    // NOT overstate that the device cannot play the format at all.
    expect(label).toMatch(/progressive streaming unavailable/i);
    expect(label).toMatch(/capability check/i);
    expect(label).not.toMatch(/cannot play|cannot stream the format/i);
  });

  it("maps 'mse-setup' to fixed copy mentioning MSE setup", () => {
    const label = fallbackTriggerLabel("mse-setup");
    expect(label).toBeDefined();
    expect(label).toMatch(/MSE setup/i);
  });

  it("the two triggers map to DISTINCT labels (a screenshot can tell them apart)", () => {
    expect(fallbackTriggerLabel("capability")).not.toBe(
      fallbackTriggerLabel("mse-setup"),
    );
  });

  it("the diagnosis object carries the label EXACTLY when the trigger is set", () => {
    const inside = classifyMediaFailure(new Error("read failed"), {
      mediaType: "video",
      fallbackTrigger: "capability",
    });
    expect(inside.fallbackTrigger).toBe("capability");
    expect(inside.fallbackTriggerLabel).toBe(fallbackTriggerLabel("capability"));

    const before = classifyMediaFailure(new Error("read failed"), {
      mediaType: "video",
    });
    expect(before.fallbackTrigger).toBeUndefined();
    expect(before.fallbackTriggerLabel).toBeUndefined();
  });

  it("the label never contains the raw exception message", () => {
    const label = fallbackTriggerLabel("capability");
    expect(label).not.toMatch(/\[AETERNA\]/);
    expect(label).not.toMatch(/https?:\/\//);
    expect(label).not.toMatch(/blob:/);
  });
});
