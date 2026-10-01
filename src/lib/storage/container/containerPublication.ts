/**
 * =========================================================
 * AETERNA — Container publication record (Stage 4, Model 3)
 * =========================================================
 *
 * ONE authoritative publication record per container capsule:
 *
 *   capsule/lifecycle binding
 *        ↓
 *   containerTxId
 *        ↓
 *   canonical ORDERED logical chunk identity
 *        ↓
 *   physical chunk map DERIVED at read time (Stage 2 layout)
 *
 * WHY THIS SHAPE
 * --------------
 * The physical container is `[HEADER][CHUNK 0]…[CHUNK N-1]` with NO index
 * (Stage 2). Offsets are therefore NOT stored: they are reproduced at read
 * time from the canonical ordered chunk metadata that the Vault already
 * carries (`items[].chunks: ChunkMetadata[]`).
 *
 * What is stored is only what CANNOT be derived:
 *   • the container txId (the publication fact);
 *   • the authority binding (capsuleId / lifecycleId / creatorIdentityId);
 *   • the ORDERED chunk identity list (which exact chunk set was published);
 *   • a digest over the canonical layout descriptor, so the reader can prove
 *     the Vault-derived layout is the one that was published.
 *
 * What is deliberately NOT stored:
 *   • per-chunk storage pointers (that would be N redundant records);
 *   • per-chunk offsets / lengths (derivable);
 *   • the chunk metadata itself (the Vault already holds it).
 *
 * This module is shared by the Cloudflare Functions (claim/read APIs) and
 * the SPA (read-time resolution), so the layout descriptor — and therefore
 * the digest — is defined exactly once.
 *
 * This module MUST NEVER: perform crypto beyond the layout digest, touch
 * the Vault, or implement HTTP routing.
 */

function failClosed(reason: string): never {
  throw new Error(reason);
}

export const CONTAINER_PUBLICATION_KIND = "container" as const;
export const CONTAINER_PUBLICATION_VERSION = 1;

export type ContainerPublicationState = "PENDING" | "VERIFIED" | "REJECTED";

/**
 * The authoritative container publication record.
 *
 * `state` mirrors the vault publication lifecycle so `/api/publication/verify`
 * can advance it the same way.
 */
export interface ContainerPublicationRecord {
  readonly kind: typeof CONTAINER_PUBLICATION_KIND;
  readonly version: number;
  readonly capsuleId: string;
  readonly lifecycleId: string;
  readonly creatorIdentityId: string;
  readonly containerTxId: string;
  /** Canonical ORDERED logical chunk identity (sha256 of ciphertext). */
  readonly chunkIds: readonly string[];
  /** sha256 hex of `canonicalContainerLayoutDescriptor(chunkMetadata)`. */
  readonly layoutDigest: string;
  readonly state: ContainerPublicationState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/* =========================
   KEYS
   ========================= */

/**
 * One key per capsule. A single key is naturally race-safe for the
 * "one container per capsule" rule: there is no shared mutable blob to
 * read-modify-write, and the key is unique per capsule by construction.
 */
export function containerPublicationKey(capsuleId: string): string {
  return `container-publication:${capsuleId}`;
}

/* =========================
   CANONICAL LAYOUT DESCRIPTOR
   ========================= */

/**
 * The exact bytes the layout digest covers.
 *
 * Deterministic, newline-delimited, no clock and no ordering ambiguity.
 * Includes BOTH the chunkId and the ciphertext size, so a digest match
 * proves the ordered chunk set AND its sizes — which is what fixes the
 * physical offsets.
 */
export function canonicalContainerLayoutDescriptor(
  entries: readonly { readonly chunkId: string; readonly size: number }[]
): string {
  if (!Array.isArray(entries)) {
    failClosed("[AETERNA] Invalid container layout entries");
  }

  const lines: string[] = [
    `AETC-LAYOUT v${CONTAINER_PUBLICATION_VERSION}`,
    `chunks:${entries.length}`,
  ];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (
      !entry ||
      typeof entry.chunkId !== "string" ||
      entry.chunkId.length === 0 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    ) {
      failClosed("[AETERNA] Invalid container layout entry");
    }
    lines.push(`${i}:${entry.chunkId}:${entry.size}`);
  }

  return lines.join("\n");
}

/**
 * sha256 hex of the canonical layout descriptor.
 *
 * Async because WebCrypto is async in every supported runtime (Workers,
 * browser, Node 20+).
 */
export async function computeContainerLayoutDigest(
  entries: readonly { readonly chunkId: string; readonly size: number }[]
): Promise<string> {
  const descriptor = canonicalContainerLayoutDescriptor(entries);

  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    failClosed("[AETERNA] WebCrypto is unavailable for the layout digest");
  }

  const bytes = new TextEncoder().encode(descriptor);
  const digest = await cryptoObj.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* =========================
   VALIDATION
   ========================= */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Fail-closed validation of a persisted container publication record.
 *
 * `capsuleId` is required so a record can never be read out of its own
 * capsule scope.
 */
export function assertContainerPublicationRecord(
  value: unknown,
  capsuleId: string
): ContainerPublicationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failClosed("[AETERNA] Invalid container publication record");
  }

  const r = value as Record<string, unknown>;

  if (r["kind"] !== CONTAINER_PUBLICATION_KIND) {
    failClosed("[AETERNA] Invalid container publication kind");
  }
  if (r["version"] !== CONTAINER_PUBLICATION_VERSION) {
    failClosed("[AETERNA] Unsupported container publication version");
  }
  if (r["capsuleId"] !== capsuleId) {
    failClosed("[AETERNA] Container publication capsule mismatch");
  }

  for (const field of ["lifecycleId", "creatorIdentityId"] as const) {
    const v = r[field];
    if (typeof v !== "string" || v.length === 0) {
      failClosed("[AETERNA] Invalid container publication binding");
    }
  }

  const txId = r["containerTxId"];
  if (typeof txId !== "string" || txId.length === 0) {
    failClosed("[AETERNA] Invalid container publication txId");
  }

  const digest = r["layoutDigest"];
  if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
    failClosed("[AETERNA] Invalid container layout digest");
  }

  const chunkIds = r["chunkIds"];
  if (!Array.isArray(chunkIds) || chunkIds.length === 0) {
    failClosed("[AETERNA] Invalid container chunk identity list");
  }

  const seen = new Set<string>();
  for (const chunkId of chunkIds) {
    if (typeof chunkId !== "string" || !SHA256_HEX.test(chunkId)) {
      failClosed("[AETERNA] Invalid container chunk identity");
    }
    if (seen.has(chunkId)) {
      failClosed("[AETERNA] Duplicate container chunk identity");
    }
    seen.add(chunkId);
  }

  const state = r["state"];
  if (state !== "PENDING" && state !== "VERIFIED" && state !== "REJECTED") {
    failClosed("[AETERNA] Invalid container publication state");
  }

  return Object.freeze({
    kind: CONTAINER_PUBLICATION_KIND,
    version: CONTAINER_PUBLICATION_VERSION,
    capsuleId,
    lifecycleId: r["lifecycleId"] as string,
    creatorIdentityId: r["creatorIdentityId"] as string,
    containerTxId: txId,
    chunkIds: Object.freeze([...(chunkIds as string[])]),
    layoutDigest: digest,
    state,
    createdAt: typeof r["createdAt"] === "number" ? r["createdAt"] : 0,
    updatedAt: typeof r["updatedAt"] === "number" ? r["updatedAt"] : 0,
  });
}

export interface BuildContainerPublicationArgs {
  capsuleId: string;
  lifecycleId: string;
  creatorIdentityId: string;
  containerTxId: string;
  chunkIds: readonly string[];
  layoutDigest: string;
  now: number;
}

export function buildContainerPublicationRecord(
  args: BuildContainerPublicationArgs
): ContainerPublicationRecord {
  return assertContainerPublicationRecord(
    {
      kind: CONTAINER_PUBLICATION_KIND,
      version: CONTAINER_PUBLICATION_VERSION,
      capsuleId: args.capsuleId,
      lifecycleId: args.lifecycleId,
      creatorIdentityId: args.creatorIdentityId,
      containerTxId: args.containerTxId,
      chunkIds: [...args.chunkIds],
      layoutDigest: args.layoutDigest,
      state: "PENDING",
      createdAt: args.now,
      updatedAt: args.now,
    },
    args.capsuleId
  );
}

/* =========================
   KV ACCESS
   ========================= */

export interface ContainerPublicationKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ContainerPublicationKV {
  PUBLICATION_VERIFICATIONS: ContainerPublicationKVNamespace;
}

/**
 * Reads the container publication record for a capsule.
 *
 * Returns null when the capsule has no container publication (legacy
 * capsules legitimately have none). A present-but-malformed record fails
 * closed rather than being treated as absent.
 */
export async function getContainerPublication(
  env: ContainerPublicationKV,
  capsuleId: string
): Promise<ContainerPublicationRecord | null> {
  const raw = await env.PUBLICATION_VERIFICATIONS.get(
    containerPublicationKey(capsuleId)
  );

  if (raw === null || raw === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failClosed("[AETERNA] Container publication record is unreadable");
  }

  return assertContainerPublicationRecord(parsed, capsuleId);
}

export async function putContainerPublication(
  env: ContainerPublicationKV,
  record: ContainerPublicationRecord
): Promise<void> {
  const validated = assertContainerPublicationRecord(record, record.capsuleId);

  await env.PUBLICATION_VERIFICATIONS.put(
    containerPublicationKey(validated.capsuleId),
    JSON.stringify(validated)
  );
}
