/**
 * AETERNA — Chunk Pointer Registry Store (Storage Authority)
 *
 * Canonical basis:
 *   - Storage Authority owns the Chunk Pointer Registry.
 *   - The Registry is an independent, persistent authority object.
 *   - The Registry is NOT part of Manifest Authority and is never
 *     read from or written into a Manifest record.
 *   - The Registry is created/persisted by the Storage Layer during
 *     upload, before Manifest creation.
 *   - Seal does not own or create the Registry.
 *   - Runtime later resolves chunkId -> StoragePointer through
 *     Storage Authority.
 *
 * This module represents only the canonical logical mapping:
 *
 *   chunkId -> StoragePointer
 *
 * scoped per capsuleId.
 *
 * This module MUST NEVER:
 *   - read from or write to CAPSULE_MANIFESTS;
 *   - import Manifest structural types (ManifestV1, ManifestIntegrityExt,
 *     Manifest.ext, etc.) or depend on Manifest.ext in any way;
 *   - implement HTTP routing;
 *   - perform encryption, decryption, hashing, trusted-time checks,
 *     payment logic, or sealing.
 *
 * This module deliberately does NOT define:
 *   - duplicate-entry semantics;
 *   - pointer-immutability policy;
 *   - migration policy;
 *   - authorization policy;
 *   - API behavior.
 *
 * None of the above are defined by canonical documentation at this
 * stage of the migration, and inventing them here would exceed this
 * file's scope. Such policy belongs in a later, explicitly reviewed
 * step, not in the persistence abstraction itself.
 */

import type { CapsuleId, ChunkId } from "@/types/manifest";
import type { StoragePointer } from "@/lib/storage/storageAdapter";

/**
 * Minimal structural KV contract.
 *
 * Deliberately NOT the full `KVNamespace` type from
 * `@cloudflare/workers-types`, and deliberately not bound to any
 * concrete Cloudflare binding here. The actual persistence backend
 * (KV, Durable Object, or otherwise) is wired in by the caller; this
 * file only depends on the minimal get/put surface it actually uses.
 */
export interface ChunkPointerRegistryKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ChunkPointerRegistryKV {
  CHUNK_POINTER_REGISTRY: ChunkPointerRegistryKVNamespace;
}

/**
 * Canonical logical mapping held by the Registry for one capsule.
 *
 * chunkId -> StoragePointer
 *
 * Reuses the existing canonical `ChunkId` (src/types/manifest.ts) and
 * `StoragePointer` (src/lib/storage/storageAdapter.ts) types rather
 * than inventing new identifier types.
 */
export type ChunkPointerMap = Readonly<Record<ChunkId, StoragePointer>>;

const REGISTRY_KEY_PREFIX = "chunk-pointer-registry:";

/**
 * Canonical persistence key for one capsule's Registry.
 */
function registryKey(capsuleId: CapsuleId): string {
  return `${REGISTRY_KEY_PREFIX}${capsuleId}`;
}

/**
 * Load the existing Chunk Pointer Registry entries for a capsule.
 *
 * Returns an empty map if no entries exist yet (e.g. a capsule with
 * no media chunks). Does not consult Manifest data in any way.
 */
export async function getChunkPointerMap(
  env: ChunkPointerRegistryKV,
  capsuleId: CapsuleId
): Promise<ChunkPointerMap> {

  const raw =
    await env.CHUNK_POINTER_REGISTRY.get(
      registryKey(capsuleId)
    );

  if (!raw) {
    return Object.freeze({});
  }

  return Object.freeze(
    JSON.parse(raw) as Record<ChunkId, StoragePointer>
  );

}

/**
 * Resolve a single chunkId to its StoragePointer, if the Registry
 * has an entry for it.
 */
export async function resolveChunkPointer(
  env: ChunkPointerRegistryKV,
  capsuleId: CapsuleId,
  chunkId: ChunkId
): Promise<StoragePointer | null> {

  const map =
    await getChunkPointerMap(
      env,
      capsuleId
    );

  return map[chunkId] ?? null;

}

/**
 * Persist Chunk Pointer Registry entries for a capsule.
 *
 * `entries` is merged into any existing map for this capsuleId and
 * the combined result is written back. This module does not impose
 * duplicate-entry rejection, overwrite rejection, or any other
 * update policy beyond this merge — canon does not yet define such
 * policy, and this file is the persistence abstraction only.
 */
export async function putChunkPointerEntries(
  env: ChunkPointerRegistryKV,
  capsuleId: CapsuleId,
  entries: ChunkPointerMap
): Promise<ChunkPointerMap> {

  const existing =
    await getChunkPointerMap(
      env,
      capsuleId
    );

  const merged: Record<ChunkId, StoragePointer> = {
    ...existing,
    ...entries,
  };

  await env.CHUNK_POINTER_REGISTRY.put(
    registryKey(capsuleId),
    JSON.stringify(merged)
  );

  return Object.freeze(merged);

}