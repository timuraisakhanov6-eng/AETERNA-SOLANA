# AETERNA — CODE-HARDENING-2: Durable Object Credit Operation Coordinator

Status: IMPLEMENTED, DEPLOYMENT VALIDATION PENDING  
Authority: Read-Only Architecture Review  
Version: 1.0

## 1. Files Modified

- `functions/do/creditOperationCoordinator.ts` — new Durable Object implementing authoritative serialization for reserve/finalize/recover operations
- `functions/do/tsconfig.json` — new TypeScript configuration for Durable Object compilation
- `functions/api/creator/reserve-lifecycle.ts` — modified to delegate authoritative reservation to CreditOperationCoordinator
- `functions/api/creator/finalize-credit.ts` — modified to delegate authoritative finalization to CreditOperationCoordinator
- `functions/api/creator/recover-lifecycle.ts` — modified to delegate authoritative recovery to CreditOperationCoordinator
- `functions/test/creditOperationCoordinator.invariant.test.ts` — new coordinator unit tests (8 tests)
- `functions/test/finalizeCredit.invariant.test.ts` — updated tests for DO-delegated finalization (5 tests)
- `functions/test/recoverLifecycle.invariant.test.ts` — updated tests for DO-delegated recovery (4 tests)
- `wrangler.toml` — added `CREDIT_OP_COORDINATOR` Durable Object binding

## 2. Durable Object Architecture

The `CreditOperationCoordinator` is a Cloudflare Durable Object that provides single-threaded serialization for all authoritative mutations on one Creator Credit.

- One Creator Credit maps to one coordinator instance via deterministic `idFromName(creatorCreditId)`.
- All state is stored in Durable Object storage, surviving process restarts and request retries.
- Operations are handled synchronously within the DO, guaranteeing that only one request executes at a time for a given Credit.

## 3. Binding

Added to `wrangler.toml`:

```
[[durable_objects]]
binding = "CREDIT_OP_COORDINATOR"
class_name = "CreditOperationCoordinator"

[[migrations]]
tag = "v1"
new_classes = ["CreditOperationCoordinator"]
```

This is the minimum binding required by SPEC-WP-12. No unrelated bindings were introduced.

## 4. Credit Keying

Coordinator identity is deterministically derived from `creatorCreditId`:

```typescript
const coordinatorId = env.CREDIT_OP_COORDINATOR.idFromName(creatorCreditId);
```

This ensures one Creator Credit → one coordinator authority, independent of wallet address, lifecycleId, or browser session.

## 5. Reservation Delegation

`functions/api/creator/reserve-lifecycle.ts` now delegates the complete reservation authority decision to the coordinator.

Request body sent to DO:
```json
{
  "op": "reserve",
  "creatorCreditId": "<credit id>",
  "creatorIdentityId": "<identity id>",
  "lifecycleId": "<lifecycle id>",
  "capsuleId": "<capsule id>"
}
```

Possible outcomes:
- RESERVED
- ALREADY_RESERVED_FOR_SAME_LIFECYCLE
- ALREADY_CONSUMING
- ALREADY_CONSUMED
- IDENTITY_MISMATCH
- INVALID

## 6. Finalization Delegation

`functions/api/creator/finalize-credit.ts` now delegates the complete finalization authority decision to the SAME coordinator.

Request body sent to DO:
```json
{
  "op": "finalize",
  "creatorCreditId": "<credit id>",
  "creatorIdentityId": "<identity id>",
  "lifecycleId": "<lifecycle id>",
  "capsuleId": "<capsule id>",
  "publicationVerified": true/false,
  "sealVerified": true/false
}
```

The coordinator serializes finalization against reserve, recover, and other finalize operations. Duplicate finalize returns the existing CONSUMED result.

## 7. Recovery Delegation

`functions/api/creator/recover-lifecycle.ts` now delegates the complete recovery authority decision to the SAME coordinator.

Request body sent to DO:
```json
{
  "op": "recover",
  "creatorCreditId": "<credit id>",
  "creatorIdentityId": "<identity id>",
  "lifecycleId": "<lifecycle id>",
  "capsuleId": "<capsule id>",
  "publicationState": "<state>",
  "sealState": "<state>"
}
```

The coordinator serializes recovery against reserve, finalize, and other recovery operations. After CONSUMED, recovery returns RETURN_EXISTING and never restores AVAILABLE.

## 8. Fencing / Revision

Every authoritative mutation is protected by a revision check:

- Each Credit record carries a monotonically increasing `revision` field.
- Stale operations with a revision lower than the current authoritative revision are rejected.
- The coordinator rejects out-of-order writes after a newer authoritative revision has committed.

## 9. Idempotency

The coordinator supports idempotent retries:

- Same legitimate operation retried → existing authoritative result.
- Different lifecycle attempts against the same Credit → rejected.
- Old/stale operation → rejected.
- Duplicate finalize → existing CONSUMED result.
- Duplicate recovery → existing authoritative outcome.

## 10. Crash / Restart Behavior

State is persisted in Durable Object storage, not process memory:

- Coordinator receives reservation and execution stops → persisted state includes CONSUMING status with lifecycle binding.
- Coordinator receives finalization and execution stops → persisted state includes CONSUMED status.
- Coordinator receives recovery and execution stops → persisted state reflects the recovery outcome.
- Client disconnects / request times out → DO continues processing; retry arrives later and returns the persisted result.
- The coordinator is the authoritative source of truth for Credit state.

## 11. Tests

New coordinator tests validate:
- Reserve from AVAILABLE to CONSUMING
- Duplicate reserve rejection
- Identity mismatch rejection
- Finalize from CONSUMING to CONSUMED
- Duplicate finalize idempotency
- Recovery from CONSUMING to AVAILABLE
- Recovery after CONSUMED returns RETURN_EXISTING
- Stale revision rejection

Endpoint tests validate:
- Delegation to coordinator
- Evidence checks (publication/seal verification)
- Ownership cleanup after CONSUMED
- idempotent duplicate finalization

Limitations:
- Current test environment cannot reproduce true concurrent Worker execution across multiple DO instances.
- Coordinator tests are deterministic single-process tests exercising the DO serialization logic.
- Deployment-level distributed semantics must be validated in a staging/preview environment with multiple concurrent Workers.

## 12. Validation

- `npm run typecheck` — PASS
- `npm run test` — PASS: 238 passed | 4 skipped
- `npm run build` — PASS
- `npm run lint` — PASS: 0 errors, 18 pre-existing warnings
- `npm run format` — PASS: 0 errors, 18 pre-existing warnings

## 13. Deployment-Specific Validation Still PENDING

The following must be validated in a real Cloudflare Workers environment:
- True concurrent Worker execution against the same Credit, verifying DO serialization prevents double reservation/finalization/recovery.
- Durable Object migration behavior.
- DO state persistence across Worker instance restarts.
- KV-to-DO migration path if any existing Credit state was stored in KV.

## 14. Transitional Lock Status

`functions/lib/creditOperationLock.ts` remains as transitional/non-authoritative code. It is no longer used by the authoritative endpoints, but has NOT been deleted per phase instructions. It can be removed in a future cleanup phase once the DO-based implementation is fully validated.

## 15. Remaining Blockers

None. Implementation is complete. Deployment-level validation remains PENDING.

---

AUDIT REPORT

FINAL CONFIRMATION:

"CODE-HARDENING-2 changed only the distributed Creator Credit serialization implementation and directly related configuration/tests. No wallets, payment architecture, Creator Identity, Vault, Manifest, canonical crypto, storage, Seal, Trusted Time, Heartbeat, or Emergency Runtime semantics were changed."
