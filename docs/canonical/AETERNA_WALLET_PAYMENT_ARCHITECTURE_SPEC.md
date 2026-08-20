# AETERNA — Wallet / Payment Architecture Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Supersedes: legacy Paddle / card / Base-USDC-only architecture notes

---

## 1. NAME

Wallet / Payment Architecture Specification

## 2. PURPOSE

This document defines the canonical architecture for how AETERNA accepts
Web3 service payments and grants Creator Credit.

This document defines wallet abstraction, payment asset abstraction,
payment verification, and the boundary between AETERNA service payment
and Irys publication/storage.

This document does NOT implement those behaviors.

## 3. SCOPE BOUNDARY

This specification covers only the AETERNA service payment flow that
grants Creator Credit.

This specification explicitly excludes:

- Irys publication/storage payment flow;
- capsule creation semantics;
- sealing semantics;
- crypto semantics;
- storage semantics;
- frontend UI implementation;
- Protocol page content;
- CapsuleHold behavior.

## 4. REFERENCE AUTHORITY

This specification is subordinate to:

- AETERNA_CREATOR_CREDIT_SPEC.md

If this document conflicts with the Creator Credit Specification,
the Creator Credit Specification is authoritative.

## 5. WALLET ABSTRACTION

AETERNA defines an abstract Wallet Provider layer.

The Wallet Provider layer is responsible for wallet-level capabilities
required by the service payment flow.

The concrete wallet provider, wallet protocol, blockchain, and signing
mechanism are NOT YET SELECTED.

This document defines only the abstract capabilities the Wallet Provider
MUST expose:

### 5.1 Required Capabilities

- connect wallet
- disconnect wallet
- identify creator
- prove wallet control
- request payment/signature
- expose selected network/asset
- report transaction/reference
- detect rejected/cancelled action

### 5.2 Requirements

- The Wallet Provider layer MUST be replaceable without changing
  Creator Credit business rules.
- The Wallet Provider layer MUST NOT be hardcoded to:
  - MetaMask;
  - Reown;
  - WalletConnect;
  - Solana wallets;
  - EVM wallets;
  - any specific wallet provider.
- The concrete Wallet Provider selection belongs to a separate
  implementation decision.

## 6. AUTHENTICATED CREATOR IDENTITY

AETERNA conceptually establishes:

"This creator controls this wallet."

### 6.1 Requirements

Server-side creator identity MUST be:

- server-verifiable;
- replay-resistant;
- bound to a challenge/nonce or equivalent;
- not reliant solely on an address sent by the frontend;
- not reliant on localStorage;
- not reliant on React state.

### 6.2 Pending Decisions

The concrete wallet authentication and signing standard are NOT YET
SELECTED.

This document records only the requirement, not the implementation.

## 7. PAYMENT ASSET ABSTRACTION

AETERNA Web3 payment architecture MUST support payment assets that are:

1. supported by the production Irys payment/publication flow;
2. explicitly approved by AETERNA.

### 7.1 Irys Support vs AETERNA Approval

Irys support for an asset does NOT automatically mean AETERNA supports
that asset.

AETERNA-approved assets form the active service payment allowlist.

### 7.2 Abstract PaymentAsset

The following abstract fields represent a payment asset:

- network
- asset identifier
- symbol
- decimals
- payment capabilities
- wallet capability
- Irys compatibility
- pricing source
- active/disabled status

The concrete asset allowlist is a separate configuration decision.

## 8. AETERNA $1 QUOTE

AETERNA service price is fixed at USD 1.00.

AETERNA uses a server-side commercial entitlement object for payment
validation:

Creator Service Payment Quote

### 8.1 Required Fields

The quote MUST contain only commercial/payment values required for
verification and entitlement:

- quoteId
- creator identity binding
- serviceFeeUsd = 1.00
- selected payment asset
- exact atomic payment amount
- recipient
- createdAt
- expiresAt
- status

### 8.2 Quote vs Credit

Payment Quote expiration and Creator Credit expiration are different
concepts.

- Payment Quote may expire.
- Creator Credit does NOT expire.

A Creator Credit is granted only after a verified payment against an
immutable quote.

## 9. PRICE CONVERSION

The canonical price conversion principle is:

USD 1.00
-> server-side price conversion
-> exact amount in selected supported asset
-> immutable payment quote

### 9.1 Requirements

The price source MUST be:

- trusted;
- server-side;
- time-bounded;
- deterministic for a quote;
- resistant to client manipulation;
- captured exactly in the quote at creation.

### 9.2 Frontend Role

The frontend MAY DISPLAY the converted amount.

The frontend does NOT determine the authoritative amount.

### 9.3 Pending Decisions

The exact price source/provider is NOT YET SELECTED.

## 10. PAYMENT VERIFICATION

Server-side payment verification checks the actual payment against the
immutable Creator Service Payment Quote.

### 10.1 Minimum Verification Requirements

Verification MUST confirm:

- correct network;
- correct asset;
- correct recipient;
- correct amount;
- correct creator identity;
- correct transaction/reference;
- correct quote;
- valid status/finality;
- no replay.

### 10.2 Idempotency

One verified payment event may produce maximum 1 Creator Credit.

Duplicate verification of the same payment MUST return the existing
entitlement or an equivalent already-processed result.

### 10.3 Abstraction Requirement

This document does not define the exact chain transaction format,
because the concrete provider/chain is not yet selected.

## 11. CREATOR CREDIT BOUNDARY

The Wallet/Payment Architecture grants Creator Credit.

The Wallet/Payment Architecture does NOT define capsule creation
semantics.

Creator Credit rules remain authoritative in:

- AETERNA_CREATOR_CREDIT_SPEC.md

The boundary is:

verified service payment
-> grant one Creator Credit

Payment system behavior after granting credit is governed by the
Creator Credit Specification, not this document.

## 12. IRYS SEPARATION

AETERNA service payment and Irys publication/storage are separate layers.

AETERNA $1 service payment:

- grants Creator Credit;
- is NOT a storage price;
- is NOT Irys gas;
- is NOT Irys publication cost;
- is NOT capsule size pricing.

Irys publication/storage:

- determines actual publication/storage cost;
- is paid by the creator through the supported Irys flow;
- remains pending final Irys production architecture confirmation.

Wallet identity rule:

- The same authenticated creator wallet identity MUST be used for both
  the AETERNA service payment and the subsequent Irys publication and
  capsule creation lifecycle.
- A different wallet MUST NOT be used after the AETERNA service payment.

Payment asset rule:

- The payment asset used for the AETERNA service fee MAY differ from the
  payment asset selected for Irys publication.
- AETERNA service payment asset selection does NOT determine Irys
  publication payment asset.
- Irys publication payment asset selection does NOT determine AETERNA
  service payment asset.

Do NOT say:

- "AETERNA uses one payment asset for both AETERNA and Irys."
- "The same token must be used for AETERNA and Irys."

Correct statement:

- "The creator uses one wallet identity for the entire capsule lifecycle.
  The payment asset used for the AETERNA service fee may differ from the
  payment asset selected for Irys publication."

This document does NOT define the final Irys browser/wallet/signing
flow.

## 13. USER EXPERIENCE

The canonical human-readable flow is:

1. User opens AETERNA.
2. Protocol Rules are available before payment.
3. User clicks CREATE CAPSULE.
4. If no AVAILABLE Creator Credit, payment modal appears.
5. User sees fixed $1 AETERNA service fee.
6. System displays exact amount in selected supported asset.
7. User confirms in wallet.
8. AETERNA verifies payment.
9. Creator Credit becomes AVAILABLE.
10. User can create a capsule without a time limit.
11. Irys publication happens separately when capsule is ready.
12. Irys determines its actual publication/storage cost.
13. User completes the Irys publication flow.
14. Successful publication + Seal consumes the Credit.

This document does NOT promise:

- one transaction;
- one signature;
- one wallet provider;
- instant Irys publication;

until confirmed by the final implementation.

## 14. SECURITY REQUIREMENTS

The architecture MUST include:

- server-side wallet authentication;
- replay protection;
- payment idempotency;
- quote immutability;
- exact amount verification;
- recipient verification;
- network verification;
- asset verification;
- creator identity binding;
- frontend non-authority;
- duplicate payment protection;
- auditability.

## 15. LEGAL / PRODUCT BOUNDARY

AETERNA sells a digital service entitlement:

- $1 Creator Credit.

AETERNA does not price storage by capsule size.

Irys storage/publication cost is a separate external infrastructure cost.

Legal classification of the service entitlement requires
jurisdiction-specific legal review.

This document does not constitute legal advice.

## 16. OPEN DECISIONS

The following decisions remain unresolved:

- wallet provider;
- wallet connection protocol;
- wallet authentication/signing standard;
- supported asset allowlist;
- blockchain/network set;
- price oracle/source;
- settlement recipient model;
- payment transaction format;
- exact Irys browser flow;
- exact Irys wallet/signing flow;
- whether AETERNA $1 and Irys publication can be combined in one
  user wallet flow;
- final storage for Creator Credit;
- final API boundaries.
