# AETERNA — LEGACY-ISOLATION-1: Blocker Analysis

Status: DIAGNOSED — BLOCKED  
Authority: Legacy Isolation Diagnostic  
Version: 1.0

## 1. Exact Active Paddle Paths

| File | Symbol | Active Runtime Purpose | Canonical Replacement |
|------|--------|------------------------|-----------------------|
| `src/components/capsule/CapsuleBuilder.tsx` | `createPaddleCheckout()` + `handleConfirmPayment()` | Active branch: if `opts?.web3TxHash` is absent, Paddle checkout is invoked as the default payment path. | Canonical `PaymentModal.confirmPayment()` → `/api/creator/grant-credit` with server-verified payment evidence. |
| `src/pages/capsule/CapsuleHold.tsx` | `finalizeSealing()` STEP 1 | Active branch: if `paymentMethod === "card"`, calls `/api/paddle/verify` before upload-token. | Remove Paddle verify; rely on server-authoritative lifecycle/Credit state already established before hold. |
| `src/components/capsule/CapsuleBuilder.tsx` | `handleConfirmPayment()` successCallback | Sets `paymentMethod: "card"` and `transactionId` from Paddle success. | Canonical flow does not need `paymentMethod` or Paddle `transactionId` as authority. |

Evidence:
- `CapsuleBuilder.tsx:111` → `fetch("/api/paddle/create-checkout")`
- `CapsuleBuilder.tsx:841-895` → active Paddle branch in `handleConfirmPayment`
- `CapsuleHold.tsx:437-483` → active Paddle verify block gating upload-token

## 2. Exact Active Web3 Legacy Paths

| File | Symbol | Active Runtime Purpose | Canonical Replacement |
|------|--------|------------------------|-----------------------|
| `src/components/capsule/CapsuleBuilder.tsx` | `handleConfirmPayment(opts?.web3TxHash)` | Active branch: if web3 tx hash is supplied, navigates to hold with `paymentMethod: "web3"`. | Canonical flow should not branch on client-supplied web3 tx hash as payment authority. |
| `functions/api/web3/create-quote.ts` | endpoint | Deprecated; returns `410 LEGACY_CREATE_QUOTE_DEPRECATED`. | No replacement needed; already deprecated. |
| `functions/api/web3/verify.ts` | endpoint | Legacy web3 verify; not used by canonical creator flow. | No replacement needed. |

Evidence:
- `CapsuleBuilder.tsx:819-838` → active web3 path
- `functions/api/web3/create-quote.ts:229` → `DEPRECATED_ENDPOINT`

## 3. Exact Block-Pricing Dependencies

| File | Symbol | Active Runtime Purpose | Canonical Replacement |
|------|--------|------------------------|-----------------------|
| `src/components/capsule/CapsuleBuilder.tsx` | `calculatePrice(previewVaultSize)` | Computes `expectedAmount` shown in PaymentModal and stored in sessionStorage. | Fixed $1.00 from canonical `/api/service-payment/create-quote` `expectedAmount`. |
| `src/components/capsule/CapsuleBuilder.tsx` | `MAX_CAPSULE_SIZE`, `FIRST_BLOCK_MB`, `NEXT_BLOCK_MB`, `NEXT_BLOCK_PRICE` | Used via `HorizontalCapsule` and `calculatePrice` for block-pricing display/limits. | Size-based limits may remain as storage/publication constraints, but MUST NOT determine Creator Credit entitlement. |
| `src/lib/pricing.ts` | `calculatePrice()` | Block-pricing function; no canonical entitlement authority should use it. | Remove from canonical entitlement path; keep only if genuinely needed for non-entitlement operational calculation and document boundary. |
| `src/lib/crypto/cryptoInvariants.test.ts` | test assertions | Tests block-pricing behavior. | Update tests to assert fixed $1 entitlement; remove block-pricing entitlement tests. |

Evidence:
- `CapsuleBuilder.tsx:14` → `import { calculatePrice } from "@/lib/pricing"`
- `CapsuleBuilder.tsx:534` → `const currentPrice = calculatePrice(previewVaultSize)`
- `CapsuleBuilder.tsx:708` → `calculatePrice(previewVaultSize)` stored as `expectedAmount`
- `HorizontalCapsule.tsx:2` → `import { calculatePrice, FIRST_BLOCK_MB, NEXT_BLOCK_MB, NEXT_BLOCK_PRICE } from "@/lib/pricing"`

## 4. Exact PaymentModal Dependencies

Current state: MIXED LEGACY/CANONICAL.

| Aspect | Finding |
|--------|---------|
| Props | Receives `onConfirmPayment` from `CapsuleBuilder`; if builder is fixed to canonical-only, modal becomes canonical-only. |
| Quote | Calls `/api/service-payment/create-quote` — canonical. |
| Payment verification | Calls `/api/creator/grant-credit` directly — this is NOT independent payment verification; it is Credit grant based on quote existence only. |
| Credit handling | Reads `status` and `creatorCreditId` from `/api/creator/grant-credit` response. |
| Legacy | None directly inside modal, but its `confirmPayment` path is gated by legacy `CapsuleBuilder` branches. |

Canonical gap:
- Frontend has no separate `/api/service-payment/verify` or payment evidence submission endpoint.
- `PaymentModal` currently calls `/api/creator/grant-credit` as the payment verification + credit grant step, but `grant-credit` does not independently verify payment facts — it only checks quote existence and creates Credit.

## 5. Exact CapsuleHold Dependencies

| Aspect | Finding |
|--------|---------|
| Paddle verify | Active: `paymentMethod === "card"` triggers `/api/paddle/verify` before upload-token. |
| transactionId | Active: read from `location.state.transactionId` or URL params `transaction_id` / `checkout_id`; passed to `/api/upload-token`. |
| Canonical lifecycleId | `locationState?.canonicalLifecycleId` is present but not used as the authoritative hold gate; `transactionId` still drives payment verification. |
| Creator Identity / Credit | Not actively read in hold flow; hold relies on payment verification + upload-token. |
| upload-token | Called with `capsuleId` + `transactionId`; must be changed to require authoritative lifecycle/Credit state. |

Evidence:
- `CapsuleHold.tsx:197-201` → `transactionId` from location/URL
- `CapsuleHold.tsx:437-483` → Paddle verify block
- `CapsuleHold.tsx:488-528` → upload-token with `transactionId`

## 6. Canonical Path Gaps

Traced actual frontend flow:

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

## 7. Exact Endpoint Gaps

| Endpoint | Status | Gap |
|----------|--------|-----|
| `POST /api/service-payment/create-quote` | EXISTS | Quote creation works. |
| `POST /api/service-payment/verify` | MISSING | No canonical payment verification endpoint. |
| `POST /api/creator/grant-credit` | EXISTS | Grants Credit, but does NOT independently verify payment facts. |
| `POST /api/creator/reserve-lifecycle` | EXISTS | Not wired into active frontend flow. |
| `POST /api/upload-token` | EXISTS | Requires `transactionId`; must be changed to require canonical lifecycle/Credit. |

MISSING CURRENT IMPLEMENTATION:
- `/api/service-payment/verify` or equivalent canonical payment evidence submission + independent verification endpoint.

## 8. Executor Hot Role

| File | Role |
|------|------|
| `functions/lib/executorHot.ts` | CURRENT PUBLICATION INFRASTRUCTURE — Irys upload/publication execution only. |
| `functions/api/upload.ts` | Imports `executorHot` for publication. |
| `functions/api/upload-token.ts` | Imports `executorHot` for upload authority. |
| `functions/test/payment.invariant.test.ts` | Mocks `executorHot`. |

No current path treats `executorHot` as AETERNA service-payment receiver. No SECURITY/CANONICAL CONFLICT found.

## 9. Transitional Helper Status

| File | Status | Notes |
|------|--------|-------|
| `functions/lib/payment/solana.ts` | TRANSITIONAL UNUSED | Placeholder; no active imports. |
| `functions/lib/payment/verify.ts` | TRANSITIONAL UNUSED | Contract file; no active imports. |
| `functions/lib/creditOperationLock.ts` | TRANSITIONAL UNUSED | Superseded by DO coordinator; no active runtime consumer. |

## 10. Minimal Ordered Migration Plan

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

LEGACY-ISOLATION-1 = BLOCKED — DIAGNOSED

FINAL CONFIRMATION:

"No production code was modified and no legacy files were deleted during this diagnostic continuation."
