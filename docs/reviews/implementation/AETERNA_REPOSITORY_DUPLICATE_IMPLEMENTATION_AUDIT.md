# AETERNA — Repository Integrity Check: Duplicate Implementations Audit

Status: COMPLETE  
Authority: Read-Only Inspection  
Version: 1.0

## A. Recent Files Checked
- functions/lib/creditOperationLock.ts
- functions/lib/sha256.ts
- functions/api/publication/verify.ts
- functions/api/seal/verify.ts
- functions/api/creator/finalize-credit.ts
- functions/api/creator/recover-lifecycle.ts
- functions/api/creator/reserve-lifecycle.ts
- src/lib/creator/creatorIdentityStore.ts
- src/lib/creator/creatorCreditStore.ts
- functions/api/creator/issue-challenge.ts
- functions/api/creator/verify-proof.ts
- functions/api/creator/grant-credit.ts
- functions/api/service-payment/create-quote.ts

## B. Existing Equivalent Files Found
- src/lib/crypto/sha256.ts — client-side SHA-256 helper with same signature as functions/lib/sha256.ts
- functions/api/web3/create-quote.ts — existing web3 quote creation endpoint
- functions/lib/business/businessQuoteStore.ts — canonical Business Quote store used by both web3 and service-payment paths
- functions/lib/payment/verify.ts — payment verification type contract
- functions/lib/payment/solana.ts — Solana payment config boundary

## C. Duplicate Implementations

1. DUPLICATE AUTHORITY — Service Quote Creation
   Files:
   - functions/api/service-payment/create-quote.ts (new)
   - functions/api/web3/create-quote.ts (existing)
   
   Both endpoints:
   - call createBusinessQuote()
   - perform idempotent quote creation
   - use BUSINESS_QUOTES KV
   - validate capsuleId
   
   Classification: SECURITY BLOCKER
   Reason: Two active endpoints can establish the same Business Quote authority. Tests only import from web3/create-quote.ts; service-payment/create-quote.ts has no test or runtime imports found.

2. NEAR-DUPLICATE — SHA-256 Helper
   Files:
   - functions/lib/sha256.ts (new, server-side)
   - src/lib/crypto/sha256.ts (existing, client-side)
   
   Both:
   - export async function sha256(data: Uint8Array): Promise<string>
   - use crypto.subtle.digest("SHA-256", data)
   - return hex-encoded digest
   
   Classification: DUPLICATE IMPLEMENTATION
   Reason: Same algorithm, same signature, split across client/server boundaries. Not an active authority duplicate because they serve different runtimes, but represents code duplication.

## D. Duplicate Authority Risks

| Authority | Active Implementation | Risk |
|---|---|---|
| Creator Identity | functions/api/creator/verify-proof.ts + src/lib/creator/creatorIdentityStore.ts | None — single authority |
| Creator Credit | functions/api/creator/grant-credit.ts + src/lib/creator/creatorCreditStore.ts | None — single authority |
| Credit reservation | functions/api/creator/reserve-lifecycle.ts | None — unique |
| Credit finalization | functions/api/creator/finalize-credit.ts | None — unique |
| Recovery | functions/api/creator/recover-lifecycle.ts | None — unique |
| Publication verification | functions/api/publication/verify.ts | None — unique |
| Seal verification | functions/api/seal/verify.ts | None — unique |
| Service Quote | functions/api/web3/create-quote.ts AND functions/api/service-payment/create-quote.ts | SECURITY BLOCKER — duplicate authority |
| Payment verification | functions/api/web3/verify.ts + functions/lib/payment/verify.ts | None — separate concerns |
| Upload-token authorization | functions/api/upload-token.ts | None — unique |

## E. Files Correctly Unique
- functions/lib/creditOperationLock.ts — no other lock/concurrency helper exists
- functions/api/publication/verify.ts — only publication verification boundary
- functions/api/seal/verify.ts — only Seal verification boundary
- functions/api/creator/finalize-credit.ts — only finalization endpoint
- functions/api/creator/recover-lifecycle.ts — only recovery endpoint
- functions/api/creator/reserve-lifecycle.ts — only reservation endpoint
- src/lib/creator/creatorIdentityStore.ts — only Creator Identity store
- src/lib/creator/creatorCreditStore.ts — only Creator Credit store
- functions/api/creator/issue-challenge.ts — only challenge issuance
- functions/api/creator/verify-proof.ts — only proof verification
- functions/api/creator/grant-credit.ts — only credit granting
- functions/lib/business/businessQuoteStore.ts — canonical single Business Quote store

## F. Unused/Dead-Code Candidates

1. functions/api/service-payment/create-quote.ts
   - Not imported by any test found
   - Not imported by any runtime code found
   - Status: DEAD-CODE CANDIDATE

2. functions/lib/payment/verify.ts
   - Exports only type definitions
   - Not imported by any runtime endpoint found
   - Status: DEAD-CODE CANDIDATE (type-only, low risk)

3. functions/lib/payment/solana.ts
   - Exports only config constants
   - Not imported by any active payment endpoint found
   - Status: DEAD-CODE CANDIDATE (config-only, low risk)

## G. Security Blockers

1. DUPLICATE_SERVICE_QUOTE_AUTHORITY
   Two active endpoints can create the same Business Quote:
   - functions/api/web3/create-quote.ts
   - functions/api/service-payment/create-quote.ts
   
   This creates a duplicate authority path for the same business logic.

## H. Files That Must NOT Be Deleted
- src/lib/crypto/sha256.ts — client-side canonical utility used by crypto invariants tests
- functions/api/web3/create-quote.ts — existing tested web3 quote endpoint
- functions/lib/business/businessQuoteStore.ts — canonical single Business Quote store
- functions/lib/payment/verify.ts — type contract, safe to preserve
- functions/lib/payment/solana.ts — config boundary, safe to preserve

## I. Rule for Future File Creation

Before creating any new file:
1. Search repository for exact filename
2. Search for equivalent symbol/role/endpoint path
3. Search imports/call sites for existing implementation
4. Inspect existing implementation
5. Only then decide: reuse, modify, or create new

If an equivalent implementation already exists:
DO NOT create a parallel file.
