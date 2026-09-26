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
 * PERSISTENCE MODEL (C=2 prerequisite):
 *
 *   One KV key PER CHUNK:
 *     chunk-pointer-entry:<capsuleId>:<chunkId>
 *
 *   The previous model stored the WHOLE capsule map under a single
 *   key and updated it with a read-modify-write. That is a proven
 *   lost-update race under concurrent chunk claims: two claims both
 *   read the same blob, each adds its own chunk to a private copy,
 *   and the second `put` overwrites the first, silently dropping a
 *   pointer (KV has no CAS / transaction). Per-chunk keys remove the
 *   shared mutable object entirely: concurrent claims for DIFFERENT
 *   chunkIds write DIFFERENT keys and cannot lose each other.
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
 *   - authorization policy;
 *   - API behavior.
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
 * file only depends on the surface it actually uses.
 *
 * `list` is part of the contract because the per-chunk key model
 * reconstructs the capsule map by prefix-listing the chunk entries.
 * This mirrors the real Cloudflare KV binding, which provides
 * `list({ prefix, cursor, limit })`.
 */
export interface ChunkPointerEntryKey {
  name: string;
}

export interface ChunkPointerRegistryKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: ChunkPointerEntryKey[];
    list_complete: boolean;
    cursor?: string;
  }>;
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

const REGISTRY_ENTRY_PREFIX = "chunk-pointer-entry:";

/**
 * Canonical per-chunk KV key.
 *
 * chunkId is a 64-char lowercase hex sha256 and capsuleId is 64-char
 * lowercase hex, so the `:` delimiter cannot collide with either
 * component and the capsule-scoped prefix cannot leak across capsules.
 */
export function chunkPointerEntryKey(
  capsuleId: string,
  chunkId: string
): string {
  return `${REGISTRY_ENTRY_PREFIX}${capsuleId}:${chunkId}`;
}

/**
 * Canonical prefix scoping every chunk entry of one capsule.
 */
export function chunkPointerEntryPrefix(
  capsuleId: string
): string {
  return `${REGISTRY_ENTRY_PREFIX}${capsuleId}:`;
}

/**
 * Extract the chunkId from a listed entry key.
 *
 * Only the KNOWN prefix is removed; the remainder is the chunkId.
 * Returns null when the key does not belong to this capsule's prefix
 * (defensive: a foreign key must never be coerced into this map).
 */
function chunkIdFromEntryKey(
  capsuleId: string,
  name: string
): string | null {
  const prefix = chunkPointerEntryPrefix(capsuleId);
  if (!name.startsWith(prefix)) {
    return null;
  }
  const chunkId = name.slice(prefix.length);
  return chunkId.length > 0 ? chunkId : null;
}

/**
 * Load one chunk's StoragePointer, if the Registry has an entry.
 *
 * Returns null when no entry exists. An unreadable/malformed stored
 * value is NOT silently treated as absent — the caller's `get()` will
 * surface a rejection and the caller fails closed.
 */
export async function getChunkPointerEntry(
  env: ChunkPointerRegistryKV,
  capsuleId: CapsuleId,
  chunkId: ChunkId
): Promise<string | null> {

  return await env.CHUNK_POINTER_REGISTRY.get(
    chunkPointerEntryKey(capsuleId, chunkId)
  );

}

/**
 * Persist ONE chunk pointer entry.
 *
 * Single-key write, no read-modify-write: two concurrent calls for
 * different chunkIds cannot lose each other's pointer.
 */
export async function putChunkPointerEntry(
  env: ChunkPointerRegistryKV,
  capsuleId: CapsuleId,
  chunkId: ChunkId,
  pointer: StoragePointer
): Promise<void> {

  await env.CHUNK_POINTER_REGISTRY.put(
    chunkPointerEntryKey(capsuleId, chunkId),
    pointer
  );

}

/**
 * Load the existing Chunk Pointer Registry entries for a capsule.
 *
 * Reconstructs the full map by PREFIX-LISTING every per-chunk entry
 * and reading each value. Returns an empty map if no entries exist
 * yet (e.g. a capsule with no media chunks). Does not consult Manifest
 * data in any way.
 *
 * Pagination is mandatory, not cosmetic:
 *   - KV `list()` returns at most 1,000 keys per page by default;
 *   - `list_complete === false` means MORE keys remain even when the
 *     returned `keys` array is empty (recently expired/deleted keys
 *     are iterated through but omitted), so `keys.length === 0` is
 *     NEVER a termination signal;
 *   - the SAME prefix must be resupplied on every page.
 */
export async function getChunkPointerMap(
  env: ChunkPointerRegistryKV,
  capsuleId: CapsuleId
): Promise<ChunkPointerMap> {

  const prefix = chunkPointerEntryPrefix(capsuleId);

  const names: string[] = [];

  let cursor: string | undefined = undefined;

  for (;;) {

    const page = await env.CHUNK_POINTER_REGISTRY.list(
      cursor === undefined ? { prefix } : { prefix, cursor }
    );

    for (const key of page.keys) {
      names.push(key.name);
    }

    if (page.list_complete) break;

    if (!page.cursor) break;

    cursor = page.cursor;

  }

  const map: Record<ChunkId, StoragePointer> = {};

  for (const name of names) {

    const chunkId = chunkIdFromEntryKey(capsuleId, name);

    if (chunkId === null) {
      // A key under this capsule's prefix but with no chunkId is
      // malformed registry state — fail closed rather than silently
      // dropping it (a dropped pointer becomes "Missing storage
      // pointer" at open time, which is worse than a loud failure).
      throw new Error(
        "[AETERNA] Chunk Pointer Registry entry is malformed"
      );
    }

    const value = await env.CHUNK_POINTER_REGISTRY.get(name);

    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        "[AETERNA] Chunk Pointer Registry entry is unreadable"
      );
    }

    map[chunkId] = value as StoragePointer;

  }

  return Object.freeze(map);

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

  const pointer = await getChunkPointerEntry(env, capsuleId, chunkId);

  return pointer === null ? null : (pointer as StoragePointer);

}

/**
 * Persist Chunk Pointer Registry entries for a capsule.
 *
 * Writes each entry under its own per-chunk key. `entries` is merged
 * into any existing map for this capsuleId. This module does not
 * impose duplicate-entry rejection, overwrite rejection, or any other
 * update policy beyond this merge — canon does not yet define such
 * policy, and this file is the persistence abstraction only.
 */
export async function putChunkPointerEntries(
  env: ChunkPointerRegistryKV,
  capsuleId: CapsuleId,
  entries: ChunkPointerMap
): Promise<ChunkPointerMap> {

  for (const [chunkId, pointer] of Object.entries(entries)) {

    await putChunkPointerEntry(
      env,
      capsuleId,
      chunkId as ChunkId,
      pointer
    );

  }

  return getChunkPointerMap(env, capsuleId);

}
