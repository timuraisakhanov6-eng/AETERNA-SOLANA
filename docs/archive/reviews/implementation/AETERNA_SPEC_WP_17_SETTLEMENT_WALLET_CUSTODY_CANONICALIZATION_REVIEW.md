# AETERNA — SPEC-WP-17 Settlement Wallet Custody Canonicalization Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review confirms that the previously PENDING Settlement Wallet custody
decision has been explicitly resolved and canonicalized.

This review does NOT create a wallet.
This review does NOT generate an address.
This review does NOT modify production code.
This review does NOT create Cloudflare resources.

---

## 2. CANONICAL SOURCES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- docs/reviews/implementation/AETERNA_SPEC_WP_16_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_15_SETTLEMENT_WALLET_CUSTODY_DECISION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_14_SETTLEMENT_WALLET_AND_PAYMENT_DECISION_REVIEW.md
- docs/reviews/implementation/AETERNA_SPEC_WP_13_SERVICE_PAYMENT_PROVIDER_SELECTION_REVIEW.md

---

## 3. PREVIOUS PENDING DECISION STATUS

Previous status from SPEC-WP-13..SPEC-WP-16:
- exact Settlement Wallet custody model: PENDING

Current status:
- exact Settlement Wallet custody model: SELECTED

Resolution:
- The pending custody decision has been explicitly canonicalized.

---

## 4. SELECTED MODEL

Selected model:
- 2-of-3 multisig
- hardware-backed keys
- application runtime has NO private-key access
- application runtime has NO signing authority

This selection is now recorded in:
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md

---

## 5. INTERNAL CONSISTENCY CHECK

Selected model against canonical requirements:

- AETERNA ownership/control: PASS — AETERNA retains operational control;
  no unilateral creator or third-party signing.
- No unilateral third-party authority: PASS — 2-of-3 threshold prevents
  unilateral withdrawal.
- Private-key isolation from runtime: PASS — application runtime has NO
  private-key access or signing authority.
- Operational access control: PASS — signing restricted to authorized
  operational infrastructure.
- Withdrawal separation of duties: PASS — multisig enforces multiple
  authorized signatures.
- Compromise containment: PASS — one compromised key is insufficient;
  rotation/replacement supported.
- Recovery: PASS — multisig threshold supports recovery without single-key
  dependency.
- Rotation/replacement: PASS — architecture supports rotation without
  breaking immutable quotes.
- Address continuity: PASS — new quotes bind to new address after rotation;
  old quotes remain valid.
- Monitoring: PASS — operational monitoring required.
- Auditability: PASS — settlement operations must be auditable.
- Practical operability for $1 recipient: PASS — model is operationally
  feasible for a $1 service-payment recipient.
- Compatibility with future payment-provider verification: PASS — model
  does not constrain provider selection.
- Suitability for small non-custodial project: PASS — model preserves
  non-custodial architecture.
- Operational complexity: medium/high — accepted tradeoff for security.
- Failure/recovery complexity: medium/high — accepted tradeoff for security.

Result: internally consistent.

---

## 6. CONSISTENCY WITH WP-5..WP-16

Checked against prior phases:

- SPEC-WP-5..SPEC-WP-10: no contradictions; selected custody model does
  not modify Creator Identity, Creator Credit, reserve-lifecycle, or
  upload-token semantics.
- SPEC-WP-13: provider selection remains separate; custody selection does
  not select network, asset, provider, or RPC.
- SPEC-WP-14: payment decision closure prerequisites updated; custody model
  is now resolved.
- SPEC-WP-15: custody decision review now superseded by explicit selection.
- SPEC-WP-16: custody model selection review now superseded by explicit
  selection.

No contradictions found.

---

## 7. PROVIDER SELECTION STATUS

Custody model selection does NOT select:

- network;
- asset;
- RPC/provider;
- price oracle;
- finality;
- evidence format.

Those remain separate PENDING decisions.

Provider selection checklist:

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

Provider selection remains blocked by items B, C, D, E, F, G, H, and J.

---

## 8. WALLET CREATION STATUS

- No wallet has been created.
- No address has been generated or invented.
- Wallet creation remains pending resolution of:
  - key-management architecture;
  - operational roles and separation of duties;
  - monitoring/alerting configuration;
  - rotation/replacement procedure;
  - legal review;
  - wallet address publication mechanism.

---

## 9. VERDICT

SPEC-WP-17 = COMPLETE

Reason:
- The previously PENDING custody decision has been explicitly recorded
  and canonicalized.
- The selected model is internally consistent.
- No contradictions with WP-5..WP-16 were found.
- Provider selection remains separate and blocked by other PENDING
  decisions.
- Wallet creation remains pending.
- No address exists yet.

---

## 10. FILES UPDATED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md

---

FINAL CONFIRMATION:

"No wallet was created. No wallet address was generated, invented, or
reused. No production code, Cloudflare resources, payment integrations,
crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or legacy
files were modified."
