Status: Repository-verified

This document records deviations between implementation and canonical
documentation, verified directly against files in this repository.

---

# Verified deviations

## 1. `description` stored inside the Manifest

Canonical Manifest field list, `docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md`
("Core Entities" / "2. Manifest"):

- Canonical fields: version, capsuleId, sealedAt, openAt, vaultTxId,
  encryptedSizeBytes, saltBase, heartbeatInterval, ext.vaultSha256.
- Explicit closure statement: "These are the only canonical Manifest
  fields ... No other description of Manifest fields is authoritative."

`description` is not part of this list. Its presence in the Manifest type
and in seal/read/emergency validation allowlists is a confirmed deviation.

## 2. `ext.chunkPointers` added to the Manifest

Same canonical field list confirms `ext.vaultSha256` as the sole mandatory
`ext` field. `AETERNA_COMPLETE_SYSTEM_LOGIC.md` further establishes a
distinct Chunk Pointer Registry as the canonical home for chunk-to-storage
mapping ("Storage pointers are not part of chunkMetadata and are not part
of the immutable core. The Chunk Pointer Registry is the sole surface for
chunk-to-storage-pointer mapping"). Storing `chunkPointers` inside Manifest
`ext` is a confirmed deviation from this model.

## 3. Emergency Runtime depends on `/api/capsule/:capsuleId`

`AETERNA_COMPLETE_SYSTEM_LOGIC.md` ("Emergency Runtime"): "emergency.html
CapsuleView is a full-featured fallback ... operates without contacting
the AETERNA server for resolution or key material." Current
`public/emergency.html` resolves the Manifest via
`/api/capsule/:capsuleId`, a confirmed deviation.

Note on attribution: this requirement was previously (incorrectly)
attributed to `INVARIANTS.md §7.2 Emergency Runtime Independence`. That
section addresses operation without React-runtime availability and
local-only decrypt guarantees; it does not address server contact. Verified
directly against `docs/canonical/INVARIANTS.md` lines 231-235 in this
session. The correct and sole source is the Emergency Runtime section of
`AETERNA_COMPLETE_SYSTEM_LOGIC.md` quoted above.

## 4. Emergency Runtime lacks post-open media rendering parity

`AETERNA_COMPLETE_SYSTEM_LOGIC.md` ("Post-open Recovery", "Disaster
Recovery Principle"): Emergency Runtime must remain capable of
"reconstructing media streams" and "rendering opened contents"; "A capsule
that can be opened by the primary runtime must also be openable by
Emergency Runtime." Current implementation renders only metadata plus a
placeholder string after decrypt. Confirmed deviation.

---

# Verification method

Each item above was checked by direct inspection of the corresponding
file(s) in `docs/canonical/` in this repository, not from memory or
conversation history alone.