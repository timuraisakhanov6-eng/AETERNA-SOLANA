# IMPLEMENTATION_MIGRATION_PLAN.md

Status: Approved Implementation Planning
Authority: Non-Canonical
Phase: Implementation Preparation

---

# Purpose

This document defines the implementation migration required to restore
implementation compliance with the approved canonical documentation.

This document is NOT part of the canonical protocol.

This document does NOT define protocol behavior.

It exists solely to guide implementation work.

If any statement in this document conflicts with the canonical documentation,
the canonical documentation always takes precedence.

Implementation exists to realize the canonical documentation.

Canonical documentation must never be rewritten to justify implementation.

---

# Scope

This document is limited to confirmed implementation deviations identified
during the Implementation Review phase.

It does not:

- modify the protocol;
- modify canonical documentation;
- redefine authorities;
- introduce new protocol behavior.

Any migration requiring protocol changes or additional protocol semantics
must be resolved through canonical documentation before implementation.

---

# Canonical Migration Plan (corrected attribution)

Correction applied per Documentation Manager review: the citation for the Emergency Runtime
server-independence requirement has been corrected. `INVARIANTS.md §7.2 Emergency Runtime
Independence` addresses React-runtime availability and local-only decrypt guarantees, not
server contact. The sole canonical source for "no AETERNA server contact for resolution or
key material" is `AETERNA_COMPLETE_SYSTEM_LOGIC.md — Emergency Runtime`. No other content in
this plan was changed.

---

## Deviation: `description` stored inside the Manifest

### 1. Canonical requirement
The surfaced canonical Manifest field set is closed to:
`version`, `capsuleId`, `sealedAt`, `openAt`, `vaultTxId`, `encryptedSizeBytes`, `saltBase`,
`heartbeatInterval`, `ext.vaultSha256`.
No other Manifest field is authoritative.
*Source: `AETERNA_COMPLETE_SYSTEM_LOGIC.md` — Manifest field list.*

### 2. Current implementation behavior
- `description` is part of the Manifest type.
- Seal flow conditionally writes `description` into the Manifest.
- Server read/seal validation and emergency runtime manifest validation explicitly allow `description`.

### 3. Canonical migration target
Preserve user-visible description functionality, but migrate it completely out of the Manifest
authority object.

Target state:
- Manifest contains only canonical fields.
- Description, if retained, is delivered through a non-Manifest, non-authority presentation path.

**Canonical clarification required.** The surfaced canonical materials establish that
`description` must not live in Manifest, but they do not identify a canonical non-Manifest
storage/transport path for preserving that UX field.

### 4. Minimal migration steps
1. Stop emitting `description` in newly sealed Manifests.
2. Remove `description` from canonical Manifest typing and from Manifest allowlists used by
   seal/read/emergency validation.
3. Isolate any remaining description display logic so it no longer depends on Manifest
   authority data.
4. Introduce the replacement presentation source only after the non-Manifest path is
   explicitly confirmed.

### 5. Temporary compatibility requirements
- Already-sealed legacy Manifests containing `description` should remain readable during migration.
- Legacy `description` must be treated as non-authoritative and must not participate in any
  authority, integrity, unlock, heartbeat, storage, or cryptographic decision.
- New seals must not produce `description` in Manifest, even while legacy reads remain tolerated.

### 6. Expected user-visible impact
- For newly sealed capsules, Manifest-based description display will stop unless the
  replacement presentation path is supplied.
- For legacy capsules, description can remain visible temporarily only through compatibility
  handling that ignores it for authority purposes.

### 7. Migration risk
Medium

### 8. Validation criteria proving canonical compliance
- Newly sealed Manifests contain only the surfaced canonical fields.
- No seal/read/open/emergency authority path depends on `description`.
- Description display, if retained, is sourced outside Manifest authority.
- Browser-side cryptography, trusted time, heartbeat, fail-closed behavior, and authority
  separation remain unchanged.

---

## Deviation: `ext.chunkPointers` added to the Manifest

### 1. Canonical requirement
- `ext.vaultSha256` is the mandatory Manifest integrity field.
- The canonical Manifest field set does not include chunk pointer data.
- The surfaced canonical materials recognize a Chunk Pointer Registry / lookup process outside
  the Manifest authority object.
*Source: `AETERNA_COMPLETE_SYSTEM_LOGIC.md` — Manifest field list; Chunk Pointer Registry
model.*

### 2. Current implementation behavior
- `ext.chunkPointers` is part of the Manifest type.
- Seal flow writes chunk pointer metadata into Manifest `ext`.
- Load/open/emergency validation paths expect and validate that Manifest structure.
- Runtime behavior resolves media publication metadata from the Manifest.

### 3. Canonical migration target
Preserve current chunked media functionality, but migrate chunk publication metadata out of
Manifest `ext` and into the canonical Chunk Pointer Registry / runtime resolution path.

Target state:
- Manifest `ext` contains canonical integrity data only.
- Chunk pointer resolution happens through Storage Authority / Chunk Pointer Registry rather
  than Manifest authority.

### 4. Minimal migration steps
1. Stop sealing `chunkPointers` into new Manifests.
2. Remove `chunkPointers` from Manifest schema/type/allowlists used as canonical authority checks.
3. Move runtime and emergency media resolution to the canonical Chunk Pointer Registry path.
4. Keep Vault hashing / `vaultSha256` / PREPARED immutability unchanged.

### 5. Temporary compatibility requirements
- Existing already-sealed capsules that only expose chunk pointers through Manifest data need
  a compatibility bridge during migration.
- That bridge must treat legacy Manifest `chunkPointers` as read-only legacy publication
  metadata, not as canonical Manifest authority.
- Compatibility must never reclassify legacy `chunkPointers` as canonical Manifest fields for
  new seals.

### 6. Expected user-visible impact
- If the compatibility bridge is present, existing media functionality can be preserved during
  migration with little or no visible change.
- Without the bridge, legacy media-opening behavior may regress for previously sealed capsules.

### 7. Migration risk
Medium

### 8. Validation criteria proving canonical compliance
- Newly sealed Manifests contain `ext.vaultSha256` only for integrity metadata.
- Media open/render flows still work through the Chunk Pointer Registry path.
- `vaultSha256` is still computed before payment and remains unchanged after publication.
- No runtime path requires Manifest-hosted chunk pointer authority for new capsules.
- Browser-side cryptography, non-custodial guarantees, authority separation, and fail-closed
  behavior remain intact.

---

## Deviation: Emergency Runtime depends on `/api/capsule/:capsuleId` for capsule resolution

### 1. Canonical requirement
Emergency Runtime must operate without contacting the AETERNA server for resolution or key
material. Emergency Runtime remains allowed to depend on Trusted Time for opening decisions
and may use heartbeat APIs if available, but server-side capsule resolution is out of bounds.
*Source: `AETERNA_COMPLETE_SYSTEM_LOGIC.md` — Emergency Runtime ("emergency.html CapsuleView
is a full-featured fallback... operates without contacting the AETERNA server for resolution
or key material"; "Emergency Runtime may use heartbeat APIs if available, but does not depend
on them for opening").*
*(Corrected: previously mis-cited as `INVARIANTS.md §7.2 Emergency Runtime Independence`.
§7.2 covers operation without React-runtime availability and local-only decrypt guarantees —
it does not address server contact and is not the source of this requirement.)*

### 2. Current implementation behavior
- `public/emergency.html` fetches the Manifest via `/api/capsule/:capsuleId`.
- Emergency startup therefore depends on AETERNA server-side capsule resolution.

### 3. Canonical migration target
Preserve emergency recovery functionality, but migrate Manifest resolution to a
non-AETERNA-server resolution path that matches surfaced canonical emergency rules.

**Canonical clarification required.** The surfaced materials clearly forbid AETERNA server
resolution in Emergency Runtime, but they do not explicitly identify the canonical replacement
resolution source/mechanism.

### 4. Minimal migration steps
1. Remove `/api/capsule/:capsuleId` as an Emergency Runtime resolution dependency.
2. Switch Emergency Runtime Manifest acquisition to the explicitly approved non-server
   resolution path once that path is confirmed.
3. Keep `/api/time` and heartbeat usage bounded to the already surfaced canonical rules.
4. Do not change key derivation, decrypt authority, or runtime cryptographic flow.

### 5. Temporary compatibility requirements
- Primary runtime may continue using current Manifest resolution while Emergency Runtime is
  migrated, since the confirmed deviation is specific to Emergency Runtime.
- Emergency Runtime should not silently fall back to AETERNA server resolution once the
  migration gate is active.
- If no approved replacement resolution source is available yet, Emergency Runtime should fail
  closed rather than use a forbidden resolution path.

### 6. Expected user-visible impact
- During transition, emergency recovery may remain limited until the canonical non-server
  resolution path is confirmed and connected.
- Once migrated, emergency access should preserve recovery behavior without depending on
  AETERNA server-side capsule lookup.

### 7. Migration risk
High

### 8. Validation criteria proving canonical compliance
- Emergency Runtime no longer calls `/api/capsule/:capsuleId`.
- Emergency Runtime still uses trusted time correctly for OPENABLE decisions.
- Emergency Runtime does not receive secrets or decryption capability from the server.
- If the approved non-server resolution path is unavailable, Emergency Runtime fails closed
  rather than degrading authority rules.

---

## Deviation: Emergency Runtime does not reconstruct/render opened media with primary-runtime parity

### 1. Canonical requirement
- Emergency Runtime is a full-featured fallback.
- It must remain capable of reconstructing media streams and rendering opened contents.
- A capsule that can be opened by the primary runtime must also be openable by Emergency Runtime.
*Source: `AETERNA_COMPLETE_SYSTEM_LOGIC.md` — "Post-open Recovery", "Disaster Recovery
Principle".*

### 2. Current implementation behavior
- After decrypt, Emergency Runtime renders media entries as metadata plus the placeholder
  text: `Preview unavailable — media recovery coming in next layer`.
- No emergency-path media reconstruction/rendering parity with the primary runtime was found.

### 3. Canonical migration target
Preserve current opened-media functionality by migrating Emergency Runtime to the same class
of canonical media reconstruction/rendering behavior already required by the surfaced
primary-runtime rules.

Target state:
- Emergency Runtime opens the same valid capsule payloads.
- Emergency Runtime reconstructs media streams.
- Emergency Runtime renders opened media contents rather than stopping at placeholder-only
  output.

### 4. Minimal migration steps
1. Replace placeholder-only emergency media handling with the canonical opened-media
   reconstruction/rendering path.
2. Align Emergency Runtime media resolution with the same canonical Chunk Pointer Registry
   source used after migration item 2.
3. Keep decrypt ordering, trusted-time gating, heartbeat enforcement, and authority boundaries
   identical to the primary runtime.
4. Limit the scope strictly to post-open media parity; do not expand protocol behavior.

### 5. Temporary compatibility requirements
- Text opening behavior can remain as-is while media parity is completed.
- Placeholder-only media UI should not be treated as a compliant final state for capsules that
  are otherwise validly openable.
- Any temporary fallback must fail closed rather than bypass media integrity or authority checks.

### 6. Expected user-visible impact
- Emergency Runtime should move from metadata-only media placeholders to actual opened-media
  recovery for canonically valid capsules.
- Users should see emergency behavior closer to primary runtime behavior once the migration is
  complete.

### 7. Migration risk
High

### 8. Validation criteria proving canonical compliance
- A capsule whose media opens in the primary runtime also opens in Emergency Runtime.
- Emergency Runtime reconstructs media streams without weakening validation.
- Emergency Runtime preserves local-only decrypt guarantees.
- Emergency Runtime does not bypass trusted time, heartbeat, manifest validation, or decrypt
  validation.
- Placeholder-only post-open media rendering is no longer the terminal behavior for valid
  openable capsules.

---

## Recommended migration order
1. Move chunk pointer authority out of Manifest while preserving media behavior.
2. Migrate Emergency Runtime media parity onto that canonical path.
3. Migrate Emergency Runtime away from AETERNA server-side capsule resolution once the
   canonical non-server resolution source is explicitly confirmed.
4. Remove `description` from Manifest while preserving description UX through an approved
   non-authority path.