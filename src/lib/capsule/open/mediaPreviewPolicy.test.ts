/**
 * Regression tests for the INLINE PREVIEW SIZE POLICY.
 *
 * An inline preview materialises the whole file in memory, so every
 * path that builds an Object URL / Blob for preview must be bounded.
 * These tests pin:
 *  - #5 within limit / exactly at the boundary / over the limit;
 *  - a malformed size fails closed;
 *  - the guard runs BEFORE any full read (oversized files are never
 *    assembled);
 *  - a read failure still terminates;
 *  - #6 the other Object-URL / Blob paths do not bypass the bound.
 *
 * No real media bytes, no network, no capability secrets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import {
  MAX_INLINE_PREVIEW_BYTES,
  MediaPreviewTooLargeError,
  isMediaPreviewTooLargeError,
  assertInlinePreviewSize,
  inlinePreviewTooLargeMessage,
} from "./mediaPreviewPolicy";

import { openImage } from "./openImage";
import { sessionToObjectUrl } from "@/pages/capsule/VaultRenderer";

import type { MediaSession, OpenMediaRequest } from "./openTypes";

/* ───────────────────────── helpers ───────────────────────── */

function installUrlStub(): void {
  (globalThis as unknown as { URL?: unknown }).URL = {
    createObjectURL: () => "blob:preview",
    revokeObjectURL: () => {},
  };
}

function makeRuntime(
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array(8),
  fail = false,
) {
  return {
    getBytes: vi.fn(async () => {
      if (fail) throw new Error("decrypt failed");
      return bytes;
    }),
    dispose: vi.fn(),
  };
}

function makeRequest(size: number): OpenMediaRequest {
  return {
    capsuleId: "a".repeat(64),
    cryptoKey: {} as CryptoKey,
    media: {
      mediaType: "image",
      filename: "photo.png",
      mimeType: "image/png",
      size,
      chunks: [],
    },
  } as unknown as OpenMediaRequest;
}

function makeSession(readImpl: () => Promise<Uint8Array<ArrayBuffer>>): MediaSession {
  return { read: () => readImpl(), dispose: () => {} };
}

beforeEach(() => {
  installUrlStub();
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as unknown as { URL?: unknown }).URL = undefined;
});

/* ───────────────────── policy boundaries ───────────────────── */

describe("#5: MAX_INLINE_PREVIEW_BYTES boundaries", () => {
  it("reuses the existing 25 MiB media-view policy", () => {
    expect(MAX_INLINE_PREVIEW_BYTES).toBe(25 * 1024 * 1024);
  });

  it("allows a size within the limit", () => {
    expect(() => assertInlinePreviewSize(1024)).not.toThrow();
  });

  it("allows a size EXACTLY at the boundary (inclusive)", () => {
    expect(() =>
      assertInlinePreviewSize(MAX_INLINE_PREVIEW_BYTES),
    ).not.toThrow();
  });

  it("rejects one byte over the boundary", () => {
    expect(() =>
      assertInlinePreviewSize(MAX_INLINE_PREVIEW_BYTES + 1),
    ).toThrow(MediaPreviewTooLargeError);
  });

  it("rejects a wildly oversized item", () => {
    expect(() =>
      assertInlinePreviewSize(2 * 1024 * 1024 * 1024),
    ).toThrow(MediaPreviewTooLargeError);
  });

  it("rejects a malformed size fail-closed", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expect(() => assertInlinePreviewSize(bad)).toThrow();
    }
  });

  it("carries the offending size and the limit", () => {
    const err = new MediaPreviewTooLargeError(MAX_INLINE_PREVIEW_BYTES + 5);
    expect(err.size).toBe(MAX_INLINE_PREVIEW_BYTES + 5);
    expect(err.limit).toBe(MAX_INLINE_PREVIEW_BYTES);
    expect(isMediaPreviewTooLargeError(err)).toBe(true);
    expect(isMediaPreviewTooLargeError(new Error("x"))).toBe(false);
  });

  it("produces a precise, human-readable terminal message", () => {
    const msg = inlinePreviewTooLargeMessage(26 * 1024 * 1024);
    expect(msg).toMatch(/too large for an inline preview/i);
    expect(msg).toMatch(/26\.0 MB/);
    expect(msg).toMatch(/25\.0 MB/);
  });
});

/* ───────────────── openImage runtime guard ───────────────── */

describe("#2: openImage refuses an oversized image BEFORE reading", () => {
  it("rejects and never calls getBytes for an over-limit image", async () => {
    const runtime = makeRuntime();
    await expect(
      openImage(runtime as never, makeRequest(MAX_INLINE_PREVIEW_BYTES + 1)),
    ).rejects.toBeInstanceOf(MediaPreviewTooLargeError);
    expect(runtime.getBytes).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
  });

  it("allows an image exactly at the boundary", async () => {
    const runtime = makeRuntime();
    const result = await openImage(
      runtime as never,
      makeRequest(MAX_INLINE_PREVIEW_BYTES),
    );
    expect(result.objectUrl).toMatch(/^blob:/);
    expect(runtime.getBytes).toHaveBeenCalledTimes(1);
  });

  it("allows an image within the limit", async () => {
    const runtime = makeRuntime();
    const result = await openImage(runtime as never, makeRequest(4096));
    expect(result.objectUrl).toMatch(/^blob:/);
  });

  it("a read failure still terminates and disposes", async () => {
    const runtime = makeRuntime(new Uint8Array(0), true);
    await expect(
      openImage(runtime as never, makeRequest(4096)),
    ).rejects.toThrow(/decrypt failed/);
    expect(runtime.dispose).toHaveBeenCalled();
  });
});

/* ───────────────── sessionToObjectUrl guard ───────────────── */

describe("#6: sessionToObjectUrl is size-bounded too", () => {
  it("rejects an over-limit size BEFORE reading", async () => {
    const read = vi.fn(async () => new Uint8Array(8) as Uint8Array<ArrayBuffer>);
    const session = { read: () => read(), dispose: () => {} };
    await expect(
      sessionToObjectUrl(session as never, MAX_INLINE_PREVIEW_BYTES + 1, "image/png"),
    ).rejects.toBeInstanceOf(MediaPreviewTooLargeError);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns an object URL within the limit", async () => {
    const session = makeSession(async () => new Uint8Array(8) as Uint8Array<ArrayBuffer>);
    await expect(
      sessionToObjectUrl(session, 4096, "image/png"),
    ).resolves.toMatch(/^blob:/);
  });
});

/* ───────────────── #6 structural audit ───────────────── */

describe("#6: no Object-URL / Blob path bypasses a bound", () => {
  const OPEN_IMAGE = readFileSync(new URL("./openImage.ts", import.meta.url), "utf8");
  const RENDERER = readFileSync(
    new URL("../../../pages/capsule/VaultRenderer.tsx", import.meta.url),
    "utf8",
  );
  const EMERGENCY = readFileSync(
    new URL("../../../emergency/emergencyRuntime.ts", import.meta.url),
    "utf8",
  );

  it("the image runtime gates size before the whole-file read", () => {
    const gate = OPEN_IMAGE.indexOf("assertInlinePreviewSize(");
    const read = OPEN_IMAGE.indexOf("runtime.getBytes(");
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(read);
  });

  it("the primary renderer bounds every whole-file materialisation", () => {
    // image preview helper
    expect(RENDERER).toMatch(/assertInlinePreviewSize\(\s*size/);
    // video/audio whole-file fallback
    expect(RENDERER).toMatch(/size > MAX_MEDIA_FALLBACK_BYTES/);
  });

  it("the emergency runtime bounds both image and fallback reads", () => {
    expect(EMERGENCY).toMatch(/assertInlinePreviewSize\(args\.size/);
    expect(EMERGENCY).toMatch(/args\.size > EMERGENCY_MEDIA_FALLBACK_MAX_BYTES/);
  });

  it("the two bounds are the same number (single policy)", () => {
    expect(RENDERER).toMatch(/MAX_MEDIA_FALLBACK_BYTES = 25 \* 1024 \* 1024/);
    expect(EMERGENCY).toMatch(
      /EMERGENCY_MEDIA_FALLBACK_MAX_BYTES = 25 \* 1024 \* 1024/,
    );
    expect(MAX_INLINE_PREVIEW_BYTES).toBe(25 * 1024 * 1024);
  });
});
