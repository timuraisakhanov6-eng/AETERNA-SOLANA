# AETERNA — Service Payment Endpoint Architecture Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks

---

## 1. PURPOSE

This document defines the exact architectural contract that the future
AETERNA service-payment endpoints must satisfy.

This document does NOT implement endpoints, wallet integration, Irys
integration, UI, or protocol core.

## 2. SCOPE

This specification covers the conceptual endpoint operations for:

- Create Service Payment Quote
- Submit / Register Payment Evidence
- Verify Payment
- Grant / Confirm Creator Credit
- Read current payment/Credit state

This specification explicitly excludes:

- Irys publication/storage payment flow;
- capsule creation semantics;
- sealing semantics;
- crypto semantics;
- storage semantics;
- frontend UI implementation;
- Protocol page content;
- CapsuleHold behavior.

## 3. TRUST BOUNDARY

Client MAY provide:

- intent to create a quote;
- selected supported asset/network;
- wallet/account information;
- payment evidence identifiers;
- UI context.

These are NOT authority.

Server MUST independently establish:

- Creator Identity validity;
- quote validity;
- quote persistence;
- allowed asset/network;
- recipient;
- exact atomic amount;
- payment existence;
- payment sender;
- payment destination;
- payment asset;
- payment network;
- actual amount;
- finality/confirmation state;
- uniqueness;
- eligibility for Credit.

## 4. ENDPOINT CONTRACTS

### 4.1 Create Service Payment Quote

Purpose:
Issue an immutable server-side AETERNA Service Payment Quote for the $1
service payment.

Authoritative inputs:

- authenticated Creator Identity;
- selected supported payment asset;
- selected supported network.

Non-authoritative inputs:

- frontend-provided amount calculation;
- frontend-provided recipient;
- client-supplied quote fields;
- provider session claims.

Required server checks:

- Creator Identity is valid and authenticated;
- selected asset/network is in the AETERNA approved allowlist;
- selected asset/network combination is supported;
- exact atomic amount is derived server-side from canonical USD 1.00;
- recipient is the canonical AETERNA Settlement Wallet;
- quote is created server-side and persisted authoritatively.

State transitions:

- CREATED -> ACTIVE
- ACTIVE -> EXPIRED
- ACTIVE -> INVALIDATED
- ACTIVE -> CONSUMED

Successful result:

- immutable quote with bound Creator Identity, asset, network, exact
  atomic amount, recipient, creation time, and expiration.

Failure result:

- quote not created;
- error returned;
- no state mutation.

Idempotency:

- duplicate quote requests for the same Creator Identity and same
  asset/network context MUST NOT create inconsistent authority;
- server MAY issue a replacement quote if prior quote is expired or
  invalidated, but MUST treat prior quote according to its own state.

Replay behavior:

- a fresh quote is generated per authorized request;
- previously expired/invalidated quotes are not reused.

Concurrency behavior:

- concurrent quote requests from the same Creator Identity MUST NOT
  grant entitlement beyond one active quote unless explicitly designed;
- server MUST serialize authoritative quote creation for the same
  identity/context.

### 4.2 Submit / Register Payment Evidence

Purpose:
Accept client-submitted payment evidence identifiers for a quote.

Authoritative inputs:

- immutable quote identifier;
- authenticated Creator Identity;
- client-submitted payment evidence identifiers.

Non-authoritative inputs:

- client claims about payment status;
- client claims about sender/account;
- client claims about amount/asset/network/recipient;
- client claims about finality.

Required server checks:

- quote exists, is active, and is bound to the authenticated Creator
  Identity;
- client-submitted evidence identifiers are recorded server-side;
- no verification or credit grant occurs at this step.

State transitions:

- ACTIVE -> EVIDENCE_REGISTERED

Successful result:

- payment evidence identifiers are recorded server-side against the quote
  and Creator Identity.

Failure result:

- evidence not registered;
- error returned;
- no state mutation.

Idempotency:

- resubmitting the same evidence identifiers for the same quote MUST NOT
  create duplicate authority or duplicate verification attempts;
- server returns the existing evidence registration state.

Replay behavior:

- previously registered evidence for the same quote is recognized;
- no duplicate registration authority is created.

Concurrency behavior:

- concurrent evidence submissions for the same quote MUST be serialized
  server-side;
- only one evidence registration authority may advance.

### 4.3 Verify Payment

Purpose:
Independently verify the actual payment facts and compare them against the
immutable quote.

Authoritative inputs:

- immutable quote identifier;
- authenticated Creator Identity;
- independently verified payment facts from trusted network source.

Non-authoritative inputs:

- client-supplied transaction ID alone;
- client-supplied sender/account alone;
- client-supplied recipient alone;
- client-supplied asset/network/amount alone;
- client-supplied finality claims alone.

Required server checks:

1. quote exists and is ACTIVE;
2. quote is bound to the authenticated Creator Identity;
3. independently verified payment facts establish:
   - payment exists on the actual network;
   - payment network matches quote.selectedNetwork;
   - payment asset matches quote.selectedPaymentAsset;
   - payment recipient matches quote.recipient;
   - payment amount meets or matches quote.exactAtomicAmount;
   - independently verified payment sender/account is authorized for the
     Creator Identity per server-verified account binding;
4. required finality/confirmation condition is satisfied;
5. payment has not been previously verified;
6. payment has not previously granted a Creator Credit;
7. quote has not previously produced a Creator Credit;
8. all required state transitions can be performed atomically.

If any required fact cannot be independently established:
-> payment is NOT verified
-> Credit is NOT granted.

State transitions:

- EVIDENCE_REGISTERED -> VERIFIED
- EVIDENCE_REGISTERED -> REJECTED

Successful result:

- payment is verified and bound to the quote and Creator Identity.

Failure result:

- payment is not verified;
- error returned;
- no Credit grant;
- quote and payment evidence state retained for audit/recovery.

Idempotency:

- repeated verification of the same payment evidence against the same
  quote MUST return the existing verified result or equivalent already-
  processed response;
- server MUST track payment verification state to enforce idempotency.

Replay behavior:

- previously verified payment evidence MUST be recognized;
- no duplicate Credit is granted.

Concurrency behavior:

- concurrent verification requests for the same quote or payment evidence
  MUST be serialized server-side;
- only one verification may succeed atomically;
- other requests receive the existing result.

### 4.4 Grant / Confirm Creator Credit

Purpose:
Atomically grant exactly one Creator Credit to the Creator Identity after
successful payment verification.

Authoritative inputs:

- verified payment;
- immutable quote;
- authenticated Creator Identity.

Non-authoritative inputs:

- frontend credit status;
- client-supplied credit state;
- provider session claims.

Required server checks:

- payment is verified and bound to the quote and Creator Identity;
- quote is still active and has not produced a Credit;
- Creator Identity is still valid;
- atomic transition can be performed.

State transitions:

- VERIFIED -> CREDIT_GRANTED
- CREDIT_GRANTED -> AVAILABLE

Successful result:

- exactly one Creator Credit is granted to the Creator Identity;
- Credit becomes AVAILABLE.

Failure result:

- Credit is not granted;
- error returned;
- no duplicate Credit created.

Idempotency:

- repeated grant requests for the same verified payment/quote MUST return
  the existing Creator Credit or equivalent already-processed response;
- server MUST track Credit grant state to enforce idempotency.

Replay behavior:

- previously granted Credit is recognized;
- no duplicate Credit is created.

Concurrency behavior:

- concurrent grant requests for the same verified payment/quote MUST be
  serialized server-side;
- only one Credit may be granted;
- other requests receive the existing result.

Cross-layer handoff:

- After Credit becomes AVAILABLE, the downstream capsule lifecycle layer
- MUST obtain an atomic/serialized transition of the Credit from
- AVAILABLE -> CONSUMING before proceeding;
- This specification defines the payment-layer grant boundary only;
- downstream consumption serialization is the responsibility of the
  capsule lifecycle layer per the SPEC-WP-6 interface contract.

### 4.5 Read Current Payment / Credit State

Purpose:
Allow authorized queries for current payment quote, verification, and
Credit state.

Authoritative inputs:

- authenticated Creator Identity;
- server-authoritative state.

Non-authoritative inputs:

- frontend-cached state;
- client-supplied status.

Required server checks:

- Creator Identity is valid;
- requested state belongs to the authenticated Creator Identity;
- server returns authoritative state only.

Successful result:

- current quote state;
- current payment verification state;
- current Credit state.

Failure result:

- state not found;
- error returned;
- no state mutation.

Idempotency:

- read operations are inherently idempotent;
- repeated reads return current server-authoritative state.

Replay behavior:

- no state mutation occurs.

Concurrency behavior:

- reads may observe intermediate states;
- reads do not affect state transitions.

## 5. PAYMENT EVIDENCE CONTRACT

Client-supplied evidence:
- transaction identifiers/hashes;
- provider-specific references;
- UI context.

These are NOT the source of truth.

Server-verified payment facts:
- existence on actual network;
- sender/account;
- recipient;
- asset/token;
- network/chain;
- amount;
- finality/confirmation;
- uniqueness.

These are the source of truth.

The server MUST independently establish payment facts from:

- direct network/blockchain queries;
OR
- a trusted verification/oracle service that independently derives the
  payment facts.

The exact provider/oracle remains implementation-selection PENDING.

## 6. CREATOR IDENTITY CONTRACT

The payment endpoint layer MUST:

- accept only server-authenticated Creator Identity;
- bind quote, verification, and Credit to Creator Identity server-side;
- verify that the independently verified payment sender/account is
  authorized for the Creator Identity per server-verified account binding;
- reject any client-supplied identity claim, raw address, or provider
  session as authoritative.

The payment layer MUST NOT:

- treat raw blockchain address as Creator Identity;
- accept client identity claims as authority;
- inherit identity from provider session;
- silently associate payment with another identity.

## 7. IDEMPOTENCY REQUIREMENTS

Conceptual idempotency boundaries:

- quote creation:
  duplicate requests for same identity/context MUST NOT create
  inconsistent authority;
- evidence registration:
  same evidence identifiers for same quote MUST NOT create duplicate
  registration authority;
- payment verification:
  same payment evidence against same quote MUST return existing verified
  result;
- Credit grant:
  same verified payment/quote MUST return existing Creator Credit.

Differences:

- idempotent request:
  same conceptual operation repeated safely;
- duplicate payment:
  same real-world payment event presented multiple times;
- duplicate evidence submission:
  same evidence identifiers submitted multiple times;
- already-completed verification:
  verification already succeeded for given payment/quote.

The server MUST track sufficient state to distinguish these cases and
enforce idempotency without inventing a specific database schema.

## 8. CONCURRENCY / RACE CONTROL

Authoritative serialization boundaries:

Payment verification serialization:
- The server MUST serialize verification and Credit grant for the same
  quoteId or payment evidence;
- concurrent verification requests MUST NOT create multiple Credits.

Creator Credit consumption serialization:
- This endpoint layer guarantees ONE verified payment -> MAXIMUM ONE
  Creator Credit;
- downstream capsule lifecycle MUST separately serialize Credit
  consumption from AVAILABLE -> CONSUMING per the SPEC-WP-6 interface
  contract.

Prevented races:

A. two verification requests granting two Credits for same payment/quote;
B. two Creator Identities claiming one payment;
C. one payment assigned to multiple quotes;
D. one Credit consumed by two capsule lifecycles;
E. retry observing intermediate state and incorrectly issuing another
   Credit.

## 9. STATE MACHINE

Conceptual state categories:

QUOTE:
- CREATED
- ACTIVE
- EXPIRED
- INVALIDATED
- CONSUMED

PAYMENT EVIDENCE:
- UNKNOWN
- REGISTERED
- VERIFIED
- REJECTED
- ALREADY_CONSUMED

CREATOR CREDIT:
- NOT_GRANTED
- AVAILABLE
- CONSUMING
- CONSUMED

Valid transitions:

- CREATED -> ACTIVE
- ACTIVE -> EXPIRED
- ACTIVE -> INVALIDATED
- ACTIVE -> EVIDENCE_REGISTERED
- EVIDENCE_REGISTERED -> VERIFIED
- EVIDENCE_REGISTERED -> REJECTED
- VERIFIED -> CREDIT_GRANTED
- CREDIT_GRANTED -> AVAILABLE
- AVAILABLE -> CONSUMING
- CONSUMING -> AVAILABLE
- CONSUMING -> CONSUMED

Forbidden transitions:

- CREATED -> CONSUMED without verification and grant;
- EVIDENCE_REGISTERED -> CREDIT_GRANTED without VERIFIED;
- REJECTED -> VERIFIED without new evidence/verification;
- CONSUMED -> AVAILABLE without explicit recovery rules from Creator
  Credit specification;
- any transition that creates more than one Credit from one verified
  payment.

## 10. FAILURE MODES

Fail-closed behavior:

- invalid Creator Identity -> no quote, no verification, no Credit;
- invalid quote -> no verification, no Credit;
- expired quote -> no verification, no Credit;
- unsupported network -> no quote, no verification, no Credit;
- unsupported asset -> no quote, no verification, no Credit;
- fabricated transaction ID -> payment NOT verified -> no Credit;
- nonexistent payment -> payment NOT verified -> no Credit;
- wrong recipient -> payment NOT verified -> no Credit;
- wrong sender/account -> payment NOT verified -> no Credit;
- wrong asset -> payment NOT verified -> no Credit;
- wrong network -> payment NOT verified -> no Credit;
- insufficient amount -> payment NOT verified -> no Credit;
- excessive/ambiguous amount -> payment NOT verified -> no Credit;
- insufficient finality -> payment NOT verified -> no Credit;
- duplicate payment -> at most one Credit;
- already-consumed payment -> no additional Credit;
- already-granted Credit -> no additional Credit;
- concurrent verification -> serialized; at most one success;
- server retry -> idempotent result;
- network/API timeout -> no Credit; state retained for retry;
- trusted verification source unavailable -> no Credit; state retained
  for retry.

No failed/uncertain condition may grant Credit.

## 11. ATTACK REVIEW

A. Change $1 to $0.01
PASS — exact atomic amount is server-computed and locked in immutable
quote; verification compares against quote, not client amount.

B. Change recipient to attacker
PASS — recipient is locked in immutable quote; server independently
verifies recipient against actual payment facts.

C. Change asset
PASS — asset is locked in immutable quote; server independently verifies
asset against actual payment facts.

D. Change network
PASS — network is locked in immutable quote; server independently
verifies network against actual payment facts.

E. Submit another user's transaction ID
PASS — server independently verifies payment sender/account against
Creator Identity's server-verified account binding.

F. Submit a fabricated transaction ID
PASS — server independently verifies payment existence from trusted
network source; nonexistent payment is rejected.

G. Replay old payment
PASS — server tracks payment verification state; already-consumed payment
cannot grant another Credit.

H. Submit same payment twice simultaneously
PASS — server serializes verification for same payment evidence/quote;
at most one Credit granted.

I. Two Creator Identities claim one payment
PASS — payment is bound to one Creator Identity via immutable quote;
server verifies sender/account against the bound Creator Identity.

J. Change wallet after quote creation
PASS — quote is bound to Creator Identity, not raw address; wallet change
requires new identity proof and new quote.

K. Change wallet after payment
PASS — Credit is bound to Creator Identity; wallet change does not transfer
Credit.

L. Change provider/session
PASS — provider session is never authoritative; identity is established by
server-verified challenge/signature.

M. Manipulate localStorage/sessionStorage/React state
PASS — frontend state is never authority for payment, quote, or Credit.

N. Forge "payment verified"
PASS — only server can transition payment state to VERIFIED; frontend
cannot declare payment verified.

O. Race two verification requests
PASS — server serializes verification for same payment/quote; at most one
success.

P. Race two Credit consumption attempts
PENDING — payment layer guarantees at most one Credit per verified payment;
downstream consumption race is addressed by SPEC-WP-6 cross-layer
interface contract, which requires the capsule layer to serialize
AVAILABLE -> CONSUMING transitions.

Q. Use expired quote
PASS — expired quote is rejected; no Credit granted.

R. Use valid payment against a different quote
PASS — payment evidence is bound to specific quoteId; verification checks
quote association.

S. Reuse valid payment after Credit already granted
PASS — server tracks payment evidence and Credit state; already-granted
Credit cannot be duplicated.

## 12. FRONTEND CONTRACT

Frontend may:

- request quote;
- display quote;
- initiate wallet payment;
- submit payment evidence;
- poll/read server state.

Frontend may NOT:

- declare payment verified;
- declare Credit granted;
- modify quote;
- modify amount;
- modify recipient;
- modify network after quote without new authorization;
- declare Creator Identity;
- finalize Credit state.

## 13. CLOUDFLARE RESPONSIBILITY BOUNDARY

Architectural responsibilities:

- authentication / identity context:
  server authenticates Creator Identity for each request;
- quote authority:
  server creates, persists, and enforces quote state;
- payment verification orchestration:
  server coordinates trusted network/blockchain verification;
- network/trusted-source verification:
  server independently establishes payment facts;
- payment uniqueness:
  server tracks payment evidence state to enforce single-use;
- Creator Identity binding:
  server binds quote, verification, and Credit to Creator Identity;
- Credit grant:
  server grants Creator Credit atomically after successful verification;
- idempotency:
  server serializes duplicate/replay/concurrent attempts;
- concurrency:
  server serializes state transitions for same quote/payment/Creator
  Identity.

Rules:

- All endpoint decisions MUST be authoritative server-side.
- Frontend MAY display state.
- Frontend MUST NOT create, modify, or prove payment/Credit state.
- Endpoints MUST be browser-compatible.
- Endpoints MUST NOT depend on Node-only runtime assumptions.
- Implementation MAY be hosted on Cloudflare Pages/Workers.

## 14. OBSERVABILITY / AUDIT

Mandatory security facts:

The server MUST maintain authoritative state sufficient to reconstruct:

- quote creation and content;
- payment evidence registration;
- payment verification result;
- Creator Identity association;
- Credit grant;
- duplicate/replay rejection;
- lifecycle handoff to downstream capsule layer.

Non-blocking recommendations:

- rate limiting on quote, evidence, verification, and grant endpoints;
- audit logging for all authoritative state transitions;
- anomaly detection for unusual quote/payment patterns.

## 15. UNRESOLVED IMPLEMENTATION DECISIONS

Genuinely unresolved and implementation-selection PENDING:

- exact supported networks;
- exact supported assets;
- exact exchange-rate/oracle provider for USD 1.00 conversion;
- exact confirmation/finality thresholds per supported network;
- exact payment evidence formats per network/provider;
- exact blockchain RPC/provider;
- exact Cloudflare Pages/Workers route names;
- exact Cloudflare data-store implementation;
- exact Settlement Wallet custody vendor;
- exact reconciliation/refund policy for misdirected or expired payments;
- legal review of service entitlement in selected jurisdictions.

Architecture/security invariants that MUST already be explicit:

- server-side authority;
- independent payment verification from trusted network source;
- immutable quote with server-side persistence;
- Creator Identity binding;
- single-use quote and payment evidence;
- atomic payment-to-Credit grant;
- cross-layer authority boundaries;
- downstream Credit consumption interface contract.

## 16. STATE TRANSITION SUMMARY

Conceptual canonical state machine:

QUOTE:
- CREATED -> ACTIVE
- ACTIVE -> EXPIRED
- ACTIVE -> INVALIDATED
- ACTIVE -> EVIDENCE_REGISTERED
- EVIDENCE_REGISTERED -> VERIFIED
- EVIDENCE_REGISTERED -> REJECTED
- VERIFIED -> CREDIT_GRANTED
- CREDIT_GRANTED -> AVAILABLE
- AVAILABLE -> CONSUMING
- CONSUMING -> AVAILABLE
- CONSUMING -> CONSUMED

Forbidden transitions:
- CREATED -> CONSUMED without intermediate verification/grant;
- EVIDENCE_REGISTERED -> CREDIT_GRANTED without VERIFIED;
- REJECTED -> VERIFIED without new evidence/verification;
- CONSUMED -> AVAILABLE without explicit recovery per Creator Credit spec;
- any transition creating more than one Credit from one verified payment.

## 17. CANONICAL CONSISTENCY

Verified against:

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md

No contradictions found.

If a contradiction is discovered in future, it MUST be reported rather
than silently changing other canonical documents.

## 18. REFERENCES

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks
