# AETERNA — SPEC-WP-16 Settlement Wallet Custody Model Selection Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review evaluates whether current canonical documentation is sufficient
to select ONE custody model for the future AETERNA Settlement Wallet.

This review does NOT select a custody model.
This review does NOT create a wallet.
This review does NOT generate an address.
This review does NOT modify production code.
This review does NOT create Cloudflare resources.

---

## 2. CANONICAL SOURCES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md
- docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md
- docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md
- docs/reviews/implementation/AETERNA_SPEC_WP_15_SETTLEMENT_WALLET_CUSTODY_DECISION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_14_SETTLEMENT_WALLET_AND_PAYMENT_DECISION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_13_SERVICE_PAYMENT_PROVIDER_SELECTION_REVIEW.md

---

## 3. CUSTODY MODELS CONTEMPLATED

The following custody models are explicitly contemplated by canonical
documents:

- externally managed wallet;
- multisig;
- institutional custody;
- hardware-backed key control;
- hot/cold separation.

No additional models are introduced.

---

## 4. SELECTION CRITERIA EVALUATION

Each model evaluated against canonical criteria:

| Criterion | Externally Managed | Multisig | Institutional Custody | Hardware-Backed | Hot/Cold Separation |
|---|---|---|---|---|---|
| A. AETERNA ownership/control | shared | full | shared | full | full |
| B. no unilateral third-party authority | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| C. private-key isolation from runtime | PASS | PASS | PASS | PASS | PASS |
| D. operational access control | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| E. withdrawal separation of duties | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| F. compromise containment | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| G. recovery | vendor-dependent | complex | custodian-dependent | complex | complex |
| H. rotation/replacement | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| I. address continuity | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| J. monitoring | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| K. auditability | vendor-dependent | PASS | custodian-dependent | PASS | PASS |
| L. practical operability for $1 recipient | possible | possible | possible | possible | possible |
| M. compatibility with future payment-provider verification | PASS | PASS | PASS | PASS | PASS |
| N. suitability for small non-custodial project | possible | possible | possible | possible | possible |
| O. operational complexity | medium | high | high | high | high |
| P. failure/recovery complexity | vendor-dependent | high | custodian-dependent | high | high |

Result:
- All models satisfy minimum canonical security requirements in principle.
- No model is selected by canonical documentation.
- No model has sufficient canonical evidence for definitive selection.

---

## 5. DECISION MATRIX

For each model:

- externally managed wallet: CONDITIONAL — canonical compatibility depends
  on vendor-specific controls not yet defined.
- multisig: CONDITIONAL — canonically compatible, but operational
  complexity and threshold governance remain unresolved.
- institutional custody: CONDITIONAL — canonical compatibility depends on
  custodian-specific controls not yet defined.
- hardware-backed key control: CONDITIONAL — canonically compatible, but
  hardware provisioning and recovery mechanisms remain unresolved.
- hot/cold separation: CONDITIONAL — recommended as principle, not
  mandatory; operational complexity remains unresolved.

No model receives PASS because selection requires external operational,
legal, and security decisions not present in canonical documentation.

No model receives FAIL because all models are canonically compatible in
principle.

All models receive CONDITIONAL because selection requires unresolved
decisions.

---

## 6. RECOMMENDED MODEL

The canonical evidence is NOT sufficient to select ONE custody model.

PENDING CANONICAL DECISION
- exact Settlement Wallet custody model.

Exact external decisions still required:
- operational/legal approval of a specific custody architecture;
- key-management architecture decision;
- separation-of-duties governance model;
- monitoring/alerting configuration;
- rotation/replacement procedure;
- legal review completion.

These decisions cannot be made from canonical documentation alone.

---

## 7. IMPORTANT SEPARATIONS

The following decisions MUST remain separate and independent:

A. custody model — PENDING
B. network — RECOMMENDED, NOT production-selected
C. payment asset — RECOMMENDED, NOT production-selected
D. payment provider/RPC — PENDING
E. price oracle — PENDING
F. finality threshold — PENDING
G. reconciliation/refund policy — PENDING
H. legal review — PENDING

Custody selection alone does NOT select a payment provider.

---

## 8. FUTURE WALLET CREATION PREREQUISITES

If a model is selected later, the following prerequisites must be defined
before wallet creation:

- who/what controls keys;
- required operational roles;
- recovery requirements;
- monitoring configuration;
- withdrawal approval workflow;
- rotation/replacement procedure;
- address declaration mechanism;
- canonical quote recipient binding process.

No wallet MAY be created until all prerequisites are resolved.

---

## 9. PRODUCTION RUNTIME SEPARATION

Preserved invariant:
Application Runtime ≠ Settlement Wallet private-key custody

No private signing key may be placed in:
- Pages;
- Pages Functions;
- Workers;
- Durable Objects;
- KV;
- `.env`;
- source code.

The application verifies incoming payments; it does not use the Settlement
Wallet key.

This separation is mandatory regardless of custody model.

---

## 10. VERDICT

SPEC-WP-16 = NOT READY

Reason:
- exact Settlement Wallet custody model is PENDING;
- exact key-management architecture is PENDING;
- exact operational roles and separation of duties are PENDING;
- exact monitoring/alerting configuration is PENDING;
- exact rotation/replacement procedure is PENDING;
- exact wallet address does not exist;
- exact payment network/asset remain RECOMMENDED, NOT production-selected;
- price conversion source/oracle is PENDING;
- verification provider/RPC is PENDING;
- finality thresholds are PENDING;
- evidence formats are PENDING;
- reconciliation/refund policy is PENDING;
- legal review is PENDING.

Custody model selection MAY proceed only after the external operational,
legal, and security decisions listed above are resolved and documented in
canonical specifications.

---

## 11. FILES CREATED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md

---

## 12. FILES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md
- docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md
- docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md
- docs/reviews/implementation/AETERNA_SPEC_WP_15_SETTLEMENT_WALLET_CUSTODY_DECISION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_14_SETTLEMENT_WALLET_AND_PAYMENT_DECISION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_13_SERVICE_PAYMENT_PROVIDER_SELECTION_REVIEW.md

---

FINAL CONFIRMATION:

"No wallet was created. No wallet address was generated, invented, or
reused. No production code, Cloudflare resources, payment integrations,
crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or legacy
files were modified."
