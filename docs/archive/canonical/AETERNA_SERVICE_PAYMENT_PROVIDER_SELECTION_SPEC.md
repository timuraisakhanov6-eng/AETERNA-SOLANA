# AETERNA — Service Payment Provider Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md

---

## 1. PURPOSE

This document defines the minimum requirements any AETERNA service payment
network, asset, provider, and verification adapter must satisfy before it can
be used in the canonical production flow.

This document does NOT select a concrete provider, network, asset, RPC,
or finality threshold for production use.

This document does NOT implement payment endpoints, wallet integration,
Irys integration, UI, or protocol core.

---

## 2. SERVICE PAYMENT MODEL

AETERNA service payment is a separate, independent commercial layer from
Irys publication/storage payment.

Business model:
- fixed USD 1.00 service fee;
- one successfully verified service payment -> maximum one Creator Credit;
- Creator Credit grants entitlement to attempt one capsule creation;
- capsule size, Irys storage cost, network fees, and internal infrastructure
  costs do NOT affect the AETERNA service fee.

Authority chain:
- Creator Identity is server-authoritative;
- Creator Service Quote is immutable and server-authoritative;
- payment verification is server-authoritative;
- Creator Credit grant is server-authoritative.

Frontend state, provider session, React state, localStorage, sessionStorage,
URL parameters, and client-supplied payment claims are NEVER authoritative.

---

## 3. REQUIRED PROVIDER CAPABILITIES

Any provider, network, asset, or verification adapter used for AETERNA
service payment MUST expose or satisfy the following capabilities.

### 3.1 Trusted Transaction Lookup
- The server MUST be able to independently look up payment existence,
  status, sender, recipient, asset, network, amount, and finality from a
  trusted source.
- Client-supplied transaction identifiers alone MUST NOT be treated as
  authoritative.

### 3.2 Sender Verification
- The server MUST verify that the independently verified payment sender
  matches a server-verified account binding for the Creator Identity
  associated with the immutable quote.

### 3.3 Recipient Verification
- The server MUST verify that the independently verified payment recipient
  matches the AETERNA Settlement Wallet recorded in the immutable quote.

### 3.4 Asset Verification
- The server MUST verify that the independently verified payment asset
  matches selectedPaymentAsset recorded in the immutable quote.

### 3.5 Exact Amount Verification
- The server MUST verify that the independently verified payment amount
  matches exactAtomicAmount recorded in the immutable quote.
- Underpayment MUST NOT grant Creator Credit.
- Overpayment MUST NOT automatically grant additional Creator Credit beyond
  the intended 1:1 entitlement.

### 3.6 Network Verification
- The server MUST verify that the independently verified payment network
  matches selectedNetwork recorded in the immutable quote.

### 3.7 Confirmation / Finality Verification
- The server MUST enforce the required confirmation/finality status for the
  selected network before granting Creator Credit.
- The exact confirmation/finality threshold is network-specific and MUST be
  explicitly configured per supported network.

### 3.8 Replay Detection
- The server MUST detect replayed or previously consumed payment evidence
  and MUST NOT grant additional Creator Credit.

### 3.9 Stable Transaction / Evidence Identifier
- The payment network/provider MUST expose a stable identifier that the
  server can use to detect duplicates, replays, and prior verifications.

### 3.10 Server-Side Verification
- All payment facts MUST be independently established and verified
  server-side.
- Browser-side or client-side verification MUST NOT be treated as
  authoritative.

### 3.11 Availability / Latency
- The provider MUST satisfy AETERNA operational availability and latency
  requirements for server-side verification during quote lifetime and
  verification retry windows.

### 3.12 Cloudflare Workers Compatibility
- The verification adapter MUST be compatible with Cloudflare Pages/Workers
  runtime constraints.
- The adapter MUST NOT depend on Node-only runtime assumptions.

### 3.13 Auditable Failure Modes
- The provider/adapter MUST expose distinguishable failure modes for:
  - network/API timeout;
  - trusted source unavailable;
  - malformed evidence;
  - payment not found;
  - insufficient finality;
  - asset/network/recipient/amount mismatch;
  - replay/duplicate detection.
- These failure modes MUST be preserved in server-side observability and
  MUST remain fail-closed: no uncertain payment MAY grant Creator Credit.

---

## 4. REQUIRED EVIDENCE

Server-verified payment facts are the sole source of truth.

The server MUST independently establish:
- payment existence on the actual network;
- payment sender/account;
- payment recipient;
- payment asset/token;
- payment network/chain;
- exact payment amount;
- confirmation/finality state;
- payment uniqueness.

Client-submitted evidence is NOT authority. Client-submitted evidence
MUST only serve as a lookup hint or operational reference.

The exact evidence format is provider/network-specific and MUST be defined
per supported network before that network can be used in production.

---

## 5. VERIFICATION INVARIANTS

The following invariants are MANDATORY for any AETERNA service payment
provider selection.

- NO independently verified payment -> NO Creator Credit.
- ONE independently verified eligible payment -> MAXIMUM ONE Creator Credit.
- The server MUST atomically bind the verified payment to:
  - one immutable quote;
  - one Creator Identity;
  - one Creator Credit grant.
- Quote is single-use and immutable for:
  - creatorIdentityId;
  - serviceFeeUsd;
  - selectedPaymentAsset;
  - selectedNetwork;
  - exactAtomicAmount;
  - recipient.
- Switching asset/network after quote creation invalidates the quote for
  that payment attempt.
- Wallet/account/network/provider switching after quote or payment creation
  MUST be treated as a potential new Creator Identity and MUST require a
  new quote and new payment.
- Provider session is NEVER authority for identity, payment, or credit.
- Frontend payment state is NEVER authority for verification or credit.
- Replayed/consumed payment evidence MUST NOT grant second Credit.
- Fail-closed on uncertainty: no verification -> no credit.

---

## 6. WALLET DEPENDENCY

The AETERNA Settlement Wallet is required for production payment verification.

The Settlement Wallet does NOT yet exist.

Until the Settlement Wallet exists, NO production payment verification can
be finalized.

### 6.1 Required Wallet Properties
Before provider verification can become production-ready, the following
wallet properties MUST be known and operational:

- custody selection model;
- private key management architecture;
- operational separation from application logic;
- withdrawal/access control policy;
- monitoring/alerting configuration;
- actual wallet address;
- address publication mechanism.

### 6.2 Wallet Creation vs Quote Recipient Binding
These are separate steps:

- wallet custody selection: choosing how AETERNA controls the wallet;
- wallet creation: generating or provisioning the wallet;
- wallet address publication: making the address available for quotes and
  operational use;
- quote recipient binding: recording the wallet address in immutable
  Creator Service Payment Quotes.

Until wallet address publication is complete, quote recipient binding MUST
remain PENDING and MUST NOT be hardcoded or invented.

### 6.3 Settlement Wallet Restrictions
The Settlement Wallet MAY receive:
- AETERNA service payments in approved assets on approved networks.

The Settlement Wallet MUST NOT receive:
- Irys publication/storage payments;
- creator funds for any purpose other than the AETERNA service fee;
- payments without an associated immutable quote and Creator Identity.

---

## 7. FINALITY MODEL

The finality model is network-specific.

Requirements:
- Each supported network MUST have an explicit confirmation/finality
  threshold configured server-side.
- The server MUST wait for the required confirmation/finality before
  granting Creator Credit.
- A blockchain reorganization or finality reversal that invalidates payment
  MUST revert verification and MUST NOT grant credit.
- The exact finality thresholds are PENDING per supported network.

Failure behavior:
- network/API timeout during finality check -> no Credit; state retained
  for retry;
- trusted verification source unavailable -> no Credit; state retained for
  retry;
- reorg invalidating payment -> verification reverted; no Credit.

---

## 8. REPLAY MODEL

Replay protection is mandatory and server-side.

Rules:
- Each payment evidence identifier MUST be tracked server-side.
- Previously verified payment evidence MUST be recognized on retry.
- Replay of verified payment evidence MUST NOT grant additional Creator
  Credit.
- Duplicate payment evidence against multiple quotes or multiple identities
  MUST be detected and MUST grant at most one Creator Credit.
- The server MUST return the existing verified result or equivalent
  already-processed response for duplicate/replay attempts.

---

## 9. FAILURE MODEL

All failures MUST be fail-closed.

Mandatory fail-closed behaviors:
- invalid Creator Identity -> no quote, no verification, no Credit;
- invalid quote -> no verification, no Credit;
- expired quote -> no verification, no Credit;
- unsupported network -> no quote, no verification, no Credit;
- unsupported asset -> no quote, no verification, no Credit;
- Settlement Wallet not configured -> no quote, no verification, no Credit;
- provider/RPC unavailable -> no Credit; state retained for retry;
- trusted verification source unavailable -> no Credit; state retained for
  retry;
- fabricated transaction ID -> payment NOT verified -> no Credit;
- nonexistent payment -> payment NOT verified -> no Credit;
- wrong recipient -> payment NOT verified -> no Credit;
- wrong sender/account -> payment NOT verified -> no Credit;
- wrong asset -> payment NOT verified -> no Credit;
- wrong network -> payment NOT verified -> no Credit;
- insufficient amount -> payment NOT verified -> no Credit;
- excessive/ambiguous amount -> payment NOT verified -> no Credit;
- insufficient finality -> payment NOT verified -> no Credit;
- already-consumed payment -> no additional Credit;
- already-granted Credit -> no additional Credit;
- concurrent verification -> serialized; at most one success;
- server retry -> idempotent result.

Recovery behavior:
- payment submitted but not yet confirmed -> quote remains active until
  expiration or confirmation; credit MUST NOT be granted;
- payment confirmed but verification temporarily fails -> server retains
  payment evidence and quote state; verification MAY be retried server-side;
  credit MUST NOT be granted prematurely;
- quote expired -> credit MUST be rejected; frontend MUST obtain new quote;
  any payment to expired quote is outside Creator Credit semantics;
- payment to wrong destination -> treated as invalid for credit purposes;
  creator MUST initiate new payment to correct Settlement Wallet.

---

## 10. PROVIDER-SELECTION DECISION MATRIX

Any candidate provider, network, or asset MUST be evaluated against ALL of
the following criteria before selection.

| Criterion | Requirement | Production-Ready Gate |
|---|---|---|
| Trusted transaction lookup | Server can independently verify payment facts | REQUIRED |
| Sender verification | Server can verify sender matches Creator Identity binding | REQUIRED |
| Recipient verification | Server can verify recipient matches immutable quote | REQUIRED |
| Asset verification | Server can verify asset matches immutable quote | REQUIRED |
| Exact amount verification | Server can verify exact atomic amount matches quote | REQUIRED |
| Network verification | Server can verify network matches immutable quote | REQUIRED |
| Confirmation/finality verification | Server can verify required finality threshold | REQUIRED |
| Replay detection | Server can detect replayed/consumed evidence | REQUIRED |
| Stable evidence identifier | Payment exposes stable identifier for deduplication | REQUIRED |
| Server-side verification | All facts established server-side, not client-side | REQUIRED |
| Availability/latency | Meets AETERNA operational SLOs | REQUIRED |
| Cloudflare Workers compatibility | No Node-only dependencies; browser-compatible adapters | REQUIRED |
| Auditable failure modes | Distinguishable fail-closed error paths | REQUIRED |
| Settlement Wallet ready | Wallet exists, custody is defined, address is published | REQUIRED |
| Irys compatibility | Selected asset/network is supported by production Irys flow | REQUIRED |
| AETERNA allowlist approval | Asset/network is explicitly approved by AETERNA | REQUIRED |
| Legal review | Jurisdiction-specific service entitlement review completed | REQUIRED |

No provider MAY be selected for production if any REQUIRED gate is FAIL.

Provider-neutral architecture:
- AETERNA MUST maintain a provider-neutral abstraction layer;
- new providers/assets MUST be added as adapters without changing Creator
  Credit business rules;
- no provider MAY be hardcoded into canonical payment verification logic.

Legacy sources excluded from provider selection:
- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- historical Base/USDC-only assumptions that predate canonical
  reconciliation in SPEC-WP-18R; current canonical initial production
  selection is documented in
  AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md.

---

## 11. EXPLICITLY UNRESOLVED PENDING DECISIONS

The following decisions remain EXPRESSLY PENDING and MUST NOT be treated
as selected:

PENDING CANONICAL DECISION
- exact payment provider/RPC/adapter for initial production;
- exact Settlement Wallet address;
- exact Settlement Wallet custody and key-management architecture;
- exact price source/oracle for USD 1.00 to asset conversion;
- exact confirmation/finality thresholds per supported network;
- exact payment evidence formats per network/provider;
- exact Cloudflare Pages/Workers route and data-store architecture for
  payment state;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected
  jurisdictions.

No implementation MAY finalize production payment verification until all
PENDING items required by the decision matrix above are resolved and
documented in canonical specifications.

---

## 12. RELATIONSHIP TO OTHER SPECIFICATIONS

This specification is subordinate to:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md

If this document conflicts with the above, the above is authoritative.

This specification does NOT define:
- Irys publication/storage payment flow;
- capsule creation semantics;
- sealing semantics;
- crypto semantics;
- storage semantics;
- frontend UI implementation;
- Protocol page content;
- CapsuleHold behavior.

---

## 13. SECURITY MODEL

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
- Settlement Wallet operational separation;
- wallet/account switching cannot transfer credit between identities;
- one Creator Credit is permitted at most one downstream consumption
  attempt under the SPEC-WP-6 cross-layer interface contract.

---

## 14. DECISION SUMMARY

Exact architectural decisions made:
- AETERNA service payment and Irys publication are separate layers.
- Payment authority chain is: Creator Identity -> immutable quote -> server
  verification -> Creator Credit.
- USD 1.00 is fixed; exact atomic amount is determined server-side.
- Server verifies recipient, asset, network, amount, quote, identity,
  finality, replay, and duplicate credit before granting credit.
- Payment-to-credit transition is atomic and server-side.
- Creator Credit is bound to Creator Identity, not raw address.
- Wallet/account/network/provider switching aborts active lifecycle and
  cannot transfer credit.
- Provider architecture MUST remain provider-neutral.
- Settlement Wallet MUST exist before production payment verification.
- All failures are fail-closed; no uncertain payment may grant credit.

Pending decisions:
- exact Settlement Wallet custody and address;
- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact payment evidence formats per network;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- legal review completion.

---

## 15. REFERENCES

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_COMPLETE_ENGINEERING_MODEL.md
- AETERNA_COMPLETE_SYSTEM_LOGIC.md
- AETERNA_COMPLETE_PROJECT_LOGIC.md
