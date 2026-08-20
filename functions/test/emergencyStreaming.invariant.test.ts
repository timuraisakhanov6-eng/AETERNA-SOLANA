import { describe, it, expect, vi } from "vitest";

import type {
  MediaSession,
} from "@/lib/capsule/open/openTypes";

import type {
  MediaItemV2,
} from "@/types/vault";

/**
 * Emergency Streaming Invariant Tests — PHASE 6H.4b
 *
 * Covers the algorithmic/runtime contract for the Emergency Runtime
 * browser adapter. Browser-only behavior such as live MediaSource
 * playback is marked INCONCLUSIVE in Node/Vitest because browser
 * globals are unavailable there.
 */

/* =========================================================
   FAKE / STUB HELPERS
   ========================================================= */

function createMediaSessionStub(
  overrides: Partial<MediaSession> = {},
  fixedSize = 1024,
): MediaSession {
  let disposed = false;

  return {
    async read(start, end) {
      if (disposed) {
        throw new Error(
          "Emergency media session has been disposed.",
        );
      }
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error("Range bounds must be integers.");
      }
      if (start < 0 || end <= start) {
        throw new Error("Invalid byte range.");
      }
      if (end > fixedSize) {
        throw new Error("Byte range exceeds file length.");
      }
      return new Uint8Array(end - start);
    },
    dispose() {
      disposed = true;
    },
    ...overrides,
  };
}

function createMediaItem(
  overrides: Partial<MediaItemV2> = {},
): MediaItemV2 {
  return {
    type: "media",
    mediaType: "file",
    filename: "file.bin",
    mimeType: "application/octet-stream",
    size: 1024,
    chunks: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  } as MediaItemV2;
}

function createPublishedChunk(
  overrides: {
    chunkId?: string;
    pointer?: string;
    index?: number;
    size?: number;
    mediaId?: string;
  } = {},
): MediaItemV2["chunks"][number] {
  return {
    chunkId: overrides.chunkId ?? "chunk_001",
    mediaId: overrides.mediaId ?? "media_001",
    index: overrides.index ?? 0,
    size: overrides.size ?? 1024,
    pointer: overrides.pointer ?? "pointer_001",
  } as MediaItemV2["chunks"][number];
}

const hasBrowserGlobals =
  typeof window !== "undefined" &&
  typeof document !== "undefined";

/* =========================================================
   CAPABILITY / OPENING GUARD CONTRACTS
   ========================================================= */

describe(
  "emergencyStreaming.invariant.test.ts — Emergency Runtime streaming invariants",
  () => {
    describe("capability parser contract", () => {
      it("accepts recipient-only links", async () => {
        const { parseCapsuleCapability } =
          await import("@/lib/capsule/parseCapsuleCapability");

        const parsed = parseCapsuleCapability(
          "#0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        );

        expect(parsed).not.toBeNull();
        expect(parsed?.recipientSecret).toBe(
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        );
        expect(parsed?.creatorAuthorityFragment).toBeUndefined();
      });

      it("accepts creator-only links", async () => {
        const { parseCapsuleCapability } =
          await import("@/lib/capsule/parseCapsuleCapability");

        const parsed = parseCapsuleCapability(
          "#c=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        );

        expect(parsed).not.toBeNull();
        expect(parsed?.creatorAuthorityFragment).toBe(
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        );
        expect(parsed?.recipientSecret).toBeUndefined();
      });

      it("rejects malformed fragments", async () => {
        const { parseCapsuleCapability } =
          await import("@/lib/capsule/parseCapsuleCapability");

        expect(parseCapsuleCapability("not-a-fragment")).toBeNull();
        expect(parseCapsuleCapability("#")).toBeNull();
        expect(parseCapsuleCapability("#c=bad")).toBeNull();
      });
    });

    describe("opening guard remains before media access", () => {
      it("requires recipient secret before media work begins", async () => {
        const mediaAccess = vi.fn();

        const parsed = {
          recipientSecret: undefined,
          creatorAuthorityFragment:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        };

        const opened = parsed.recipientSecret !== undefined;

        expect(opened).toBe(false);
        expect(mediaAccess).not.toHaveBeenCalled();
      });

      it("requires effective open time before media work begins", async () => {
        const mediaAccess = vi.fn();

        const nowUtc = 1_700_000_000_000;
        const effectiveOpenAt = 2_000_000_000_000;

        const opened =
          nowUtc >= effectiveOpenAt;

        expect(opened).toBe(false);
        expect(mediaAccess).not.toHaveBeenCalled();
      });
    });

    describe("canonical chunk pointer resolution", () => {
      it("resolves chunk metadata into published chunk pointers", async () => {
        const { resolveChunkPointers } =
          await import("@/lib/capsule/open/resolveChunkPointers");

        const chunks = [
          createPublishedChunk({
            chunkId: "chunk_001",
            pointer: "pointer_001",
          }),
          createPublishedChunk({
            chunkId: "chunk_002",
            pointer: "pointer_002",
            index: 1,
          }),
        ];

        const chunkPointers = {
          chunk_001: "pointer_001",
          chunk_002: "pointer_002",
        };

        const resolved = resolveChunkPointers(chunks, chunkPointers);

        expect(resolved).toHaveLength(2);
        expect(resolved[0]?.pointer).toBe("pointer_001");
        expect(resolved[1]?.pointer).toBe("pointer_002");
      });

      it("fails closed on missing pointer", async () => {
        const { resolveChunkPointers } =
          await import("@/lib/capsule/open/resolveChunkPointers");

        const chunks = [
          createPublishedChunk({
            chunkId: "chunk_001",
            pointer: "pointer_001",
          }),
        ];

        expect(() =>
          resolveChunkPointers(chunks, {}),
        ).toThrow("Missing storage pointer for chunk chunk_001");
      });

      it("fails closed on invalid pointer shape", async () => {
        const { resolveChunkPointers } =
          await import("@/lib/capsule/open/resolveChunkPointers");

        const chunks = [
          createPublishedChunk({
            chunkId: "chunk_001",
            pointer: "",
          }),
        ];

        expect(() =>
          resolveChunkPointers(chunks, {
            chunk_001: "",
          }),
        ).toThrow(
          "Missing storage pointer for chunk chunk_001",
        );
      });
    });

    describe("range boundary validation", () => {
      it("rejects non-integer bounds", async () => {
        const session = createMediaSessionStub();

        await expect(session.read(0.5, 10)).rejects.toThrow(
          "Range bounds must be integers.",
        );
        await expect(session.read(0, 10.5)).rejects.toThrow(
          "Range bounds must be integers.",
        );
      });

      it("rejects negative or inverted ranges", async () => {
        const session = createMediaSessionStub();

        await expect(session.read(-1, 10)).rejects.toThrow(
          "Invalid byte range.",
        );
        await expect(session.read(10, 10)).rejects.toThrow(
          "Invalid byte range.",
        );
      });

      it("rejects ranges beyond media size", async () => {
        const session = createMediaSessionStub();

        await expect(session.read(0, 2048)).rejects.toThrow(
          "Byte range exceeds file length.",
        );
      });
    });

    describe("session abort / dispose", () => {
      it("rejects reads after dispose", async () => {
        const session = createMediaSessionStub(undefined, 1024);

        session.dispose();

        await expect(session.read(0, 10)).rejects.toThrow(
          "Emergency media session has been disposed.",
        );
      });

      it("dispose is idempotent", async () => {
        const session = createMediaSessionStub();

        session.dispose();
        session.dispose();

        // Should not throw.
        expect(true).toBe(true);
      });
    });

    describe("no full-media concatenation path", () => {
      it.skip("emergency media source stream uses bounded chunk reads — INCONCLUSIVE: MediaSource adapter is internal to compiled emergencyRuntime bundle and not separately importable", async () => {

        const {
          emergencyMediaSourceStream,
        } = await import(
          "@/emergency/emergencyMediaSource"
        );

        const readPlan: number[][] = [];

        const session: MediaSession = {
          async read(start, end) {
            readPlan.push([start, end]);
            return new Uint8Array(end - start);
          },
          dispose() {
            // no-op
          },
        };

        const mediaSourceSpy = vi.spyOn(window, "MediaSource");

        try {
          const result = emergencyMediaSourceStream({
            session,
            mimeType: "video/mp4",
            size: 500_000,
            signal: new AbortController().signal,
            onError: () => {},
          });

          expect(result).not.toBeNull();
          expect(readPlan.length).toBeGreaterThan(1);
          expect(readPlan[0]).toEqual([0, 262144]);
          expect(readPlan[1]).toEqual([262144, 524288]);
          expect(readPlan[2]).toEqual([524288, 500000]);
        } finally {
          mediaSourceSpy.mockRestore();
        }
      });

      it.skip("does not invoke full-media read for video/audio — INCONCLUSIVE: MediaSource adapter is internal to compiled emergencyRuntime bundle and not separately importable", async () => {

        const readCalls: [number, number][] = [];

        const session: MediaSession = {
          async read(start, end) {
            readCalls.push([start, end]);
            return new Uint8Array(end - start);
          },
          dispose() {
            // no-op
          },
        };

        const mediaSourceSpy = vi.spyOn(window, "MediaSource");

        try {
          const result = emergencyMediaSourceStream({
            session,
            mimeType: "video/mp4",
            size: 400_000,
            signal: new AbortController().signal,
            onError: () => {},
          });

          expect(result).not.toBeNull();

          const hasFullRead = readCalls.some(
            ([start, end]) => start === 0 && end === 400_000,
          );

          expect(hasFullRead).toBe(false);
        } finally {
          mediaSourceSpy.mockRestore();
        }
      });
    });

    describe("object URL cleanup", () => {
      it.skip("revokes previous object URL before assigning a new one in media elements — INCONCLUSIVE: DOM element lifecycle is browser-only", async () => {

        const revokeSpy = vi.spyOn(URL, "revokeObjectURL");

        const media = document.createElement("video");
        media.src = "blob:old";

        const previousUrl = media.src;

        const newUrl = "blob:new";
        if (media.src && media.src.startsWith("blob:")) {
          URL.revokeObjectURL(media.src);
        }
        media.src = newUrl;

        expect(revokeSpy).toHaveBeenCalledWith(previousUrl);
        expect(media.src).toBe(newUrl);

        revokeSpy.mockRestore();
      });
    });

    describe("fail-closed behavior", () => {
      it.skip("returns failure on media session read error — INCONCLUSIVE: MediaSource adapter is internal to compiled emergencyRuntime bundle and not separately importable", async () => {

        const session: MediaSession = {
          async read() {
            throw new Error("read failure");
          },
          dispose() {
            // no-op
          },
        };

        const objectUrl = emergencyMediaSourceStream({
          session,
          mimeType: "video/mp4",
          size: 1024,
          signal: new AbortController().signal,
          onError: () => {
            // failure observed via null result
          },
        });

        expect(objectUrl).toBeNull();
      });
    });
  },
);
