# AETERNA — Settlement Wallet Custody and Payment Decision Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md

---

## 1. SETTLEMENT WALLET ROLE

The AETERNA Settlement Wallet is the AETERNA-owned payment destination that
receives the $1 USD-equivalent AETERNA service payment.

Responsibilities:
- receive AETERNA service payments in approved assets on approved networks;
- serve as the canonical recipient recorded in every immutable AETERNA
  Service Payment Quote;
- be operated by AETERNA, not by creators.

Restrictions:
- MUST NOT receive Irys publication/storage payments;
- MUST NOT receive creator funds for any purpose other than the AETERNA
  service fee;
- MUST NOT receive payments without an associated immutable quote and
  Creator Identity.

Relationship to Creator Identity:
- The Settlement Wallet is the payment destination, not the identity.
- A verified payment to the Settlement Wallet is evidence for granting
  Creator Credit to a Creator Identity.
- The Settlement Wallet has no entitlement semantics; it is a recipient
  only.

Relationship to Creator Credit:
- Creator Credit is granted to a Creator Identity.
- Creator Credit is never granted to a raw wallet address or settlement
  destination.

Relationship to Irys:
- AETERNA service payment and Irys publication/storage are architecturally
  and economically independent layers.
- The Settlement Wallet MUST NOT be used for Irys payment receipt.
- A separate Irys funding model, if any, is outside this document.

---

## 2. CUSTODY REQUIREMENTS

The Settlement Wallet custody model MUST satisfy the following requirements.

### 2.1 Ownership and Control
- AETERNA must retain full operational control of the Settlement Wallet.
- No creator, contractor, or third party may have unilateral signing
  authority over the Settlement Wallet.

### 2.2 Separation from Application Runtime
- Private key custody MUST be separated from application logic.
- The AETERNA server/runtime MUST NOT hold wallet signing authority for
  creator service payments.
- Creator-side wallet signing is sufficient; the server verifies, it does
  not sign on behalf of creators.

### 2.3 Access Control
- Access to signing authority MUST be restricted to authorized operational
  infrastructure.
- Access control MUST limit who or what can initiate withdrawals or
  configuration changes.

### 2.4 Secrets Management
- Private keys and credentials MUST be protected by operational secrets
  management.
- Secrets MUST NOT be stored in application code, environment variables
  exposed to untrusted runtime, or frontend-accessible configuration.

### 2.5 Monitoring and Alerting
- Operational monitoring MUST detect anomalous receipt patterns.
- Monitoring MUST detect unauthorized withdrawal attempts.
- Monitoring MUST detect misconfiguration.

### 2.6 Compromise Containment
- The architecture MUST limit exposure if settlement credentials are
  compromised.
- Compromise containment MUST include ability to rotate or replace the
  Settlement Wallet without breaking existing immutable quotes.
- Exact rotation/replacement procedure is PENDING.

### 2.7 Withdrawal Authority
- Withdrawal authority MUST follow operational separation of duties.
- Withdrawal from the Settlement Wallet MUST be an explicit operational
  action, not automatic.

### 2.8 Auditability
- Settlement operations MUST be auditable.
- The architecture MUST support reconstructing receipt and withdrawal
  history.

### 2.9 Hot/Cold Separation
- Hot/cold separation is recommended if operational requirements support it.
- Hot/cold separation is NOT mandatory unless required by another
  canonical document.

---

## 3. KEY MANAGEMENT REQUIREMENTS

### 3.1 Private Key Management
- Private keys MUST be generated using cryptographically secure methods.
- Private keys MUST be stored in a secrets manager or equivalent
  operational control system.
- Private keys MUST NOT be exposed to application runtime beyond the
  minimum required signing surface.

### 3.2 Signing Authority
- Signing authority for settlement operations MUST be restricted to
  authorized operational infrastructure.
- The AETERNA server does NOT need wallet signing authority for creator
  service payments.
- Creator-side wallet signing is sufficient.

### 3.3 Key Rotation
- The architecture MUST support key rotation without breaking existing
  immutable quotes.
- Key rotation MUST NOT retroactively alter already-issued quotes.
- Already-issued quotes bound to the old address MUST be handled according
  to operational reconciliation rules outside Creator Credit semantics.

### 3.4 Address Continuity
- The Settlement Wallet address MUST remain stable during normal operations.
- Address changes MUST be treated as exceptional operational events.
- Address continuity is REQUIRED for quote recipient binding integrity.

---

## 4. WALLET / ADDRESS LIFECYCLE

The canonical lifecycle phases for the Settlement Wallet are:

1. custody architecture selected
2. wallet created
3. wallet address verified
4. settlement wallet declared canonical
5. future quotes bind to that recipient
6. operational monitoring and control maintained
7. rotation/replacement if required

Rule:
- Until phase 4 is complete, NO immutable quote MAY contain a real
  Settlement Wallet address.
- Until phase 4 is complete, NO production payment verification MAY be
  finalized.

---

## 5. RECIPIENT BINDING

The immutable quote MUST contain the exact Settlement Wallet recipient.

Requirements:
- recipient field in the quote MUST be the canonical Settlement Wallet
  address for the selected network/asset.
- recipient MUST NOT be a placeholder, example address, or invented value.
- recipient MUST NOT change after quote creation.
- If the Settlement Wallet address changes, existing quotes remain bound to
  the old address; new quotes are required for the new address.

Conceptual ordering:
- wallet custody architecture selected
  -> wallet created
  -> wallet address verified
  -> settlement wallet declared canonical
  -> future quotes bind to that recipient

No step MAY be skipped.

---

## 6. PAYMENT NETWORK / ASSET DEPENDENCY

### 6.1 Current Canonical Status

A. Architecture recommendation:
- Provider-neutral multi-provider architecture is the canonical
  architectural recommendation.
- Initial concrete adapter: EVM injected wallet/provider path, encapsulated
  inside the provider-neutral architecture.

B. Production selection:
- The above recommendation has NOT been promoted to canonical production
  authority.
- Exact network and asset for initial production remain PENDING.

C. Still pending:
- exact AETERNA payment network for initial production;
- exact AETERNA payment asset allowlist for initial production;
- exact payment provider/RPC/adapter for initial production.

### 6.2 Dependency
The Settlement Wallet address is network-specific and asset-specific.
- One Settlement Wallet address per supported network/asset combination
  MAY be required, depending on custody model.
- The exact address structure is PENDING.

Until network/asset are selected:
- Settlement Wallet address cannot be finalized.
- Quote recipient binding cannot be finalized.
- Production payment verification cannot be finalized.

---

## 7. PRICE CONVERSION DEPENDENCY

### 7.1 Fixed Commercial Denomination
- The AETERNA service fee is fixed at USD 1.00.
- This is a commercial denomination, not a network-native amount.

### 7.2 Actual Network Asset Amount
- The exact atomic amount in the selected payment asset MUST be derived
  server-side from the canonical USD 1.00.
- The conversion result MUST be recorded in the immutable quote.
- The frontend MAY display the converted amount; it does NOT determine the
  authoritative amount.

### 7.3 Oracle / Conversion Requirement
- The exact price source/oracle for USD 1.00 conversion is PENDING.
- The oracle MUST be:
  - trusted;
  - server-side;
  - time-bounded;
  - deterministic for a quote;
  - resistant to client manipulation.
- The oracle MUST NOT be selected or invented in this document.

### 7.4 Quote Immutability
- The exactAtomicAmount in an issued quote is a snapshot established at
  quote creation time.
- A later exchange-rate change MUST NOT retroactively mutate an already-
  issued quote.

### 7.5 Rounding
- Exact amount matching is REQUIRED against the immutable quote.
- Underpayment MUST NOT grant Creator Credit.
- Overpayment handling is a reconciliation decision outside Creator Credit
  semantics.
- Acceptable rounding rules are PENDING.

---

## 8. FINALITY DEPENDENCY

### 8.1 Requirement
- Each supported network MUST have an explicit confirmation/finality
  threshold configured server-side.
- The server MUST wait for the required confirmation/finality before
  granting Creator Credit.
- A blockchain reorganization or finality reversal that invalidates payment
  MUST revert verification and MUST NOT grant credit.

### 8.2 Current Status
- Exact confirmation/finality thresholds per supported network are PENDING.
- No threshold MAY be invented or assumed in canonical documents.

### 8.3 Failure Behavior
- network/API timeout -> no Credit; state retained for retry;
- trusted verification source unavailable -> no Credit; state retained for
  retry;
- reorg invalidating payment -> verification reverted; no Credit.

---

## 9. VERIFICATION-PROVIDER DEPENDENCY

### 9.1 Requirement
- The server MUST independently establish payment facts from a trusted
  network source.
- The exact verification provider/RPC/adapter is PENDING.

### 9.2 Current Implementation
- `/api/service-payment/verify` is implemented as a provider-neutral
  fail-closed adapter.
- It returns PAYMENT_VERIFICATION_FAILED when provider/finality are
  pending.
- This implementation is consistent with canonical requirements and does
  NOT select a production provider.

### 9.3 Dependency Chain
- verification provider -> payment facts -> quote matching -> credit grant
- Until the verification provider is selected and configured, production
  payment verification cannot be finalized.

---

## 10. UNRESOLVED PENDING DECISIONS

The following decisions remain EXPRESSLY PENDING and MUST NOT be treated
as selected:

PENDING CANONICAL DECISION
- exact Settlement Wallet custody model;
- exact Settlement Wallet address;
- exact Settlement Wallet key-management architecture;
- exact AETERNA payment network for initial production;
- exact AETERNA payment asset allowlist for initial production;
- exact payment provider/RPC/adapter for initial production;
- exact price source/oracle for USD 1.00 conversion;
- exact confirmation/finality thresholds per supported network;
- exact payment evidence formats per network/provider;
- exact Cloudflare Pages/Workers route and data-store architecture;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected
  jurisdictions;
- exact wallet rotation/replacement procedure.

No implementation MAY finalize production payment verification until all
PENDING items required by the provider-selection decision matrix are
resolved and documented in canonical specifications.

---

## 11. PREREQUISITES FOR SPEC-WP-15 PROVIDER SELECTION

SPEC-WP-15 MAY proceed only after ALL of the following are resolved and
documented in canonical specifications:

A. Settlement Wallet custody model — RESOLVED / PENDING
B. Settlement Wallet address — RESOLVED / PENDING
C. Network — RESOLVED / PENDING
D. Asset — RESOLVED / PENDING
E. Price conversion source — RESOLVED / PENDING
F. Verification provider/RPC — RESOLVED / PENDING
G. Finality thresholds — RESOLVED / PENDING
H. Evidence format — RESOLVED / PENDING
I. Replay policy — RESOLVED in canonical docs
J. Reconciliation/refund policy — RESOLVED / PENDING

Current state for SPEC-WP-15 readiness:
- A. Settlement Wallet custody model — PENDING
- B. Settlement Wallet address — PENDING
- C. Network — RECOMMENDED, NOT production-selected
- D. Asset — RECOMMENDED, NOT production-selected
- E. Price conversion source — PENDING
- F. Verification provider/RPC — PENDING
- G. Finality thresholds — PENDING
- H. Evidence format — PENDING
- I. Replay policy — RESOLVED
- J. Reconciliation/refund policy — PENDING

Because items A, B, E, F, G, H, and J remain PENDING, and items C and D
remain recommendations rather than production selections:

SPEC-WP-14 = NOT READY FOR PROVIDER SELECTION

---

## 12. LEGACY ISOLATION

The following are NOT valid sources for provider selection, custody
decisions, or payment architecture:

- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- old payment receiver addresses;
- old Cloudflare resources.

Any future selection MUST be based solely on current canonical documents
and explicitly documented decisions.

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
  attempt under the SPEC-WP-6 cross-layer interface contract;
- Settlement Wallet compromise MUST NOT compromise Creator Credit
  authority or capsule contents.

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
- Settlement Wallet custody MUST be separated from application logic.
- All failures are fail-closed; no uncertain payment may grant credit.

Pending decisions:
- exact Settlement Wallet custody model;
- exact Settlement Wallet address;
- exact payment network/asset/provider for initial production;
- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact payment evidence formats per network;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- exact wallet rotation/replacement procedure;
- legal review completion.

---

## 15. REFERENCES

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_COMPLETE_ENGINEERING_MODEL.md
- AETERNA_COMPLETE_SYSTEM_LOGIC.md
- AETERNA_COMPLETE_PROJECT_LOGIC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
