# AETERNA — CODE-MIGRATION-5: Blocker Analysis

Status: DIAGNOSED — BLOCKED  
Authority: Canonical Service Payment Migration Diagnostic  
Version: 1.0

## 1. Exact Active Legacy Paths

### A. Paddle
- `src/components/capsule/CapsuleBuilder.tsx:111` → `fetch("/api/paddle/create-checkout")`
- `src/components/capsule/CapsuleBuilder.tsx:841-895` → `handleConfirmPayment()` default branch invokes Paddle checkout and SDK
- `src/components/capsule/CapsuleBuilder.tsx:1037` → UI hint: "Secure Payment via Paddle or USDC"
- `src/pages/capsule/CapsuleHold.tsx:437-483` → `finalizeSealing()` STEP 1: `paymentMethod === "card"` calls `/api/paddle/verify`
- `src/pages/capsule/CapsuleHold.tsx:197-201` → `transactionId` from location/URL drives hold state

### B. Legacy Web3
- `src/components/capsule/CapsuleBuilder.tsx:819-838` → `handleConfirmPayment(opts?.web3TxHash)` navigates to hold with `paymentMethod: "web3"`
- `src/lib/crypto/validators.ts:146` → comment reference to `/api/web3/verify` (non-executable)
- `functions/api/web3/create-quote.ts:229` → deprecated 410 endpoint
- `functions/api/web3/verify.ts` → legacy verify endpoint

### C. Block Pricing
- `src/components/capsule/CapsuleBuilder.tsx:14` → `import { calculatePrice } from "@/lib/pricing"`
- `src/components/capsule/CapsuleBuilder.tsx:534` → `const currentPrice = calculatePrice(previewVaultSize)`
- `src/components/capsule/CapsuleBuilder.tsx:708` → `expectedAmount: calculatePrice(previewVaultSize)` stored as session state
- `src/components/capsule/CapsuleBuilder.tsx:1037` → UI displays `currentPrice.toFixed(2)`
- `src/components/capsule/HorizontalCapsule.tsx:2` → imports `calculatePrice`, `FIRST_BLOCK_MB`, `NEXT_BLOCK_MB`, `NEXT_BLOCK_PRICE`
- `src/lib/pricing.ts` → block-pricing implementation

### D. PaymentModal
- `src/components/capsule/PaymentModal.tsx:132` → `/api/service-payment/create-quote` (canonical)
- `src/components/capsule/PaymentModal.tsx:175` → `/api/creator/grant-credit` directly without payment verification
- `src/components/capsule/PaymentModal.tsx` → receives `onConfirmPayment` from CapsuleBuilder which has legacy branches

### E. CapsuleHold
- `src/pages/capsule/CapsuleHold.tsx:197-201` → `transactionId` from location/URL
- `src/pages/capsule/CapsuleHold.tsx:437-483` → Paddle verify block
- `src/pages/capsule/CapsuleHold.tsx:488-528` → upload-token with `transactionId`
- `src/pages/capsule/CapsuleHold.tsx:79` → `canonicalLifecycleId` present but unused as authoritative gate

## 2. Canonical Path Gaps

Traced actual flow:

CapsuleBuilder
→ PREPARE ✅
→ PaymentModal ✅ opens after prepare
→ `/api/service-payment/create-quote` ✅ called by PaymentModal
→ payment ❌ NO canonical payment evidence submission + independent verification endpoint
→ `/api/creator/grant-credit` ✅ called by PaymentModal, but does NOT verify payment independently
→ Creator Credit ✅ created if quote exists
→ reserve-lifecycle ❌ NOT called from active frontend flow
→ CapsuleHold ❌ opens via legacy `transactionId`/Paddle/web3 state
→ upload-token ✅ called with `transactionId`, not canonical lifecycle authority

Breaks/falls back to legacy:
A. CapsuleBuilder default path falls back to Paddle checkout, not canonical payment UI.
B. PaymentModal calls grant-credit without independent payment verification.
C. CapsuleHold authorizes upload via Paddle verify + transactionId, not server lifecycle/Credit.
D. `reserve-lifecycle` is not wired into active Create → Hold flow.

## 3. Exact Endpoint Gaps

| Endpoint | Status | Gap |
|----------|--------|-----|
| `POST /api/service-payment/create-quote` | EXISTS | Quote creation works. |
| `POST /api/service-payment/verify` | MISSING | No canonical payment verification endpoint. |
| `POST /api/creator/grant-credit` | EXISTS | Grants Credit, but does NOT independently verify payment facts. |
| `POST /api/creator/reserve-lifecycle` | EXISTS | Not wired into active frontend flow. |
| `POST /api/upload-token` | EXISTS | Requires `transactionId`; must be changed to require canonical lifecycle/Credit. |

MISSING CURRENT IMPLEMENTATION:
- `/api/service-payment/verify` or equivalent canonical payment evidence submission + independent verification endpoint.

## 4. Executor Hot Role

| File | Role |
|------|------|
| `functions/lib/executorHot.ts` | CURRENT PUBLICATION INFRASTRUCTURE — Irys upload/publication execution only. |
| `functions/api/upload.ts` | Imports `executorHot` for publication. |
| `functions/api/upload-token.ts` | Imports `executorHot` for upload authority. |
| `functions/test/payment.invariant.test.ts` | Mocks `executorHot`. |

No current path treats `executorHot` as AETERNA service-payment receiver. No SECURITY/CANONICAL CONFLICT found.

## 5. Transitional Helper Status

| File | Status | Notes |
|------|--------|-------|
| `functions/lib/payment/solana.ts` | TRANSITIONAL UNUSED | Placeholder; no active imports. |
| `functions/lib/payment/verify.ts` | TRANSITIONAL UNUSED | Contract file; no active imports. |
| `functions/lib/creditOperationLock.ts` | TRANSITIONAL UNUSED | Superseded by DO coordinator; no active runtime consumer. |

## 6. Minimal Ordered Migration Plan

STEP 1:
Remove Paddle authority from CapsuleBuilder/PaymentModal.
- Delete `createPaddleCheckout` and Paddle branch in `handleConfirmPayment`.
- Remove Paddle SDK/open/close/success logic.
- Ensure `PaymentModal` remains canonical-only UI.

STEP 2:
Remove legacy Paddle verification from CapsuleHold.
- Delete `paymentMethod === "card"` block calling `/api/paddle/verify`.
- Remove `transactionId` as upload-token authorization factor.

STEP 3:
Remove block-pricing entitlement dependency.
- Remove `calculatePrice` from canonical entitlement path in CapsuleBuilder.
- Replace `expectedAmount` with fixed `$1.00` from server quote or constant.
- Keep `previewVaultSize` only as UX display / storage constraint, not Credit authority.

STEP 4:
Wire canonical Service Quote/payment verification/Credit state.
- Add canonical payment evidence submission endpoint.
- Add independent payment verification before Credit grant.
- Update `PaymentModal` to submit evidence, then call verification, then read Credit state.

STEP 5:
Wire reserve-lifecycle into active Create flow.
- After Credit AVAILABLE, call `/api/creator/reserve-lifecycle` before navigating to `/create/hold`.
- Pass `canonicalLifecycleId` as authoritative hold context.

STEP 6:
Verify upload-token uses lifecycle/Credit authority.
- Update `/api/upload-token` to require authoritative lifecycle + CONSUMING Credit.
- Remove `transactionId` as authorization factor.

STEP 7:
Only after tests pass, delete proven legacy files.
- `functions/api/paddle/*`
- `functions/api/web3/*`
- `src/lib/pricing.ts`
- `src/components/web3/WalletSelectorModal.tsx`
- `src/hooks/useUSDCPayment.ts`
- `functions/lib/payment/*`
- `functions/lib/creditOperationLock.ts`

CODE-MIGRATION-5 = BLOCKED — DIAGNOSED

FINAL CONFIRMATION:

"No production code was modified and no legacy files were deleted during this diagnostic continuation."
