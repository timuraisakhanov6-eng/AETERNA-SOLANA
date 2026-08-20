# AETERNA — LEGACY-CLEANUP-1: Final Legacy Delete Audit

Status: READ ONLY  
Authority: Legacy Cleanup Audit  
Version: 1.0

## 1. Legacy Inventory

### Paddle
- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/paddle/webhook.ts`

### Web3 Legacy
- `functions/api/web3/create-quote.ts`
- `functions/api/web3/verify.ts`

### Block Pricing
- `src/lib/pricing.ts`

### Legacy Payment UI
- `src/components/capsule/PaymentModal.tsx`
- `src/components/web3/WalletSelectorModal.tsx`
- `src/hooks/useUSDCPayment.ts`

### Executor Hot
- `functions/lib/executorHot.ts`

### Payment Helpers
- `functions/lib/payment/solana.ts`
- `functions/lib/payment/verify.ts`

### Credit Lock
- `functions/lib/creditOperationLock.ts`

## 2. Active References

### Paddle
- `src/components/capsule/CapsuleBuilder.tsx` — active frontend call to `/api/paddle/create-checkout`
- `src/pages/capsule/CapsuleHold.tsx` — active frontend call to `/api/paddle/verify`

### Web3 Legacy
- `src/lib/crypto/validators.ts` — comment reference to `/api/web3/verify`
- `functions/test/harness.smoke.test.ts` — imports `functions/api/web3/create-quote`
- `functions/test/payment.invariant.test.ts` — imports `functions/api/web3/verify`

### Block Pricing
- `src/components/capsule/CapsuleBuilder.tsx` — imports `calculatePrice`
- `src/components/capsule/HorizontalCapsule.tsx` — imports `calculatePrice`, block constants
- `src/lib/crypto/cryptoInvariants.test.ts` — imports `calculatePrice`

### Legacy Payment UI
- `src/components/web3/WalletSelectorModal.tsx` — active component file
- `src/hooks/useUSDCPayment.ts` — active hook file
- `src/components/capsule/CapsuleBuilder.tsx` — references web3 payment flow

### Executor Hot
- `functions/api/upload.ts` — imports `executorHot`
- `functions/api/upload-token.ts` — imports `executorHot`
- `functions/test/payment.invariant.test.ts` — mocks `executorHot`

### Payment Helpers
- No active runtime imports found in `src/**` or `functions/api/**`

### Credit Lock
- No active runtime imports found in current canonical creator flow

## 3. Exact Delete Candidates

| FILE | STATUS | WHY | ACTIVE REFERENCES | SAFE TO DELETE |
|------|--------|-----|-------------------|----------------|
| `functions/api/paddle/create-checkout.ts` | LEGACY UNUSED | No canonical creator flow uses Paddle checkout; canonical path is service payment | `CapsuleBuilder.tsx` still calls `/api/paddle/create-checkout` | NO |
| `functions/api/paddle/verify.ts` | LEGACY UNUSED | No canonical creator flow uses Paddle verify; canonical verification is authoritative publication/seal | `CapsuleHold.tsx` still calls `/api/paddle/verify` | NO |
| `functions/api/paddle/webhook.ts` | LEGACY UNUSED | No active caller found | None | YES — verify first |
| `functions/api/web3/create-quote.ts` | LEGACY UNUSED | Returns 410 DEPRECATED; no canonical quote authority | `functions/test/harness.smoke.test.ts` imports it | NO |
| `functions/api/web3/verify.ts` | LEGACY UNUSED | Legacy web3 payment verify; canonical flow does not depend on it | `functions/test/payment.invariant.test.ts` imports it | NO |
| `src/lib/pricing.ts` | LEGACY UNUSED | Block pricing contradicts canonical fixed $1 Creator Credit model | `CapsuleBuilder.tsx`, `HorizontalCapsule.tsx`, `cryptoInvariants.test.ts` | NO |
| `src/components/web3/WalletSelectorModal.tsx` | LEGACY UNUSED | Legacy web3 wallet selector; canonical UI does not use it | None found in canonical src/ | YES — verify first |
| `src/hooks/useUSDCPayment.ts` | LEGACY UNUSED | Legacy web3 payment hook; canonical UI does not use it | None found in canonical src/ | YES — verify first |
| `functions/lib/payment/solana.ts` | LEGACY UNUSED | Placeholder boundary; no active import | None | YES |
| `functions/lib/payment/verify.ts` | LEGACY UNUSED | Contract file; no active import | None | YES |
| `functions/lib/creditOperationLock.ts` | TRANSITIONAL UNUSED | Superseded by Durable Object coordinator; no active runtime consumer | None | YES |
| `functions/lib/executorHot.ts` | CURRENT ACTIVE | Required for publication/upload path; not payment receiver | `upload.ts`, `upload-token.ts`, test mock | NO |

## 4. Protected Files

- `functions/do/*` — authoritative Durable Object coordinator
- `functions/api/creator/*` — canonical creator authority
- `functions/api/publication/*` — canonical publication verification
- `functions/api/seal/*` — canonical seal verification
- `functions/api/service-payment/*` — canonical service payment
- `src/lib/creator/*` — canonical frontend creator runtime
- `src/context/CreatorRuntimeContext.tsx` — canonical frontend context
- canonical crypto, Vault, Manifest, storage, Emergency Runtime

## 5. Transitional Files

- `functions/lib/creditOperationLock.ts` — transitional; replaced by DO coordinator
- `functions/lib/payment/solana.ts` — transitional placeholder
- `functions/lib/payment/verify.ts` — transitional contract
- `src/lib/pricing.ts` — transitional block pricing

## 6. Environment/Config Cleanup

### Current
- `functions/api/service-payment/create-quote.ts` — canonical service payment quote
- `functions/api/service-payment/verify.ts` — canonical service payment verification
- `functions/api/creator/*` — canonical creator lifecycle endpoints
- `functions/do/*` — DO coordinator deployment

### Legacy
- Paddle environment variables in `functions/api/paddle/*` — `PADDLE_ENV`, `PADDLE_API_KEY`, `PADDLE_PRICE_BASE_ID`, `PADDLE_PRICE_EXTRA_ID`, `PADDLE_WEBHOOK_SECRET`
- Web3 environment variables in `functions/api/web3/*` — `ALCHEMY_BASE_URL`
- Legacy pricing references in `src/lib/pricing.ts`

### Pending
- Cloudflare KV namespace migration for old account IDs in `wrangler.toml`

## 7. Exact Deletion Order

1. `functions/lib/payment/solana.ts` — no active references
2. `functions/lib/payment/verify.ts` — no active references
3. `functions/lib/creditOperationLock.ts` — no active references, superseded by DO
4. `functions/api/paddle/webhook.ts` — no active caller
5. `src/components/web3/WalletSelectorModal.tsx` — no canonical consumer
6. `src/hooks/useUSDCPayment.ts` — no canonical consumer

**Blocked pending frontend cleanup:**
- `functions/api/paddle/create-checkout.ts` — blocked by `CapsuleBuilder.tsx`
- `functions/api/paddle/verify.ts` — blocked by `CapsuleHold.tsx`
- `functions/api/web3/create-quote.ts` — blocked by test import
- `functions/api/web3/verify.ts` — blocked by test import
- `src/lib/pricing.ts` — blocked by frontend imports

## 8. Files Requiring Extra Caution

- `src/components/capsule/CapsuleBuilder.tsx` — contains active legacy payment code that must be refactored before Paddle files can be deleted
- `src/pages/capsule/CapsuleHold.tsx` — contains active legacy payment verification that must be refactored before Paddle files can be deleted
- `functions/api/web3/verify.ts` — still imported by payment invariant test
- `functions/api/web3/create-quote.ts` — still imported by smoke test

## 9. Final Deletion List

**Ready for deletion (no active references):**
- `functions/lib/payment/solana.ts`
- `functions/lib/payment/verify.ts`
- `functions/lib/creditOperationLock.ts`
- `functions/api/paddle/webhook.ts`
- `src/components/web3/WalletSelectorModal.tsx`
- `src/hooks/useUSDCPayment.ts`

**Not ready for deletion (active references exist):**
- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/web3/create-quote.ts`
- `functions/api/web3/verify.ts`
- `src/lib/pricing.ts`

## 10. Remaining Uncertainty

- Whether `src/components/web3/WalletSelectorModal.tsx` and `src/hooks/useUSDCPayment.ts` have dynamic imports or emergency runtime references not caught by static search
- Whether `functions/api/paddle/webhook.ts` is called by external Paddle infrastructure outside repository
- Whether legacy test imports in `functions/test/` are intentionally preserved for historical migration coverage

LEGACY-CLEANUP-1 = NOT READY

FINAL CONFIRMATION:

"No production or documentation files were deleted or modified during LEGACY-CLEANUP-1."
