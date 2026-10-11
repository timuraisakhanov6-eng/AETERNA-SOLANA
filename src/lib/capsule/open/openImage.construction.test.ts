// @vitest-environment jsdom
/**
 * Image open — Blob / object-URL construction boundary.
 *
 * Issue 2 (Phase E2.2): the SPA image path is
 * `openRuntime.openImage` → `openImage.ts`, which builds its OWN Blob
 * and calls `URL.createObjectURL`. A failure there happens AFTER a
 * successful read, so it must be a CONSTRUCTION failure — never a read
 * failure.
 *
 * These tests exercise the REAL `openImage.ts` (not a mock) with a stub
 * ByteRuntime, so the typed `MediaPreviewConstructionError` boundary is
 * proven to sit around the actual Blob / createObjectURL operation.
 *
 * No real media bytes, no network, no capability secrets.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { openImage } from "./openImage";
import type { ByteRuntime } from "../runtime/runtimeTypes";
import type { OpenMediaRequest } from "./openTypes";
import {
  isMediaPreviewConstructionError,
  MediaPreviewTooLargeError,
} from "./mediaPreviewPolicy";

function stubRuntime(bytes: Uint8Array): ByteRuntime {
  return {
    getBytes: () => Promise.resolve(bytes),
    dispose: vi.fn(),
    // Only the members openImage touches are required.
  } as unknown as ByteRuntime;
}

function requestFor(size: number): OpenMediaRequest {
  return {
    capsuleId: "cap-test",
    cryptoKey: ({} as unknown) as CryptoKey,
    media: {
      type: "media",
      mediaType: "image",
      filename: "photo.png",
      mimeType: "image/png",
      size,
      chunks: [],
    },
  } as unknown as OpenMediaRequest;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openImage — construction boundary", () => {
  it("a createObjectURL failure is wrapped as MediaPreviewConstructionError", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: () => {
        throw new Error("createObjectURL exploded");
      },
      revokeObjectURL: () => {},
    });

    const runtime = stubRuntime(new Uint8Array(8));

    const err = await openImage(runtime, requestFor(8)).catch((e: unknown) => e);
    expect(isMediaPreviewConstructionError(err)).toBe(true);

    // Runtime ownership still ends (dispose is called) even on failure.
    expect(
      (runtime.dispose as unknown as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalled();
  });

  it("a Blob constructor failure is wrapped as MediaPreviewConstructionError", async () => {
    // Force `new Blob(...)` to throw.
    vi.stubGlobal("Blob", function ThrowingBlob() {
      throw new Error("Blob exploded");
    } as unknown as typeof Blob);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:never",
      revokeObjectURL: () => {},
    });

    const err = await openImage(
      stubRuntime(new Uint8Array(8)),
      requestFor(8),
    ).catch((e: unknown) => e);
    expect(isMediaPreviewConstructionError(err)).toBe(true);
  });

  it("the oversized gate still fails closed BEFORE any read (unchanged)", async () => {
    const runtime = stubRuntime(new Uint8Array(8));
    await expect(
      openImage(runtime, requestFor(26 * 1024 * 1024)),
    ).rejects.toBeInstanceOf(MediaPreviewTooLargeError);
    // The read must not have been attempted for an oversized image.
    expect(
      (runtime.dispose as unknown as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalled();
  });

  it("a successful construction returns the object URL", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:ok",
      revokeObjectURL: () => {},
    });
    const res = await openImage(stubRuntime(new Uint8Array(8)), requestFor(8));
    expect(res.objectUrl).toBe("blob:ok");
  });
});
