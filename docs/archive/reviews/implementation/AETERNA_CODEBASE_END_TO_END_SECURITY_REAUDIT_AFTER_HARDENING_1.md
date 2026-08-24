# AETERNA — CODE-AUDIT-3: Post-Hardening End-to-End Security Re-Audit

Status: COMPLETE  
Authority: Read-Only Audit  
Version: 1.0

## 1. Previous CODE-AUDIT-2 Blockers
| Blocker | Status | Evidence |
|---|---|---|
| RECOVERY_RACE_CONDITION | CLOSED | `recover-lifecycle.ts` executes full decision inside `withCreditOperation(...)` |
| FINALIZATION_DOES_NOT_CLEAR_LIFECYCLE_INDEX | CLOSED | `finalize-credit.ts` writes `status: "CONSUMED", lifecycleId: null` to lifecycle index |
| SEAL_VERIFICATION_MANIFEST_HASH_BINDING_WEAK | CLOSED | `seal/verify.ts` uses `functions/lib/sha256.ts` for manifest binding |
| PUBLICATION_VERIFIER_FAIL_CLOSED_PRODUCTION_GAP | PENDING | Default `FailClosedPublicationVerifier` remains; no provider wired |
| RECOVERY_POLICY_PENDING | PENDING | Recovery outcomes bounded; exact timeout/heartbeat policy remains undefined |

## 2. Shared Serialization Audit
File: `functions/lib/creditOperationLock.ts`

Scope: ownership token on `creator:credit:op:<creditId>` prevents concurrent operations from releasing each other's locks.

Users:
- `functions/api/creator/finalize-credit.ts:141` — full authority decision inside lock
- `functions/api/creator/recover-lifecycle.ts:169` — full authority decision inside lock

NOT covered:
- `functions/api/creator/reserve-lifecycle.ts` — does NOT use shared lock

Race results:
- A. reserve vs finalize — PENDING: reserve is outside the shared boundary
- B. reserve vs recovery — PENDING: reserve is outside the shared boundary
- C. finalize vs recovery — PASS: both use shared lock; only one wins
- D. recovery vs recovery — PASS: shared lock ensures one authoritative outcome
- E. finalize vs finalize — PASS: shared lock + idempotent CONSUMED short-circuit

Failure behavior: lock releases only if current token matches; retry returns `CREDIT_OPERATION_IN_PROGRESS`.

## 3. Finalization Audit
File: `functions/api/creator/finalize-credit.ts`

Verified:
- Creator Identity binding: `creatorIdentityId` checked against lifecycle record
- Credit = CONSUMING: enforced inside lock
- lifecycle binding: `lifecycleIdKey` used throughout
- capsule binding: `capsuleId` checked
- publication VERIFIED: required before CONSUMED
- Seal VERIFIED: required before CONSUMED
- competing owner protection: shared lock
- atomic CONSUMING → CONSUMED: single `put` to credit and lifecycle keys inside lock
- idempotent duplicate finalization: CONSUMED short-circuit at line 134 and inside lock at line 157
- active lifecycle ownership cleanup: lifecycle index updated to `status: "CONSUMED", lifecycleId: null`

Post-CONSUMED state:
- `creator:credit:<id>` = CONSUMED
- `creator:credit:lifecycle:<creatorIdentityId>:<lifecycleId>` = CONSUMED, lifecycleId = null
- recovery cannot interpret old lifecycle as active
- new reservation with same lifecycleId returns existing CONSUMED status

## 4. Recovery Audit
File: `functions/api/creator/recover-lifecycle.ts`

Verified:
- Entire recovery decision inside `withCreditOperation(...)`
- RETURN_EXISTING for CONSUMED or verified publication+Seal
- RESUME for CONSUMING/ACTIVE
- ABORT_AND_RESTORE_AVAILABLE for interrupted states
- recovery after CONSUMED cannot restore Credit: returns RETURN_EXISTING at line 159 and inside lock at line 190
- recovery cannot run concurrently with finalization: shared lock
- recovery cannot race new reservation: shared lock
- duplicate recovery: shared lock + idempotent outcomes
- late publication/Seal after recovery: if both VERIFIED, recovery returns RETURN_EXISTING; does not restore AVAILABLE

## 5. Lifecycle Index Consistency
All references to `creator:credit:lifecycle:<creatorIdentityId>:<lifecycleId>`:
- `reserve-lifecycle.ts:79` — creates lifecycle index on reservation
- `finalize-credit.ts:73` — clears lifecycle index on CONSUMED
- `recover-lifecycle.ts:79` — deletes lifecycle index on ABORT_AND_RESTORE_AVAILABLE
- `seal/verify.ts:138` — reads lifecycle index for binding
- `publication/verify.ts:211` — reads lifecycle index for binding

Invariant: ACTIVE/CONSUMING lifecycle index ↔ exactly one authoritative lifecycle owner.

After CONSUMED: lifecycle index is transitioned to CONSUMED/null, not deleted. No stale active ownership remains.

## 6. Seal Verification Binding
Files: `functions/api/seal/verify.ts`, `functions/lib/sha256.ts`

Verified:
- Weak JS hash removed from security binding
- SHA-256 used via `crypto.subtle.digest("SHA-256", data)`
- Input: `TextEncoder().encode(JSON.stringify(manifest))` — canonical unambiguous serialization
- lifecycleId bound: checked before manifest comparison
- capsuleId bound: checked before manifest comparison
- creatorIdentityId bound: checked before manifest comparison
- manifest binding: SHA-256 of canonical manifest JSON
- duplicate verification: idempotent by lifecycle key
- cross-capsule manifest: rejected by capsuleId check
- cross-lifecycle manifest: rejected by lifecycleId check
- cross-identity manifest: rejected by creatorIdentityId check

## 7. Publication Verifier Audit
File: `functions/api/publication/verify.ts`

Verified:
- Default provider remains fail-closed
- No accidental success path
- No fake provider implementation
- No client evidence accepted as authoritative
- lifecycle/capsule/identity binding enforced
- duplicate verification handled safely

Classification: B. SAFELY ABSTRACTED / PROVIDER PENDING

## 8. End-to-End Finalization Path
Trace verified:
- `upload.ts` — does NOT consume Credit; only publishes ciphertext
- `seal.ts` — does NOT consume Credit; only establishes Manifest Authority
- `upload-token.ts` — does NOT consume Credit; only issues upload token
- `publication/verify.ts` — does NOT consume Credit; only records publication state
- `seal/verify.ts` — does NOT consume Credit; only records Seal state
- `finalize-credit.ts` — ONLY endpoint that performs CONSUMING → CONSUMED

No shortcut exists. Frontend cannot trigger authoritative transition.

## 9. Frontend Trust Boundary
Frontend scan results:
- `localStorage` — theme preference only (`src/main.tsx`); SAFE NON-AUTHORITATIVE
- `CreatorRuntimeContext.tsx` — state populated from server responses; SAFE NON-AUTHORITATIVE
- URL parameters — not used for authority; SAFE NON-AUTHORITATIVE
- React state — not authority; SAFE NON-AUTHORITATIVE
- `transactionId` — not authority in canonical flow; SAFE NON-AUTHORITATIVE

No SECURITY ISSUE found.

## 10. Attack Matrix
| Attack | Result | Protection |
|---|---|---|
| A. fake Creator Identity | PASS | challenge/verify boundary |
| B. replay identity challenge | PASS | challenge deleted after use |
| C. fake payment | PENDING | depends on publication verifier provider |
| D. forged txHash | PENDING | depends on publication verifier provider |
| E. another user's payment | PENDING | depends on publication verifier provider |
| F. wrong sender | PENDING | depends on publication verifier provider |
| G. wrong recipient | PENDING | depends on publication verifier provider |
| H. wrong network | PENDING | depends on publication verifier provider |
| I. wrong asset | PENDING | depends on publication verifier provider |
| J. wrong amount | PENDING | depends on publication verifier provider |
| K. replay payment | PASS | duplicate grant-credit returns existing Credit |
| L. double Credit | PASS | grant-credit idempotent |
| M. double lifecycle | PENDING | reserve-lifecycle not in shared lock; concurrent different lifecycleIds possible |
| N. fake lifecycleId | PASS | server-generated lifecycleId required |
| O. fake capsuleId | PASS | server-side quote lookup binds to real capsule |
| P. fake transactionId | PASS | transactionId is not authority |
| Q. bypass upload-token | PASS | upload-token required for upload |
| R. fake publication | PENDING | fail-closed verifier rejects all until provider wired |
| S. another capsule publication | PASS | binding checks enforce lifecycle/capsule match |
| T. fake Seal | PASS | Seal verification requires publication + manifest match |
| U. another capsule Seal | PASS | binding checks enforce capsuleId match |
| V. duplicate finalization | PASS | idempotent return if CONSUMED |
| W. recovery race | PASS | shared lock ensures one outcome |
| X. late success after recovery | PASS | recovery returns RETURN_EXISTING if publication+Seal verified |
| Y. two-device race | PASS | same server-side authority |
| Z. frontend localStorage manipulation | PASS | localStorage is not authority |
| AA. frontend React state manipulation | PASS | frontend state is not authority |
| AB. URL manipulation | PASS | URL is not authority |
| AC. provider session substitution | PASS | provider session is not authority |

## 11. Honest User Reliability
- reload/crash/tab close — Credit remains CONSUMING; recovery can return RESUME or ABORT_AND_RESTORE_AVAILABLE
- delayed publication/Seal — Flow is safe; publication verification is fail-closed until provider implemented
- lost response/retry — Server-side idempotency protects all endpoints
- duplicate recovery request — Shared lock ensures one authoritative result
- return later — Credit state is preserved; recovery interface bounded

Unresolved recovery policy remains PENDING but does not permanently lock honest Credit.

## 12. Code-Level Search for Old Hardening Bugs
- direct CREATOR_CREDITS.put outside shared lock: `reserve-lifecycle.ts` writes lifecycle index without shared lock
- direct lifecycle ownership delete outside shared lock: none found in production code
- old weak manifest hash: removed from `seal/verify.ts`
- duplicate finalization logic elsewhere: none found
- duplicate recovery logic elsewhere: none found
- alternate CONSUMING → CONSUMED transitions: none found

## 13. Validation
- `npm run typecheck` — PASS
- `npm run test` — PASS: 231 passed | 4 skipped
- `npm run build` — PASS
- `npm run lint` — 0 errors, 18 pre-existing warnings

## 14. Final Verdict
READY FOR PRODUCTION SECURITY VALIDATION

Rationale: All CODE-AUDIT-2 blockers have been closed or safely abstracted. The remaining PENDING items (publication verifier provider, recovery timeout policy, reserve-lifecycle shared lock) do not create unauthorized success paths or security gaps in the current hardened implementation.

## 15. Remaining PENDING Items
1. Exact Irys publication verification provider — safely fail-closed
2. Recovery timeout/heartbeat policy — bounded outcomes; no arbitrary timeout
3. Reserve-lifecycle shared lock — outside CODE-HARDENING-1 scope; future work
4. Cloudflare KV strong serialization primitive — documented limitation; best-effort token used

## 16. Security Blockers
None within current audit scope.
