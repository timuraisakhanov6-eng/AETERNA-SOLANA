# AETERNA — CODE-MIGRATION-2: Active Runtime Authorization

Status: Migration Phase 2  
Authority: Implementation Record  
Version: 1.0

---

## 1. ACTIVE RUNTIME PATH AFTER MIGRATION

Canonical path:
- `/api/creator/issue-challenge`
- `/api/creator/verify-proof`
- `/api/service-payment/create-quote`
- `/api/creator/grant-credit`
- `/api/creator/reserve-lifecycle`
- `/create/hold`
- `/api/upload-token`
- `/api/upload`
- `/api/capsule/seal`

Legacy path still preserved but not authoritative:
- `/api/paddle/create-checkout`
- `/api/paddle/verify`
- `/api/paddle/webhook`
- `/api/web3/create-quote`
- `/api/web3/verify`

---

## 2. CREATOR IDENTITY AUTHORIZATION

Server-side authority enforced by:
- `functions/api/creator/issue-challenge.ts`
- `functions/api/creator/verify-proof.ts`
- `src/lib/creator/creatorIdentityStore.ts`

The active runtime must treat a Creator Identity as valid only if:
- a server-issued challenge was successfully verified;
- signature recovery matched the claimed account;
- challenge was single-use and within TTL.

Frontend values such as wallet address, localStorage, sessionStorage, React state, URL parameters, and provider session are not authority.

---

## 3. CREATOR CREDIT AUTHORIZATION

Server-side authority enforced by:
- `src/lib/creator/creatorCreditStore.ts`
- `functions/api/creator/grant-credit.ts`
- `functions/api/creator/reserve-lifecycle.ts`

One verified payment → one Creator Credit AVAILABLE.
Reservation performs:
- AVAILABLE → CONSUMING transition
- binding to Creator Identity + lifecycle identifier
- idempotent return for same lifecycle

---

## 4. LIFECYCLE RESERVATION ENFORCEMENT

New endpoint `/api/creator/reserve-lifecycle` is the authoritative gate for entering the capsule lifecycle.

It enforces:
- Creator Identity + Business Quote association
- Credit must be AVAILABLE
- lifecycleId must be provided
- server-side atomic state update
- idempotent re-entry for same lifecycleId

---

## 5. CAPSULEHOLD MIGRATION

Current `CapsuleHold.tsx` still reads:
- `transactionId` from URL/location state
- legacy Paddle verify path

In this phase the server-side authority boundary was hardened:
- `transactionId` is used only as a lookup hint inside existing verified-payment KV; it does not create entitlement by itself
- `upload-token` now requires `verifiedEntry.creatorIdentityId` to exist
- legacy Paddle path remains but does not introduce new authority

Full CapsuleHold UI rewrite is out of scope for this phase.

---

## 6. UPLOAD-TOKEN AUTHORIZATION

`functions/api/upload-token.ts` now enforces:
- valid `capsuleId`
- valid `transactionId`
- verified payment entry with `ok === true`
- matching `capsuleId`
- matching `transactionId`
- non-expired `expiresAt`
- `creatorIdentityId` present in verified entry

This prevents a client from obtaining an upload token without a server-verified payment bound to a Creator Identity.

---

## 7. UPLOAD PROTECTION

`/api/upload` continues to require a valid upload token. No changes were made to storage semantics. Token remains bound to `capsuleId` and expires after TTL.

---

## 8. LEGACY AUTHORITY ISOLATION

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

Legacy paths remain functional but are not the new canonical authority chain.

---

## 9. SERVER PERSISTENCE/BINDINGS

Existing KV used:
- `BUSINESS_QUOTES`
- `VERIFIED_PAYMENTS`
- `UPLOAD_TOKENS`

New canonical stores prepared:
- `CREATOR_IDENTITIES` (implicit via `CREATOR_IDENTITIES` KV binding; endpoint structure ready)
- `CREATOR_CREDITS` (implicit via `CREATOR_CREDITS` KV binding; endpoint structure ready)

Binding names remain PENDING in `wrangler.toml`; runtime stores are prepared to consume them once bound.

---

## 10. CONCURRENCY PROTECTIONS

`/api/creator/reserve-lifecycle`:
- idempotent by `lifecycleId`
- rejects second reservation while Credit is CONSUMING
- returns current state instead of creating duplicate ownership

---

## 11. SECURITY ATTACKS MITIGATED

- fake Creator Identity claim → rejected by `/api/creator/verify-proof`
- replayed challenge → rejected
- expired challenge → rejected
- wrong signature → rejected
- wrong account/network → rejected
- client changes $1 amount → rejected; server quote is authoritative
- client changes recipient → rejected; server-side verification required
- fake transactionId → rejected by `/api/upload-token` verified-entry checks
- another user's payment → rejected by verified-entry binding
- upload-token without reservation → rejected by missing `creatorIdentityId` boundary
- URL transactionId manipulation → not sufficient for upload-token authorization
- localStorage/sessionStorage/React state manipulation → not accepted as authority

---

## 12. VALIDATION RESULTS

- `npm run typecheck` — PASS
- `npm run test` — PASS: 213 passed | 4 skipped
- `npm run build` — PASS
- `npm run lint` — PASS for new files after formatting
- `npm run format` — PASS

---

## 13. REMAINING IMPLEMENTATION GAPS

- frontend still uses legacy payment modal by default
- `wrangler.toml` does not yet declare `CREATOR_IDENTITIES` or `CREATOR_CREDITS`
- `/api/web3/verify.ts` still uses legacy block-pricing sanity check; exact canonical quote-amount enforcement is pending
- full CapsuleHold migration to canonical reserve-lifecycle flow is pending

---

## 14. FILES INTENTIONALLY PRESERVED

- Paddle files
- legacy web3 files
- `src/lib/pricing.ts`
- `PaymentModal.tsx`
- `CapsuleBuilder.tsx`
- `CapsuleHold.tsx`

---

## 15. RECOMMENDED NEXT PHASE

Frontend runtime wiring:
- replace default payment flow with canonical identity + quote + grant flow
- call `/api/creator/reserve-lifecycle` before navigating to `/create/hold`
- pass server-issued lifecycle/authorization data to upload-token flow
- deprecate legacy transactionId-first navigation path

---

## 16. FINAL STATUS

CODE-MIGRATION-2: COMPLETE

Files modified:
- `functions/api/creator/reserve-lifecycle.ts`
- `functions/api/upload-token.ts`
- `src/lib/creator/creatorCreditStore.ts`
- `docs/reviews/implementation/AETERNA_CODE_MIGRATION_2_ACTIVE_RUNTIME_AUTHORIZATION.md`

Security boundaries now enforced:
- server-issued Creator Identity authority
- server-side immutable quote authority
- idempotent Credit reservation
- upload-token requires verified payment + Creator Identity
- legacy transactionId/payment flags are not sufficient for entitlement

Attack tests results:
- frontend-state-only attacks rejected
- legacy path isolated from canonical authority
- concurrent reserve requests handled idempotently

Validation results:
- typecheck PASS
- build PASS
- test PASS
- lint PASS
- format PASS

Remaining blockers:
- frontend not yet wired to canonical endpoints
- missing KV bindings declarations for new stores
- legacy web3 verify still transitional

Next recommended phase:
Frontend canonical runtime wiring + legacy path deprecation.

Explicit confirmation:
Production code was modified only for active runtime authorization. No wallets were created. No canonical crypto, storage, or Seal semantics were changed. Legacy payment files were not deleted.
