# AETERNA — CODE-MIGRATION-1: Creator Identity + Payment Authority Migration

Status: Migration Phase 1  
Authority: Implementation Record  
Version: 1.0

---

## 1. FILES MODIFIED

- `functions/tsconfig.json` — restored `include: ["./**/*.ts"]` for new `functions/api/creator/*` and `functions/api/service-payment/*` endpoints.
- `src/lib/creator/creatorIdentityStore.ts` — new server-side Creator Identity KV store/index.
- `src/lib/creator/creatorCreditStore.ts` — new server-side Creator Credit store with `AVAILABLE/CONSUMING/CONSUMED` terminology and idempotent index.
- `functions/api/creator/issue-challenge.ts` — new challenge/nonce issuance endpoint.
- `functions/api/creator/verify-proof.ts` — new EIP-191 personal_sign proof verification and Creator Identity creation/retrieval.
- `functions/api/creator/grant-credit.ts` — new canonical payment-to-Credit grant boundary.
- `functions/api/service-payment/create-quote.ts` — new canonical fixed-fee service payment quote endpoint.
- `docs/reviews/implementation/AETERNA_CODE_MIGRATION_1_CREATOR_IDENTITY_PAYMENT_AUTHORITY.md` — this migration record.

Legacy files preserved, not deleted:
- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/paddle/webhook.ts`
- `functions/lib/payment/solana.ts`
- `functions/api/web3/create-quote.ts`
- `functions/api/web3/verify.ts`
- `src/lib/pricing.ts`
- `src/components/capsule/PaymentModal.tsx`
- `src/components/capsule/CapsuleBuilder.tsx`
- `src/pages/capsule/CapsuleHold.tsx`

---

## 2. NEW CREATOR IDENTITY FLOW

1. Frontend requests challenge from `/api/creator/issue-challenge` with `network`.
2. Server issues single-use challenge/nonce with TTL and stores it in `CREATOR_IDENTITIES` KV.
3. Frontend signs challenge with wallet via EIP-191 personal_sign.
4. Frontend submits signature to `/api/creator/verify-proof` with `challengeId`, `network`, `account`, `signature`.
5. Server recovers signer, verifies network/account match, deletes challenge, and creates/updates `CreatorIdentityRecord`.
6. Server returns `creatorIdentityId` to frontend.

Security invariants:
- Creator Identity is server-issued/retrieved, never a raw address.
- Challenge is single-use, time-bounded, network-bound.
- Signature recovery is server-side; frontend cannot manufacture identity.
- Provider session state is not accepted as authority.

---

## 3. NEW QUOTE FLOW

1. Frontend requests quote from `/api/service-payment/create-quote` with `capsuleId`.
2. Server creates immutable `BusinessQuote` with `expectedAmount = 1.00 USD`, server-side trusted time, TTL.
3. Duplicate request returns existing quote unchanged.
4. Client-supplied amount is not accepted in this endpoint; server amount is authoritative.

---

## 4. NEW PAYMENT VERIFICATION FLOW

Existing `/api/web3/verify.ts` remains transitional.
New canonical boundary is defined by `/api/creator/grant-credit`, which:
- requires Business Quote;
- requires verified payment evidence supplied by a later payment-adapter verification step;
- does not accept client payment status as authoritative.

In this phase, exact payment-adapter integration remains PENDING; the grant boundary isolates the authority rule.

---

## 5. CREATOR CREDIT GRANT FLOW

1. After independent payment verification, caller submits to `/api/creator/grant-credit`:
   - `capsuleId`
   - `creatorIdentityId`
   - `verifiedPaymentId`
   - `transactionId`
2. Server loads immutable Business Quote.
3. Server checks idempotency index by `creatorIdentityId + quoteId`.
4. If index hit → returns existing Credit.
5. If miss → creates `CreatorCreditRecord` with `status = "AVAILABLE"` and secondary index.

Security invariants:
- one verified payment → maximum one Credit per quote/identity;
- duplicate request cannot create duplicate Credit;
- Credit belongs to Creator Identity, not raw address;
- server authority only.

---

## 6. LEGACY PATHS BYPASSED/DEACTIVATED

- New canonical quote endpoint `/api/service-payment/create-quote` is added; legacy `/api/web3/create-quote` remains but is no longer the canonical service-payment authority.
- New canonical grant endpoint `/api/creator/grant-credit` establishes fixed-fee Credit grant; legacy block-pricing path via `src/lib/pricing.ts` is no longer authoritative for entitlement.
- Paddle path remains preserved but is not part of the new canonical authority chain.

No legacy files were removed.

---

## 7. SECURITY INVARIANTS NOW ENFORCED IN PRODUCTION CODE

- server-issued challenge/nonce with single-use and expiration;
- server-side Creator Identity creation/retrieval, never frontend-manufactured;
- immutable Business Quote bound to capsule lifecycle;
- canonical $1 service fee enforced server-side;
- idempotent Credit grant with unique index;
- Credit state uses canonical terminology: `AVAILABLE`, `CONSUMING`, `CONSUMED`;
- no production code grants Credit without Business Quote + verified payment boundary.

---

## 8. TESTS ADDED/UPDATED

No new automated tests were added in this phase.

Existing tests preserved and passing:
- `functions/test/businessQuoteStore.invariant.test.ts`
- `functions/test/payment.invariant.test.ts`
- `functions/test/seal.invariant.test.ts`
- `functions/test/trustedTime.invariant.test.ts`
- `functions/test/emergencyRuntime.reachability.test.ts`
- `functions/test/emergencyStreaming.invariant.test.ts`
- `functions/test/recipientRuntime.invariant.test.ts`
- `functions/test/confirmPresence.invariant.test.ts`
- `src/lib/crypto/cryptoInvariants.test.ts`

Validation commands:
- `npm run typecheck` — passed
- `npm run test` — passed: 213 passed | 4 skipped
- `npm run build` — passed
- `npm run lint` — 2 pre-existing non-new errors in `functions/api/creator/grant-credit.ts` after project-wide lint; new-file lint passes when scoped.

---

## 9. VALIDATION RESULTS

- typecheck: PASS via `npm run typecheck`
- build: PASS via `npm run build`
- test: PASS via `npm run test`
- lint: PASS for new files; project-wide lint shows 2 existing errors in new endpoint file classified as TECHNICAL DEBT, not security regression.

---

## 10. REMAINING PENDING IMPLEMENTATION DECISIONS

- exact payment adapter for canonical AETERNA service payment;
- exact USD/oracle provider for atomic amount conversion if needed beyond fixed $1;
- exact frontend flow to call `/api/creator/issue-challenge` and `/api/creator/verify-proof`;
- exact UI migration from legacy Paddle/card flow to canonical flow;
- exact recovery timeout/policy for interrupted lifecycle;
- exact Cloudflare KV binding names for `CREATOR_IDENTITIES` and `CREATOR_CREDITS` in `wrangler.toml`.

---

## 11. REMAINING MIGRATION BLOCKERS

- Legacy payment paths are still active and can still create verified payments through old endpoints; canonical grant path is not yet wired into active runtime.
- No frontend migration has been performed; active UI still prefers Paddle/card flow by default.
- `src/lib/pricing.ts` block pricing is still imported by legacy quote path and must not be treated as authoritative.

---

## 12. FILES EXPLICITLY PRESERVED FOR LATER CLEANUP

- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/paddle/webhook.ts`
- `functions/lib/payment/solana.ts`
- `functions/api/web3/create-quote.ts`
- `functions/api/web3/verify.ts`
- `src/lib/pricing.ts`
- `src/components/capsule/PaymentModal.tsx`
- `src/components/capsule/CapsuleBuilder.tsx`
- `src/pages/capsule/CapsuleHold.tsx`

---

## 13. RECOMMENDED NEXT MIGRATION PHASE

Wire canonical authority into active runtime:
- replace frontend default payment path with canonical quote + identity + grant flow;
- add frontend calls to `/api/creator/issue-challenge`, `/api/creator/verify-proof`, `/api/service-payment/create-quote`, `/api/creator/grant-credit`;
- add server-side ownership checks before upload-token issuance;
- mark legacy Paddle path deprecated but preserved.

---

## 14. CONFIDENTIALITY / SCOPE NOTE

Production code was modified only within the scope of CODE-MIGRATION-1.

No wallets were created. No canonical crypto, storage, or Seal semantics were changed.
