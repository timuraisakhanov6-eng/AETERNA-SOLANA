import type {
  StorageAdapter,
  StoragePointer,
} from "./storageAdapter";

import {
  assertChunkPointerMap,
  assertStoragePointer,
} from "./storageAdapter";

import type {
  ChunkId,
  ManifestV1
} from "@/types/manifest";
import { MANIFEST_VERSION } from "@/types/manifest";

import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
} from "@/lib/crypto/validators";

import { MAX_ENCRYPTED_VAULT_SIZE } from "@/lib/crypto/constants";
import type { ChunkPointerReadout } from "./storageAdapter";
import {
  assertContainerPublicationRecord,
  type ContainerPublicationRecord,
} from "@/lib/storage/container/containerPublication";

/**
 * AETERNA — Storage read transport (read-only)
 *
 * Read path of the former Executor Hot storage transport: gateway
 * downloads, manifest reads, and Chunk Pointer Registry lookups.
 * Publication (upload/uploadChunk) has moved to the Creator-paid
 * path: the creator wallet uploads directly to Irys and the
 * publication authority is established server-side via
 * /api/publication/claim (see creatorIrysStorage.ts).
 */

const MAX_DOWNLOAD_SIZE = 256 * 1024 * 1024;

const GATEWAY_TIMEOUT = 8000;

// Download uses immutable public storage gateways. The publication
// transport is Executor Hot, while reads remain storage-provider
// independent — the read path does not change based on who signed
// the write.
const GATEWAYS = [
  "https://gateway.irys.xyz/",
  "https://arweave.net/",
  "https://permaweb.eu/",
  "https://arweave.live/",
];

function failClosed(reason?: string): never {
  throw new Error(reason ?? "[AETERNA] Fail closed");
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical bounded range window.
 *
 * A range read is a half-open request [offset, offset + length)
 * expressed on the wire as the inclusive HTTP Range
 * `bytes=<offset>-<offset + length - 1>`.
 */
export type RangeWindow = {
  readonly offset: number;
  readonly length: number;
  readonly end: number;
};

/**
 * Canonical range-window validator.
 *
 * Fail-closed boundary for every range read. Rejects:
 *
 * • non-numbers, non-integers, negatives
 * • zero or negative length
 * • unsafe integers and arithmetic overflow
 *   (offset + length - 1 must itself remain a safe integer)
 *
 * The returned `end` is the INCLUSIVE last byte offset, so callers
 * never re-derive it and can never disagree with the validator.
 */
export function assertRangeWindow(
  offset: unknown,
  length: unknown
): RangeWindow {
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    failClosed("[AETERNA] Invalid range offset");
  }

  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    failClosed("[AETERNA] Invalid range length");
  }

  const end = offset + length - 1;

  /**
   * Overflow guard.
   *
   * A safe offset plus a safe length can still leave the
   * safe-integer domain. Worse, IEEE-754 rounding above 2^53 can
   * silently NARROW the window without ever leaving it — e.g.
   * offset = 2^53-1, length = 2 collapses to a 1-byte span.
   *
   * Either way the Range header would no longer describe the
   * requested window, so the round-trip is asserted explicitly
   * rather than assumed.
   */
  if (
    !Number.isSafeInteger(end) ||
    end < offset ||
    end - offset + 1 !== length
  ) {
    failClosed("[AETERNA] Range arithmetic overflow");
  }

  return { offset, length, end };
}

/**
 * Builds the canonical Irys/Arweave range-read URL.
 *
 * `https://<gateway>/tx/<txId>/data`
 */
function buildRangeUrl(gateway: string, txId: string): string {
  const base = gateway.endsWith("/") ? gateway : gateway + "/";
  return `${base}tx/${txId}/data`;
}

/**
 * Canonical Manifest validator.
 *
 * Validates the production ManifestV1 boundary before the manifest
 * enters the runtime. This is the single source of truth for
 * manifest-shape validation on the read path.
 */
function assertStrictManifestShape(
  manifest: unknown,
  capsuleId: string
): asserts manifest is ManifestV1 {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !isPlainObject(manifest)
  ) {
    failClosed("[AETERNA] Invalid manifest shape");
  }

  const obj = manifest as Record<string, unknown>;

  if (
    obj["version"] !== MANIFEST_VERSION ||
    obj["capsuleId"] !== capsuleId ||

    typeof obj["openAt"] !== "number" ||
    !Number.isSafeInteger(obj["openAt"] as number) ||

    typeof obj["sealedAt"] !== "number" ||
    !Number.isSafeInteger(obj["sealedAt"] as number) ||

    (obj["openAt"] as number) <= (obj["sealedAt"] as number) ||

    typeof obj["saltBase"] !== "string" ||
    !SALT_BASE_REGEX.test(obj["saltBase"] as string) ||

    typeof obj["encryptedSizeBytes"] !== "number" ||
    !Number.isSafeInteger(obj["encryptedSizeBytes"] as number) ||
    !Number.isInteger(obj["encryptedSizeBytes"] as number) ||
    (obj["encryptedSizeBytes"] as number) <= 0 ||
    (obj["encryptedSizeBytes"] as number) > MAX_ENCRYPTED_VAULT_SIZE ||

    typeof obj["vaultTxId"] !== "string" ||

    !isPlainObject(obj["ext"]) ||
    typeof (obj["ext"] as Record<string, unknown>)["vaultSha256"] !==
      "string" ||
    !SHA256_REGEX.test(
      (obj["ext"] as Record<string, unknown>)["vaultSha256"] as string
    )
  ) {
    failClosed("[AETERNA] Invalid manifest fields");
  }
}

function assertChunkPointerResponse(
  value: unknown,
  capsuleId: string
): Readonly<Record<ChunkId, StoragePointer>> {
  if (!isPlainObject(value)) {
    failClosed("[AETERNA] Invalid chunk pointer response");
  }

  if (value["capsuleId"] !== capsuleId) {
    failClosed("[AETERNA] Chunk pointer capsule mismatch");
  }

  if (!("chunkPointers" in value)) {
    failClosed("[AETERNA] Missing chunk pointer payload");
  }

  try {
    return assertChunkPointerMap(
      value["chunkPointers"]
    );
  } catch {
    failClosed("[AETERNA] Invalid chunk pointer payload");
  }
}

/**
 * Stage 4.5 — reads the ADDITIVE container publication from the same
 * response. Absence (or an explicit null) is the legacy case and is not an
 * error; a present-but-malformed record fails closed.
 */
function readContainerPublication(
  value: unknown,
  capsuleId: string
): ContainerPublicationRecord | null {
  if (!isPlainObject(value)) {
    failClosed("[AETERNA] Invalid chunk pointer response");
  }

  if (!("container" in value)) return null;

  const raw = value["container"];
  if (raw === null || raw === undefined) return null;

  try {
    return assertContainerPublicationRecord(raw, capsuleId);
  } catch {
    failClosed("[AETERNA] Invalid container publication record");
  }
}

/**
 * Stage 4.5 — a capsule publishes EITHER N per-chunk pointers OR ONE
 * container. The container write path deliberately creates ZERO per-chunk
 * registry entries, so both being populated is an inconsistent state and
 * must fail closed rather than silently prefer one representation.
 */
function assertUnambiguousPublication(
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>,
  container: ContainerPublicationRecord | null
): void {
  if (container === null) return;

  if (Object.keys(chunkPointers).length > 0) {
    failClosed(
      "[AETERNA] Capsule exposes both a container publication and legacy chunk pointers"
    );
  }
}

/**
 * Stage 4.5 — the single fetch behind BOTH the legacy pointer map and the
 * additive container readout. The legacy `getChunkPointers` result is
 * byte-for-byte what it was before; the only added rule is the fail-closed
 * mixed-state guard, which can never trigger for a legitimate capsule.
 */
async function fetchChunkPointerReadout(
  capsuleId: string
): Promise<ChunkPointerReadout> {
  if (typeof capsuleId !== "string" || !CAPSULE_ID_REGEX.test(capsuleId)) {
    failClosed("[AETERNA] Invalid capsule ID");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

  try {
    const res = await fetch(
      `/api/capsule/${encodeURIComponent(capsuleId)}/chunk-pointers`,
      { cache: "no-store", signal: controller.signal }
    );

    if (!res.ok || res.status !== 200) {
      failClosed("[AETERNA] Chunk pointer fetch failed");
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      failClosed("[AETERNA] Invalid chunk pointer content type");
    }

    const payload: unknown = await res.json();

    const chunkPointers = assertChunkPointerResponse(payload, capsuleId);
    const container = readContainerPublication(payload, capsuleId);

    assertUnambiguousPublication(chunkPointers, container);

    return Object.freeze({ chunkPointers, container });
  } catch (cause) {
    if (import.meta.env.DEV) {
      console.error("[executor-hot] getChunkPointers failed", cause);
    }
    failClosed(
      cause instanceof Error
        ? cause.message
        : "[AETERNA] Chunk pointer fetch failed"
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read-only storage contract: the subset of StorageAdapter that
 * remains after the Creator-paid upload path replaced Executor Hot.
 */
/**
 * Read-only storage contract: the subset of StorageAdapter that
 * remains after the Creator-paid upload path replaced Executor Hot.
 *
 * `downloadRange` is REQUIRED here even though it is optional on the
 * general StorageAdapter contract: this adapter does support bounded
 * range reads, and callers of the read transport must be able to rely
 * on that without an extra presence check.
 */
export type ExecutorReadStorageAdapter = Pick<
  StorageAdapter,
  "name" | "download" | "getManifest" | "getChunkPointers" | "getChunkPointerReadout"
> & {
  downloadRange(
    pointer: StoragePointer,
    offset: number,
    length: number
  ): Promise<Uint8Array<ArrayBuffer>>;
};

export const executorStorage: ExecutorReadStorageAdapter = {
  name: "executor-hot",


  async download(txId: StoragePointer): Promise<Uint8Array<ArrayBuffer>> {
    assertStoragePointer(txId);

    for (const gateway of GATEWAYS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

      try {
        const url = gateway.endsWith("/") ? gateway + txId : gateway + "/" + txId;

        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });

        if (!res.ok || res.status !== 200) continue;

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/html")) continue;

        const buffer = await res.arrayBuffer();

        if (buffer.byteLength === 0 || buffer.byteLength > MAX_DOWNLOAD_SIZE) {
          continue;
        }

        clearTimeout(timeout);
        return new Uint8Array(buffer);
      } catch (cause) {
        if (import.meta.env.DEV) {
          console.warn(`[executor-hot] gateway failed: ${gateway}`, cause);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    failClosed("[AETERNA] All gateways failed");
  },

  /**
   * Bounded range read.
   *
   * Reads exactly `length` bytes starting at `offset` of the object
   * identified by `txId`, using the proven Irys/Arweave range
   * endpoint:
   *
   *   GET https://<gateway>/tx/<txId>/data
   *   Range: bytes=<offset>-<offset + length - 1>
   *
   * Contract (all fail-closed):
   *
   * • pointer, offset and length are validated before any I/O
   * • a successful read MUST be HTTP 206 (Partial Content)
   * • the received body MUST be EXACTLY `length` bytes
   * • a 200 (full-object) response is NEVER accepted — the caller
   *   asked for a bounded window, and a gateway that ignores Range
   *   is not a valid range source
   * • 4xx/5xx, empty bodies, HTML error pages and short/long bodies
   *   are rejected
   * • no silent full-object fallback exists on any path
   *
   * `Content-Range` is deliberately NOT required: Stage 0 proved the
   * Irys gateway/CDN path returns it unreadable (null) to the browser
   * even on a correct 206, so it cannot be a gate.
   *
   * Gateways are tried in the same order as `download()`: a gateway
   * that cannot serve a correct 206 window is skipped, and if none
   * can, the call fails closed. Skipping is NOT a fallback — a
   * full-object response is never used to satisfy a range read.
   */
  async downloadRange(
    txId: StoragePointer,
    offset: number,
    length: number
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertStoragePointer(txId);

    const window = assertRangeWindow(offset, length);

    for (const gateway of GATEWAYS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

      try {
        const url = buildRangeUrl(gateway, txId);

        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Range: `bytes=${window.offset}-${window.end}`,
          },
        });

        // A range read is only satisfied by Partial Content.
        if (res.status !== 206) continue;

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/html")) continue;

        const buffer = await res.arrayBuffer();

        // Exact-length contract: a short or long body is a
        // gateway/protocol failure, never a partial success.
        if (buffer.byteLength !== window.length) continue;

        clearTimeout(timeout);
        return new Uint8Array(buffer);
      } catch (cause) {
        if (import.meta.env.DEV) {
          console.warn(`[executor-hot] gateway range failed: ${gateway}`, cause);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    failClosed("[AETERNA] Range read failed");
  },

  async getManifest(capsuleId: string): Promise<ManifestV1> {
    if (typeof capsuleId !== "string" || !CAPSULE_ID_REGEX.test(capsuleId)) {
      failClosed("[AETERNA] Invalid capsule ID");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

    try {
      const res = await fetch(
        `/api/capsule/${encodeURIComponent(capsuleId)}`,
        { cache: "no-store", signal: controller.signal }
      );

      if (!res.ok || res.status !== 200) {
        failClosed("[AETERNA] Manifest fetch failed");
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        failClosed("[AETERNA] Invalid manifest content type");
      }

      const manifest: unknown = await res.json();

      assertStrictManifestShape(manifest, capsuleId);

      assertStoragePointer(manifest.vaultTxId);

      return manifest;
    } catch (cause) {
      if (import.meta.env.DEV) {
        console.error("[executor-hot] getManifest failed", cause);
      }
      failClosed(
        cause instanceof Error
          ? cause.message
          : "[AETERNA] Manifest fetch failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  },

  async getChunkPointers(
    capsuleId: string
  ): Promise<
    Readonly<Record<
      ChunkId,
      StoragePointer
    >>
  > {
    const readout = await fetchChunkPointerReadout(capsuleId);

    return readout.chunkPointers;
  },

  /**
   * Stage 4.5 — the additive readout: the legacy per-chunk pointer map PLUS
   * the container publication record when the capsule was published as ONE
   * media container. Legacy capsules get `container: null` and behave
   * exactly as before.
   */
  async getChunkPointerReadout(
    capsuleId: string
  ): Promise<ChunkPointerReadout> {
    return fetchChunkPointerReadout(capsuleId);
  },
};