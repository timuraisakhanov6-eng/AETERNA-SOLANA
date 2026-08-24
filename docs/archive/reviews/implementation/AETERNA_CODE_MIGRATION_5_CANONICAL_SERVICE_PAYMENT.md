# AETERNA — CODE-MIGRATION-5: Canonical Service Payment Implementation

Status: IMPLEMENTATION COMPLETE  
Authority: Implementation Report  
Version: 1.0

## 1. Payment Verification Boundary

Implemented missing canonical endpoint:

- `functions/api/service-payment/verify.ts` — `POST /api/service-payment/verify`

Properties:
- resolves immutable Business Quote server-side
- resolves Creator Identity server-side
- accepts non-authoritative payment evidence only
- idempotent verified-payment records
- provider-neutral adapter boundary
- fail-closed when provider/finality are pending

Provider-specific decisions still PENDING:
- exact AETERNA payment network
- exact AETERNA payment asset
- exact RPC/provider
- exact confirmation/finality threshold

## 2. Quote Binding

- Quote resolved from `BUSINESS_QUOTES` by `capsuleId`
- Quote expiry enforced
- Quote binding verified before payment verification record creation

## 3. Credit Grant Authority

Updated:
- `functions/api/creator/grant-credit.ts`

Rule:
- ONLY independently VERIFIED payment
- immutable Quote
- correct Creator Identity
- single-use payment
→ Creator Credit AVAILABLE

## 4. PaymentModal

Updated:
- `src/components/capsule/PaymentModal.tsx`

Active path:
- `/api/service-payment/verify`
- `/api/creator/grant-credit`

Removed:
- direct grant-credit as payment substitute
- Paddle calls
- legacy web3 verify calls

## 5. CapsuleBuilder

Updated:
- `src/components/capsule/CapsuleBuilder.tsx`

Changes:
- `currentPrice = 1.0`
- `expectedAmount = 1.0`
- removed active Paddle checkout branch
- removed active web3 tx-hash branch
- canonical navigation to `/create/hold` without legacy payment state

## 6. CapsuleHold

Updated:
- `src/pages/capsule/CapsuleHold.tsx`

Changes:
- removed `/api/paddle/verify`
- removed `paymentMethod === "card"` authority
- `transactionId` reduced to correlation-only display
- authority = Creator Identity + lifecycleId + CONSUMING Credit + capsule binding
- upload-token request sends `canonicalLifecycleId` + `correlationTransactionId`

## 7. Reserve Lifecycle

- active frontend reserve-lifecycle wiring not introduced in this phase
- server-side canonical authority preserved in existing endpoints

## 8. Upload Token

Updated:
- `functions/api/upload-token.ts`

Changes:
- requires `canonicalLifecycleId`
- verified payment lookup by `capsule:{capsuleId}`
- `transactionId` never authorizes upload
- `correlationTransactionId` preserved for correlation only

## 9. Block Pricing Isolation

Removed:
- `calculatePrice()` from active entitlement path

Canonical fee:
- `$1.00 USD-equivalent`

Size remains available for operational estimates only.

## 10. Legacy Isolation

Preserved:
- `functions/api/paddle/*`
- `functions/api/web3/*`
- `src/lib/pricing.ts`

Active runtime dependency:
- zero

## 11. Tests

Updated:
- `functions/test/payment.invariant.test.ts`

Coverage:
- verified payment required
- wrong capsule rejection
- expired payment rejection
- payment binding checks
- non-ok payment rejection
- missing KV fail-closed
- valid verified payment issues upload token
- service-payment verify missing quote rejection
- service-payment verify fail-closed when provider pending
- service-payment verify idempotency

## 12. Honest User Flow

PREPARED
→ Service Quote
→ `/api/service-payment/verify` (provider-pending = fail-closed)
→ VERIFIED payment record
→ `/api/creator/grant-credit`
→ Creator Credit AVAILABLE
→ reserve-lifecycle
→ CONSUMING
→ CapsuleHold
→ `/api/upload-token`

Note:
- provider-specific verification remains PENDING;
  current flow returns `PAYMENT_VERIFICATION_FAILED` until configured.

## 13. Validation

- `npm run typecheck` — PASS
- `npm run test` — PASS: 241 passed | 4 skipped
- `npm run build` — PASS
- `npm run lint` — 0 errors / 18 pre-existing warnings
- `npm run format` — 0 errors / 18 pre-existing warnings

## 14. Remaining Blockers

1. Exact payment network/asset/provider/finality selection is PENDING.
2. Live provider verification integration is not implemented.
