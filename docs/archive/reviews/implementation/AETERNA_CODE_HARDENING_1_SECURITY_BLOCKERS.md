# AETERNA — CODE-HARDENING-1: Security Blocker Remediation

Status: COMPLETE  
Authority: Implementation Record  
Version: 1.0

## 1. Files Modified
- functions/lib/creditOperationLock.ts
- functions/lib/sha256.ts
- functions/api/creator/finalize-credit.ts
- functions/api/creator/recover-lifecycle.ts
- functions/api/seal/verify.ts
- functions/test/finalizeCredit.invariant.test.ts
- functions/test/recoverLifecycle.invariant.test.ts
- functions/test/sealVerify.invariant.test.ts

## 2. Finalization Serialization
functions/api/creator/finalize-credit.ts now executes the entire authoritative decision inside `withCreditOperation(...)`, including:
- lifecycle ownership read;
- publication verification read;
- Seal verification read;
- CONSUMING -> CONSUMED transition;
- active lifecycle ownership cleanup.

Duplicate finalization remains idempotent.

## 3. Lifecycle Ownership Consistency
After CONSUMED:
- creator:credit:<id> status = CONSUMED
- creator:credit:lifecycle:<creatorIdentityId>:<lifecycleId> status = CONSUMED, lifecycleId = null
Active ownership reference is cleared.

## 4. Recovery Serialization
functions/api/creator/recover-lifecycle.ts now executes the entire authoritative recovery decision inside `withCreditOperation(...)`, including:
- Credit state read;
- lifecycle state read;
- publication verification;
- Seal verification;
- competing owner detection;
- recovery outcome;
- Credit restoration;
- lifecycle ownership cleanup.

## 5. Seal Verification Binding
functions/api/seal/verify.ts now uses functions/lib/sha256.ts for manifest binding instead of the weak JS string hash.

## 6. Recovery Policy
Exact timeout/heartbeat policy remains PENDING per canonical documentation.
Recovery outcomes preserved: RETURN_EXISTING, RESUME, ABORT_AND_RESTORE_AVAILABLE.

## 7. Tests Added
- finalize-credit: duplicate finalization, lifecycle index cleanup
- recover-lifecycle: RETURN_EXISTING for CONSUMED/verified, RESUME for active, ABORT_AND_RESTORE_AVAILABLE with ownership cleanup
- seal-verify: verified/manifest binding idempotency

## 8. Validation
- typecheck: PASS
- test: 70 passed
- build: PASS
- lint: 0 errors / 18 warnings
- format: 0 errors / 18 warnings

## 9. Remaining PENDING
- Exact Irys publication verification provider
- Exact Seal verification adapter policy
- Recovery timeout/heartbeat policy
- Cloudflare KV strong serialization primitive

## 10. Remaining Blockers
None within current audit scope.
