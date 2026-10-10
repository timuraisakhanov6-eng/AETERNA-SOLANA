/**
 * Regression tests for media MIME / WebM / MSE compatibility.
 *
 * These cover task section 7 #7 and #8:
 *  - #7  Bare `video/webm` (or `audio/webm` / `video/mp4`) must select a
 *       legacy compatibility candidate through a browser-capability probe
 *       WITHOUT guessing the encrypted payload's actual codec.
 *  - #8  A codec-qualified, MSE-supported mime must stream unchanged.
 *
 * The browser's `MediaSource.isTypeSupported` is faked so the probe is
 * deterministic. No media bytes are inspected — codec selection is purely
 * a capability question, never a claim about the ciphertext's codec.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveStreamableMimeType,
  isBareWebmOrMp4,
  MediaNotStreamableError,
  isMediaNotStreamableError,
} from "./mediaCompatibility";

/** Controllable fake MediaSource. */
class FakeMediaSource {
  static supported = new Set<string>();

  static isTypeSupported(mime: string): boolean {
    return FakeMediaSource.supported.has(mime);
  }
}

let originalMediaSource: unknown;

beforeEach(() => {
  originalMediaSource = (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource = FakeMediaSource;
});

afterEach(() => {
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource = originalMediaSource;
  FakeMediaSource.supported = new Set<string>();
});

describe("isBareWebmOrMp4", () => {
  it("detects bare container types that MSE rejects", () => {
    expect(isBareWebmOrMp4("video/webm")).toBe(true);
    expect(isBareWebmOrMp4("audio/webm")).toBe(true);
    expect(isBareWebmOrMp4("video/mp4")).toBe(true);
  });

  it("does not flag codec-qualified or non-container types", () => {
    expect(isBareWebmOrMp4("video/webm;codecs=vp8")).toBe(false);
    expect(isBareWebmOrMp4("image/png")).toBe(false);
    expect(isBareWebmOrMp4("application/pdf")).toBe(false);
    expect(isBareWebmOrMp4(undefined)).toBe(false);
  });
});

describe("resolveStreamableMimeType", () => {
  it("#8: codec-qualified, MSE-supported type is used verbatim", () => {
    FakeMediaSource.supported.add("video/webm;codecs=vp8");
    expect(resolveStreamableMimeType("video/webm;codecs=vp8")).toBe(
      "video/webm;codecs=vp8",
    );
  });

  it("#8: codec-qualified type MSE rejects returns null (no streaming)", () => {
    // empty supported set
    expect(resolveStreamableMimeType("video/webm;codecs=vp8")).toBeNull();
  });

  it("#7: bare video/webm expands via capability probe (no payload-codec guess)", () => {
    // When nothing is supported, the resolver must NOT invent a codec —
    // it returns null so the caller chooses a bounded whole-file fallback.
    expect(resolveStreamableMimeType("video/webm")).toBeNull();

    FakeMediaSource.supported.add("video/webm;codecs=vp8,opus");
    const resolved = resolveStreamableMimeType("video/webm");
    expect(resolved).toBe("video/webm;codecs=vp8,opus");

    // The returned candidate is the BROWSER's declared capability; the
    // resolver never asserts the stored payload actually carries that codec.
    expect(resolved).not.toBe("video/webm");
  });

  it("#7: bare video/webm prefers the first supported candidate in preference order", () => {
    FakeMediaSource.supported.add("video/webm;codecs=vp9,opus");
    FakeMediaSource.supported.add("video/webm;codecs=vp8,opus");
    expect(resolveStreamableMimeType("video/webm")).toBe(
      "video/webm;codecs=vp8,opus",
    );
  });

  it("#7: bare audio/webm probes audio candidates", () => {
    FakeMediaSource.supported.add("audio/webm;codecs=opus");
    expect(resolveStreamableMimeType("audio/webm")).toBe(
      "audio/webm;codecs=opus",
    );
  });

  it("#7: bare video/mp4 probes mp4 candidates", () => {
    FakeMediaSource.supported.add("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    expect(resolveStreamableMimeType("video/mp4")).toBe(
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    );
  });

  it("empty or undefined mime returns null", () => {
    expect(resolveStreamableMimeType("")).toBeNull();
    expect(resolveStreamableMimeType(undefined)).toBeNull();
  });

  it("non-media types are not streamed through MSE", () => {
    expect(resolveStreamableMimeType("image/png")).toBeNull();
    expect(resolveStreamableMimeType("application/pdf")).toBeNull();
  });
});

/* ============================================================
   #5 — MSE/MIME incompatibility is a distinct, classifiable error
   ============================================================ */

describe("#5: MediaNotStreamableError marks a capability failure only", () => {
  it("carries the canonical 'Progressive playback unavailable' message", () => {
    const err = new MediaNotStreamableError("video/webm");
    expect(err.message).toMatch(/Progressive playback unavailable/i);
    expect(err.mimeType).toBe("video/webm");
    expect(err.name).toBe("MediaNotStreamableError");
  });

  it("keeps a caller-supplied reason but still prefixes the AETERNA tag", () => {
    const err = new MediaNotStreamableError(
      "video/webm",
      "MediaSource updateend timed out.",
    );
    expect(err.message).toBe("[AETERNA] MediaSource updateend timed out.");
  });

  it("isMediaNotStreamableError is true ONLY for this class", () => {
    expect(isMediaNotStreamableError(new MediaNotStreamableError("video/webm"))).toBe(
      true,
    );
    // A genuine read/decrypt failure must NOT be eligible for the
    // compatibility fallback.
    expect(isMediaNotStreamableError(new Error("decrypt failed"))).toBe(false);
    expect(isMediaNotStreamableError(new TypeError("boom"))).toBe(false);
    expect(isMediaNotStreamableError("string")).toBe(false);
    expect(isMediaNotStreamableError(undefined)).toBe(false);
    expect(isMediaNotStreamableError(null)).toBe(false);
  });
});
