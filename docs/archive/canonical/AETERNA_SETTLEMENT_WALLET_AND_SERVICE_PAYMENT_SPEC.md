# AETERNA — Settlement Wallet and Service Payment Architecture Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- IRYS-RESEARCH-1 findings
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks

---

## 1. PURPOSE

This document defines the canonical architecture for the AETERNA Service
Payment layer and the AETERNA Settlement Wallet.

This document does NOT implement payment endpoints, wallet integration,
Irys integration, UI, or protocol core.

## 2. SCOPE BOUNDARY

This specification covers only:

- AETERNA Settlement Wallet role and security model;
- AETERNA Service Payment Quote;
- AETERNA service payment verification;
- payment-to-Creator-Credit grant atomicity;
- Creator Identity binding for service payments.

This specification explicitly excludes:

- Irys publication/storage payment flow;
- capsule creation semantics;
- sealing semantics;
- crypto semantics;
- storage semantics;
- frontend UI implementation;
- Protocol page content;
- CapsuleHold behavior.

## 3. AUTHORITY HIERARCHY

The authoritative chain for AETERNA service payment is:

Creator Identity
-> immutable AETERNA Service Payment Quote
-> payment evidence
-> server-side verification
-> Creator Credit grant

Frontend intent, React state, localStorage, sessionStorage, URL parameters,
and client-supplied payment claims are NEVER sufficient to establish
payment entitlement or grant Creator Credit.

Server-side authority is authoritative for all payment decisions.

## 4. WHAT THE AETERNA SETTLEMENT WALLET IS

The AETERNA Settlement Wallet is the AETERNA-owned payment destination that
receives the $1 USD-equivalent AETERNA service payment.

Role:

- receives AETERNA service payments from creators;
- is the canonical recipient recorded in every immutable AETERNA Service
  Payment Quote;
- is operated by AETERNA, not by creators;
- is separate from Irys payment/publication infrastructure.

What it may receive:

- AETERNA service payments in approved payment assets on approved networks.

What it may not receive:

- Irys publication/storage payments;
- creator funds for any purpose other than the AETERNA service fee;
- payments without an associated immutable quote and Creator Identity.

Custody model:

- The Settlement Wallet is controlled by AETERNA operational infrastructure.
- The architecture does not require AETERNA to custody creator funds beyond
  the service payment receipt.
- AETERNA must maintain operational separation between settlement receipt
  and any downstream treasury or withdrawal flow.

Relationship to Creator Identity:

- The Settlement Wallet is the payment destination, not the identity.
- Creator Identity is the authenticated creator principal.
- A verified payment to the Settlement Wallet is evidence for granting
  Creator Credit to a Creator Identity, not evidence that the Settlement
  Wallet owns the credit.

Relationship to Creator Credit:

- Creator Credit is granted to a Creator Identity.
- Creator Credit is never granted to a raw wallet address or settlement
  destination.
- The Settlement Wallet has no entitlement semantics; it is a recipient
  only.

## 5. AETERNA SERVICE PAYMENT QUOTE

The AETERNA Service Payment Quote is the immutable server-side commercial
entitlement object for the $1 service payment.

Required fields:

- quoteId: unique immutable identifier;
- creatorIdentityId: bound Creator Identity;
- serviceFeeUsd: 1.00;
- selectedPaymentAsset: approved AETERNA payment asset;
- selectedNetwork: approved network for the payment asset;
- exactAtomicAmount: exact amount in asset atomic units;
- recipient: AETERNA Settlement Wallet destination;
- createdAt: server timestamp;
- expiresAt: server-defined expiration;
- status: created/used/expired/cancelled.

Immutable fields:

- quoteId;
- creatorIdentityId;
- serviceFeeUsd;
- selectedPaymentAsset;
- selectedNetwork;
- exactAtomicAmount;
- recipient.

Once created, immutable fields MUST NOT change.

Single-use semantics:

- Each quote MUST be consumed at most once.
- Reuse after successful verification MUST be rejected.
- A quote MUST NOT be reused to grant multiple Creator Credits.

Expiration:

- A quote MAY expire.
- An expired quote MUST NOT be used to grant Creator Credit.
- Frontend display of an expired quote MUST trigger quote cancellation or
  reissuance through the server.

Relation to challenge/nonce:

- When a quote is tied to an identity proof, the challenge/nonce MUST be
  bound to the exact quote context.
- The server MUST validate proof context against the quote before granting
  credit.

Duplicate-payment handling:

- If the same on-chain/off-chain payment evidence is presented against
  multiple quotes or multiple identities, the server MUST detect the
  duplicate and grant at most one Creator Credit.
- Duplicate verification MUST return the existing result or an equivalent
  already-processed response.

## 6. PAYMENT ASSET AND NETWORK MODEL

AETERNA maintains an approved payment asset and network allowlist.

Allowlist authority:

- AETERNA is authoritative for the allowlist.
- Irys support for an asset/network is a prerequisite, not automatic
  inclusion.
- The allowlist is a configuration decision, not determined by frontend
  preference or provider session state.

Quote locking:

- The quote locks the selectedPaymentAsset and selectedNetwork.
- After quote creation, the creator MUST pay in the quoted asset/network.
- Switching asset/network after quote creation invalidates the quote for
  that payment attempt.

Authoritative persistence:

- Every issued Service Payment Quote MUST exist in authoritative server-
  side state.
- The frontend MUST NOT be the canonical storage or authority for quote
  amount, asset, network, recipient, creatorIdentityId, expiration, status,
  or consumption state.
- The quote returned to the frontend is a representation of server authority,
  not the authority itself.
- The exact server-side storage technology remains implementation PENDING.

Asset/network switching:

- If the user switches asset/network after quote creation:
  - the current quote MUST be treated as cancelled or expired for payment
    purposes;
  - a new quote is REQUIRED for the new asset/network;
  - any partial payment against the old quote MUST follow failure/recovery
    rules.
- A new quote MUST NOT silently inherit the old quote's creator entitlement.

## 7. EXACT $1 USD EQUIVALENCE

Business rule:

- The AETERNA service fee is fixed at USD 1.00.
- The fee does NOT depend on capsule size, Irys cost, network fees, or
  payment asset.

Conversion architecture:

- The canonical USD amount is converted to exact atomic amount in the
  selected payment asset by server-side logic.
- The conversion result is recorded in the immutable quote.
- The frontend MAY display the converted amount.
- The frontend does NOT determine the authoritative amount.

Tolerance policy:

- Payments MUST match the exact atomic amount recorded in the quote.
- Underpayment MUST NOT grant Creator Credit.
- Overpayment handling is a configuration/reconciliation decision, but
  overpayment MUST NOT automatically grant additional Creator Credit beyond
  the intended 1:1 entitlement.

Quote rate snapshot:

- The exactAtomicAmount in an issued quote is a snapshot established at
  quote creation time.
- A later exchange-rate change MUST NOT retroactively mutate an already-
  issued quote.
- If a quote becomes invalid, a NEW quote must be issued.

Pending decision:

- The exact price source/oracle for USD-to-asset conversion is NOT YET
  SELECTED.

## 8. PAYMENT VERIFICATION

Before granting Creator Credit, the server MUST independently establish
the actual payment facts from a trusted network source.

Client-supplied payment evidence MUST NEVER by itself establish payment
validity. The server MUST NOT trust client claims for:

- transaction ID/hash;
- sender/account;
- recipient;
- network/chain;
- asset/token;
- amount;
- confirmation count;
- finality;
- payment status.

The server MUST verify payment through one of the following:

- direct network/blockchain queries;
- a trusted verification/oracle service that independently derives the
  payment facts.

The exact provider/oracle remains implementation-selection PENDING.

Once independently established, the server MUST verify:

- recipient matches the AETERNA Settlement Wallet for the quote;
- asset matches selectedPaymentAsset in the quote;
- network matches selectedNetwork in the quote;
- amount matches exactAtomicAmount in the quote;
- the verified sender/account is authorized for the Creator Identity
  associated with the quote;
- payment evidence is associated with the correct quoteId;
- payment has not already been used to grant a Creator Credit;
- payment evidence is not a replay of previously verified evidence;
- payment has reached the required confirmation/finality status for the
  selected network.

Sender / Creator Identity verification:

- The server MUST verify that the independently verified payment sender
  matches a server-verified account binding for the Creator Identity.
- The server MUST NOT treat a client-supplied wallet address, provider
  session, or raw address as sufficient proof of payment ownership.

Network-specific verification:

- Different networks may require different evidence types, confirmation
  rules, and finality criteria.
- The server MUST apply network-specific verification rules.
- One universal verification method across all networks is NOT required.

## 9. SETTLEMENT WALLET SECURITY

Architectural security requirements:

- private key custody must be separated from application logic;
- signing authority for settlement operations must be restricted to
  authorized operational infrastructure;
- access control must limit who or what can initiate withdrawals or
  configuration changes;
- secrets management must protect private keys and credentials;
- monitoring must detect anomalous receipt patterns, unauthorized
  withdrawal attempts, or misconfiguration;
- withdrawal authority must follow operational separation of duties;
- compromise containment must limit exposure if settlement credentials are
  compromised;
- hot/cold separation is recommended if operational requirements support it;
- the AETERNA server does NOT need wallet signing authority for creator
  service payments; creator-side wallet signing is sufficient.

This document does NOT select a specific custody solution, wallet product,
or key management system.

## 10. PAYMENT-TO-CREDIT ATOMICITY

Canonical state transition:

verified payment for valid quote bound to Creator Identity
-> grant one Creator Credit to that Creator Identity

Authority invariant:

NO independently verified payment
-> NO Creator Credit

ONE independently verified eligible payment
-> MAXIMUM ONE Creator Credit

The server MUST atomically bind the verified payment to:

- one immutable quote;
- one Creator Identity;
- one Creator Credit grant.

A retry MUST NOT create another Credit.

The architecture MUST prevent:

- verified payment without Creator Credit grant;
- Creator Credit grant without verified payment;
- duplicate Creator Credit from one verified payment;
- two Creator Credits from the same payment evidence;
- concurrent redemption races for the same quote or payment evidence;
- replay of verified payment evidence to grant additional credit.

Concurrency protection:

- The server MUST serialize verification and credit grant for the same
  quoteId or payment evidence.
- Atomic transition MUST be enforced server-side.
- Frontend retries or duplicate requests MUST NOT create additional credits.

Idempotency:

- Repeated verification of the same payment evidence against the same
  quote MUST return the existing Creator Credit or equivalent already-
  processed result.
- The server MUST track payment evidence state to enforce idempotency.

### 10.1 Downstream Credit Consumption Interface Contract

Payment-layer atomicity guarantees ONE verified payment -> MAXIMUM ONE
Creator Credit. It does NOT by itself guarantee that ONE Creator Credit
will be consumed by at most one downstream capsule lifecycle.

This section defines the architectural interface contract between the
payment layer and the downstream capsule lifecycle.

Contract:

A. Creator Credit is the authoritative entitlement for one capsule
   creation attempt.
B. A capsule creation attempt MUST obtain an atomic/serialized transition
   of the Credit from AVAILABLE -> CONSUMING before proceeding.
C. Two concurrent capsule creation attempts MUST NOT both successfully
   obtain the same Creator Credit.
D. Only the lifecycle that successfully owns CONSUMING may proceed toward
   final consumption via successful publication + Seal.
E. On failure before successful publication + Seal, the Credit returns to
   AVAILABLE according to the canonical Creator Credit rules.
F. After successful publication + Seal, the Credit becomes CONSUMED.
G. The downstream capsule/Seal implementation is responsible for
   implementing this interface safely.
H. This specification defines the entitlement boundary and contract only;
   it does NOT implement the capsule layer.

Failure safety:

- payment not independently verified -> no Credit;
- quote invalid/expired -> no Credit under that quote;
- verification failure -> no Credit;
- duplicate payment verification -> no duplicate Credit;
- server retry -> idempotent result;
- lifecycle failure before final successful Seal -> Credit preserved/
  restored according to Creator Credit specification;
- successful publication + Seal -> Credit consumed.

## 11. CREATOR IDENTITY BINDING

A verified AETERNA service payment becomes associated with a Creator Identity
through the immutable quote.

Binding rules:

- The quote MUST contain creatorIdentityId.
- The server MUST verify that the payment evidence, quote, and Creator
  Identity are consistent before granting credit.
- Creator Credit MUST be bound to Creator Identity, not to a raw wallet
  address, frontend account state, or provider session.

Respect for SPEC-WP-5:

- If the payment requires additional network-account proof, the server MUST
  verify the proof and bind the account to the existing Creator Identity
  before or during the payment flow.
- Cross-network account association MUST be explicit and server-verified.

## 12. WALLET AND ACCOUNT SWITCHING

If the user changes wallet, account, network, or provider:

- The change MUST be treated as a potential new Creator Identity.
- An active capsule lifecycle using the old identity MUST be aborted.
- Creator Credit MUST be restored to AVAILABLE if it was CONSUMING.
- A new service payment and new quote are REQUIRED for the new identity.

Switching wallet/account/network/provider MUST NOT transfer Creator Credit
between Creator Identities.

Returning later:

- The user may return to the same Creator Identity by reconnecting the
  same wallet/account and completing identity proof via fresh
  challenge/signature.
- A returned user with the same Creator Identity may use an available
  Creator Credit without paying again.
- A returned user with a different wallet/account MUST establish a new
  Creator Identity and obtain a new Creator Credit.

## 13. CROSS-LAYER AUTHORITY

Authority boundaries by layer:

- Payment layer:
  verified payment -> Creator Credit entitlement.
- Creator Credit layer:
  Credit state -> permission to begin one capsule lifecycle.
- Capsule lifecycle layer:
  successful publication + Seal -> final Credit consumption.

No layer may infer the authority of another layer from frontend state alone.
Each layer must enforce its own authority server-side.

## 14. FAILURE AND RECOVERY

Architectural behavior for failure scenarios:

- payment submitted but not yet confirmed:
  - quote remains active until expiration or confirmation;
  - server MUST NOT grant credit until payment is verified.
- payment confirmed but verification temporarily fails:
  - server MUST retain payment evidence and quote state;
  - verification MAY be retried server-side;
  - credit MUST NOT be granted prematurely.
- duplicate verification:
  - server MUST detect duplicate payment evidence;
  - server MUST return existing credit or already-processed result;
  - server MUST NOT grant additional credit.
- quote expired:
  - server MUST reject credit grant;
  - frontend MUST obtain a new quote;
  - any payment to an expired quote MUST follow overpayment/refund
    reconciliation rules outside Creator Credit semantics.
- payment to wrong destination:
  - server MUST NOT grant credit;
  - payment MUST be treated as invalid for credit purposes;
  - creator MUST initiate a new payment to the correct Settlement Wallet.
- wrong asset or network:
  - server MUST NOT grant credit;
  - quote MUST be treated as invalidated;
  - creator MUST obtain a new quote for the correct asset/network.
- partial or underpayment:
  - server MUST NOT grant credit;
  - partial payment MUST NOT accumulate toward credit.
- overpayment:
  - server MUST NOT grant more than one Creator Credit;
  - overpayment handling is a reconciliation matter outside the credit
    state machine.
- blockchain reorganization or finality issues:
  - server MUST wait for the required confirmation/finality before
    granting credit;
  - reorg that invalidates payment MUST revert verification and MUST NOT
    grant credit.
- server failure after payment but before credit grant:
  - server MUST retain immutable quote and payment evidence;
  - upon recovery, server MUST complete verification or reject safely;
  - credit MUST NOT be granted twice.

## 14. RELATIONSHIP TO IRYS

AETERNA service payment and Irys publication/storage are architecturally
and economically independent layers.

AETERNA Service Payment:

- $1 USD-equivalent payment to the AETERNA Settlement Wallet;
- grants exactly one Creator Credit;
- does NOT pay Irys;
- does NOT cover Irys publication/storage cost;
- does NOT determine Irys payment asset or network.

Irys Publication Payment:

- determined by Irys;
- paid by the creator through the supported Irys flow;
- may use a different asset/network than the AETERNA service payment;
- is a separate user-facing charge.

Prohibited conflations:

- AETERNA service payment MUST NOT automatically pay Irys;
- Irys payment MUST NOT count as AETERNA service payment;
- one payment transaction MUST NOT be assumed to satisfy both layers unless
  explicitly confirmed by future implementation.

## 15. CLOUDFLARE ARCHITECTURE

Architectural responsibilities for Cloudflare Pages/Workers:

- quote creation:
  server generates immutable quote with context binding and expiration;
- payment verification:
  server verifies payment evidence against quote, asset, network, amount,
  recipient, and Creator Identity;
- payment record authority:
  server maintains authoritative state for quote and payment evidence to
  enforce idempotency and single-use;
- credit grant:
  server grants Creator Credit atomically after successful verification;
- idempotency/concurrency:
  server serializes duplicate/replay/concurrent attempts;
- identity binding:
  server binds verified payment to immutable Creator Identity.

Rules:

- All payment decisions MUST be authoritative server-side.
- Frontend MAY display quote and payment status.
- Frontend MUST NOT create, modify, or prove payment state.
- Identity endpoints MUST be browser-compatible.
- Identity endpoints MUST NOT depend on Node-only runtime assumptions.
- Implementation MAY be hosted on Cloudflare Pages/Workers.

## 16. SECURITY REVIEW

Mandatory security invariants:

- server-side authority for all payment decisions;
- immutable quote locks asset, network, amount, recipient, and Creator
  Identity;
- single-use quote and payment evidence;
- server MUST independently establish payment facts from a trusted network
  source rather than accepting client-supplied evidence as authoritative;
- replay-resistant verification;
- frontend non-authority;
- Creator Credit bound to Creator Identity, not raw address;
- concurrent verification/credit grant serialized server-side;
- settlement wallet operational separation;
- wallet/account switching cannot transfer credit between identities;
- one Creator Credit is permitted at most one downstream consumption
  attempt under the cross-layer interface contract.

Pending architectural decisions:

- exact price source/oracle for USD 1.00 conversion;
- exact confirmation/finality thresholds per supported network;
- exact Settlement Wallet custody and key-management architecture;
- exact monitoring/alerting requirements for settlement operations.

Non-blocking recommendations:

- rate limiting on payment and identity proof endpoints;
- audit logging for quote creation, payment verification, credit grant,
  and identity association events;
- anomaly detection for settlement receipt patterns.

## 17. OPEN ISSUES

- exact price source/oracle for USD 1.00 conversion;
- exact confirmation/finality requirements per supported network;
- exact Settlement Wallet custody solution and key-management architecture;
- exact Cloudflare Pages/Workers route and data-store architecture;
- exact payment evidence formats per network/provider;
- exact reconciliation and refund process for misdirected or expired
  payments;
- legal review of service entitlement in selected jurisdictions.

## 18. DECISION SUMMARY

Exact architectural decisions made:

- AETERNA Settlement Wallet is the AETERNA-owned recipient for $1 service
  payments only.
- AETERNA service payment and Irys publication are separate layers.
- Payment authority chain is: Creator Identity -> immutable quote -> server
  verification -> Creator Credit.
- Quote is single-use, immutable for key fields, and server-authoritative.
- AETERNA maintains approved asset/network allowlist; quote locks selection.
- USD 1.00 is converted server-side to exact atomic amount; frontend is
  display-only.
- Server verifies recipient, asset, network, amount, quote, identity,
  finality, replay, and duplicate credit before granting credit.
- Payment-to-credit transition is atomic and server-side.
- Creator Credit is bound to Creator Identity, not raw address.
- Wallet/account/network/provider switching aborts active lifecycle and
  cannot transfer credit.
- Failure before credit grant preserves quote/payment state for safe
  recovery; credit is never granted without verified payment.

Pending decisions:

- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact Settlement Wallet custody architecture;
- exact Cloudflare implementation;
- exact payment evidence formats per network.

## 19. REFERENCES

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks
