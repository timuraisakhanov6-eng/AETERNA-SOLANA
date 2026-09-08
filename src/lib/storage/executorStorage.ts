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
 * Read-only storage contract: the subset of StorageAdapter that
 * remains after the Creator-paid upload path replaced Executor Hot.
 */
export type ExecutorReadStorageAdapter = Pick<
  StorageAdapter,
  "name" | "download" | "getManifest" | "getChunkPointers"
>;

export const executorStorage: ExecutorReadStorageAdapter = {
  name: "executor-hot",


  async download(txId: StoragePointer): Promise<Uint8Array> {
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

      return assertChunkPointerResponse(
        payload,
        capsuleId
      );
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
  },
};