# AETERNA — REPOSITORY INTEGRITY FIX 1: Duplicate Service Quote Authority

Status: COMPLETE  
Authority: Implementation Record  
Version: 1.0

## 1. Duplicate Authority Found
- functions/api/web3/create-quote.ts — legacy/transitional endpoint
- functions/api/service-payment/create-quote.ts — canonical Service Payment Quote authority

Both previously called createBusinessQuote() and could establish authoritative Business Quote state.

## 2. Canonical Authority Selected
functions/api/service-payment/create-quote.ts is the current canonical Service Payment Quote authority per:
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md

## 3. Legacy Path Isolation
Modified functions/api/web3/create-quote.ts:
- Deprecated header/documentation
- Changed POST handler to return 410 LEGACY_CREATE_QUOTE_DEPRECATED
- No longer calls createBusinessQuote()
- No longer mutates BUSINESS_QUOTES KV
- Preserved OPTIONS preflight handler

## 4. Tests Updated
- functions/test/businessQuoteStore.invariant.test.ts: retargeted to canonical service-payment/create-quote.ts
- functions/test/harness.smoke.test.ts: updated to verify legacy web3/create-quote returns 410 DEPRECATED

## 5. Active Runtime Verification
- ACTIVE RUNTIME → /api/service-payment/create-quote
- /api/web3/create-quote → DEPRECATED, returns 410, no quote authority
- No active creator flow depends on /api/web3/create-quote for quote creation

## 6. Business Quote Store
- Single canonical store: functions/lib/business/businessQuoteStore.ts
- Both endpoints previously used the same store, creating duplicate authority
- Now only canonical endpoint can write Business Quote state
- Legacy endpoint has no write path to BUSINESS_QUOTES

## 7. SHA-256 Duplication
- functions/lib/sha256.ts — server-side helper
- src/lib/crypto/sha256.ts — client-side helper

Classification: NON-BLOCKING duplication/cleanup candidate
- Neither creates separate security authority
- Both use same canonical crypto.subtle.digest("SHA-256", ...)
- Retained for later cleanup phase

## 8. Security Tests
A. Legacy web3 create-quote cannot create canonical quote — PASS
B. Canonical service-payment create-quote works — PASS
C. Only canonical endpoint can establish Service Quote authority — PASS
D. Quote cannot be created without required fields — PASS
E. Duplicate quote authority cannot exist — PASS
F. Legacy path cannot grant Creator Credit — PASS

## 9. Validation Results
- npm run typecheck — PASS
- npm run test — PASS: 230 passed | 4 skipped
- npm run build — PASS
- npm run lint — 0 errors, 18 pre-existing warnings
- npm run format — 0 errors, 18 pre-existing warnings

## 10. Remaining Blockers
- functions/lib/sha256.ts and src/lib/crypto/sha256.ts duplication — NON-BLOCKING, deferred to later phase
