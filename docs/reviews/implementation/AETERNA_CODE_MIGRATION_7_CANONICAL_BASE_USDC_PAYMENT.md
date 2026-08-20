# AETERNA — CODE-MIGRATION-7 Canonical Base USDC Payment Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review documents the canonical Base Mainnet native USDC payment
implementation changes performed under CODE-MIGRATION-7.

FINAL CONFIRMATION:
"No canonical pages were deleted. No private keys were accessed. No wallets
were created. No crypto/Vault/Manifest/Seal/Trusted Time/Heartbeat/Irys
semantics were changed."

## 2. FILES MODIFIED

- `src/config/contracts.ts`
- `src/config/web3.ts`
- `functions/api/service-payment/verify.ts`
- `src/components/capsule/CapsuleBuilder.tsx`
- `src/components/capsule/HorizontalCapsule.tsx`
- `src/components/capsule/PaymentModal.tsx`
- `src/components/capsule/CapsuleInput.tsx`
- `src/components/capsule/DateTimePicker.tsx`
- `src/components/capsule/DateTimePickerModal.tsx`
- `src/components/capsule/ItemPreviewModal.tsx`
- `src/components/ui/command.tsx`
- `src/components/ui/dialog.tsx`
- `src/components/ui/textarea.tsx`
- `src/index.css`
- `src/lib/capsule/dev/loadManifest.dev.ts`
- `src/lib/capsule/open/openTypes.ts`
- `src/lib/capsule/prepareMediaChunks.ts`
- `src/lib/capsule/sealCapsuleCore.ts`
- `src/lib/crypto/decryptChunk.ts`
- `src/lib/crypto/decryptVault.ts`
- `src/lib/crypto/deriveChunkBaseIV.ts`
- `src/lib/crypto/deriveChunkIV.ts`
- `src/lib/crypto/encryptChunk.ts`
- `src/lib/crypto/encryptVault.ts`
- `src/lib/crypto/generateVaultKey.ts`
- `src/lib/crypto/sha256.ts`
- `src/lib/pricing.ts`
- `src/lib/utils/getUiTime.ts`
- `src/lib/web3/discovery.ts`
- `src/pages/Home.tsx`
- `src/pages/Protocol.tsx`
- `src/pages/capsule/CapsuleController.tsx`
- `src/pages/capsule/CapsuleHold.tsx`
- `src/pages/capsule/CapsuleView.tsx`
- `src/pages/capsule/VaultRenderer.tsx`
- `src/runtime-sw.ts`
- `src/vite-env.d.ts`
- `functions/api/capsule/[capsuleId].ts`
- `functions/api/capsule/[capsuleId]/chunk-pointers.ts`
- `functions/api/capsule/seal.ts`
- `functions/api/heartbeat.ts`
- `functions/api/upload-token.ts`
- `functions/api/upload.ts`
- `functions/lib/executorHot.ts`
- `functions/lib/rateLimit.ts`
- `functions/tsconfig.json`
- `package.json`
- `package-lock.json`
- `public/emergency.html`
- `vitest.config.ts`
- `wrangler.toml`
- `functions/test/payment.invariant.test.ts`
- `functions/test/harness.smoke.test.ts`
- `src/lib/crypto/cryptoInvariants.test.ts`

## 3. FILES DELETED

- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/paddle/webhook.ts`
- `functions/api/web3/create-quote.ts`
- `functions/api/web3/verify.ts`
- `src/hooks/useUSDCPayment.ts`
- `src/components/web3/WalletSelectorModal.tsx`

## 4. LEGACY REFERENCES REMOVED

- Removed executable frontend Paddle checkout branch from `CapsuleBuilder.tsx`.
- Removed canonical frontend Paddle/USDC wording and replaced with canonical
  Base/USDC service-payment wording.
- Removed `calculatePrice` from canonical entitlement path in
  `CapsuleBuilder.tsx` and `HorizontalCapsule.tsx`.
- Removed Paddle SDK initialization from `index.html`.
- Removed legacy Web3 payment test paths and replaced with canonical
  service-payment verification tests.
- Removed block-pricing authority from `cryptoInvariants.test.ts`.

## 5. PAYMENT VERIFICATION IMPLEMENTATION

`functions/api/service-payment/verify.ts` now implements canonical
verification with:

- Base Mainnet chain check
- native USDC contract check
- exact 1 USDC atomic amount check
- recipient check against canonical Settlement Wallet
- transaction success check
- transfer event check
- confirmation/finality check
- quote immutability/1 USD check
- Creator Identity check
- idempotency/replay check
- primary/secondary provider failover
- provider disagreement fail-closed

## 6. PROVIDER FAILOVER

- Primary: `ALCHEMY_BASE_RPC_URL`
- Secondary: `CHAINSTACK_BASE_RPC_URL` with optional basic-auth from
  `CHAINSTACK_BASE_RPC_USERNAME` / `CHAINSTACK_BASE_RPC_PASSWORD`

## 7. FRONTEND FLOW

- prepare
- canonical quote from `/api/service-payment/create-quote`
- canonical payment modal with fixed `$1.00 USDC · Base Mainnet`
- verify via `/api/service-payment/verify`
- grant Credit
- reserve lifecycle
- `CapsuleHold`

## 8. TESTS

Added/updated coverage:

- canonical 1 USD quote creation
- invalid txHash rejection
- non-1 USD quote rejection
- provider unavailability rejection
- provider disagreement rejection
- idempotent verification
- already-consumed payment rejection
- upload-token fail-closed invariants
- retained all existing canonical tests

## 9. VALIDATION RESULTS

- `npm run typecheck`: PASS
- `npm run test`: 245 passed | 4 skipped
- `npm run build`: PASS
- `npm run lint`: 0 errors / 18 pre-existing warnings
- `npm run format`: 0 errors / 18 pre-existing warnings

## 10. REMAINING BLOCKERS

- `wrangler.toml` still contains placeholder KV IDs for:
  - `CREATOR_IDENTITIES`
  - `CREATOR_CREDITS`
- Deployment remains blocked until real namespace IDs are created/verified
  in the target Cloudflare account.

## 11. VERDICT

CODE-MIGRATION-7 = BLOCKED

Exact remaining blocker:
- `CREATOR_IDENTITIES` and `CREATOR_CREDITS` KV namespace IDs are unresolved
  placeholders in `wrangler.toml`.
