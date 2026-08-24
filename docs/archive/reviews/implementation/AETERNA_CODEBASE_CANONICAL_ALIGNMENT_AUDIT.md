# AETERNA — Repository vs Canonical Creator Architecture Alignment Audit

Status: Audit Only  
Authority: Read-Only Review  
Version: 1.0  
Reference:
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- AETERNA_AUTHORITATIVE_PUBLICATION_SEAL_VERIFICATION_AND_LIFECYCLE_RECOVERY_SPEC.md
- AETERNA_END_TO_END_CREATOR_CAPSULE_FLOW_IMPLEMENTATION_READINESS_REVIEW.md

---

## 1. EXECUTIVE SUMMARY

This audit compares the current repository implementation against the newly hardened canonical AETERNA creator architecture.

Primary finding:
The current codebase implements a transitional payment/capsule lifecycle with significant legacy and partial canonical support, but it does not yet implement the canonical SPEC-WP-5 through SPEC-WP-10 architectures.

Highest-risk gaps:
- active legacy Paddle/path alongside new web3 path;
- block-based business pricing instead of fixed $1 Creator Credit;
- Base/USDC-only payment model instead of provider-neutral architecture;
- no canonical Creator Credit authority/reservation states in production code;
- publication/Seal verification exists in principle but depends on authoritative Irys/executor evidence paths still pending;
- recovery exists only as local session retry, not as server-side stale-Consuming restoration.

This report identifies:
- PASS: structural invariants already present;
- MISSING IMPLEMENTATION: canonical features absent;
- CANONICAL CONFLICT: existing code contradicts canonical docs;
- TRANSITIONAL CODE: old/new coexisting paths;
- SECURITY BLOCKER: trust-boundary or replay/identity gaps;
- TECHNICAL DEBT: implementation quirks not directly security-blocking.

No production code was modified.

## 2. REPOSITORY INVENTORY

Classification summary:

A. Canonical/current implementation:
- `functions/api/capsule/seal.ts` — server-authoritative seal boundary with payment/upload enforcement and manifest immutability.
- `functions/api/upload-token.ts` — upload authorization gated by verified payment state.
- `functions/api/web3/verify.ts` — independent RPC-based payment verification for Base/USDC, dual-key replay defense.
- `functions/api/web3/create-quote.ts` — server-price-authoritative quote creation for web3 path.
- `functions/lib/business/businessQuoteStore.ts` — immutable quote persistence.
- `src/lib/crypto/*` — crypto/storage authority boundary remains canonical.
- `src/lib/capsule/sealCapsuleCore.ts` — client-side sealing authority generation.
- `functions/api/heartbeat.ts` — capability-guarded heartbeat with trusted time.
- `tests/*.invariant.test.ts` — targeted invariant coverage for payment, seal, upload token, business quote, trusted time, emergency runtime.

B. Transitional implementation:
- `functions/api/paddle/*` — active Paddle checkout/webhook/verify alongside web3 path.
- `src/components/capsule/PaymentModal.tsx` — card+web3 selector with both active flows.
- `src/components/capsule/CapsuleBuilder.tsx` — Paddle+web3 payment orchestration and session recovery.
- `src/pages/capsule/CapsuleHold.tsx` — local lifecycle state/retry with client payment state restoration.

C. Legacy implementation:
- `src/lib/pricing.ts` — block-pricing model.
- `functions/lib/payment/solana.ts` — Solana boundary placeholder only, not wired into active runtime.
- `functions/irys/transport.ts` — Irys transport/bundle utilities, partially legacy vs current executor/gateway flow.

D. Tests:
- `functions/test/*.invariant.test.ts`, `src/lib/crypto/cryptoInvariants.test.ts`, `src/lib/capsule/runtime/byteRuntime.test.ts`.

E. Documentation:
- `docs/canonical/*`, root canonical docs.

F. Build/deployment configuration:
- `wrangler.toml`, `vite.config.ts`, `package.json`, multiple tsconfig files.

G. Unknown/requires investigation:
- exact frontend API contract for payment→hold navigation;
- server route bindings/filesystem routing;
- whether `_worker.bundle` reflects active routing or stale artifact;
- exact Irys publication verification boundary in runtime.

## 3. ACTUAL CREATOR RUNTIME PATH

Entry:
`src/pages/capsule/Create.tsx` → `src/components/capsule/CapsuleBuilder.tsx`

Observed flow:
1. Creator adds items/date/description in `CapsuleBuilder`.
2. Clicking seal path:
   - single-shot PREPARED guard via fingerprint;
   - `preparePreparedCapsule()` generates ciphertext/keys/metadata;
   - result stored in `preparedRef` and optionally `sessionStorage` key `aeterna-prepared-capsule`.
3. Payment:
   - `PaymentModal` supports card (`Paddle`) and web3 (`MetaMask` injected wallet discovery + `sendUSDC`).
   - Web3 path: calls `/api/web3/create-quote`, then `sendUSDC(price, provider)`, then local `verifyWeb3Tx(...)`, then `onConfirmPayment({ web3TxHash })`.
   - Card path: `createPaddleCheckout()` → Paddle overlay → success callback navigates to `/create/hold`.
4. Hold/seal:
   - `CapsuleHold` loads `holdState` from location state or `sessionStorage`.
   - Guards require `holdState` + `transactionId`; otherwise redirects home.
   - Local seal lock via `sessionStorage` key `aeterna-seal-lock`.
   - Core sequence:
     - optional Paddle verification (`/api/paddle/verify`) if `paymentMethod === "card"`;
     - upload token request (`/api/upload-token`) using `transactionId`;
     - vault upload through `/api/upload` using issued upload token;
     - `sealCapsuleCore()` builds manifest + creator authority fragment;
     - server seal (`/api/capsule/seal`) enforces upload token + payment authority + vault availability + manifest whitelist;
     - after successful seal, `CAPSULE_MANIFESTS`, `AUTHORITY_TOKENS`, and consumed authorities are written; `VERIFIED_PAYMENTS` and `UPLOAD_TOKENS` are deleted.

Real authority mapping:
- Server authority: quote creation, payment verification, upload-token issuance, seal manifest commit.
- Frontend authority: orchestration, local retry, UI state, session recovery.

## 4. PAYMENT IMPLEMENTATION AUDIT

Files:
- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/paddle/webhook.ts`
- `functions/api/web3/create-quote.ts`
- `functions/api/web3/verify.ts`
- `functions/lib/business/businessQuoteStore.ts`
- `src/components/capsule/PaymentModal.tsx`
- `src/components/capsule/CapsuleBuilder.tsx`
- `src/lib/pricing.ts`

Findings:
- Legacy Paddle path is active code, not dead.
- New web3 path is active, but is hardcoded to Base/USDC/Alchemy and EVM injected provider discovery.
- Business Quote is present and used as price authority, but its pricing is block-based (`calculatePrice`) instead of fixed $1 Creator Credit.
- Verified payment record uses KV with TTL and dual-key topology, which provides replay protection but is not durable Credit authority.
- No server-side Creator Credit model exists in code.

Classifications:
- TRANSITIONAL CODE: active Paddle + active web3.
- CANONICAL CONFLICT: `src/lib/pricing.ts` block pricing contradicts canonical fixed $1 model.
- SECURITY BLOCKER: frontend-supplied `price` is validated against server-calculated block price in web3/create-quote, but block price itself is not canonical under new model.
- MISSING IMPLEMENTATION: canonical Creator Credit states, reservation, server-authoritative grant.

## 5. CREATOR IDENTITY IMPLEMENTATION AUDIT

Files inspected:
- `src/components/capsule/PaymentModal.tsx`
- `src/components/capsule/CapsuleBuilder.tsx`
- `src/pages/capsule/CapsuleHold.tsx`
- `functions/api/web3/verify.ts`
- `functions/api/web3/create-quote.ts`

Findings:
- No server-side Creator Identity creation/retrieval was found.
- No challenge/nonce issuance endpoint exists in inspected code.
- No explicit network-account binding store exists.
- Web3 path uses `provider` and wallet discovery, but payment verification does not bind sender to a server-side identity object.
- Payment verification binds `capsuleId → transactionId` and `transactionId → record`, but does not map to `Creator Identity`.

Classifications:
- MISSING IMPLEMENTATION: server-issued challenge/nonce, identity proof, Creator Identity store.
- MISSING IMPLEMENTATION: account binding per SPEC-WP-5.
- CANONICAL CONFLICT: payment verification binds to capsule/payment only, not to Creator Identity.
- SECURITY BLOCKER: provider session/wallet state is effectively the only identity signal in current flow.

## 6. CREATOR CREDIT IMPLEMENTATION AUDIT

Files inspected:
- `functions/api/web3/verify.ts`
- `functions/api/upload-token.ts`
- `functions/api/capsule/seal.ts`
- `src/types/business.ts`
- canonical Credit docs

Findings:
- Verified payment grants upload-token eligibility, not a canonical Credit object.
- No `AVAILABLE/CONSUMING/CONSUMED` Credit state machine exists in production code.
- No atomic reservation for capsule lifecycle exists.
- Duplicate prevention is limited to KV replay checks; no Credit-layer serialization.
- Credit recovery for interrupted lifecycle is not implemented server-side.

Classifications:
- MISSING IMPLEMENTATION: canonical Creator Credit authority in code.
- MISSING IMPLEMENTATION: Credit reservation/lifecycle binding.
- MISSING IMPLEMENTATION: recovery state machine for stale Consuming.

## 7. CAPSULE CREATION IMPLEMENTATION AUDIT

Files:
- `src/components/capsule/CapsuleBuilder.tsx`
- `src/components/capsule/PaymentModal.tsx`
- `src/pages/capsule/CapsuleHold.tsx`
- `src/lib/capsule/sealCapsuleCore.ts`

Findings:
- Creation authorization currently depends on successful payment verification and valid upload token.
- No explicit Credit reservation endpoint exists.
- Multiple tabs can potentially progress independently because the only guard is local sessionStorage/refs until server seal.
- Wallet/account/provider switching during lifecycle is not enforced server-side; frontend can navigate away/return using sessionStorage recovery.

Classifications:
- MISSING IMPLEMENTATION: server-side reservation and lifecycle ownership.
- SECURITY BLOCKER: client-side guard is not authoritative for concurrent lifecycle ownership.

## 8. PUBLICATION VERIFICATION AUDIT

Files:
- `functions/api/capsule/seal.ts`
- `functions/lib/executorHot.ts`
- `functions/irys/transport.ts`

Findings:
- `seal.ts` performs vault availability verification via `https://gateway.irys.xyz/{vaultTxId}` with content-length check and retry loop.
- This is closer to authoritative evidence than frontend state, but still relies on gateway availability and HTTP response, not explicit Irys finality/publication proof.
- No separate publication-layer verification contract is implemented.
- `executorHot.ts` balance/gas precheck is performed in `upload-token.ts`, not publication verification.

Classifications:
- MISSING IMPLEMENTATION: explicit authoritative publication evidence/interface per SPEC-WP-10.
- MISSING IMPLEMENTATION: publication finality policy.
- TECHNICAL DEBT: vault-availability check is a proxy for publication proof; may be acceptable temporarily but is not the canonical interface.

## 9. SEAL VERIFICATION AUDIT

Files:
- `functions/api/capsule/seal.ts`
- `src/lib/capsule/sealCapsuleCore.ts`
- `src/pages/capsule/CapsuleHold.tsx`

Findings:
- Seal is server-authoritative for manifest commitment and authority consumption.
- Idempotency exists for identical manifest retries.
- Frontend shows sealed state after successful response; no evidence of frontend forging server state beyond local UI because seal is server-gated.
- However, final Credit consumption is not implemented, so seal currently functions as final irreversible event without explicit Credit state transition.

Classifications:
- PASS: seal authority boundary is strong.
- MISSING IMPLEMENTATION: canonical Credit consumption state transition after seal.

## 10. RECOVERY / HEARTBEAT AUDIT

Files:
- `functions/api/heartbeat.ts`
- `src/components/capsule/CapsuleHold.tsx`
- `src/components/capsule/CapsuleBuilder.tsx`

Findings:
- Heartbeat exists for sealed capsules as presence confirmation using trusted time and creator authority fragment.
- Frontend recovery exists via `sessionStorage` prepared-capsule restore and local retry.
- No server-side lifecycle recovery for stale `CONSUMING` exists.
- No mechanism to distinguish legitimately interrupted lifecycle from attacker replay exists server-side.

Classifications:
- MISSING IMPLEMENTATION: server-side recovery authority and stale-Consuming reconciliation.
- TECHNICAL DEBT: client recovery is safe for honest users but not authoritative against concurrent/replay attacks.

## 11. CRYPTO / STORAGE NON-REGRESSION AUDIT

Files:
- `src/lib/crypto/*`
- `src/lib/storage/*`
- `src/lib/capsule/*`

Findings:
- No evidence that newer creator/payment architecture weakened crypto invariants.
- Secret remains browser-local in current code path.
- Plaintext does not reach server in normal path.
- Canonical serialization/crypto still enforced in seal/manifest path.

Classifications:
- PASS: no non-regression found in inspected paths.

## 12. TRUST-BOUNDARY AUDIT

Key risky patterns:
- `src/components/capsule/CapsuleHold.tsx` uses URL query params and `location.state` to obtain `transactionId` and `holdState`. While server seal still enforces authority, relying on URL/state for primary input widens attack surface.
- `sessionStorage` recovery is authoritative for local ciphertext restore, but server still independently verifies payment before upload token issuance and seal.
- `PaymentModal.tsx` drives payment orchestration but relies on server endpoints for verification.

Classifications:
- SECURITY BLOCKER: client-URL/location-state payment evidence accepted into hold flow without additional server-side ownership check.
- TECHNICAL DEBT: sessionStorage recovery is useful but client-authoritative for resume.

## 13. LEGACY / TRANSITIONAL CODE

Active legacy/transitional artifacts:
- `functions/api/paddle/create-checkout.ts`: active legacy checkout path.
- `functions/api/paddle/verify.ts`: active legacy verify path.
- `functions/api/paddle/webhook.ts`: active legacy webhook path.
- `src/lib/pricing.ts`: active legacy block-pricing model.
- `src/components/capsule/PaymentModal.tsx`: active transitional card/web3 selector.
- `src/components/capsule/CapsuleBuilder.tsx`: active transitional Paddle+web3 orchestration.
- `functions/lib/payment/solana.ts`: unknown/placeholder; no active Solana runtime wiring found.
- `functions/irys/transport.ts`: partially legacy vs active executor/gateway flow.

## 14. DEAD-CODE CANDIDATES

Candidates only:
- `functions/lib/payment/solana.ts` — placeholder/boundary; no active import/runtime usage found.
- `functions/irys/transport.ts` — contains Irys transport utilities not referenced by active seal/upload paths in inspected runtime.
- `functions/api/capsule/[capsuleId].ts`, `functions/api/capsule/[capsuleId]/chunk-pointers.ts` — present but not traced into active creator flow from inspected frontend paths.

Evidence-based note:
These are candidates only. They are not declared dead without route/import confirmation.

## 15. CONFIGURATION AUDIT

Files:
- `wrangler.toml`
- `package.json`
- `vite.config.ts`
- `tsconfig*.json`

Findings:
- `wrangler.toml` includes payment/verification bindings (`VERIFIED_PAYMENTS`, `BUSINESS_QUOTES`, etc.), matching current transitional model.
- No binding for canonical Credit reservation store is present because canonical Credit model is not implemented.
- `package.json` still includes `@paddle/paddle-js`.
- `tsconfig.json` shows baseUrl deprecation-related setup; should be tracked as technical debt.

Classifications:
- TECHNICAL DEBT: tsconfig baseUrl deprecation warning.
- TECHNICAL DEBT: stale legacy payment dependency present.
- MISSING IMPLEMENTATION: new architecture bindings/stores not present.

## 16. TEST AUDIT

Test files:
- `functions/test/businessQuoteStore.invariant.test.ts`
- `functions/test/payment.invariant.test.ts`
- `functions/test/seal.invariant.test.ts`
- `functions/test/upload-token-related coverage`
- `src/lib/crypto/cryptoInvariants.test.ts`
- `src/lib/capsule/runtime/byteRuntime.test.ts`

Findings:
- Meaningful invariant tests exist for Business Quote, payment replay/dual-key binding, seal-once, upload token authorization, trusted time, emergency runtime.
- Some payment tests are marked inconclusive/runtime resolution issues instead of executed invariants.
- No tests exist for canonical Creator Credit states/reservation/recovery.

Classifications:
- PASS: existing payment/seal/quote tests cover current transitional invariants.
- MISSING IMPLEMENTATION: tests for new canonical Credit/lifecycle model.

## 17. FINDINGS CLASSIFICATION SUMMARY

- SECURITY BLOCKER:
  - active legacy Paddle path alongside canonical deprecation target;
  - block-pricing model conflicts with canonical $1 fixed Credit;
  - Base/USDC-only flow conflicts with provider-neutral requirement;
  - frontend URL/location-state payment evidence accepted in hold flow;
  - no server-side Creator Identity; payment verification binds to capsule/payment only.
- CANONICAL CONFLICT:
  - `src/lib/pricing.ts` block pricing;
  - payment verification model not aligned with SPEC-WP-5/6/7 identity/Credit binding.
- MISSING IMPLEMENTATION:
  - server-side Creator Identity store/challenge/signature flow;
  - canonical Creator Credit state machine;
  - atomic Credit reservation and lifecycle ownership;
  - authoritative publication verification interface contract;
  - authoritative Seal verification interface contract;
  - stale Consuming recovery mechanism;
  - new architecture bindings/stores.
- TRANSITIONAL CODE:
  - active Paddle + web3 payment flows;
  - transitional PaymentModal/CapsuleBuilder/CapsuleHold.
- TECHNICAL DEBT:
  - tsconfig baseUrl deprecation warning;
  - stale `@paddle/paddle-js` dependency;
  - some vitest runtime mocks/INCONCLUSIVE markers.
- PASS:
  - seal authority boundary;
  - payment verification independent RPC checks;
  - dual-key replay defense;
  - upload-token gating;
  - crypto non-regression in inspected paths.

## 18. FINAL REPORT

A. Executive summary:
The repository is in a transitional state. It has hardened legacy transitional payment/seal invariants, but does not implement the new canonical Creator Identity, Creator Credit, settlement wallet, or recovery architectures.

B. Actual creator runtime path:
`Create.tsx` → `CapsuleBuilder.tsx` → `PaymentModal.tsx` → `/api/web3/create-quote` or Paddle checkout → `/api/web3/verify` or Paddle verify/webhook → `/create/hold` (`CapsuleHold.tsx`) → `/api/upload-token` → `/api/upload` → `/api/capsule/seal` → manifest commit + authority consumption.

C. Payment implementation audit:
Active legacy Paddle and active Base/USDC web3. Both paths use `BusinessQuote`, but pricing is block-based, not fixed $1 Credit. No server-side Credit model.

D. Creator Identity audit:
No server-side Creator Identity, challenge/nonce, or account binding implementation found. Payment verification does not bind to a server-verified identity.

E. Creator Credit audit:
No canonical Credit authority/reservation/consumption in code.

F. Capsule lifecycle audit:
Lifecycle exists locally and is gated server-side at upload-token and seal, but without Credit-layer ownership/recovery.

G. Publication verification audit:
`seal.ts` checks vault availability via Irys gateway with retries and content-length validation. This is a reasonable proxy but not the canonical SPEC-WP-10 publication evidence interface.

H. Seal verification audit:
Seal is server-authoritative and idempotent. Good boundary, but it does not transition explicit Credit state.

I. Recovery/heartbeat audit:
Client-side sessionStorage recovery exists. Heartbeat exists for post-seal presence. No server-side stale-Consuming recovery.

J. Crypto/storage non-regression audit:
No regression found in inspected paths; crypto/storage authority remains browser-local or server-authoritative appropriately.

K. Trust-boundary findings:
- `transactionId` from URL/location state accepted in `CapsuleHold.tsx`.
- `sessionStorage` recovery is not cryptographically bound to server state.

L. Legacy/transitional code inventory:
- Paddle checkout/verify/webhook active.
- Block pricing active.
- Solana placeholder present.
- Irys transport partially legacy.

M. Dead-code candidates:
- `functions/lib/payment/solana.ts`
- `functions/irys/transport.ts`
- `functions/api/capsule/[capsuleId].ts`
- `functions/api/capsule/[capsuleId]/chunk-pointers.ts`

N. Configuration audit:
- Wrangler lacks new Credit stores/bindings.
- Package still includes Paddle SDK.
- tsconfig baseUrl deprecation warning.

O. Test coverage audit:
- Good transitional invariant coverage.
- Missing canonical Credit/lifecycle/recovery tests.

P. Security blockers:
- Legacy payment paths remain active while canonical model deprecates them.
- Block pricing contradicts canonical fixed-fee model.
- No Creator Identity binding in payment verification.
- Client payment state accepted from URL/location without stronger ownership binding.

Q. Canonical conflicts:
- `src/lib/pricing.ts` block model vs canonical $1 Credit.
- Payment verification binds capsule/payment without Creator Identity layer.

R. Missing implementation:
- SPEC-WP-5 Creator Identity store/proof.
- SPEC-WP-6 Settlement Wallet/Credit authority.
- SPEC-WP-7 payment endpoint canonical contract.
- SPEC-WP-8 Credit reservation/lifecycle ownership.
- SPEC-WP-10 authoritative publication/Seal interface and recovery.

S. Recommended implementation order:
1. Remove or isolate legacy Paddle path.
2. Replace block pricing with canonical $1 Credit model.
3. Implement server-side Creator Identity challenge/proof.
4. Implement canonical Credit store/reservation.
5. Implement authoritative publication verification interface.
6. Implement recovery/reconciliation.
7. Add invariant tests for new states.

T. Explicit list of files that MUST NOT be deleted yet:
- `functions/api/paddle/create-checkout.ts`
- `functions/api/paddle/verify.ts`
- `functions/api/paddle/webhook.ts`
- `functions/lib/payment/solana.ts`
- `functions/irys/transport.ts`
- `functions/api/capsule/[capsuleId].ts`
- `functions/api/capsule/[capsuleId]/chunk-pointers.ts`
- `src/components/capsule/CapsuleBuilder.tsx`
- `src/components/capsule/PaymentModal.tsx`
- `src/pages/capsule/CapsuleHold.tsx`
- `src/lib/pricing.ts`

These files represent active runtime or migration-critical transitional logic.

## 19. CONFIDENTIALITY / SCOPE NOTE

This document is an audit output only.

No production code, configuration, wallets, payment integration, UI, crypto, storage, or Seal implementation was modified.
