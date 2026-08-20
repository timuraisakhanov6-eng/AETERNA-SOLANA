# AETERNA — SPEC-WP-15 Settlement Wallet Custody Decision Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review evaluates whether current canonical documentation resolves the
Settlement Wallet custody and key-management decision required before
AETERNA service payment provider selection can proceed.

This review does NOT select a custody model.
This review does NOT create a wallet.
This review does NOT invent an address.
This review does NOT modify production code.
This review does NOT create Cloudflare resources.

---

## 2. CANONICAL SOURCES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
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

No additional models are introduced in this review.

---

## 4. SECURITY REQUIREMENTS EVALUATION

Each model is evaluated against canonical requirements:

| Requirement | Externally Managed | Multisig | Institutional Custody | Hardware-Backed | Hot/Cold Separation |
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

## 5. APPLICATION RUNTIME SEPARATION

Preserved invariant:
- Cloudflare application/runtime ≠ Settlement Wallet private-key custody.

The production application must not require the Settlement Wallet
private key in:
- Pages;
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

Conceptual separation required by canonical documents:
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

## 9. RECOMMENDED MODEL

After evaluating canonical documents:

- The canonical documents explicitly contemplate multiple custody models.
- The canonical documents define mandatory security requirements.
- The canonical documents do NOT select a specific custody model.
- The Settlement Wallet does NOT yet exist.
- Exact operational roles and rotation procedures are PENDING.

Therefore, no definitive custody model can be selected at this time.

PENDING CANONICAL DECISION
- exact Settlement Wallet custody model.

---

## 10. DECISIONS THAT MUST REMAIN SEPARATE

The following decisions are independent and MUST NOT be conflated:

A. custody model — PENDING
B. network — RECOMMENDED, NOT production-selected
C. payment asset — RECOMMENDED, NOT production-selected
D. payment provider/RPC — PENDING
E. price oracle — PENDING
F. finality threshold — PENDING
G. reconciliation/refund policy — PENDING
H. legal review — PENDING

Custody selection alone does not select a payment provider.

---

## 11. PREREQUISITES BEFORE WALLET CREATION

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

## 12. PREREQUISITES BEFORE PAYMENT-PROVIDER SELECTION

Before payment-provider selection can proceed, the following MUST be
resolved:

| Item | Status |
|---|---|
| A. Settlement Wallet custody model | PENDING |
| B. Settlement Wallet address | PENDING |
| C. Network | RECOMMENDED, NOT production-selected |
| D. Asset | RECOMMENDED, NOT production-selected |
| E. Price conversion source | PENDING |
| F. Verification provider/RPC | PENDING |
| G. Finality thresholds | PENDING |
| H. Evidence format | PENDING |
| I. Replay policy | RESOLVED |
| J. Reconciliation/refund policy | PENDING |

Because custody model, address, price conversion source, verification
provider, finality thresholds, evidence format, and reconciliation policy
remain PENDING, and network/asset remain recommendations:

Payment-provider selection remains blocked.

---

## 13. LEGACY ISOLATION

Explicitly, the following are NOT valid sources for custody decisions or
payment architecture:

- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- old payment receiver addresses;
- old Cloudflare resources.

Confirmed:
- Active runtime dependencies on legacy payment paths have been removed.
- /api/service-payment/verify is implemented as provider-neutral fail-closed
  adapter.
- No legacy payment provider is wired into active canonical creator path.

---

## 14. VERDICT

SPEC-WP-15 = NOT READY

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

All requirements and decision criteria are now explicitly documented in
AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md.

Custody selection MAY proceed only after all PENDING decisions are resolved
and documented in canonical specifications.

---

## 15. FILES CREATED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md

---

## 16. FILES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
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
- docs/reviews/implementation/AETERNA_SPEC_WP_14_SETTLEMENT_WALLET_AND_PAYMENT_DECISION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_13_SERVICE_PAYMENT_PROVIDER_SELECTION_REVIEW.md

---

FINAL CONFIRMATION:

"No wallet was created. No wallet address was generated, invented, or
reused. No production code, Cloudflare resources, payment integrations,
crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or legacy
files were modified."
