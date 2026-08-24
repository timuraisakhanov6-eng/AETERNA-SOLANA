# AETERNA — CODE-MIGRATION-4: Authoritative Publication Verification, Seal Verification, Credit Finalization, and Lifecycle Recovery

Status: COMPLETE  
Authority: Implementation Record  
Version: 1.0

---

## 1. FILES MODIFIED

- functions/api/publication/verify.ts
- functions/api/seal/verify.ts
- functions/api/creator/finalize-credit.ts
- functions/api/creator/recover-lifecycle.ts
- functions/test/publicationVerify.invariant.test.ts
- functions/test/sealVerify.invariant.test.ts
- functions/test/finalizeCredit.invariant.test.ts
- functions/test/recoverLifecycle.invariant.test.ts

---

## 2. PUBLICATION VERIFICATION IMPLEMENTATION

- Added `functions/api/publication/verify.ts`.
- Client may submit evidence identifiers only: `publicationId`, optional `txHash`, optional `providerRef`.
- Server enforces:
  - lifecycle reservation exists;
  - Creator Credit is `CONSUMING`;
  - Creator Identity binding matches.
- Uses provider-neutral `PublicationVerifier` interface.
- Default verifier is fail-closed until provider selection is implemented.
- Result states: `NOT_VERIFIED` -> `PENDING` -> `VERIFIED` / `REJECTED`.
- Idempotent: repeated verification returns existing state.

---

## 3. SEAL VERIFICATION IMPLEMENTATION

- Added `functions/api/seal/verify.ts`.
- Server establishes:
  - lifecycle reservation and Credit state;
  - publication verification state = `VERIFIED`;
  - manifest exists in `CAPSULE_MANIFESTS`;
  - submitted manifest matches stored manifest hash binding.
- Result states: `NOT_VERIFIED` -> `PENDING` -> `VERIFIED`.
- Idempotent for identical lifecycle/manifest inputs.

---

## 4. FINALIZATION ENDPOINT

- Added `functions/api/creator/finalize-credit.ts`.
- Preconditions:
  1. lifecycle exists;
  2. Credit status = `CONSUMING`;
  3. Creator Identity binding matches;
  4. publication verification = `VERIFIED`;
  5. Seal verification = `VERIFIED`;
  6. lifecycle/capsule binding consistent.
- Atomic transition: `CONSUMING -> CONSUMED`.
- Idempotent: duplicate finalization returns existing `CONSUMED` result.
- Serialized against recovery and new reservation via same `CREATOR_CREDITS` records.

---

## 5. RECOVERY IMPLEMENTATION

- Added `functions/api/creator/recover-lifecycle.ts`.
- Authoritative outcomes:
  - `RETURN_EXISTING`
  - `RESUME`
  - `ABORT_AND_RESTORE_AVAILABLE`
- Recovery inspects:
  - lifecycle state;
  - Credit state;
  - publication verification;
  - Seal verification;
  - finalization state.
- Restores `CONSUMING -> AVAILABLE` only if:
  - no authoritative publication + Seal finalization exists;
  - lifecycle is legitimately unresolved/abandoned;
  - no competing lifecycle ownership;
  - restoration is idempotent;
  - recovery cannot happen after authoritative final success.
- No arbitrary timeout implemented; recovery is explicit action-based.

---

## 6. SERIALIZATION BOUNDARY

- Finalization, recovery, and new lifecycle reservation all read/write the same `CREATOR_CREDITS` keys:
  - `creator:credit:<creditId>`
  - `creator:credit:lifecycle:<creatorIdentityId>:<lifecycleId>`
- This provides the minimum safe serialization boundary compatible with current Cloudflare KV architecture.
- Exact stronger concurrency primitive remains implementation-selection PENDING.

---

## 7. ATTACK/RACE TESTS

Added tests covering:

Publication verification:
- provider fail-closed rejection;
- idempotency;
- missing lifecycle;
- non-CONSUMING Credit.

Seal verification:
- missing publication;
- missing manifest;
- successful verification;
- idempotency.

Finalization:
- missing publication;
- missing Seal;
- successful finalization;
- duplicate finalization.

Recovery:
- already consumed;
- publication+Seal already verified;
- active resume;
- restore available.

All server authority boundaries are enforced.

---

## 8. HONEST USER RECOVERY TESTS

- Active CONSUMING lifecycle without publication/Seal -> `RESUME`.
- Unresolved non-active lifecycle -> `ABORT_AND_RESTORE_AVAILABLE`.
- Already finalized lifecycle -> `RETURN_EXISTING`.
- Late publication/Seal after recovery is blocked because recovery requires absence of authoritative finalization.

---

## 9. VALIDATION RESULTS

- `npm run typecheck` — PASS
- `npm run test` — PASS: 229 passed | 4 skipped
- `npm run build` — PASS
- `npm run lint` — 0 errors, 18 pre-existing warnings
- `npm run format` — 0 errors, 18 pre-existing warnings

---

## 10. PROVIDER-SPECIFIC PENDING DECISIONS

- exact Irys publication verification provider/adapter;
- exact publication finality threshold;
- exact Seal verification adapter/implementation;
- exact recovery timeout/policy, if any;
- exact heartbeat/reconciliation mechanism, if any;
- exact Cloudflare KV keys/schema for publication, Seal, finalization, recovery state;
- exact route names/endpoint surface for publication verification, finalization, recovery.

---

## 11. REMAINING BLOCKERS

- IMPLEMENTATION BLOCKER: publication verification provider not selected; current verifier is fail-closed by design.
- TECHNICAL DEBT: stronger serialization primitive than KV put/get remains PENDING.

---

## 12. NEXT PHASE

- SPEC-WP-12 / CODE-MIGRATION-5: frontend integration with new canonical boundaries and honest-user end-to-end verification.

---

CODE-MIGRATION-4 changed only the authoritative publication verification, Seal verification, Credit finalization, and lifecycle recovery boundaries. No wallets were created. No canonical crypto, Vault, Manifest, storage, Trusted Time, Heartbeat, or Emergency Runtime semantics were changed.
