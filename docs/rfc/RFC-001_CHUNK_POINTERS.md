# RFC-001 — Chunk Pointer Extraction from Vault to Manifest

Status: proposed (pending implementation)
Authority: canonical implementation alignment (manifest extension + runtime resolution)
Scope: media chunk publication metadata
Vault protocol version: V2 (unchanged)
Manifest version affected: V1 (ext extension only, no version bump)

---

## 1. Problem

`MediaItemV2.chunks` is currently typed as `readonly PublishedChunkMetadata[]`
(`types/vault.ts`), i.e. Vault items are declared to always carry a permanent
storage `pointer` per chunk.

In practice, the sealing pipeline cannot satisfy this:

```
preparePreparedCapsule.ts
  toVaultItems(items, getMediaFile, chunkMetadata)   // chunkMetadata: ChunkMetadata[] — no pointer yet
  prepareVault(...)                                   // serializes vaultBytes from the above
  prepareEncryptedCapsule(...)                         // encryptedPayload = encrypt(vaultBytes)
                                                        // vaultSha256 = sha256(encryptedPayload)
  → PREPARED boundary reached, before payment
```

`pointer` only exists after chunks are actually published:

```
sealCapsuleCore.ts (runs after payment)
  uploadPreparedChunks(runtime, chunkMetadata, token)
    → returns PublishedChunkMetadata[] (has pointer)
    → used only to check .length and uniqueness
    → discarded — never merged back into vaultBytes / encryptedPayload
```

`encryptedPayload` — the thing actually uploaded as the Vault and referenced
by `manifest.vaultTxId` — was finalized at PREPARE, before `pointer` existed.
It is never re-serialized or re-encrypted after upload. As a result the
published Vault's `chunks[].pointer` is always `undefined`, which is what
Runtime observes on open (`[CHUNK POINTER] { pointerType: "undefined" }`).

## 2. Canonical invariants

- `docs/canonical/INVARIANTS.md §2.4` — *"vaultSha256 MUST bind encrypted
  vault integrity."* `vaultSha256` is computed once
  (`prepareEncryptedCapsule.ts`, before payment) and never recomputed;
  `openCapsule.ts` verifies the downloaded ciphertext against this exact
  hash. This means `encryptedPayload` bytes cannot change after PREPARE
  without violating the invariant.
- `docs/canonical/VAULT_EVOLUTION.md §9 "Media Evolution"` — required
  properties are *encrypted chunk semantics, deterministic ordering,
  integrity verification, replay resistance*. Storage/transport pointer
  location is not listed as required Vault content anywhere in this
  document.
- `docs/canonical/VAULT_EVOLUTION.md §13 "Breaking Change Rule"` — breaking
  vault changes require a new vault version. This proposal does not touch
  serialization, envelope structure, or the decrypt pipeline, so it is not
  a breaking change under this section.
- `docs/canonical/MANIFEST_EVOLUTION.md §7 "Extension Fields"` — `ext` MAY
  contain protocol extensions provided they remain deterministic, preserve
  fail-closed semantics, avoid authority escalation, and preserve
  compatibility boundaries.

## 3. Conflict analysis

`types/vault.ts` carries a non-canonical comment on `MediaItemV2.chunks`:

> "Vault always stores the published representation."

This statement is not supported by `VAULT_EVOLUTION.md`, which never
requires storage pointers as Vault content, and it directly conflicts with
`INVARIANTS.md §2.4`: if pointers were part of Vault content, `vaultSha256`
could only be computed after upload/payment, which breaks the pre-payment
hash-commitment model that `Business Quote` / seal / verify currently rely
on. Per the repository's canonical documentation hierarchy, the canonical
documentation takes precedence over implementation-level comments.

Normative protocol behavior is defined by:

- AETERNA Complete Engineering Model
- AETERNA Complete Project Logic
- AETERNA Complete System Logic
- Applicable Canonical Specifications

The implementation comment is therefore inconsistent with the canonical
documentation and is superseded by it; the hash-commitment design is not
in question.

## 4. Proposed change

- Vault (`MediaItemV2.chunks`) stores transport-independent chunk metadata
  only — no `pointer`. Today that shape is `ChunkMetadata`, which is what
  the pipeline already produces at PREPARE time; the type is brought in
  line with reality. The RFC does not pin the model to this specific
  TypeScript interface name — a future `ChunkMetadataV2` / `ChunkLocator`
  rename is compatible with this proposal as long as it stays
  transport-independent (no storage pointer, no publication state).
- `Manifest.ext.chunkPointers: Readonly<Record<ChunkId, ArweaveTxId>>` is
  introduced, populated from `PublishedChunkMetadata[]` returned by
  `uploadPreparedChunks()`, after payment, before manifest is persisted.
  The mapping is canonicalized by `chunkId` and MUST contain exactly one
  entry for every chunk referenced by the Vault. `chunkPointers` is
  publication metadata and MUST NOT participate in Vault hashing,
  encryption, or `vaultSha256` computation.
- The set of `chunkId` values referenced by the Vault MUST exactly match
  the key set of `Manifest.ext.chunkPointers` — no extra keys, no missing
  keys, no ambiguity.
- Runtime performs deterministic publication resolution — mapping
  `chunkId → pointer` — via `manifest.ext.chunkPointers` when
  constructing an `OpenMediaRequest`, producing the
  `PublishedChunkMetadata[]` that `ByteRuntime` already expects. Runtime
  MUST verify that every Vault chunk has exactly one corresponding
  Manifest pointer before constructing `PublishedChunkMetadata[]`. Missing
  a pointer for any `chunkId` is a fail-closed error, not a silent
  `undefined`.
- Emergency Runtime is updated to the same resolution step, since it
  reuses the same Vault/Manifest formats.

## 5. Security rationale

Chunk pointers are publication metadata, not cryptographic state. Moving
them from Vault commitment to Manifest extension does not weaken
confidentiality, authenticity, or integrity, because:

- pointers are public transport identifiers, not secrets — Executor and
  the Storage Layer already handle them without ever holding decrypt
  authority (per the creator/recipient path description: Executor never
  receives the user secret, the encryption key, or plaintext);
- `vaultSha256` continues to commit the encrypted Vault bytes exactly as
  before — this proposal does not touch what is hashed or when. This
  proposal does not alter the byte sequence committed by `vaultSha256`;
  only Manifest publication metadata is extended;
- Manifest remains the trusted publication authority Runtime already
  relies on (it is already the source of `vaultTxId` and
  `manifest.ext.vaultSha256`); adding `chunkPointers` extends an
  authority boundary that already exists rather than introducing a new
  one;
- a missing `chunkId → pointer` mapping fails closed (explicit error),
  never silently substituted or skipped;
- Runtime only resolves pointers it is given by Manifest — it never
  derives, guesses, or synthesizes a pointer value. Pointer authenticity
  is inherited from Manifest authenticity; Runtime performs only
  deterministic resolution.

## 6. Compatibility

Unaffected by this change:
- AES-GCM encryption / `encryptVault`
- `canonicalSerializeVaultV2` (Vault V2 serialization format)
- `vaultSha256` computation and verification
- `encryptedPayload` / envelope structure
- `ByteRuntime`, `chunkLoader` internals (still consume
  `PublishedChunkMetadata[]`, just resolved one layer earlier — at the
  Runtime boundary instead of inside Vault)
- `Manifest` stable fields (`version`, `capsuleId`, `openAt`, `sealedAt`,
  `saltBase`, `vaultTxId`, `encryptedSizeBytes`) — untouched
- Manifest version stays V1 (additive `ext` field only, per
  `MANIFEST_EVOLUTION.md §5/§7`)
- Vault version stays V2 (no serialization change, per
  `VAULT_EVOLUTION.md §13`)

Old manifests sealed before this change will not carry `chunkPointers` and
will fail closed under the updated Runtime — consistent with
`MANIFEST_EVOLUTION.md §7` ("Unknown extensions MUST fail closed when
required by security semantics"). Capsules sealed under the previous
implementation do not contain `chunkPointers`. Under the updated Runtime
they will fail closed, which is consistent with the protocol's security
model.

## 7. Runtime invariant

Manifest generation MUST verify, at publication time:

1. Every uploaded chunk appears exactly once.
2. Every Vault `chunkId` has exactly one uploaded chunk.
3. No uploaded `chunkId` exists that is absent from the Vault.
4. `chunkPointers` is generated only after these checks succeed.
   `chunkPointers` MUST be derived exclusively from the verified
   `PublishedChunkMetadata[]` returned by `uploadPreparedChunks()` — no
   alternative source may populate this mapping.

This moves the chunkId/pointer correspondence check into the publication
path itself, so a mismatch is caught in `sealCapsuleCore.ts` before
`Manifest` is ever persisted — not only later, on open.

Before any media chunk download begins:

1. Vault MUST be successfully decrypted.
2. Manifest MUST be successfully verified.
3. Every Vault `chunkId` MUST resolve to exactly one Manifest
   `chunkPointer`.
4. Only then MAY `PublishedChunkMetadata[]` be constructed.
5. `ByteRuntime` MUST never observe unresolved `ChunkMetadata`.
   `PublishedChunkMetadata[]` MUST be fully constructed before any
   `ByteRuntime` instance is created — no intermediate state may exist
   in which a `ByteRuntime` instance holds partially resolved chunk
   data.

## 8. Files affected

| File | Change |
|---|---|
| `src/types/vault.ts` | `MediaItemV2.chunks` → `readonly ChunkMetadata[]`; correct the stale comment |
| `src/types/manifest.ts` | `ManifestIntegrityExt` gains `chunkPointers: Readonly<Record<string, ArweaveTxId>>` |
| `src/lib/capsule/sealCapsuleCore.ts` | Build `chunkPointers` map from `uploadedChunks` (already computed, currently discarded); include in `finalManifest.ext` |
| `src/pages/capsule/CapsuleOpened.tsx` | Pass `manifest` (or derived `chunkPointers`) down to `VaultRenderer` |
| `src/pages/capsule/VaultRenderer.tsx` | Thread the new prop through to `MediaItemV2Block`; resolve `item.chunks` → `PublishedChunkMetadata[]` via `chunkPointers` before building `OpenMediaRequest.media` |
| `src/lib/capsule/open/openTypes.ts` | Confirm/document that `OpenMediaRequest.media.chunks` is `PublishedChunkMetadata[]` (resolved, not raw Vault data) |
| Emergency Runtime equivalent of `VaultRenderer`/`openRuntime` | Same resolution step, for parity per `VAULT_EVOLUTION.md §11 "Runtime Parity"` |

Not touched: `ByteRuntime`, `chunkLoader`, `toVaultItems.ts`, `prepareVault.ts`,
`prepareEncryptedCapsule.ts`, `uploadPreparedChunks.ts`, any crypto module.

## 9. Rollout order

1. **Types** — `types/vault.ts`, `types/manifest.ts`. Compile-only change;
   expect type errors at every call site that assumed `pointer` existed
   inside Vault items — these mark exactly the code that needs updating.
2. **Publication** — `sealCapsuleCore.ts`. Build and attach `chunkPointers`,
   enforcing the publication-time checks from §7 (Runtime invariant)
   before `chunkPointers` is generated.
   Before implementing, verify every construction and merge site of
   `Manifest.ext` (there may be more than one): confirm each is built
   additively (`{ ...manifest.ext, vaultSha256 }`) and not by
   object-literal replacement (`{ vaultSha256 }`). If the latter is found
   anywhere, it must be corrected first, or attaching `chunkPointers`
   could silently drop other existing `ext` fields.
3. **Runtime** — `CapsuleOpened.tsx`, `VaultRenderer.tsx`, `openTypes.ts` /
   resolution point. Build after each file to confirm no other consumer
   depends on the old shape.
4. **Emergency Runtime** — bring to parity with step 3.

Build/typecheck after each stage before proceeding to the next.