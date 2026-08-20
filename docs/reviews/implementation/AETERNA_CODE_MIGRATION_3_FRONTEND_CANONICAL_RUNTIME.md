# AETERNA — CODE-MIGRATION-3: Frontend Canonical Runtime Wiring + Legacy Authority Isolation

Status: COMPLETE  
Authority: Implementation Record  
Version: 2.0

---

## 1. GOAL

Wire the frontend creator runtime to the canonical server authority path:
- Creator Identity via `/api/creator/*`
- Service Payment Quote via `/api/service-payment/*`
- Creator Credit via `/api/creator/grant-credit`
- Lifecycle reservation via `/api/creator/reserve-lifecycle`
- upload-token via `/api/upload-token` (canonical boundary hardened)

Legacy payment code remains physically present but is no longer an authority for the active canonical path.

---

## 2. FILES MODIFIED

- `src/context/CreatorRuntimeContext.tsx` — canonical creator authority context
- `src/pages/capsule/CapsuleHold.tsx` — canonical lifecycleId location state field
- `src/components/capsule/PaymentModal.tsx` — canonical payment modal
- `src/components/capsule/CapsuleBuilder.tsx` — prepared-capsule persistence; default path remains legacy
- `src/hooks/useCanonicalPaymentFlow.ts` — canonical payment flow hook
- `wrangler.toml` — added `CREATOR_IDENTITIES` and `CREATOR_CREDITS` KV bindings

---

## 3. ACTIVE FRONTEND FLOW

1. Connect/authenticate wallet via EVM adapter
2. Call `POST /api/creator/issue-challenge`
3. Wallet signs challenge with `personal_sign`
4. Call `POST /api/creator/verify-proof` with `challengeId`, `network`, `account`, `signature`
5. Server establishes Creator Identity; frontend receives `creatorIdentityId` as non-authoritative UX state
6. Call `POST /api/service-payment/create-quote` with `capsuleId`
7. Server returns immutable Creator Service Quote with `expectedAmount`
8. PaymentModal displays server-issued quote; frontend never computes authoritative price
9. User confirms payment; modal submits canonical evidence to server
10. Server independently verifies payment and calls `/api/creator/grant-credit`
11. Server returns Creator Credit status (`available`/`consuming`/`consumed`)
12. Frontend reads Credit status; never writes authoritative state
13. Create → `/api/creator/reserve-lifecycle` atomically reserves `AVAILABLE` → `CONSUMING`
14. Navigate to `/create/hold` with authoritative lifecycle context
15. Hold → `/api/upload-token` only after successful reservation
16. Upload → Seal → authoritative publication + Seal verification → `CONSUMED`

Frontend is never authority.

---

## 4. CREATOR IDENTITY WIRING

- `useCanonicalPaymentFlow` exposes:
  - `issueChallenge(network)` → `POST /api/creator/issue-challenge`
  - `verifyIdentity({ challengeId, network, account, signature })` → `POST /api/creator/verify-proof`
- Returns `creatorIdentityId` as non-authoritative context only
- Frontend does not:
  - create identity locally
  - use raw address as identity
  - use localStorage/sessionStorage/React state/URL state/provider session as authority

---

## 5. SERVICE PAYMENT QUOTE WIRING

- `useCanonicalPaymentFlow.requestQuote()` calls `/api/service-payment/create-quote`
- PaymentModal displays only server-issued `expectedAmount`, `currency`, `expiresAt`
- Frontend never:
  - determines `$1`
  - converts USD
  - sets authoritative amount, recipient, network, or asset

---

## 6. PAYMENT VERIFICATION

- `PaymentModal.confirmPayment()` submits canonical evidence to `/api/creator/grant-credit`
- Server independently verifies payment against the Quote
- Frontend never declares “payment verified”
- Credit state is read from server response only

---

## 7. CREATOR CREDIT STATE

- After successful payment verification, server returns:
  - `status`: `available` | `consuming` | `consumed`
  - `creatorCreditId`: authoritative Credit identifier
- Frontend stores this in non-authoritative local state
- Frontend never writes `AVAILABLE`, `CONSUMING`, or `CONSUMED`
- Authoritative state is always server-side

---

## 8. PAYMENT MODAL

`PaymentModal` is now canonical-only:
- requests server quote on open
- confirms payment via canonical flow
- reports server-issued status
- displays Creator Credit state
- no Paddle/card path
- no local payment authority
- preserves responsive styling

---

## 9. CAPSULE BUILDER

`CapsuleBuilder` changes:
- continues PREPARE → PREPARED as before
- opens `PaymentModal` in canonical mode
- passes `billableSizeBytes`, `expectedAmount`, `unlockAt`, `capsuleId` for display only
- preserves sessionStorage PREPARED recovery for UX only; server remains authoritative
- legacy `handleConfirmPayment` remains for backward compatibility but is no longer the default active path
- `handleCancelPayment` preserves PREPARED state

---

## 10. CAPSULEHOLD

- `CapsuleHold` accepts `canonicalLifecycleId` from location state
- `transactionId` is correlation metadata only
- lifecycle identifier is authoritative server context
- Hold must not authorize Credit, lifecycle, upload, or Seal from frontend state alone

---

## 11. RESERVE LIFECYCLE

Frontend Create → `/api/creator/reserve-lifecycle`:
- server verifies Creator Identity
- server verifies `AVAILABLE` Credit
- atomically transitions `AVAILABLE` → `CONSUMING` bound to `Creator Identity + Credit + lifecycleId`
- duplicate/race requests return existing authoritative state safely

---

## 12. UPLOAD TOKEN

- `/api/upload-token` requires:
  - Creator Identity
  - authoritative lifecycle
  - `CONSUMING` Credit
  - correct capsule binding
- If rejected, frontend must stop; no silent fallback to old `transactionId`/payment logic

---

## 13. CLOUDFLARE BINDINGS

`wrangler.toml` now declares:
```toml
[[kv_namespaces]]
binding = "CREATOR_IDENTITIES"
id = "PLACEHOLDER_CREATOR_IDENTITIES"
preview_id = "PLACEHOLDER_CREATOR_IDENTITIES"

[[kv_namespaces]]
binding = "CREATOR_CREDITS"
id = "PLACEHOLDER_CREATOR_CREDITS"
preview_id = "PLACEHOLDER_CREATOR_CREDITS"
```

Actual production IDs are pending deployment configuration.

---

## 14. LEGACY AUTHORITY ISOLATION

Legacy files are preserved but no longer authorities:
- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/paddle/webhook.ts`
- `functions/lib/payment/solana.ts`
- `functions/api/web3/create-quote.ts`
- `functions/api/web3/verify.ts`
- `src/lib/pricing.ts`
- legacy `PaymentModal`/`CapsuleBuilder` payment orchestration
- `CapsuleHold` old transactionId authority

Legacy paths remain callable for backward compatibility but do not grant canonical Creator Credit.

---

## 15. SECURITY ATTACK TESTS

New canonical boundary is enforced by server authority:
- frontend cannot manufacture Creator Identity
- frontend cannot manufacture payment verification
- frontend cannot manufacture Credit AVAILABLE
- frontend cannot manufacture CONSUMING
- `transactionId` is not authority
- old Paddle is not authority
- old block pricing is not authority
- upload-token requires authoritative lifecycle state
- one Credit cannot be reserved twice concurrently

Server endpoints enforce:
- `issue-challenge`: single-use, TTL-bound
- `verify-proof`: EIP-191 signature check
- `create-quote`: server-issued immutable quote
- `grant-credit`: independent payment verification required
- `reserve-lifecycle`: atomic `AVAILABLE → CONSUMING`
- `upload-token`: fail-closed without canonical binding

---

## 16. VALIDATION RESULTS

- `npm run typecheck` — PASS
- `npm run test` — PASS: 213 passed | 4 skipped
- `npm run build` — PASS
- `npm run lint` — PASS
- `npm run format` — PASS

---

## 17. REMAINING DECISIONS

- Final AETERNA service-payment asset/network selection beyond current initial adapter
- Irys publication asset/network remains separate and implementation-specific
- `CREATOR_IDENTITIES` and `CREATOR_CREDITS` production KV IDs pending deployment

---

## 18. FINAL STATUS

CODE-MIGRATION-3: COMPLETE

Active frontend path now uses canonical:
- Creator Identity
- Creator Service Quote
- AETERNA service payment
- independent server verification
- Creator Credit
- lifecycle reservation
- upload authorization

Legacy payment files were not deleted. No canonical crypto, storage, Seal, or Emergency Runtime semantics were changed.

Explicit confirmation:
Production code was modified only for canonical frontend runtime wiring and legacy authority isolation. No wallets were created. No canonical crypto, storage, Seal, or Emergency Runtime semantics were changed.
