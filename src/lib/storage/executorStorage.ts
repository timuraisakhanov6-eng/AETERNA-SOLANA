import type {
  StorageAdapter,
  StoragePointer,
  UploadToken,
} from "./storageAdapter";

import {
  assertChunkPointerMap,
  assertStoragePointer,
  assertUploadToken,
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
 * AETERNA — Executor Hot storage transport
 *
 * Implements the canonical client transport described in
 * AETERNA_EXECUTOR_PUBLICATION_SPEC_v1, Section 3 (Publication Law):
 * the client never talks to the storage provider directly. It calls
 * POST /api/upload; Executor Hot funds, signs, and submits the
 * publication server-side.
 *
 * This is the sole StorageAdapter implementation. upload()/download()
 * take only (data, uploadToken) / (pointer). capsuleId is deliberately
 * not part of this signature; the server resolves it from the Upload
 * Token record itself (see functions/api/upload.ts).
 */

const UPLOAD_ENDPOINT = "/api/upload";

const MAX_UPLOAD_SIZE = 256 * 1024 * 1024;
const MAX_DOWNLOAD_SIZE = 256 * 1024 * 1024;

const GATEWAY_TIMEOUT = 8000;
const UPLOAD_TIMEOUT = 120000;

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

function devLog(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
}

function failClosed(reason?: string): never {
  throw new Error(reason ?? "[AETERNA] Fail closed");
}

function isDetachedBuffer(arr: Uint8Array): boolean {
  return arr.byteLength === 0 || arr.buffer.byteLength === 0;
}

/**
 * Transport encoding only.
 *
 * Base64 is how ciphertext bytes travel inside a JSON request body —
 * it has no cryptographic meaning of its own. The Vault's ciphertext
 * representation is unchanged; this function does not touch, derive
 * from, or participate in any cryptographic authority.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
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

export const executorStorage: StorageAdapter = {
  name: "executor-hot",

  async upload(
    data: Uint8Array,
    uploadToken: UploadToken
  ): Promise<{ txId: StoragePointer }> {
    assertUploadToken(uploadToken);

    if (
      !(data instanceof Uint8Array) ||
      isDetachedBuffer(data) ||
      data.byteLength === 0 ||
      data.byteLength > MAX_UPLOAD_SIZE
    ) {
      failClosed("[AETERNA] Invalid upload data");
    }

  /**
   * Defensive transport copy.
   *
   * Upload transport owns this buffer.
   *
   * The original ciphertext remains owned by the caller
   * (PreparedCapsule / Runtime pipeline).
   *
   * The transport layer may safely wipe this temporary
   * copy after publication without mutating the caller's
   * buffer.
   */

    const normalized = data.slice();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT);

    try {
      const ciphertext = toBase64(normalized);

      const res = await fetch(UPLOAD_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          uploadToken,
          ciphertext,
          // Declared ciphertext size. Used only for transport
          // integrity (server-side size-mismatch rejection, Upload
          // Law step 9) — it is not trusted as Business Authority.
          // Pricing was already fixed by the Business Quote before
          // this request exists; this field cannot change it.
          declaredSize: normalized.byteLength,
        }),
      });

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        failClosed("[AETERNA] Invalid upload response");
      }

      const parsed = json as Record<string, unknown> | null;

      if (
        !res.ok ||
        !parsed ||
        typeof parsed !== "object" ||
        parsed["ok"] !== true ||
        typeof parsed["storagePointer"] !== "string"
      ) {
        failClosed("[AETERNA] Upload failed");
      }

      const pointer = parsed["storagePointer"] as string;

      devLog("[executor-hot] upload complete");

      return { txId: assertStoragePointer(pointer) };
    } catch (cause) {
      if (import.meta.env.DEV) {
        console.error("[executor-hot] upload failed", cause);
      }
      failClosed(
        cause instanceof Error ? cause.message : "[AETERNA] Upload failed"
      );
    } finally {
      normalized.fill(0);
      clearTimeout(timeoutId);
    }
  },

  async uploadChunk(
    data: Uint8Array,
    chunkId: ChunkId,
    uploadToken: UploadToken
  ): Promise<{ txId: string }> {
    assertUploadToken(uploadToken);

    // Mandatory chunkId boundary:
    // chunkId REQUIRED
    // NO chunkId → NO UPLOAD
    if (typeof chunkId !== "string" || chunkId.length === 0) {
      failClosed("[AETERNA] Invalid chunkId");
    }

    if (
      !(data instanceof Uint8Array) ||
      isDetachedBuffer(data) ||
      data.byteLength === 0 ||
      data.byteLength > MAX_UPLOAD_SIZE
    ) {
      failClosed("[AETERNA] Invalid upload data");
    }

    const normalized = data.slice();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT);

    try {
      const ciphertext = toBase64(normalized);

      const res = await fetch(UPLOAD_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          uploadToken,
          ciphertext,
          // Mandatory chunkId binding: the Storage Authority
          // receives the canonical chunkId (SHA-256 of the chunk
          // ciphertext, produced by prepareMediaChunks) so it can
          // bind the returned pointer in the Chunk Pointer Registry.
          chunkId,
          declaredSize: normalized.byteLength,
        }),
      });

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        failClosed("[AETERNA] Invalid upload response");
      }

      const parsed = json as Record<string, unknown> | null;

      if (
        !res.ok ||
        !parsed ||
        typeof parsed !== "object" ||
        parsed["ok"] !== true ||
        typeof parsed["storagePointer"] !== "string"
      ) {
        failClosed("[AETERNA] Upload failed");
      }

      const pointer = parsed["storagePointer"] as string;

      devLog("[executor-hot] uploadChunk complete");

      return { txId: assertStoragePointer(pointer) };
    } catch (cause) {
      if (import.meta.env.DEV) {
        console.error("[executor-hot] uploadChunk failed", cause);
      }
      failClosed(
        cause instanceof Error ? cause.message : "[AETERNA] Upload failed"
      );
    } finally {
      normalized.fill(0);
      clearTimeout(timeoutId);
    }
  },

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