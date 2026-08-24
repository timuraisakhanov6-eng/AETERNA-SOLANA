# AETERNA — Settlement Wallet Custody Decision Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md

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

## 3. EVALUATED CUSTODY MODELS

The following custody models are explicitly contemplated by canonical
documents. No model is selected in this document.

### 3.1 Externally Managed Wallet
Description:
- AETERNA delegates wallet custody to an external provider.

Canonical compatibility:
- Compatible if separation from application runtime is preserved.

Security:
- Depends on vendor security model.

Operational complexity:
- Medium.

Recovery:
- Vendor-dependent.

Signing workflow:
- External provider controls signing.

Cloudflare compatibility:
- Compatible; application runtime never holds signing authority.

Suitability for $1 recipient:
- Possible, provided vendor supports required operational controls.

### 3.2 Multisig
Description:
- Multiple independent signatures are required to control the wallet.

Canonical compatibility:
- Compatible.

Security:
- Strong; no single point of signing compromise.

Operational complexity:
- High; requires multiple authorized signers.

Recovery:
- Complex; requires threshold of signers.

Signing workflow:
- Multiple signatures required for withdrawal.

Cloudflare compatibility:
- Compatible; application runtime never holds signing authority.

Suitability for $1 recipient:
- Possible, though potentially over-specified for a $1 recipient.

### 3.3 Institutional Custody
Description:
- A qualified custodian holds and manages the wallet.

Canonical compatibility:
- Compatible if separation from application runtime is preserved.

Security:
- Strong; depends on custodian security.

Operational complexity:
- High; requires custodian onboarding and governance.

Recovery:
- Custodian-dependent.

Signing workflow:
- Custodian controls signing.

Cloudflare compatibility:
- Compatible; application runtime never holds signing authority.

Suitability for $1 recipient:
- Possible, provided custodian supports required operational controls.

### 3.4 Hardware-Backed Key Control
Description:
- Private keys are stored in hardware security modules or equivalent.

Canonical compatibility:
- Compatible.

Security:
- Strong; keys protected by hardware.

Operational complexity:
- High; requires hardware provisioning and management.

Recovery:
- Complex; depends on hardware key recovery mechanisms.

Signing workflow:
- Hardware-backed signing only.

Cloudflare compatibility:
- Compatible; application runtime never holds signing authority.

Suitability for $1 recipient:
- Possible, though operational overhead may be high.

### 3.5 Hot/Cold Separation
Description:
- A portion of funds is kept in offline cold storage; a hot wallet
  handles operational receipts.

Canonical compatibility:
- Recommended as a principle, not mandatory.

Security:
- Strong; limits exposure of offline keys.

Operational complexity:
- High; requires transfer between hot and cold.

Recovery:
- Complex; depends on cold storage recovery.

Signing workflow:
- Cold keys sign withdrawals; hot keys sign operational receipt.

Cloudflare compatibility:
- Compatible; application runtime never holds signing authority.

Suitability for $1 recipient:
- Possible, though operational overhead may be high for a $1 service
  payment.

---

## 4. SECURITY COMPARISON

| Criterion | Externally Managed | Multisig | Institutional Custody | Hardware-Backed | Hot/Cold Separation |
|---|---|---|---|---|---|
| AETERNA ownership | shared | full | shared | full | full |
| No unilateral creator control | PASS | PASS | PASS | PASS | PASS |
| No unilateral contractor/third-party signing | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Private-key isolation from runtime | PASS | PASS | PASS | PASS | PASS |
| Restricted operational access | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Withdrawal separation of duties | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Compromise containment | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Rotation/replacement | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Monitoring | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Auditability | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Recovery | vendor-dependent | complex | custodian-dependent | complex | complex |
| Address continuity | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Cloudflare compatibility | PASS | PASS | PASS | PASS | PASS |
| Suitability for $1 recipient | possible | possible | possible | possible | possible |

All models are canonically compatible in principle. None is selected.

---

## 5. RUNTIME / KEY SEPARATION

Cloudflare application/runtime
≠
Settlement Wallet private-key custody.

The production application must not require the Settlement Wallet
private key in:
- Cloudflare Pages;
- Pages Functions;
- Workers;
- Durable Objects;
- environment variables;
- KV;
- source code.

The server only verifies incoming payments.

This separation is mandatory regardless of custody model.

---

## 6. WITHDRAWAL AUTHORITY

Canonical requirements:
- Withdrawal authority MUST follow operational separation of duties.
- Withdrawal MUST be an explicit operational action, not automatic.

Operational roles (conceptual, not finalized):
- receiving payments: automated, no special authority required;
- monitoring: operational team or automated alerting;
- operational access: restricted to authorized infrastructure;
- withdrawal initiation: restricted role;
- withdrawal approval: separate restricted role;
- emergency response: separate restricted role.

Exact operational roles and separation of duties are PENDING.

---

## 7. INCIDENT / COMPROMISE MODEL

### 7.1 Application Runtime Compromise
- Settlement Wallet private key is NOT in application runtime.
- Runtime compromise MUST NOT expose wallet signing authority.
- Payment verification remains fail-closed; no credit is granted without
  verified payment.

### 7.2 Operator Credential Compromise
- Operational access MUST be restricted and monitored.
- Compromise of operator credentials MUST be detectable.
- Response MUST include credential revocation and access rotation.

### 7.3 Wallet Signing Authority Compromise
- Architecture MUST support wallet rotation/replacement.
- Existing immutable quotes remain bound to the old address;
  new quotes bind to the new address.
- Exact rotation/replacement procedure is PENDING.

### 7.4 Quote Integrity After Rotation
- Immutable quotes issued before rotation remain valid for their original
  recipient.
- Payments to the old address after rotation MUST be handled according to
  operational reconciliation rules outside Creator Credit semantics.
- New quotes MUST bind to the new canonical Settlement Wallet address.

---

## 8. ADDRESS LIFECYCLE

Canonical lifecycle:
1. custody model selected
2. wallet created
3. wallet address verified
4. settlement wallet declared canonical
5. future immutable quotes bind that recipient
6. operational monitoring and control maintained
7. rotation/replacement if required

Rules:
- Until step 4 is complete, NO immutable quote MAY contain a real
  Settlement Wallet address.
- Until step 4 is complete, NO production payment verification MAY be
  finalized.
- Address changes after step 4 MUST NOT retroactively alter already-issued
  quotes.
- New quotes after rotation MUST bind to the new canonical address.

---

## 9. SELECTED MODEL OR PENDING STATUS

After evaluating the canonical documents:

- The canonical documents explicitly contemplate multiple custody models.
- The canonical documents define mandatory security requirements.
- The canonical documents do NOT select a specific custody model.
- The Settlement Wallet does NOT yet exist.
- Exact operational roles and rotation procedures are PENDING.

Therefore:

SETTLED CANONICAL DECISION
- exact Settlement Wallet custody model: 2-of-3 multisig with
  hardware-backed keys.

SPEC-WP-17 = COMPLETE

Reason:
- explicit canonical decision has been recorded for the custody model;
- the selected model satisfies all mandatory canonical security
  requirements;
- no further custody-model selection is required.

---

## 10. PREREQUISITES BEFORE WALLET CREATION

Before the Settlement Wallet is created, the following MUST be resolved:

- custody model is selected and documented in canonical specifications;
- key-management architecture is selected and documented;
- operational roles and separation of duties are defined;
- monitoring and alerting configuration is defined;
- rotation/replacement procedure is defined;
- legal review is completed;
- wallet address publication mechanism is defined.

No wallet MAY be created until all prerequisites are resolved.

---

## 11. PREREQUISITES BEFORE PAYMENT-PROVIDER SELECTION

Before payment-provider selection can proceed, the following MUST be
resolved:

- Settlement Wallet custody model — SELECTED: 2-of-3 multisig with hardware-backed keys
- Settlement Wallet address — RESOLVED / PENDING
- Network — RESOLVED / PENDING
- Asset — RESOLVED / PENDING
- Price conversion source — RESOLVED / PENDING
- Verification provider/RPC — RESOLVED / PENDING
- Finality thresholds — RESOLVED / PENDING
- Evidence format — RESOLVED / PENDING
- Replay policy — RESOLVED
- Reconciliation/refund policy — RESOLVED / PENDING

Current state:
- custody model: PENDING
- address: PENDING
- network: RECOMMENDED, NOT production-selected
- asset: RECOMMENDED, NOT production-selected
- price conversion source: PENDING
- verification provider/RPC: PENDING
- finality thresholds: PENDING
- evidence format: PENDING
- replay policy: RESOLVED
- reconciliation/refund policy: PENDING

Because custody model, address, price conversion source, verification
provider, finality thresholds, evidence format, and reconciliation policy
remain PENDING, and network/asset remain recommendations:

Payment-provider selection remains blocked.

---

## 12. UNRESOLVED OPERATIONAL / LEGAL DECISIONS

PENDING CANONICAL DECISION
- exact Settlement Wallet key-management architecture;
- exact operational roles and separation of duties;
- exact monitoring and alerting configuration;
- exact rotation/replacement procedure;
- exact wallet address publication mechanism;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected
  jurisdictions.

No implementation MAY create the Settlement Wallet or select a payment
provider until all PENDING items required by the custody decision matrix
are resolved and documented in canonical specifications.

---

## 13. LEGACY ISOLATION

The following are NOT valid sources for custody decisions or payment
architecture:

- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- old payment receiver addresses;
- old Cloudflare resources.

Any future selection MUST be based solely on current canonical documents
and explicitly documented decisions.

---

## 14. SECURITY MODEL

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
  attempt;
- Settlement Wallet private key MUST be isolated from application runtime;
- Settlement Wallet compromise MUST NOT compromise Creator Credit
  authority or capsule contents;
- hot/cold separation is recommended but not mandatory.

---

## 15. DECISION SUMMARY

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
- Application runtime MUST NOT hold Settlement Wallet private key.

Pending decisions:
- exact key-management architecture;
- exact operational roles and separation of duties;
- exact monitoring/alerting configuration;
- exact rotation/replacement procedure;
- exact wallet address;
- exact payment network/asset/provider;
- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact payment evidence formats per network;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- legal review completion.

---

## 16. REFERENCES

- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_COMPLETE_ENGINEERING_MODEL.md
- AETERNA_COMPLETE_SYSTEM_LOGIC.md
- AETERNA_COMPLETE_PROJECT_LOGIC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
