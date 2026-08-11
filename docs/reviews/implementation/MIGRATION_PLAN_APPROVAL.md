Status: Repository-verified

This document records the verification of
`docs/implementation/IMPLEMENTATION_MIGRATION_PLAN.md` against canonical
documentation in this repository.

---

# Scope of verification

This review checked, against the files in `docs/canonical/`:

1. Whether the corrected attribution in the migration plan is accurate.
2. Whether the two items marked "Canonical clarification required" are
   genuine gaps in the canon rather than gaps introduced by the plan.
3. Whether the items marked as ready for implementation are directly
   supported by canon without requiring new protocol decisions.

# Findings

## Attribution correction — confirmed accurate

`INVARIANTS.md` §7.2 ("Emergency Runtime Independence") states only that
Emergency Runtime must remain operational without React runtime
availability and must preserve local-only decrypt guarantees. It does not
mention server contact.

The actual requirement — no AETERNA server contact for resolution or key
material in Emergency Runtime — is stated in
`AETERNA_COMPLETE_SYSTEM_LOGIC.md`, Emergency Runtime section, matching the
migration plan's citation verbatim in substance.

The correction changes only the citation, not the requirement's meaning.
Confirmed.

## Clarification item 1 — `description` — confirmed genuine gap

Canon (`AETERNA_COMPLETE_SYSTEM_LOGIC.md`, Manifest field list) closes the
Manifest field set and excludes `description`. No canonical
non-Manifest storage/transport path for this field is defined anywhere in
`docs/canonical/`. The plan's characterization of this as requiring a
separate canonical decision, rather than an engineering guess, is
accurate.

## Clarification item 2 — Emergency Runtime resolution source — confirmed genuine gap

Canon forbids AETERNA server contact for Manifest resolution in Emergency
Runtime but does not specify a replacement resolution mechanism anywhere
in `docs/canonical/`. The plan's characterization is accurate.

## Items marked ready for implementation — confirmed supported by canon

- `chunkPointers` migration to the Chunk Pointer Registry: directly
  supported by the Chunk Pointer Registry model in
  `AETERNA_COMPLETE_SYSTEM_LOGIC.md` (canonical operational mapping between
  chunk identifiers and storage pointers; explicitly used by Emergency
  Runtime as well).
- Emergency Runtime media rendering parity: directly required by the
  "Post-open Recovery" and "Disaster Recovery Principle" sections of the
  same document.

Neither item requires a new protocol decision; both are corrections of
implementation to match existing canon.

# Conclusion

The Migration Plan, as corrected, is consistent with canonical
documentation in this repository. It defers the two undefined points to
future canonical decisions rather than resolving them by implementation
assumption, consistent with the principle stated in the plan itself:
"Implementation exists to realize the canonical documentation."

Approved as an implementation-preparation artifact. Not itself canonical
and does not modify canonical documentation.