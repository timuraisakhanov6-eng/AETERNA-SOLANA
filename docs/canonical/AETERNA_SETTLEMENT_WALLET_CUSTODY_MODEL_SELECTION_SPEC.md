# AETERNA — Settlement Wallet Custody Model Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md

---

## 1. DECISION SCOPE

This document evaluates the canonical custody models for the future AETERNA
Settlement Wallet and records whether the canonical evidence is sufficient
to select one model.

This document does NOT create a wallet.
This document does NOT generate an address.
This document does NOT select a payment network, asset, provider, or
verification adapter.

---

## 2. SECURITY REQUIREMENTS

Any selected custody model MUST satisfy:

- AETERNA ownership/control;
- no unilateral creator control;
- no unilateral contractor/third-party signing;
- private-key isolation from application runtime;
- restricted operational access;
- withdrawal separation of duties;
- compromise containment;
- rotation/replacement without breaking immutable quotes;
- monitoring;
- auditability;
- address continuity;
- compatibility with future payment-provider verification;
- compatibility with Cloudflare runtime;
- suitability for a $1 service-payment recipient.

These requirements are mandatory and non-negotiable.

---

## 3. EVALUATED MODELS

Models explicitly contemplated by canonical documentation:

- externally managed wallet;
- multisig;
- institutional custody;
- hardware-backed key control;
- hot/cold separation.

No additional models are introduced.

---

## 4. COMPARISON MATRIX

| Criterion | Externally Managed | Multisig | Institutional Custody | Hardware-Backed | Hot/Cold Separation |
|---|---|---|---|---|---|
| AETERNA ownership/control | shared | full | shared | full | full |
| No unilateral third-party authority | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Private-key isolation from runtime | PASS | PASS | PASS | PASS | PASS |
| Operational access control | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Withdrawal separation of duties | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Compromise containment | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Recovery | vendor-dependent | complex | custodian-dependent | complex | complex |
| Rotation/replacement | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Address continuity | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Monitoring | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Auditability | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| Practical operability for $1 recipient | possible | possible | possible | possible | possible |
| Compatibility with future payment-provider verification | PASS | PASS | PASS | PASS | PASS |
| Suitability for small non-custodial project | possible | possible | possible | possible | possible |
| Operational complexity | medium | high | high | high | high |
| Failure/recovery complexity | vendor-dependent | high | custodian-dependent | high | high |

Selected model:
- 2-of-3 multisig with hardware-backed keys.

This model satisfies all mandatory canonical security requirements and
is selected as the canonical Settlement Wallet custody model.

---

## 5. SELECTED MODEL OR EXPLICIT UNRESOLVED DECISION

After evaluating the canonical documents:

- The canonical documents explicitly contemplate multiple custody models.
- The canonical documents define mandatory security requirements.
- The canonical documents now explicitly select the custody model:
  2-of-3 multisig with hardware-backed keys.
- The Settlement Wallet does NOT yet exist.
- Exact operational roles, separation of duties, rotation procedures, and
  legal review remain PENDING.

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

## 6. OPERATIONAL REQUIREMENTS

Regardless of custody model, the following operational requirements are
mandatory:

- receiving payments: automated, no special authority required;
- monitoring: operational team or automated alerting;
- operational access: restricted to authorized infrastructure;
- withdrawal initiation: restricted role;
- withdrawal approval: separate restricted role;
- emergency response: separate restricted role.

Exact operational roles, separation of duties, and governance are PENDING.

---

## 7. RECOVERY REQUIREMENTS

Regardless of custody model, the following recovery requirements are
mandatory:

- application runtime compromise MUST NOT expose wallet signing authority;
- operator credential compromise MUST be detectable and recoverable;
- wallet signing authority compromise MUST support rotation/replacement;
- existing immutable quotes remain valid for their original recipient after
  rotation;
- new quotes bind to the new canonical address after rotation.

Exact rotation/replacement procedure and recovery mechanisms are PENDING.

---

## 8. ADDRESS LIFECYCLE REQUIREMENTS

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

## 9. PREREQUISITES BEFORE WALLET CREATION

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

## 10. PREREQUISITES BEFORE PROVIDER SELECTION

Before payment-provider selection can proceed, the following MUST be
resolved:

| Item | Status |
|---|---|
| A. Settlement Wallet custody model | SELECTED: 2-of-3 multisig with hardware-backed keys |
| B. Settlement Wallet address | PENDING |
| C. Network | RECOMMENDED, NOT production-selected |
| D. Asset | RECOMMENDED, NOT production-selected |
| E. Price conversion source | PENDING |
| F. Verification provider/RPC | PENDING |
| G. Finality thresholds | PENDING |
| H. Evidence format | PENDING |
| I. Replay policy | RESOLVED |
| J. Reconciliation/refund policy | PENDING |

Because custody model is now selected, but address, price conversion source,
verification provider, finality thresholds, evidence format, and
reconciliation policy remain PENDING, and network/asset remain
recommendations:

Payment-provider selection remains blocked.

---

## 11. LEGACY ISOLATION

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

## 12. SECURITY MODEL

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

## 13. DECISION SUMMARY

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
- exact Settlement Wallet custody model;
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

## 14. REFERENCES

- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
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
