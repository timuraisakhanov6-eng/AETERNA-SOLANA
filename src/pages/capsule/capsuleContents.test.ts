/**
 * R9-A90.1 — pure content-summary counting tests.
 *
 * These use the REAL capsule descriptor shapes (`CapsuleItemV2` /
 * `CapsuleItemV1`) — no parallel mock schema. Counting is a fold over
 * those descriptors, so this file needs no DOM, runtime or storage.
 */

import { describe, it, expect } from "vitest";

import type {
  CapsuleItemV1,
  CapsuleItemV2,
  MediaItemV2,
} from "@/types/vault";

import {
  classifyCapsuleItem,
  isZipFileDescriptor,
  summarizeCapsuleContents,
} from "./capsuleContents";

let seq = 0;

function textItem(text = "Hello"): CapsuleItemV2 {
  return {
    type: "text",
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as CapsuleItemV2;
}

function mediaItem(
  mediaType: MediaItemV2["mediaType"],
  overrides: Partial<MediaItemV2> = {},
): CapsuleItemV2 {
  seq += 1;

  return {
    type: "media",
    mediaType,
    filename: `${mediaType}-${seq}.bin`,
    mimeType: "application/octet-stream",
    size: 10,
    chunks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as MediaItemV2;
}

function chunk(index: number) {
  return {
    chunkId: `chunk-${index}`,
    mediaId: "media-1",
    index,
    size: 10,
  } as unknown as MediaItemV2["chunks"][number];
}

function sumCategories(
  summary: ReturnType<typeof summarizeCapsuleContents>,
): number {
  return summary.categories.reduce((total, category) => total + category.count, 0);
}

describe("summarizeCapsuleContents — category counts", () => {
  it("counts the correct total and every category from real descriptors", () => {
    const items: CapsuleItemV2[] = [
      mediaItem("image", { mimeType: "image/png" }),
      mediaItem("image", { mimeType: "image/jpeg" }),
      mediaItem("video", { mimeType: "video/mp4" }),
      mediaItem("video", { mimeType: "video/webm" }),
      textItem("A letter"),
      mediaItem("audio", { mimeType: "audio/webm" }),
      mediaItem("file", {
        filename: "archive.zip",
        mimeType: "application/zip",
      }),
      mediaItem("file", {
        filename: "document.pdf",
        mimeType: "application/pdf",
      }),
    ];

    const summary = summarizeCapsuleContents(items);

    expect(summary.total).toBe(8);
    expect(summary.photos).toBe(2);
    expect(summary.videos).toBe(2);
    expect(summary.letters).toBe(1);
    expect(summary.audio).toBe(1);
    expect(summary.zip).toBe(1);
    expect(summary.other).toBe(1);
  });

  it("A protocol audio item counts under Audio — no voice inference exists", () => {
    // `MediaItemV2.mediaType` has no voice-message discriminator; a
    // filename such as "voice-note.webm" must NOT invent a category.
    const summary = summarizeCapsuleContents([
      mediaItem("audio", {
        filename: "voice-note.webm",
        mimeType: "audio/webm",
      }),
    ]);

    expect(summary.audio).toBe(1);
    expect(summary.total).toBe(1);
    expect(summary.categories.find((c) => c.key === "audio")?.count).toBe(1);
  });

  it("counts ZIP by MIME metadata, including common variants", () => {
    for (const mimeType of [
      "application/zip",
      "application/x-zip",
      "application/x-zip-compressed",
      "application/zip-compressed",
      "multipart/x-zip",
      "APPLICATION/ZIP; charset=binary",
    ]) {
      expect(
        isZipFileDescriptor({ mediaType: "file", mimeType, filename: "x.bin" }),
      ).toBe(true);
    }

    const summary = summarizeCapsuleContents([
      mediaItem("file", {
        filename: "one.zip",
        mimeType: "application/x-zip-compressed",
      }),
      mediaItem("file", {
        filename: "two.zip",
        mimeType: "application/zip",
      }),
    ]);

    expect(summary.zip).toBe(2);
    expect(summary.other).toBe(0);
  });

  it("does not override a real non-ZIP MIME with a .zip filename", () => {
    expect(
      isZipFileDescriptor({
        mediaType: "file",
        mimeType: "application/pdf",
        filename: "not-really.zip",
      }),
    ).toBe(false);

    // …whereas a missing/generic MIME may use the name as a last resort.
    expect(
      isZipFileDescriptor({
        mediaType: "file",
        mimeType: "application/octet-stream",
        filename: "actually.zip",
      }),
    ).toBe(true);
  });

  it("a ZIP with no MIME type at all falls back to the filename", () => {
    // The protocol may omit mimeType entirely; the classifier then has no
    // type information and may use the filename as a last resort.
    expect(
      isZipFileDescriptor({
        mediaType: "file",
        filename: "archive.zip",
      }),
    ).toBe(true);

    expect(
      isZipFileDescriptor({
        mediaType: "file",
        filename: "document.pdf",
      }),
    ).toBe(false);

    const summary = summarizeCapsuleContents([
      {
        type: "media",
        mediaType: "file",
        filename: "no-mime.zip",
        size: 1,
        chunks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      } as unknown as CapsuleItemV2,
    ]);

    expect(summary.zip).toBe(1);
    expect(summary.other).toBe(0);
  });

  it("unknown item and media types are included in Other", () => {
    const unknownItem = {
      type: "poll",
      question: "?",
    } as unknown as CapsuleItemV2;

    const unknownMedia = {
      type: "media",
      mediaType: "hologram",
      filename: "future.bin",
      mimeType: "application/x-future",
      size: 1,
      chunks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    } as unknown as CapsuleItemV2;

    const summary = summarizeCapsuleContents([
      unknownItem,
      unknownMedia,
      mediaItem("file", { mimeType: "application/pdf" }),
    ]);

    expect(summary.other).toBe(3);
    expect(summary.total).toBe(3);
  });

  it("the total always equals the sum of every category", () => {
    const summary = summarizeCapsuleContents([
      textItem(),
      mediaItem("image"),
      mediaItem("video"),
      mediaItem("audio"),
      mediaItem("file", { mimeType: "application/zip" }),
      mediaItem("file", { mimeType: "application/pdf" }),
      { type: "unknown" } as unknown as CapsuleItemV2,
    ]);

    expect(summary.total).toBe(7);
    expect(sumCategories(summary)).toBe(summary.total);
  });

  it("multi-chunk media counts as ONE logical item", () => {
    const summary = summarizeCapsuleContents([
      mediaItem("video", {
        filename: "chunked-video.mp4",
        mimeType: "video/mp4",
        size: 300,
        chunks: [chunk(0), chunk(1), chunk(2)],
      }),
      mediaItem("image", {
        filename: "chunked-photo.png",
        mimeType: "image/png",
        size: 200,
        chunks: [chunk(3), chunk(4)],
      }),
    ]);

    expect(summary.total).toBe(2);
    expect(summary.videos).toBe(1);
    expect(summary.photos).toBe(1);
  });

  it("an empty capsule has a zero total and no counts", () => {
    const summary = summarizeCapsuleContents([]);

    expect(summary.total).toBe(0);
    expect(summary.categories).toHaveLength(6);
    expect(summary.categories.every((category) => category.count === 0)).toBe(true);
    expect(sumCategories(summary)).toBe(0);
  });

  it("null and undefined inputs are treated as empty, not as errors", () => {
    expect(summarizeCapsuleContents(null).total).toBe(0);
    expect(summarizeCapsuleContents(undefined).total).toBe(0);
  });

  it("legacy V1 descriptors classify the same way", () => {
    const isoUtc = "2026-01-01T00:00:00.000Z" as CapsuleItemV1["createdAt"];

    const v1Items: CapsuleItemV1[] = [
      {
        type: "text",
        text: "Legacy letter",
        createdAt: isoUtc,
      },
      {
        type: "media",
        mediaType: "image",
        filename: "legacy.png",
        mimeType: "image/png",
        size: 1,
        data: "data:image/png;base64,AA==",
        createdAt: isoUtc,
      },
      {
        type: "media",
        mediaType: "file",
        filename: "legacy.zip",
        mimeType: "application/zip",
        size: 1,
        data: "data:application/zip;base64,AA==",
        createdAt: isoUtc,
      },
    ];

    const summary = summarizeCapsuleContents(v1Items);

    expect(summary.total).toBe(3);
    expect(summary.letters).toBe(1);
    expect(summary.photos).toBe(1);
    expect(summary.zip).toBe(1);
  });

  it("classifyCapsuleItem is total: every real descriptor gets one category", () => {
    expect(classifyCapsuleItem(textItem())).toBe("letters");
    expect(classifyCapsuleItem(mediaItem("image"))).toBe("photos");
    expect(classifyCapsuleItem(mediaItem("video"))).toBe("videos");
    expect(classifyCapsuleItem(mediaItem("audio"))).toBe("audio");
    expect(
      classifyCapsuleItem(
        mediaItem("file", { mimeType: "application/zip" }),
      ),
    ).toBe("zip");
    expect(
      classifyCapsuleItem(
        mediaItem("file", { mimeType: "application/pdf" }),
      ),
    ).toBe("other");
    expect(classifyCapsuleItem(null)).toBe("other");
    expect(classifyCapsuleItem({ type: "unknown" })).toBe("other");
  });
});
