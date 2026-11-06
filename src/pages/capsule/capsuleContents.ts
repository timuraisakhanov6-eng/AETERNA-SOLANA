/**
 * =========================================================
 * AETERNA — Capsule content summary (derived UI data)
 * =========================================================
 *
 * R9-A90.1 — a PURE classifier over the content descriptors that
 * already exist in an opened capsule's Vault.
 *
 * Boundaries (deliberate):
 *
 *  • No storage access, no decryption, no media decode, no Blob /
 *    object URL creation. Counting is a synchronous fold over the
 *    Vault metadata the renderer already holds.
 *  • No new protocol field. The summary is never written into the
 *    Vault or the manifest; it is recomputed from `items`.
 *  • Each logical item is counted exactly once. Encrypted chunks are
 *    never items — `MediaItemV2.chunks` describes the transport of
 *    ONE logical file, so a multi-chunk video/photo stays one item.
 *  • The protocol has no voice-message discriminator: `MediaItemV2`
 *    exposes only `mediaType` ("image" | "video" | "audio" | "file").
 *    All audio is therefore counted under Audio; a filename is never
 *    used to invent a "voice" category.
 *  • ZIP detection uses the real MIME metadata first. A filename
 *    suffix is consulted ONLY when the MIME is absent or generic
 *    (`application/octet-stream`), because in that case the
 *    descriptor carries no usable type information.
 *  • Unknown item or media types fall into Other, so the displayed
 *    total always equals the sum of every displayed category.
 */

import type {
  CapsuleItemV1,
  CapsuleItemV2,
} from "@/types/vault";

export type CapsuleContentCategory =
  | "photos"
  | "videos"
  | "letters"
  | "audio"
  | "zip"
  | "other";

export interface CapsuleCategoryCount {
  readonly key: CapsuleContentCategory;
  readonly label: string;
  readonly count: number;
}

export interface CapsuleContentSummary {
  readonly total: number;
  readonly photos: number;
  readonly videos: number;
  readonly letters: number;
  readonly audio: number;
  readonly zip: number;
  readonly other: number;
  /**
   * All six categories in presentation order. The summary component
   * hides zero-count categories; keeping them here lets tests (and a
   * future UI) prove `total === sum(categories)` without special cases.
   */
  readonly categories: readonly CapsuleCategoryCount[];
}

/**
 * The MIME types that describe a ZIP archive. Kept explicit rather
 * than extension-based so a misnamed file is not reclassified by its
 * filename when the protocol already says what it is.
 */
const ZIP_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "application/zip-compressed",
  "multipart/x-zip",
]);

const CATEGORY_ORDER: readonly {
  key: CapsuleContentCategory;
  label: string;
}[] = [
  { key: "photos", label: "Photos" },
  { key: "videos", label: "Videos" },
  { key: "letters", label: "Letters" },
  { key: "audio", label: "Audio" },
  { key: "zip", label: "ZIP" },
  { key: "other", label: "Other" },
];

function normalizeMimeType(value: unknown): string {
  if (typeof value !== "string") return "";
  // `type/subtype; parameter=value` — the category is the bare type.
  return value.split(";")[0]!.trim().toLowerCase();
}

function normalizeFilename(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Whether a `mediaType: "file"` descriptor is a ZIP archive.
 *
 * MIME is authoritative whenever it carries a real type. The filename
 * is a last resort for descriptors whose MIME is missing or the
 * generic binary fallback.
 */
export function isZipFileDescriptor(descriptor: {
  readonly mediaType?: unknown;
  readonly mimeType?: unknown;
  readonly filename?: unknown;
}): boolean {
  if (descriptor.mediaType !== "file") return false;

  const mimeType = normalizeMimeType(descriptor.mimeType);

  if (mimeType && mimeType !== "application/octet-stream") {
    return ZIP_MIME_TYPES.has(mimeType);
  }

  return normalizeFilename(descriptor.filename).endsWith(".zip");
}

/**
 * Classify one real capsule content descriptor into exactly one
 * presentation category.
 */
export function classifyCapsuleItem(item: unknown): CapsuleContentCategory {
  if (!item || typeof item !== "object") return "other";

  const descriptor = item as {
    readonly type?: unknown;
    readonly mediaType?: unknown;
  };

  if (descriptor.type === "text") return "letters";

  if (descriptor.type !== "media") return "other";

  switch (descriptor.mediaType) {
    case "image":
      return "photos";
    case "video":
      return "videos";
    case "audio":
      return "audio";
    case "file":
      return isZipFileDescriptor(
        descriptor as {
          readonly mediaType?: unknown;
          readonly mimeType?: unknown;
          readonly filename?: unknown;
        },
      )
        ? "zip"
        : "other";
    default:
      return "other";
  }
}

/**
 * Fold the capsule's real content descriptors into counts.
 *
 * The function is pure and deterministic: the same descriptor list
 * always produces the same summary, which is why opening/closing a
 * viewer or re-rendering can never change the displayed counts.
 */
export function summarizeCapsuleContents(
  items:
    | readonly (CapsuleItemV1 | CapsuleItemV2)[]
    | null
    | undefined,
): CapsuleContentSummary {
  const counts: Record<CapsuleContentCategory, number> = {
    photos: 0,
    videos: 0,
    letters: 0,
    audio: 0,
    zip: 0,
    other: 0,
  };

  let total = 0;

  if (Array.isArray(items)) {
    for (const item of items) {
      counts[classifyCapsuleItem(item)] += 1;
      total += 1;
    }
  }

  return {
    total,
    photos: counts.photos,
    videos: counts.videos,
    letters: counts.letters,
    audio: counts.audio,
    zip: counts.zip,
    other: counts.other,
    categories: CATEGORY_ORDER.map((category) => ({
      ...category,
      count: counts[category.key],
    })),
  };
}
