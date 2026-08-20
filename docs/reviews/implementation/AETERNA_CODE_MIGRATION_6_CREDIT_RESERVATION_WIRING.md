# AETERNA — CODE-MIGRATION-6: Credit Reservation Wiring

Status: IMPLEMENTATION COMPLETE  
Authority: Implementation Report  
Version: 1.0

## 1. Active Frontend Transition

The authoritative sequence is now wired:

VERIFIED PAYMENT
→ Creator Credit AVAILABLE
→ reserve-lifecycle
→ authoritative lifecycleId
→ CapsuleHold
→ upload-token

Frontend never infers reservation success.

## 2. Reserve-Lifecycle Integration

- `src/components/capsule/PaymentModal.tsx` now calls `/api/creator/reserve-lifecycle` after verified payment and Credit grant.
- `src/components/capsule/CapsuleBuilder.tsx` owns the reserve step and navigation to `/create/hold`.
- Server-returned `lifecycleId` is authoritative; browser generates a candidate only for the request.

## 3. Authoritative LifecycleId

- `reserve-lifecycle.ts` returns server authority.
- Frontend stores `canonicalLifecycleId` in location state.
- `CapsuleHold.tsx` uses `canonicalLifecycleId` as the only lifecycle authority.

## 4. Creator Identity / Credit Binding

- reserve-lifecycle requires `creatorIdentityId`, `capsuleId`, `lifecycleId`.
- CreditOperationCoordinator enforces binding, idempotency, and single lifecycle per Credit.

## 5. CapsuleHold Boundary

- No Paddle verify.
- No transactionId authority.
- `transactionId` is correlation/display only.
- Upload token requires verified payment + canonical lifecycle.

## 6. Upload-Token Boundary

- `functions/api/upload-token.ts` requires `canonicalLifecycleId`.
- verified payment lookup by `capsule:{capsuleId}`.
- `transactionId` never authorizes upload.

## 7. Concurrency Tests

Added `functions/test/reserveLifecycle.invariant.test.ts`:
- successful reservation
- missing credit rejection
- duplicate lifecycle rejection
- same lifecycle idempotency
- wrong identity rejection
- forged lifecycle rejection
- retry after lost response
- missing quote rejection

## 8. Validation

- `npm run typecheck` — PASS
- `npm run test` — PASS: 249 passed | 4 skipped
- `npm run build` — PASS
- `npm run lint` — 0 errors / 18 pre-existing warnings
- `npm run format` — 0 errors / 18 pre-existing warnings

## 9. Remaining Provider PENDING

- exact payment network/asset/provider/finality remain PENDING.
- `/api/service-payment/verify` remains fail-closed until provider selection is completed.
